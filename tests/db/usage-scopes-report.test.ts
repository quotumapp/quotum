import { describe, expect, it } from "bun:test";
import type { MeterLimitRow } from "../../src/db/repository/meter-limit-sources";
import {
	type AccountScopeGroup,
	compareAccountGroups,
	type FeatureScopes,
	groupAccountWindows,
	type MeterLimitItemRow,
	mixedScopeConfigurations,
	resolveAccountScope,
	type ScopeVersionLimit,
	type WindowRow,
} from "../../src/db/repository/usage-scopes-report";

function limit(overrides: Partial<ScopeVersionLimit>): ScopeVersionLimit {
	return {
		plan: "pro",
		version: 1,
		planKind: "base",
		published: true,
		scope: "account",
		overagePolicy: "blocked",
		quantity: "100",
		reset: { interval: "day", intervalCount: 1 },
		subscriptions: 1,
		planGrants: 0,
		...overrides,
	};
}

function source(overrides: Partial<MeterLimitRow>): MeterLimitRow {
	return {
		plan_item_id: "1",
		subscription_id: "sub-1",
		plan_grant_id: null,
		quantity: "100.000000000",
		overage_policy: "blocked",
		reset_interval: "day",
		reset_interval_count: 1,
		billing_interval: "month",
		billing_interval_count: 1,
		period_start_at: "2026-10-01T00:00:00.000Z",
		period_end_at: "2026-11-01T00:00:00.000Z",
		plan_kind: "base",
		sort_at: "2026-10-01T00:00:00.000Z",
		...overrides,
	};
}

type Item = Pick<MeterLimitItemRow, "plan_key" | "version" | "scope">;

function windowRow(overrides: Partial<WindowRow>): WindowRow {
	return {
		customer_id: "customer-1",
		billing_account_id: "acct-1",
		feature_id: "7",
		feature_key: "api_requests",
		credit_scale: 0,
		entity_id: null,
		entity_external_id: null,
		filter_key: null,
		window_start_at: "2026-10-02T00:00:00.000Z",
		window_end_at: "2026-10-03T00:00:00.000Z",
		usage: "0.000000000",
		held: "0",
		...overrides,
	};
}

describe("mixed-scope configurations", () => {
	it("pairs a base with an add-on, and add-ons of different plans, that cap with different scopes", () => {
		const features: FeatureScopes[] = [
			{
				featureKey: "api_requests",
				limits: [
					limit({ plan: "pro", planKind: "base", scope: "account" }),
					limit({ plan: "team", planKind: "base", scope: "entity" }),
					limit({ plan: "boost", planKind: "addon", scope: "entity" }),
					limit({ plan: "burst", planKind: "addon", scope: "account" }),
					limit({ plan: "burst", version: 2, planKind: "addon", scope: "entity" }),
				],
			},
		];
		const pairs = mixedScopeConfigurations(features).map(
			(pair) =>
				`${pair.first.plan}v${pair.first.version}:${pair.second.plan}v${pair.second.version}`,
		);
		// Two base plans never coexist, nor do two versions of one plan.
		expect(pairs).toEqual(["prov1:boostv1", "prov1:burstv2", "teamv1:burstv1", "boostv1:burstv1"]);
	});

	it("finds nothing when every limit on a feature shares one scope", () => {
		expect(
			mixedScopeConfigurations([
				{
					featureKey: "api_requests",
					limits: [limit({ planKind: "base" }), limit({ plan: "boost", planKind: "addon" })],
				},
			]),
		).toEqual([]);
	});
});

describe("resolving an account's declared scope", () => {
	const items = new Map<string, Item>([
		["1", { plan_key: "pro", version: 1, scope: "account" }],
		["2", { plan_key: "boost", version: 3, scope: "account" }],
		["3", { plan_key: "teams", version: 2, scope: "entity" }],
	]);

	it("takes the anchor's scope and the summed cap of the joining add-ons", () => {
		expect(
			resolveAccountScope(
				[
					source({ plan_item_id: "1" }),
					source({
						plan_item_id: "2",
						subscription_id: "sub-2",
						plan_kind: "addon",
						quantity: "50",
					}),
				],
				items,
				0,
			),
		).toEqual({ scope: "account", limit: "150", overagePolicy: "blocked" });
	});

	it("takes the base plan's scope when an entity-scoped add-on also applies", () => {
		expect(
			resolveAccountScope(
				[
					source({ plan_item_id: "3", subscription_id: "sub-3", plan_kind: "addon" }),
					source({ plan_item_id: "1" }),
				],
				items,
				0,
			),
		).toMatchObject({ scope: "account" });
	});

	it("is unresolved when nothing caps the feature now", () => {
		expect(resolveAccountScope([], items, 0)).toEqual({
			scope: "unresolved",
			limit: null,
			overagePolicy: null,
		});
	});

	it("falls back to the account scope for an anchor it cannot name", () => {
		expect(resolveAccountScope([source({ plan_item_id: "9" })], items, 0)).toMatchObject({
			scope: "account",
			limit: "100",
		});
	});
});

