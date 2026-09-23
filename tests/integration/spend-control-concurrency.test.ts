import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { ConsumeUsageResult } from "../../src/billing/metering";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { overageFeatureKey, seedOverageSubscriber } from "./helpers/overage-fixtures";
import { seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
const account = "spend-race";
let context: LocalPostgresContext;

/**
 * A 25-unit meter limit with flat overage at 5 minor per 10 units. The first 75 units cost 25,
 * the next 75 cost 38 (63 for 150 units in total), so a 60 spend limit admits exactly one of them.
 */
const expectedDenial = {
	allowed: false,
	reason: "control_limit_exceeded",
	control: {
		kind: "spend_limit",
		limitValue: "60",
		currentValue: "25",
		requestedValue: "38",
		remainingValue: "35",
	},
};

localDescribe("spend controls under concurrent metered consumption", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3ControlCatalog(context.sql);
		await seedOverageSubscriber(context.sql, { account, provider: "stripe" });
		await context.repository.controlsEnterprise.upsertControl(project, {
			billingAccountId: account,
			controlKind: "spend_limit",
			featureKey: null,
			currency: "USD",
			limitValue: "60",
			interval: "month",
			actor: "integration-test",
		});
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("prices the second consume from the committed window", async () => {
		expect(await consume("serial:first")).toMatchObject({
			allowed: true,
			balance: { consumed: "75" },
		});
		expect(await consume("serial:second")).toMatchObject(expectedDenial);
		await expectSingleConsumePersisted();
	});

	it("serializes concurrent consumes so only one spends the same exposure", async () => {
		const [customer] = await context.sql<Array<{ id: string }>>`
			SELECT id FROM customers WHERE billing_account_id = ${account}
		`;
		const lockKey = `billing-controls:${project.projectInstanceId}:${customer?.id}`;
		let pending: Promise<ConsumeUsageResult>[] = [];
		// Holding the customer control lock parks the first consume behind it while it already
		// owns the meter spend lock, and parks the second consume behind that lock. Releasing
		// the control lock then lets both proceed in that order.
		await context.sql.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
			pending = ["race:one", "race:two"].map((idempotencyKey) => consume(idempotencyKey));
			await waitForWaitingBackends(2);
			const [advisory] = await tx<Array<{ waiting: number }>>`
				SELECT count(*)::integer AS waiting
				FROM pg_locks WHERE locktype = 'advisory' AND granted = false
			`;
			expect(advisory?.waiting).toBe(2);
		});
		const results = await Promise.all(pending);

		const allowed = results.filter((result) => result.allowed);
		const denied = results.filter((result) => !result.allowed);
		expect(allowed).toHaveLength(1);
		expect(allowed[0]).toMatchObject({ balance: { consumed: "75" } });
		expect(denied).toHaveLength(1);
		expect(denied[0]).toMatchObject(expectedDenial);
		await expectSingleConsumePersisted();
	});
});

function consume(idempotencyKey: string): Promise<ConsumeUsageResult> {
	return context.repository.consumeUsage(project, {
		billingAccountId: account,
		featureKey: overageFeatureKey(account),
		quantity: "75",
		idempotencyKey,
	});
}

async function waitForWaitingBackends(expected: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const [row] = await context.sql<Array<{ waiting: number }>>`
			SELECT count(DISTINCT pid)::integer AS waiting FROM pg_locks WHERE granted = false
		`;
		if ((row?.waiting ?? 0) >= expected) return;
		await Bun.sleep(20);
	}
	throw new Error(`Expected ${expected} waiting backends`);
}

async function expectSingleConsumePersisted(): Promise<void> {
	const [state] = await context.sql<
		Array<{ usage: string; consumed: string; events: number; receipts: number }>
	>`
		SELECT
			(SELECT usage::text FROM usage_windows) AS usage,
			(SELECT consumed_value::text FROM control_windows) AS consumed,
			(SELECT count(*)::integer FROM usage_events) AS events,
			(SELECT count(*)::integer FROM usage_event_control_entries) AS receipts
	`;
	expect(state).toEqual({
		usage: "75.000000000",
		consumed: "25.000000000",
		events: 1,
		receipts: 1,
	});
}
