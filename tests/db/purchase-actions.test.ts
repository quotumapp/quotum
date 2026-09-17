import { describe, expect, it } from "bun:test";
import type { MeteringBalance } from "../../src/billing/metering";
import {
	buildDecision,
	type FeatureRow,
	type RateDecision,
} from "../../src/db/repository/metering-persistence";
import { FakeDatabase } from "./repository-fixture";

/**
 * The purchase actions offered on a denied consume are persisted as the operation outcome and
 * replayed verbatim, so both the action each provider gets and the JSON key order must hold once
 * the action comes from the capability declarations instead of a SQL literal.
 */

function feature(key: string): FeatureRow {
	return {
		id: "1",
		key,
		unit: "credit",
		credit_scale: 0,
		kind: "metered",
		meter_kind: "consumable",
		filter_dimensions: [],
	};
}

const rate: RateDecision = {
	meter: feature("api_calls"),
	wallet: feature("credits"),
	path: "direct",
	revision: 3,
	revisionId: "revision-3",
	entryId: "entry-1",
	pricingModel: "flat",
	ratePerUnit: "1",
	tiers: [],
};

const emptyBalance: MeteringBalance = {
	featureKey: "credits",
	unit: "credit",
	scale: 0,
	granted: "0",
	consumed: "0",
	held: "0",
	available: "0",
	breakdown: [],
};

describe("eligible purchase actions", () => {
	it("asks every provider selling credits for a customer purchase", async () => {
		const database = new FakeDatabase(
			[[{ provider: "apple" }, { provider: "google" }, { provider: "stripe" }]],
			{ strict: true },
		);

		const decision = await buildDecision(
			database as never,
			"project-1",
			rate,
			"1",
			"1",
			emptyBalance,
		);

		expect(decision.reason).toBe("insufficient_balance");
		expect(decision.eligiblePurchaseActions).toEqual([
			{ provider: "apple", action: "purchase_required" },
			{ provider: "google", action: "purchase_required" },
			{ provider: "stripe", action: "purchase_required" },
		]);
		// Replayed outcomes are compared as stored JSON, so the key order matters.
		expect(JSON.stringify(decision.eligiblePurchaseActions[0])).toBe(
			'{"provider":"apple","action":"purchase_required"}',
		);
		database.assertConsumed();
	});

	it("selects the providers alone, scoped to the project and ordered by provider", async () => {
		const database = new FakeDatabase([[{ provider: "stripe" }]], { strict: true });

		await buildDecision(database as never, "project-1", rate, "1", "1", emptyBalance);

		const query = database.queries[0] ?? "";
		expect(query).toContain("SELECT DISTINCT sp.provider");
		expect(query).not.toContain("purchase_required");
		expect(query).toContain("ORDER BY sp.provider");
		expect(database.boundParameter("sp.project_id", 0)).toBe("project-1");
	});

	it("offers nothing when the wallet covers the request", async () => {
		const database = new FakeDatabase([], { strict: true });

		const decision = await buildDecision(database as never, "project-1", rate, "1", "1", {
			...emptyBalance,
			granted: "5",
			available: "5",
		});

		expect(decision.allowed).toBe(true);
		expect(decision.eligiblePurchaseActions).toEqual([]);
		expect(database.queries).toHaveLength(0);
	});
});
