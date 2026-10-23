import { describe, expect, it } from "bun:test";
import { CanonicalCatalogSchema } from "../../src/app/contracts/catalog-responses";
import { sha256Hex, stableJson } from "../../src/billing/decimal";
import { InvalidRequestError } from "../../src/billing/errors";
import { stripeProviderPricedAdvisory } from "../../src/catalog/canonical-intent";
import {
	CatalogControlPlane,
	checkNewCatalogIntent,
	decodeStoredIntent,
	parseAuthoredIntent,
} from "../../src/catalog/control-plane";
import type {
	AuthoredCatalogIntent,
	AuthoredPlanIntent,
	CatalogExpiryIntent,
	CatalogFeatureIntent,
	CatalogPriceIntent,
	CatalogProviderBindingIntent,
} from "../../src/catalog/types";

const features: CatalogFeatureIntent[] = [
	{
		key: "credits",
		name: "Credits",
		kind: "metered",
		meterKind: "consumable",
		unit: "credit",
		creditScale: 0,
		filterDimensions: [],
	},
	{
		key: "api_calls",
		name: "API calls",
		kind: "metered",
		meterKind: "consumable",
		unit: "call",
		creditScale: 0,
		filterDimensions: [],
	},
	{
		key: "seats",
		name: "Seats",
		kind: "metered",
		meterKind: "non_consumable",
		unit: "seat",
		creditScale: 0,
		filterDimensions: [],
	},
	{
		key: "support",
		name: "Support",
		kind: "boolean",
		meterKind: null,
		unit: "access",
		creditScale: 0,
		filterDimensions: [],
	},
];

const stripe = (productKey: string): CatalogProviderBindingIntent => ({
	productKey,
	provider: "stripe",
	channel: "web",
});
const apple = (productKey: string): CatalogProviderBindingIntent => ({
	productKey,
	provider: "apple",
	channel: "ios",
});
const google = (productKey: string): CatalogProviderBindingIntent => ({
	productKey,
	provider: "google",
	channel: "android",
});

function price(
	key: string,
	bindings: CatalogProviderBindingIntent[],
	overrides: Partial<CatalogPriceIntent> = {},
): CatalogPriceIntent {
	return {
		key,
		currency: "USD",
		unitAmountMinor: 2000,
		billingUnits: "1",
		billingInterval: "month",
		minimumQuantity: 1,
		maximumQuantity: 1,
		taxBehavior: "exclusive",
		providerBindings: bindings,
		...overrides,
	};
}

function catalog(plans: AuthoredPlanIntent[], extra: Partial<AuthoredCatalogIntent> = {}) {
	return { features, plans, topups: [], rateCards: [], ...extra } satisfies AuthoredCatalogIntent;
}

/** The same catalog in the canonical spelling. */
function canonicalCatalog(): AuthoredCatalogIntent {
	return catalog(
		[
			{
				key: "pro",
				name: "Pro",
				version: 1,
				basePrice: price("pro-base", [stripe("pro")]),
				providerPriced: {
					billingInterval: "month",
					providerBindings: [apple("pro_ios"), google("pro_android")],
				},
				items: [
					{ itemKind: "access", featureKey: "support" },
					{
						itemKind: "allocation",
						featureKey: "credits",
						quantity: "1000",
						reset: { interval: "month", intervalCount: 1 },
						expiry: { mode: "after_seconds", seconds: 86400 },
						rollover: {
							maxQuantity: "500",
							expiry: { mode: "after", interval: "month", intervalCount: 3 },
						},
					},
					{
						itemKind: "meter_limit",
						featureKey: "api_calls",
						quantity: "10000",
						reset: { interval: "day", intervalCount: 1 },
					},
					{
						itemKind: "licensed_quantity",
						featureKey: "seats",
						quantity: "5",
						allocationScope: "license_pool",
						price: price("seat", [stripe("pro_seat")], {
							unitAmountMinor: 800,
							maximumQuantity: null,
						}),
					},
				],
			},
		],
		{
			topups: [
				{
					key: "credits_1000",
					featureKey: "credits",
					quantity: "1000",
					expiry: { mode: "after_seconds", seconds: 31536000 },
					providerBindings: [stripe("credits_1000")],
				},
			],
		},
	);
}

