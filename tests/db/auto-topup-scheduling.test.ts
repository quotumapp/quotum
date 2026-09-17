import { describe, expect, it } from "bun:test";
import {
	type AutoTopupPolicyRow,
	scheduleAutoTopupIfNeeded,
} from "../../src/db/repository/controls-runtime";
import { FakeDatabase } from "./repository-fixture";

/**
 * Pins what automatic top-up scheduling does per provider — the queries it issues, the job status
 * it writes and the terminal fields that go with it — so that deriving provider support from the
 * capability declarations cannot change the rows. Written against unchanged source first.
 */

const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function policyRow(overrides: Partial<AutoTopupPolicyRow> = {}): AutoTopupPolicyRow {
	return {
		id: "11",
		provider: "stripe",
		// PR1 added this column; scheduling copies it into the job row.
		provider_account_id: "cus_fixture",
		threshold_quantity: "10",
		cooldown_seconds: 300,
		limit_interval_seconds: 86_400,
		max_purchases_per_interval: 5,
		max_spend_minor: null,
		amount_minor: 499,
		currency: "usd",
		store_product_id: "store-1",
		...overrides,
	};
}

/** A ready state whose interval is young, so the interval-reset UPDATE never runs. */
function readyState(): Array<Record<string, unknown>> {
	return [
		{
			status: "ready",
			interval_started_at: new Date().toISOString(),
			purchases_in_interval: 0,
			spend_minor_in_interval: 0,
			cooldown_until: null,
		},
	];
}

async function schedule(
	database: FakeDatabase,
	policy: AutoTopupPolicyRow,
): Promise<{ queries: string[]; insertParams: unknown[] }> {
	await scheduleAutoTopupIfNeeded(database as never, {
		projectId: "project-1",
		customerId: "customer-1",
		entityId: null,
		featureId: "5",
		availableQuantity: "1",
		triggerKey: "wallet:low",
		policy,
	});
	const index = database.queries.findIndex((query) =>
		query.includes("INSERT INTO auto_topup_jobs"),
	);
	return {
		queries: database.queries,
		insertParams: index === -1 ? [] : (database.params[index] ?? []),
	};
}

function timestampParams(params: unknown[]): string[] {
	return params.filter(
		(value): value is string => typeof value === "string" && isoTimestamp.test(value),
	);
}

describe("automatic top-up scheduling", () => {
	for (const provider of ["apple", "google"] as const) {
		it(`writes a terminal provider-action job for ${provider}`, async () => {
			const database = new FakeDatabase(
				[readyState(), [{ pending: false }], [{ id: "77" }], [{ policy_id: "11" }]],
				{ strict: true },
			);
			const before = Date.now();
			const { queries, insertParams } = await schedule(
				database,
				policyRow({
					provider,
					provider_account_id: `${provider}-account`,
					amount_minor: null,
					currency: null,
				}),
			);
			const after = Date.now();

			expect(queries).toHaveLength(4);
			expect(queries.some((query) => query.includes("interval_started_at = now()"))).toBe(false);
			// Asserted by value: PR1 shifted every positional index in this insert.
			expect(insertParams).toContain(provider);
			expect(insertParams).toContain(`${provider}-account`);
			expect(insertParams).toContain("provider_action_required");
			expect(insertParams).not.toContain("pending");
			expect(insertParams).toContain("Provider-native purchase action is required");
			const completedAt = timestampParams(insertParams);
			expect(completedAt).toHaveLength(1);
			expect(new Date(completedAt[0] ?? "").getTime()).toBeGreaterThanOrEqual(before);
			expect(new Date(completedAt[0] ?? "").getTime()).toBeLessThanOrEqual(after);
			database.assertConsumed();
		});
	}

	it("queues a pending job for Stripe with a positive amount", async () => {
		const database = new FakeDatabase(
			[readyState(), [{ pending: false }], [{ id: "77" }], [{ policy_id: "11" }]],
			{ strict: true },
		);
		const { queries, insertParams } = await schedule(database, policyRow({ amount_minor: 499 }));

		expect(queries).toHaveLength(4);
		expect(insertParams).toContain("stripe");
		expect(insertParams).toContain("cus_fixture");
		expect(insertParams).toContain("pending");
		expect(insertParams).not.toContain("provider_action_required");
		expect(insertParams).not.toContain("Provider-native purchase action is required");
		expect(insertParams).toContain(499);
		expect(insertParams).toContain("USD");
		// A pending job has no completion, so nothing in the row is a timestamp.
		expect(timestampParams(insertParams)).toHaveLength(0);
		database.assertConsumed();
	});

	it("returns before the pending query when a Stripe policy has no chargeable amount", async () => {
		const database = new FakeDatabase([readyState()]);
		const { queries, insertParams } = await schedule(database, policyRow({ amount_minor: 0 }));

		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("FROM auto_topup_states");
		expect(insertParams).toEqual([]);
		expect(queries.some((query) => query.includes("auto_topup_jobs"))).toBe(false);
	});
});
