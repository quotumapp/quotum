import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import {
	closeUsageWindows,
	overageFeatureKey,
	seedOverageSubscriber,
} from "./helpers/overage-subscriber";
import { seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
const account = "regions";
let context: LocalPostgresContext;

/**
 * A usage invoice period covers every filter and entity window of a plan item in one billing
 * window. Whoever materializes it first, the recurring worker or a closed-period correction,
 * must price the same aggregate: the period's unique key has no filter dimension, so a partial
 * period could never be completed later.
 */
localDescribe("Usage invoice period materialization", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3ControlCatalog(context.sql);
		await seedOverageSubscriber(context.sql, { account, provider: "stripe" });
		await context.sql`
			UPDATE features SET filter_dimensions = ARRAY['region']
			WHERE key = ${overageFeatureKey(account)}
		`;
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("invoices every filter window when a correction materializes the period first", async () => {
		const original = await consumeRegion("us");
		await consumeRegion("eu");
		await closeUsageWindows(context.sql);

		await correctTen(original);
		expect(await periodRows()).toEqual([
			{ usage_quantity: "200.000000000", amount_minor: "88", status: "pending" },
		]);
		expect(await adjustmentRows()).toEqual([
			{ quantity: "-10.000000000", amount_minor: "-5", status: "pending" },
		]);

		const claim = await context.repository.materializeAndClaimUsageInvoicePeriods("worker", 10);
		expect(claim.materialized).toBe(0);
		expect(claim.jobs.map((job) => job.jobKind)).toEqual(["period"]);
		expect(await periodRows()).toHaveLength(1);
		expect(
			(await context.repository.materializeAndClaimUsageInvoicePeriods("worker", 10)).materialized,
		).toBe(0);
	});

	it("adjusts the aggregate period when the worker materializes it before a correction", async () => {
		const original = await consumeRegion("us");
		await consumeRegion("eu");
		await closeUsageWindows(context.sql);

		const claim = await context.repository.materializeAndClaimUsageInvoicePeriods("worker", 10);
		expect(claim.materialized).toBe(1);
		expect(await periodRows()).toEqual([
			{ usage_quantity: "200.000000000", amount_minor: "88", status: "processing" },
		]);

		await correctTen(original);
		expect(await periodRows()).toHaveLength(1);
		expect(await adjustmentRows()).toEqual([
			{ quantity: "-10.000000000", amount_minor: "-5", status: "pending" },
		]);
		expect(
			(await context.repository.materializeAndClaimUsageInvoicePeriods("worker", 10)).materialized,
		).toBe(0);
	});

	it("keeps an open window out of the correction path", async () => {
		const original = await consumeRegion("us");
		await consumeRegion("eu");

		await correctTen(original);
		expect(await periodRows()).toEqual([]);
		expect(await adjustmentRows()).toEqual([]);
		const [window] = await context.sql<Array<{ usage: string }>>`
			SELECT usage::text AS usage
			FROM usage_windows
			WHERE id = (
				SELECT (metadata->>'usageWindowId')::bigint FROM usage_events
				WHERE id = ${original.usageEventId}::uuid
			)
		`;
		expect(window?.usage).toBe("90.000000000");
	});
});

async function consumeRegion(region: string) {
	const receipt = await context.repository.consumeUsage(project, {
		billingAccountId: account,
		featureKey: overageFeatureKey(account),
		quantity: "100",
		filters: { region },
		idempotencyKey: `${account}:${region}`,
	});
	expect(receipt).toMatchObject({ allowed: true });
	if (receipt.usageEventId === null || receipt.recordedAt === null) {
		throw new Error(`Expected an accepted usage event for ${region}`);
	}
	return { usageEventId: receipt.usageEventId, recordedAt: receipt.recordedAt };
}

async function correctTen(receipt: { usageEventId: string; recordedAt: string }): Promise<void> {
	await context.repository.correctUsage(project, {
		billingAccountId: account,
		originalUsageEventId: receipt.usageEventId,
		originalRecordedAt: new Date(receipt.recordedAt),
		quantity: "10",
		reason: "period materialization correction",
		actor: "usage-invoice-periods-test",
		idempotencyKey: `${account}:correct`,
	});
}

async function periodRows() {
	return await context.sql<Array<{ usage_quantity: string; amount_minor: string; status: string }>>`
		SELECT usage_quantity::text AS usage_quantity, amount_minor::text AS amount_minor, status
		FROM usage_invoice_periods
		WHERE project_id = ${project.projectInstanceId}::uuid
		ORDER BY created_at
	`;
}

async function adjustmentRows() {
	return await context.sql<Array<{ quantity: string; amount_minor: string; status: string }>>`
		SELECT quantity::text AS quantity, amount_minor::text AS amount_minor, status
		FROM usage_invoice_adjustments
		WHERE project_id = ${project.projectInstanceId}::uuid
		ORDER BY created_at
	`;
}