describe("grouping an account's open windows", () => {
	const rows = [
		windowRow({ entity_id: "11", entity_external_id: "workspace-a", usage: "60" }),
		windowRow({ entity_id: "12", entity_external_id: "workspace-b", usage: "30", held: "15" }),
		windowRow({ entity_id: "12", entity_external_id: "workspace-b", filter_key: "f1", usage: "5" }),
		windowRow({ usage: "4" }),
		windowRow({
			window_start_at: "2026-10-01T00:00:00.000Z",
			window_end_at: "2026-10-31T00:00:00.000Z",
			usage: "7",
		}),
	];

	it("sums every entity and filter in a window under an account scope", () => {
		const groups = groupAccountWindows(rows, {
			scope: "account",
			limit: "100",
			overagePolicy: "blocked",
		});
		expect(groups).toEqual([
			{
				billingAccountId: "acct-1",
				featureKey: "api_requests",
				windowStartAt: "2026-10-02T00:00:00.000Z",
				windowEndAt: "2026-10-03T00:00:00.000Z",
				scope: "account",
				entity: null,
				windows: 4,
				entities: 3,
				filters: 2,
				usage: "99",
				held: "15",
				limit: "100",
				overagePolicy: "blocked",
				overCap: true,
			},
			expect.objectContaining({ windows: 1, usage: "7", overCap: false }),
		]);
	});

	it("sums per entity, across filters, under an entity scope", () => {
		const groups = groupAccountWindows(rows.slice(0, 4), {
			scope: "entity",
			limit: "50",
			overagePolicy: "blocked",
		});
		expect(
			groups.map((group) => [group.entity, group.windows, group.usage, group.held, group.overCap]),
		).toEqual([
			["workspace-a", 1, "60", "0", true],
			["workspace-b", 2, "35", "15", false],
			[null, 1, "4", "0", false],
		]);
	});

	it("never marks postpaid or unresolved usage over a cap", () => {
		expect(
			groupAccountWindows(rows.slice(0, 1), {
				scope: "account",
				limit: "1",
				overagePolicy: "allowed",
			}),
		).toMatchObject([{ overCap: false }]);
		expect(
			groupAccountWindows(rows.slice(0, 1), {
				scope: "unresolved",
				limit: null,
				overagePolicy: null,
			}),
		).toMatchObject([{ scope: "unresolved", overCap: false, limit: null }]);
	});
});

describe("ordering listed account groups", () => {
	const base: AccountScopeGroup = {
		billingAccountId: "acct-1",
		featureKey: "api_requests",
		windowStartAt: "2026-10-02T00:00:00.000Z",
		windowEndAt: "2026-10-03T00:00:00.000Z",
		scope: "account",
		entity: null,
		windows: 2,
		entities: 2,
		filters: 1,
		usage: "10",
		held: "0",
		limit: "100",
		overagePolicy: "blocked",
		overCap: false,
	};

	it("lists over-cap groups first, then the largest exposure, then by account and feature", () => {
		const groups: AccountScopeGroup[] = [
			{ ...base, billingAccountId: "acct-c", usage: "5" },
			{ ...base, billingAccountId: "acct-b", usage: "5", featureKey: "tokens" },
			{ ...base, billingAccountId: "acct-b", usage: "5" },
			{ ...base, billingAccountId: "acct-a", usage: "1", held: "8" },
			{ ...base, billingAccountId: "acct-z", usage: "120", overCap: true },
			{ ...base, billingAccountId: "acct-y", usage: "101", held: "30", overCap: true },
		];
		expect(
			[...groups]
				.sort(compareAccountGroups)
				.map((group) => `${group.billingAccountId}/${group.featureKey}`),
		).toEqual([
			"acct-y/api_requests",
			"acct-z/api_requests",
			"acct-a/api_requests",
			"acct-b/api_requests",
			"acct-b/tokens",
			"acct-c/api_requests",
		]);
	});
});
