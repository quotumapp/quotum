import { describe, expect, it } from "bun:test";
import {
	type AutoTopupPolicyRow,
	scheduleAutoTopupIfNeeded,
	scheduleAutoTopups,
} from "../../src/db/repository/controls-runtime";
import {
	type AllocationRow,
	autoTopupTriggers,
	type FeatureRow,
} from "../../src/db/repository/metering-persistence";
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
		entity_id: null,
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

describe("which automatic top-up policies a usage write triggers", () => {
	const wallet: FeatureRow = {
		id: "5",
		key: "ai_credits",
		unit: "credit",
		credit_scale: 0,
		kind: "metered",
		meter_kind: "consumable",
		filter_dimensions: [],
	};
	const account = policyRow({ id: "11", entity_id: null });
	const entity = policyRow({ id: "12", entity_id: "7" });

	function allocation(id: string, entity: string | null, quantity: string, consumed: string) {
		return {
			id,
			quantity,
			reversed_quantity: "0",
			consumed_quantity: consumed,
			held_quantity: "0",
			source_kind: "credit_grant",
			source_key: `fixture:${id}`,
			expires_at: null,
			created_at: new Date("2026-09-01T00:00:00.000Z"),
			reversed_at: null,
			entity_external_id: entity,
			rollover_origin_allocation_id: null,
			carry_over_origin_allocation_id: null,
			rollover_policy_revision: null,
			period_start_at: null,
			period_end_at: null,
		} satisfies AllocationRow;
	}
	function deduction(allocationId: string) {
		return {
			allocationId,
			quantity: "1",
			sourceKind: "credit_grant",
			sourceKey: `fixture:${allocationId}`,
			expiresAt: null,
		};
	}
	// The pool has 3 left and the entity's own allocation 4.
	const rows = [allocation("1", null, "10", "7"), allocation("2", "team-a", "10", "6")];

	it("compares the account's policy with the pool for account usage", () => {
		const triggers = autoTopupTriggers({
			policies: [account],
			entityId: null,
			wallet,
			rows: [rows[0] as AllocationRow],
			deductions: [deduction("1")],
		});
		expect(triggers).toEqual([{ policy: account, availableQuantity: "3" }]);
	});

	it("compares the entity's policy with all it can spend and the account's with the pool", () => {
		const triggers = autoTopupTriggers({
			policies: [account, entity],
			entityId: "7",
			wallet,
			rows,
			deductions: [deduction("2"), deduction("1")],
		});
		expect(triggers).toEqual([
			{ policy: account, availableQuantity: "3" },
			{ policy: entity, availableQuantity: "7" },
		]);
	});

	it("leaves the account's policy out when entity usage never reached the pool", () => {
		const triggers = autoTopupTriggers({
			policies: [account, entity],
			entityId: "7",
			wallet,
			rows,
			deductions: [deduction("2")],
		});
		expect(triggers).toEqual([{ policy: entity, availableQuantity: "7" }]);
	});

	it("schedules each triggered policy in turn", async () => {
		const database = new FakeDatabase(
			[
				readyState(),
				[{ pending: false }],
				[{ id: "77" }],
				[{ policy_id: "11" }],
				readyState(),
				[{ pending: false }],
				[{ id: "78" }],
				[{ policy_id: "12" }],
			],
			{ strict: true },
		);
		await scheduleAutoTopups(database as never, {
			projectId: "project-1",
			customerId: "customer-1",
			triggerKey: "usage:1",
			triggers: [
				{ policy: account, availableQuantity: "1" },
				{ policy: entity, availableQuantity: "1" },
			],
		});
		const inserts = database.queries.flatMap((query, index) =>
			query.includes("INSERT INTO auto_topup_jobs") ? [database.params[index] ?? []] : [],
		);
		expect(inserts).toHaveLength(2);
		expect(inserts[0]).toContain("11");
		expect(inserts[1]).toContain("12");
		database.assertConsumed();
	});
});
