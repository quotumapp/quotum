import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	databaseNow,
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

	it("waits for an outstanding reservation before invoicing the period", async () => {
		const windowEnd = await closePeriodSoon();
		await consumeRegion("us");
		const reservation = await reserveRegion("us", 300);
		await sleepPast(windowEnd);

		const deferred = await context.repository.materializeAndClaimUsageInvoicePeriods("worker", 10);
		expect(deferred).toEqual({ materialized: 0, jobs: [] });
		expect(await periodRows()).toEqual([]);

		const confirmation = await context.repository.confirmUsageReservation(project, {
			billingAccountId: account,
			reservationId: reservation,
			quantity: "50",
			idempotencyKey: `${account}:confirm`,
		});
		expect(confirmation).toMatchObject({ allowed: true, status: "confirmed" });
		expect(await windowUsage()).toEqual(["150.000000000"]);

		const claim = await context.repository.materializeAndClaimUsageInvoicePeriods("worker", 10);
		expect(claim.materialized).toBe(1);
		expect(await periodRows()).toEqual([
			{ usage_quantity: "150.000000000", amount_minor: "63", status: "processing" },
		]);
		expect(await adjustmentRows()).toEqual([]);
	});

	it("invoices the period once its reservation has expired", async () => {
		const windowEnd = await closePeriodSoon();
		await consumeRegion("us");
		const reservation = await reserveRegion("us", 1);
		const [held] = await context.sql<Array<{ expires_at: Date }>>`
			SELECT expires_at FROM reservations WHERE id = ${reservation}::uuid
		`;
		if (held === undefined) throw new Error("Expected the reservation row");
		await sleepPast(new Date(Math.max(windowEnd.getTime(), held.expires_at.getTime())));

		const claim = await context.repository.materializeAndClaimUsageInvoicePeriods("worker", 10);
		expect(claim.materialized).toBe(1);
		expect(await periodRows()).toEqual([
			{ usage_quantity: "100.000000000", amount_minor: "38", status: "processing" },
		]);

		const confirmation = await context.repository.confirmUsageReservation(project, {
			billingAccountId: account,
			reservationId: reservation,
			quantity: "50",
			idempotencyKey: `${account}:confirm-expired`,
		});
		expect(confirmation).toMatchObject({ allowed: false, status: "expired" });
		expect(await windowUsage()).toEqual(["100.000000000"]);
		expect(await adjustmentRows()).toEqual([]);
	});

	it("bills a confirmation against a period a correction already materialized", async () => {
		const windowEnd = await closePeriodSoon();
		const original = await consumeRegion("us");
		await consumeRegion("us", "again");
		const reservation = await reserveRegion("us", 300);
		await sleepPast(windowEnd);

		await correctTen(original);
		expect(await periodRows()).toEqual([
			{ usage_quantity: "200.000000000", amount_minor: "88", status: "pending" },
		]);

		const confirmation = await context.repository.confirmUsageReservation(project, {
			billingAccountId: account,
			reservationId: reservation,
			quantity: "50",
			idempotencyKey: `${account}:confirm-late`,
		});
		expect(confirmation).toMatchObject({ allowed: true, status: "confirmed" });
		expect(await windowUsage()).toEqual(["250.000000000"]);
		// 240 invoiced units rate to 108; the period (88) and its adjustments (-5, +25) add up.
		expect(await adjustmentRows()).toEqual([
			{ quantity: "-10.000000000", amount_minor: "-5", status: "pending" },
			{ quantity: "50.000000000", amount_minor: "25", status: "pending" },
		]);
		expect(await periodRows()).toHaveLength(1);
		expect(
			(await context.repository.materializeAndClaimUsageInvoicePeriods("worker", 10)).materialized,
		).toBe(0);
	});
});

/**
 * Ends the subscriber's current period shortly, so its usage window closes on its own. The end is
 * still ahead on both clocks, so usage recorded before it lands in the closing window.
 */
async function closePeriodSoon(): Promise<Date> {
	const ahead = Math.max(Date.now(), (await databaseNow(context.sql)).getTime());
	const end = new Date(ahead + 1500);
	await context.sql`
		UPDATE subscriptions SET current_period_end = ${end.toISOString()}
		WHERE project_id = ${project.projectInstanceId}::uuid
			AND external_subscription_id = ${`sub_${account}`}
	`;
	return end;
}

/**
 * Waits until both clocks have passed `instant`: the database closes windows and expires holds by
 * `now()`, while metering reads the host clock. Neither is assumed to agree with the other.
 */
async function sleepPast(instant: Date): Promise<void> {
	for (;;) {
		const behind = Math.min(Date.now(), (await databaseNow(context.sql)).getTime());
		if (behind > instant.getTime()) return;
		await Bun.sleep(instant.getTime() - behind + 1);
	}
}

async function reserveRegion(region: string, expiresInSeconds: number): Promise<string> {
	const reservation = await context.repository.reserveUsage(project, {
		billingAccountId: account,
		featureKey: overageFeatureKey(account),
		quantity: "50",
		filters: { region },
		expiresInSeconds,
		idempotencyKey: `${account}:${region}:reserve`,
	});
	expect(reservation).toMatchObject({ allowed: true });
	if (reservation.reservationId === null) throw new Error("Expected an accepted reservation");
	return reservation.reservationId;
}

async function windowUsage(): Promise<string[]> {
	const rows = await context.sql<Array<{ usage: string }>>`
		SELECT usage::text AS usage FROM usage_windows
		WHERE project_id = ${project.projectInstanceId}::uuid
		ORDER BY id
	`;
	return rows.map((row) => row.usage);
}

async function consumeRegion(region: string, key = region) {
	const receipt = await context.repository.consumeUsage(project, {
		billingAccountId: account,
		featureKey: overageFeatureKey(account),
		quantity: "100",
		filters: { region },
		idempotencyKey: `${account}:${key}`,
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