class NormalizationSentinel extends Error {}
const passedNormalization = new NormalizationSentinel("normalization passed");

/** Preview up to its transaction: "normalized", or the message a new-intent rule refused with. */
async function previewOutcome(authored: AuthoredCatalogIntent): Promise<string> {
	const controlPlane = new CatalogControlPlane({
		transaction(): never {
			throw passedNormalization;
		},
	} as never);
	try {
		await controlPlane.preview({} as never, {
			expectedRevision: null,
			actor: "test",
			catalog: authored,
		});
	} catch (error) {
		if (error === passedNormalization) return "normalized";
		if (error instanceof InvalidRequestError) return error.message;
		throw error;
	}
	throw new Error("Catalog preview resolved without reaching its transaction");
}

describe("canonical catalog intent", () => {
	it("normalizes defaults, reads its own output and preserves its hash", () => {
		const first = parseAuthoredIntent(canonicalCatalog());
		const second = parseAuthoredIntent(first.canonical);
		expect(second.canonical).toEqual(first.canonical);
		expect(sha256Hex(stableJson(second.canonical))).toBe(sha256Hex(stableJson(first.canonical)));
		expect(decodeStoredIntent(first.canonical)).toEqual(first.canonical);
		expect(CanonicalCatalogSchema.safeParse(first.canonical).success).toBe(true);
		expect(first.canonical.plans[0]).toMatchObject({ kind: "base", controls: [], trialDays: null });
		expect(first.working.plans[0]?.providerBindings).toEqual([
			apple("pro_ios"),
			google("pro_android"),
			stripe("pro"),
		]);
		expect(first.advisories).toEqual([]);
	});

	it("derives an item-only plan's cadence without a plan amount or currency", () => {
		const parsed = checkNewCatalogIntent(catalog([seatPlan("year")]));
		expect(parsed.working.plans[0]).toMatchObject({
			billingInterval: "year",
			billingIntervalCount: 1,
			currency: null,
			baseAmountMinor: null,
		});
		expect(parsed.canonical.plans[0]).toMatchObject({ basePrice: null, providerPriced: null });
	});

	it("rejects disagreeing item prices, including counts of the same unit", () => {
		for (const other of [
			price("other", [stripe("other")], { billingInterval: "year" }),
			price("other", [stripe("other")], { billingIntervalCount: 2 }),
		]) {
			const plan = seatPlan("month");
			plan.items.push({
				itemKind: "meter_limit",
				featureKey: "api_calls",
				quantity: "100",
				reset: { interval: "month", intervalCount: 1 },
				overage: { policy: "allowed", price: other },
			});
			expect(() => checkNewCatalogIntent(catalog([plan]))).toThrow(
				"Plan team price intervals must match",
			);
		}
	});

	it("rejects two licensed quantities with different cadences", () => {
		const plan = seatPlan("month");
		const seatFeature = features.find((feature) => feature.key === "seats");
		if (seatFeature === undefined) throw new Error("Missing seat feature fixture");
		const intent = catalog([plan], {
			features: [...features, { ...seatFeature, key: "reviewers", name: "Reviewers" }],
		});
		plan.items.push({
			itemKind: "licensed_quantity",
			featureKey: "reviewers",
			quantity: "1",
			price: price("reviewer", [stripe("reviewer")], { billingInterval: "year" }),
		});
		expect(() => checkNewCatalogIntent(intent)).toThrow("Plan team price intervals must match");
	});

	it("checks allocations and meter limits against the item-derived billing cadence", () => {
		for (const itemKind of ["allocation", "meter_limit"] as const) {
			const plan = seatPlan("month");
			plan.items.push({
				itemKind,
				featureKey: "credits",
				quantity: "1200",
				reset: { interval: "year", intervalCount: 1 },
			});
			expect(() => checkNewCatalogIntent(catalog([plan]))).toThrow(
				"cannot reset every year on a plan billed every month",
			);
		}
	});

	it("accepts equivalent price cadences and shorter resets", () => {
		const plan = seatPlan("quarter");
		plan.items.push({
			itemKind: "meter_limit",
			featureKey: "api_calls",
			quantity: "100",
			reset: { interval: "month", intervalCount: 1 },
			overage: {
				policy: "allowed",
				price: price("overage", [stripe("overage")], {
					billingInterval: "month",
					billingIntervalCount: 3,
				}),
			},
		});
		expect(checkNewCatalogIntent(catalog([plan])).working.plans[0]).toMatchObject({
			billingInterval: "quarter",
			billingIntervalCount: 1,
		});
	});

	it("leaves an unpriced plan without a billing cadence", () => {
		const parsed = checkNewCatalogIntent(
			catalog([
				{
					key: "free",
					name: "Free",
					version: 1,
					items: [
						{
							itemKind: "allocation",
							featureKey: "credits",
							quantity: "100",
							reset: { interval: "year", intervalCount: 1 },
						},
					],
				},
			]),
		);
		expect(parsed.working.plans[0]?.billingInterval).toBeNull();
	});

	it("rejects removed fields in new requests and stored catalogs, even null and empty values", () => {
		const plan = seatPlan("month");
		for (const extra of [
			{ providerBindings: [] },
			{ billingInterval: null },
			{ billingIntervalCount: null },
			{ currency: null },
			{ baseAmountMinor: null },
		]) {
			const intent = catalog([{ ...plan, ...extra }]);
			expect(() => checkNewCatalogIntent(intent)).toThrow("Unrecognized key");
			expect(() => decodeStoredIntent(intent)).toThrow("Unrecognized key");
		}
		for (const extra of [
			{ resetInterval: null },
			{ resetIntervalCount: null },
			{ expiresAfterSeconds: null },
			{ overagePolicy: "blocked" },
		]) {
			const intent = catalog([
				{
					key: "free",
					name: "Free",
					version: 1,
					items: [{ itemKind: "allocation", featureKey: "credits", quantity: "1", ...extra }],
				},
			]);
			expect(() => checkNewCatalogIntent(intent)).toThrow("Unrecognized key");
		}
		const topup = {
			key: "pack",
			featureKey: "credits",
			quantity: "1",
			providerBindings: [stripe("pack")],
			expiresAfterSeconds: null,
		};
		expect(() => checkNewCatalogIntent(catalog([], { topups: [topup] }))).toThrow(
			"Unrecognized key",
		);
		const rollover = { maxQuantity: null, expiry: { mode: "months", months: 3 } };
		expect(() =>
			checkNewCatalogIntent(
				catalog([
					{
						key: "free",
						name: "Free",
						version: 1,
						items: [
							{
								itemKind: "allocation",
								featureKey: "credits",
								quantity: "1",
								rollover: rollover as never,
							},
						],
					},
				]),
			),
		).toThrow("invalid");
	});

	it("requires a provider-owned price's cadence and keeps the Stripe advisory", () => {
		const plan: AuthoredPlanIntent = {
			key: "pro",
			name: "Pro",
			version: 1,
			providerPriced: { billingInterval: "month", providerBindings: [stripe("pro")] },
			items: [],
		};
		expect(checkNewCatalogIntent(catalog([plan])).advisories[0]?.message).toBe(
			stripeProviderPricedAdvisory,
		);
		expect(() =>
			decodeStoredIntent(
				catalog([
					{
						...plan,
						providerPriced: {
							billingIntervalCount: 1,
							providerBindings: [stripe("pro")],
							billingInterval: null as never,
						},
					},
				]),
			),
		).toThrow("invalid");
	});

	it("checks agreement and exclusive bindings between both price blocks", () => {
		const plan: AuthoredPlanIntent = {
			key: "pro",
			name: "Pro",
			version: 1,
			basePrice: price("base", [stripe("pro")]),
			providerPriced: { billingInterval: "year", providerBindings: [apple("pro")] },
			items: [],
		};
		expect(() => checkNewCatalogIntent(catalog([plan]))).toThrow(
			"Plan pro price intervals must match",
		);
		plan.providerPriced = { billingInterval: "month", providerBindings: [stripe("pro")] };
		expect(() => checkNewCatalogIntent(catalog([plan]))).toThrow(
			"binds stripe/web/pro in both basePrice and providerPriced",
		);
	});
});

