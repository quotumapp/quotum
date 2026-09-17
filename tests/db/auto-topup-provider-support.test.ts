import { describe, expect, it } from "bun:test";
import {
	type AutoTopupPolicyRow,
	scheduleAutoTopupIfNeeded,
} from "../../src/db/repository/controls-runtime";
import {
	type ProviderCapabilityLookup,
	providerCapabilityCatalog,
	providerCapabilityDeclaration,
} from "../../src/providers/capabilities";
import type { DeclaredProvider, OperationSupport } from "../../src/shared/provider-capabilities";
import { FakeDatabase } from "./repository-fixture";

/**
 * Automatic top-up support comes from the declarations, not from the string "stripe". The tests
 * inject declarations rather than a provider set, so scheduling has to derive the supported
 * providers: the job status, the terminal fields and the amount guard all follow the declaration.
 */

/** The declared catalog with one provider's automatic top-up support replaced. */
function automaticTopupDeclaring(
	provider: DeclaredProvider,
	support: OperationSupport,
): ProviderCapabilityLookup {
	const declaration = providerCapabilityDeclaration(provider);
	return new Map(providerCapabilityCatalog).set(provider, {
		...declaration,
		operations: { ...declaration.operations, "topup.automatic": support },
	});
}

const nativelyVerified: OperationSupport = {
	level: "native",
	verification: {
		status: "verified",
		verifiedOn: "2026-09-17",
		evidence: { tests: [], scenarios: [], questions: [] },
	},
	conditions: [],
};

const unsupported: OperationSupport = {
	level: "unsupported",
	verification: { status: "not_applicable" },
	conditions: [],
};

function policyRow(overrides: Partial<AutoTopupPolicyRow> = {}): AutoTopupPolicyRow {
	return {
		id: "11",
		provider: "stripe",
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
	capabilities?: ProviderCapabilityLookup,
): Promise<unknown[]> {
	await scheduleAutoTopupIfNeeded(database as never, {
		projectId: "project-1",
		customerId: "customer-1",
		entityId: null,
		featureId: "5",
		availableQuantity: "1",
		triggerKey: "wallet:low",
		policy,
		capabilities,
	});
	const index = database.queries.findIndex((query) =>
		query.includes("INSERT INTO auto_topup_jobs"),
	);
	return index === -1 ? [] : (database.params[index] ?? []);
}

describe("automatic top-up support follows the declared providers", () => {
	it("queues a pending job for a provider whose declaration builds automatic top-up", async () => {
		const database = new FakeDatabase(
			[readyState(), [{ pending: false }], [{ id: "77" }], [{ policy_id: "11" }]],
			{ strict: true },
		);

		const insertParams = await schedule(
			database,
			policyRow({ provider: "apple", provider_account_id: "apple-account" }),
			automaticTopupDeclaring("apple", nativelyVerified),
		);

		expect(insertParams).toContain("apple");
		expect(insertParams).toContain("pending");
		expect(insertParams).not.toContain("provider_action_required");
		expect(insertParams).not.toContain("Provider-native purchase action is required");
		database.assertConsumed();
	});

	it("writes a terminal provider-action job once a declaration drops automatic top-up", async () => {
		const database = new FakeDatabase(
			[readyState(), [{ pending: false }], [{ id: "77" }], [{ policy_id: "11" }]],
			{ strict: true },
		);

		const insertParams = await schedule(
			database,
			policyRow(),
			automaticTopupDeclaring("stripe", unsupported),
		);

		expect(insertParams).toContain("stripe");
		expect(insertParams).toContain("provider_action_required");
		expect(insertParams).toContain("Provider-native purchase action is required");
		expect(insertParams).not.toContain("pending");
		database.assertConsumed();
	});

	it("applies the chargeable-amount guard to the supported provider", async () => {
		const guarded = new FakeDatabase([readyState()], { strict: true });
		expect(
			await schedule(
				guarded,
				policyRow({ provider: "apple", amount_minor: 0, currency: null }),
				automaticTopupDeclaring("apple", nativelyVerified),
			),
		).toEqual([]);
		expect(guarded.queries).toHaveLength(1);

		// The same policy is terminal, not skipped, under the declarations as they ship.
		const terminal = new FakeDatabase(
			[readyState(), [{ pending: false }], [{ id: "77" }], [{ policy_id: "11" }]],
			{ strict: true },
		);
		expect(
			await schedule(terminal, policyRow({ provider: "apple", amount_minor: 0, currency: null })),
		).toContain("provider_action_required");
		terminal.assertConsumed();
	});
});