function seatPlan(billingInterval: CatalogPriceIntent["billingInterval"]): AuthoredPlanIntent {
	return {
		key: "team",
		name: "Team",
		version: 1,
		items: [
			{
				itemKind: "licensed_quantity",
				featureKey: "seats",
				quantity: "1",
				price: price("seat", [stripe("seat")], { billingInterval, maximumQuantity: null }),
			},
		],
	};
}

describe("calendar expiry", () => {
	/** A monthly plan with one allocation and a top-up, each expiring as given. */
	function expiringCatalog(
		allocationExpiry: CatalogExpiryIntent,
		topupExpiry: CatalogExpiryIntent,
	): AuthoredCatalogIntent {
		return catalog(
			[
				{
					key: "pro",
					name: "Pro",
					version: 1,
					basePrice: price("pro-base", [stripe("pro")]),
					items: [
						{
							itemKind: "allocation",
							featureKey: "credits",
							quantity: "1000",
							reset: { interval: "month", intervalCount: 1 },
							expiry: allocationExpiry,
						},
					],
				},
			],
			{
				topups: [
					{
						key: "credits_1000",
						featureKey: "credits",
						quantity: "1000",
						expiry: topupExpiry,
						providerBindings: [stripe("credits_1000")],
					},
				],
			},
		);
	}

	it("keeps a calendar expiry through the working model and reads it back unchanged", () => {
		const twoWeeks = { mode: "after", interval: "week", intervalCount: 2 } as const;
		const oneYear = { mode: "after", interval: "year", intervalCount: 1 } as const;
		const parsed = parseAuthoredIntent(expiringCatalog(twoWeeks, oneYear));
		expect(parsed.canonical.plans[0]?.items[0]).toMatchObject({ expiry: twoWeeks });
		expect(parsed.canonical.topups[0]?.expiry).toEqual(oneYear);
		// The working model publishes the cadence and no seconds.
		expect(parsed.working.plans[0]?.items[0]).toMatchObject({
			expiresAfterSeconds: null,
			expiryInterval: "week",
			expiryIntervalCount: 2,
		});
		expect(parsed.working.topups[0]).toMatchObject({
			expiresAfterSeconds: null,
			expiryInterval: "year",
			expiryIntervalCount: 1,
		});
		expect(CanonicalCatalogSchema.safeParse(parsed.canonical).success).toBe(true);
		expect(parseAuthoredIntent(parsed.canonical as AuthoredCatalogIntent).canonical).toEqual(
			parsed.canonical,
		);
		expect(decodeStoredIntent(parsed.canonical)).toEqual(parsed.canonical);
	});

	it("keeps an exact duration apart from the calendar cadence it approximates", () => {
		const calendar = parseAuthoredIntent(
			expiringCatalog({ mode: "forever" }, { mode: "after", interval: "year", intervalCount: 1 }),
		);
		const exact = parseAuthoredIntent(
			expiringCatalog({ mode: "forever" }, { mode: "after_seconds", seconds: 31_536_000 }),
		);
		expect(exact.canonical.topups[0]?.expiry).toEqual({
			mode: "after_seconds",
			seconds: 31_536_000,
		});
		expect(exact.working.topups[0]).toMatchObject({
			expiresAfterSeconds: 31_536_000,
			expiryInterval: null,
			expiryIntervalCount: null,
		});
		expect(sha256Hex(stableJson(calendar.canonical))).not.toBe(
			sha256Hex(stableJson(exact.canonical)),
		);
	});

	it("bounds a calendar expiry at ten years and accepts an hourly one", async () => {
		const forever = { mode: "forever" } as const;
		expect(
			await previewOutcome(
				expiringCatalog({ mode: "after", interval: "year", intervalCount: 11 }, forever),
			),
		).toBe("Plan pro item credits expiry cannot span more than 10 × year");
		expect(
			await previewOutcome(
				expiringCatalog(forever, { mode: "after", interval: "month", intervalCount: 121 }),
			),
		).toBe("Top-up credits_1000 expiry cannot span more than 10 × year");
		expect(
			await previewOutcome(
				expiringCatalog(
					{ mode: "after", interval: "hour", intervalCount: 12 },
					{
						mode: "after",
						interval: "year",
						intervalCount: 10,
					},
				),
			),
		).toBe("normalized");
	});
});

describe("unlimited usage items", () => {
	const metered = (items: AuthoredPlanIntent["items"], kind: "base" | "addon" = "base") => ({
		key: kind === "base" ? "pro" : "unlimited_calls",
		name: "Plan",
		version: 1,
		kind,
		items,
	});
	const unlimitedCalls = { itemKind: "unlimited_usage" as const, featureKey: "api_calls" };

	it("reads an unlimited item back as itself and publishes it without a quantity", () => {
		const parsed = parseAuthoredIntent(catalog([metered([unlimitedCalls])]));
		expect(parsed.canonical.plans[0]?.items).toEqual([unlimitedCalls]);
		expect(parsed.working.plans[0]?.items[0]).toMatchObject({
			itemKind: "unlimited_usage",
			quantity: null,
			resetInterval: null,
			price: null,
		});
		expect(CanonicalCatalogSchema.safeParse(parsed.canonical).success).toBe(true);
		expect(parseAuthoredIntent(parsed.canonical as AuthoredCatalogIntent).canonical).toEqual(
			parsed.canonical,
		);
	});

	it("refuses an unlimited item on a boolean or wallet feature and beside a postpaid limit", async () => {
		expect(
			await previewOutcome(
				catalog([metered([{ itemKind: "unlimited_usage", featureKey: "support" }])]),
			),
		).toBe("Unlimited usage support requires a metered feature");
		expect(
			await previewOutcome(
				catalog([
					metered([
						unlimitedCalls,
						{ itemKind: "allocation", featureKey: "credits", quantity: "10" },
					]),
					{
						...metered([{ itemKind: "allocation", featureKey: "api_calls", quantity: "5" }]),
						key: "starter",
					},
				]),
			),
		).toBe("Feature api_calls cannot use both a usage window and an allocation stack");
		expect(
			await previewOutcome(
				catalog([
					metered([
						{
							itemKind: "meter_limit",
							featureKey: "api_calls",
							quantity: "100",
							reset: { interval: "month", intervalCount: 1 },
							overage: {
								policy: "allowed",
								price: price("api-overage", [stripe("api_overage")], {
									unitAmountMinor: 1,
									maximumQuantity: null,
								}),
							},
						},
					]),
					metered([unlimitedCalls], "addon"),
				]),
			),
		).toBe(
			"Plan pro cannot allow postpaid overage on api_calls, because plan unlimited_calls grants unlimited usage of it; unlimited usage lifts hard caps only",
		);
		// A base plan's unlimited item beside another base plan's postpaid limit is allowed: an
		// account holds one base plan.
		expect(
			await previewOutcome(
				catalog([
					metered([unlimitedCalls]),
					{
						...metered([
							{
								itemKind: "meter_limit",
								featureKey: "api_calls",
								quantity: "100",
								reset: { interval: "month", intervalCount: 1 },
								overage: {
									policy: "allowed",
									price: price("api-overage", [stripe("api_overage")], {
										unitAmountMinor: 1,
										maximumQuantity: null,
									}),
								},
							},
						]),
						key: "metered",
						basePrice: price("metered-base", [stripe("metered")]),
					},
				]),
			),
		).toBe("normalized");
	});
});

describe("gifts", () => {
	const pro = {
		key: "pro",
		name: "Pro",
		version: 1,
		basePrice: price("pro-base", [stripe("pro")]),
		items: [{ itemKind: "access" as const, featureKey: "support" }],
	};
	const gift = (overrides: Partial<NonNullable<AuthoredCatalogIntent["gifts"]>[number]> = {}) => ({
		key: "gift-12m",
		name: "One year, as a gift",
		promotionKey: "voucher-12m",
		codeValidDays: 730,
		providerBindings: [stripe("gift_12m")],
		...overrides,
	});

	it("leaves a catalog without gifts as it was, so its intent hash does not move", () => {
		const without = parseAuthoredIntent(catalog([pro]));
		const empty = parseAuthoredIntent(catalog([pro], { gifts: [], retiredGiftKeys: [] }));

		expect(without.canonical).not.toHaveProperty("gifts");
		expect(without.canonical).not.toHaveProperty("retiredGiftKeys");
		expect(sha256Hex(stableJson(empty.canonical))).toBe(sha256Hex(stableJson(without.canonical)));
	});

	it("defaults to one code and reads its own canonical form back unchanged", () => {
		const parsed = parseAuthoredIntent(catalog([pro], { gifts: [gift()] }));

		expect(parsed.canonical.gifts).toEqual([
			{
				key: "gift-12m",
				name: "One year, as a gift",
				promotionKey: "voucher-12m",
				codeCount: 1,
				codeValidDays: 730,
				providerBindings: [stripe("gift_12m")],
			},
		]);
		expect(CanonicalCatalogSchema.safeParse(parsed.canonical).success).toBe(true);
		expect(parseAuthoredIntent(parsed.canonical as AuthoredCatalogIntent).canonical).toEqual(
			parsed.canonical,
		);
		expect(decodeStoredIntent(JSON.parse(JSON.stringify(parsed.canonical)))).toEqual(
			parsed.canonical,
		);
	});

	it("keeps a pack of codes and a retired gift", () => {
		const parsed = parseAuthoredIntent(
			catalog([pro], {
				gifts: [gift({ key: "gift-12m-x2", codeCount: 2 })],
				retiredGiftKeys: ["gift-6m"],
			}),
		);

		expect(parsed.canonical.gifts?.[0]?.codeCount).toBe(2);
		expect(parsed.canonical.retiredGiftKeys).toEqual(["gift-6m"]);
	});

	it("accepts a Stripe web gift and refuses anything else", async () => {
		expect(await previewOutcome(catalog([pro], { gifts: [gift()] }))).toBe("normalized");
		expect(
			await previewOutcome(
				catalog([pro], { gifts: [gift({ providerBindings: [apple("gift_12m")] })] }),
			),
		).toBe("Gift gift-12m binds only to Stripe web, not apple/ios");
		expect(
			await previewOutcome(
				catalog([pro], { gifts: [gift({ providerBindings: [stripe("gift_12m"), google("g")] })] }),
			),
		).toBe("Gift gift-12m binds only to Stripe web, not google/android");
	});

	it("bounds the code count and the validity", async () => {
		for (const [overrides] of [
			[{ codeCount: 0 }, "gift code count must be an integer from 1 to 100"],
			[{ codeCount: 101 }, "gift code count must be an integer from 1 to 100"],
			[{ codeCount: 1.5 }, "gift code count must be an integer from 1 to 100"],
			[{ codeValidDays: 0 }, "gift code validity in days must be an integer from 1 to 730"],
			[{ codeValidDays: 731 }, "gift code validity in days must be an integer from 1 to 730"],
		] as const) {
			expect(await previewOutcome(catalog([pro], { gifts: [gift(overrides)] }))).toContain(
				"codeCount" in overrides ? "codeCount" : "codeValidDays",
			);
		}
	});

	it("keeps a gift key, a gift's product and a retirement unambiguous", async () => {
		expect(
			await previewOutcome(catalog([pro], { gifts: [gift(), gift({ promotionKey: "other" })] })),
		).toBe("Duplicate gift key values are not allowed");
		expect(
			await previewOutcome(
				catalog([pro], {
					topups: [
						{
							key: "credits_1000",
							featureKey: "credits",
							quantity: "1000",
							providerBindings: [stripe("gift_12m")],
						},
					],
					gifts: [gift()],
				}),
			),
		).toBe("Duplicate provider product binding values are not allowed");
		expect(
			await previewOutcome(catalog([pro], { gifts: [gift()], retiredGiftKeys: ["gift-12m"] })),
		).toBe("gift gift-12m cannot be active and retired");
	});

	it("reads a gift the same in the working intent as in the canonical one", () => {
		const parsed = parseAuthoredIntent(catalog([pro], { gifts: [gift()] }));

		expect(parsed.working.gifts).toEqual(parsed.canonical.gifts);
	});
});
