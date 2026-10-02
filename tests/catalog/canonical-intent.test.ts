import { describe, expect, it } from "bun:test";
import { CanonicalCatalogSchema } from "../../src/app/contracts/catalog-responses";
import { sha256Hex, stableJson } from "../../src/billing/decimal";
import { InvalidRequestError } from "../../src/billing/errors";
import { stripeProviderPricedAdvisory } from "../../src/catalog/canonical-intent";
import {
	CatalogControlPlane,
	decodeStoredIntent,
	parseAuthoredIntent,
} from "../../src/catalog/control-plane";
import type {
	AuthoredCatalogIntent,
	AuthoredPlanIntent,
	CatalogExpiryIntent,
	CatalogFeatureIntent,
	CatalogPlanIntent,
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

/** A legacy plan as the console and earlier catalog files spell it. */
function legacyPlan(overrides: Partial<CatalogPlanIntent>): CatalogPlanIntent {
	return {
		key: "pro",
		name: "Pro",
		version: 1,
		currency: "USD",
		baseAmountMinor: 2000,
		billingInterval: "month",
		trialDays: null,
		items: [],
		providerBindings: [],
		...overrides,
	};
}

/** The pro plan spelled the legacy way, with one item of each kind and a top-up. */
function legacyCatalog(): AuthoredCatalogIntent {
	return catalog(
		[
			legacyPlan({
				basePrice: price("pro-base", [stripe("pro")]),
				providerBindings: [stripe("pro"), apple("pro_ios"), google("pro_android")],
				items: [
					{
						featureKey: "support",
						itemKind: "access",
						quantity: null,
						resetInterval: null,
						expiresAfterSeconds: null,
						overagePolicy: "blocked",
					},
					{
						featureKey: "credits",
						itemKind: "allocation",
						quantity: "1000",
						resetInterval: "month",
						resetIntervalCount: 1,
						expiresAfterSeconds: 86400,
						overagePolicy: "blocked",
						rollover: { maxQuantity: "500", expiry: { mode: "months", months: 3 } },
					},
					{
						featureKey: "api_calls",
						itemKind: "meter_limit",
						quantity: "10000",
						resetInterval: "day",
						expiresAfterSeconds: null,
						overagePolicy: "blocked",
					},
					{
						featureKey: "seats",
						itemKind: "licensed_quantity",
						quantity: "5",
						resetInterval: null,
						expiresAfterSeconds: null,
						overagePolicy: "blocked",
						allocationScope: "license_pool",
						price: price("seat", [stripe("pro_seat")], {
							unitAmountMinor: 800,
							maximumQuantity: null,
						}),
					},
				],
			}),
		],
		{
			topups: [
				{
					key: "credits_1000",
					featureKey: "credits",
					quantity: "1000",
					expiresAfterSeconds: 31536000,
					providerBindings: [stripe("credits_1000")],
				},
			],
		},
	);
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
	it("spells a legacy intent in the canonical shape, with every default explicit", () => {
		const { canonical } = parseAuthoredIntent(legacyCatalog());
		expect(canonical.plans[0]).toEqual({
			key: "pro",
			name: "Pro",
			version: 1,
			kind: "base",
			visibility: "public",
			customerBillingAccountId: null,
			tierRank: 0,
			trialDays: null,
			trialRequiresPaymentMethod: true,
			trialEndBehavior: "cancel",
			upgradeProrationBehavior: "always_invoice",
			downgradeProrationBehavior: "none",
			basePrice: {
				...price("pro-base", [stripe("pro")]),
				billingIntervalCount: 1,
				pricingModel: "flat",
				tiers: [],
			},
			// The plan-level bindings the base price does not hold are the provider-priced products.
			providerPriced: {
				billingInterval: "month",
				billingIntervalCount: 1,
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
					allocationScope: "account",
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
					overage: { policy: "blocked" },
					allocationScope: "account",
				},
				{
					itemKind: "licensed_quantity",
					featureKey: "seats",
					quantity: "5",
					price: {
						...price("seat", [stripe("pro_seat")], {
							unitAmountMinor: 800,
							maximumQuantity: null,
						}),
						billingIntervalCount: 1,
						pricingModel: "flat",
						tiers: [],
					},
					allocationScope: "license_pool",
				},
			],
			controls: [],
		});
		expect(canonical.topups).toEqual([
			{
				key: "credits_1000",
				featureKey: "credits",
				quantity: "1000",
				expiry: { mode: "after_seconds", seconds: 31536000 },
				providerBindings: [stripe("credits_1000")],
			},
		]);
		expect(canonical).toMatchObject({
			retiredFeatureKeys: [],
			retiredPlanKeys: [],
			retiredTopupKeys: [],
		});
		expect(canonical).not.toHaveProperty("defaultPlan");
		expect(CanonicalCatalogSchema.safeParse(canonical).success).toBe(true);
	});

	it("gives a legacy and a canonical spelling of one catalog the same intent and hash", () => {
		const legacy = parseAuthoredIntent(legacyCatalog());
		const canonical = parseAuthoredIntent(canonicalCatalog());
		expect(stableJson(canonical.canonical)).toBe(stableJson(legacy.canonical));
		expect(sha256Hex(stableJson(canonical.canonical))).toBe(
			sha256Hex(stableJson(legacy.canonical)),
		);
		expect(canonical.deprecations).toEqual([]);
		expect(legacy.deprecations.map(({ path }) => path)).toEqual([
			"plans[0].items[0]",
			"plans[0].items[1]",
			"plans[0].items[2]",
			"plans[0].items[3]",
			"plans[0]",
			"topups[0]",
		]);
	});

	it("reads its own canonical form back unchanged", () => {
		const { canonical } = parseAuthoredIntent(legacyCatalog());
		expect(parseAuthoredIntent(canonical as AuthoredCatalogIntent).canonical).toEqual(canonical);
		expect(decodeStoredIntent(canonical)).toEqual(canonical);
	});

	it("decodes a catalog stored in the legacy normalized shape", () => {
		// What the control plane stored before the canonical intent: legacy fields filled in, the
		// legacy binding list kept over the base price's, and a price that never charges.
		const stored = {
			...legacyCatalog(),
			plans: [
				{
					...legacyPlan({
						basePrice: {
							...price("pro-base", [stripe("pro")]),
							billingIntervalCount: 1,
							pricingModel: "flat",
							tiers: [],
						},
						providerBindings: [apple("pro_ios")],
						billingIntervalCount: 1,
						items: [
							{
								featureKey: "api_calls",
								itemKind: "meter_limit",
								quantity: "10000",
								resetInterval: "day",
								resetIntervalCount: 1,
								expiresAfterSeconds: null,
								overagePolicy: "blocked",
								allocationScope: "account",
								rollover: null,
								price: price("api-overage", [stripe("api_overage")]),
							},
						],
					}),
					kind: "base",
					visibility: "public",
					customerBillingAccountId: null,
					tierRank: 0,
					trialRequiresPaymentMethod: true,
					trialEndBehavior: "cancel",
					upgradeProrationBehavior: "always_invoice",
					downgradeProrationBehavior: "none",
					controls: [],
				},
			],
			retiredFeatureKeys: [],
			retiredPlanKeys: [],
			retiredTopupKeys: [],
		};
		const decoded = decodeStoredIntent(stored);
		expect(decoded.plans[0]).toMatchObject({
			basePrice: { key: "pro-base", providerBindings: [stripe("pro")] },
			providerPriced: {
				billingInterval: "month",
				billingIntervalCount: 1,
				providerBindings: [apple("pro_ios")],
			},
			// A blocked limit's price never charged, so the canonical intent has no place for it.
			items: [{ itemKind: "meter_limit", overage: { policy: "blocked" } }],
		});
		expect(decodeStoredIntent(decoded)).toEqual(decoded);
		expect(CanonicalCatalogSchema.safeParse(decoded).success).toBe(true);
	});

	it("maps a provider-priced legacy plan and drops the amounts nothing charges", () => {
		const { canonical, deprecations, advisories } = parseAuthoredIntent(
			catalog([
				legacyPlan({
					key: "store",
					baseAmountMinor: 999,
					providerBindings: [apple("store_ios"), stripe("store_web")],
				}),
				legacyPlan({ key: "free", billingInterval: null, baseAmountMinor: 0 }),
				legacyPlan({ key: "trialware", currency: null, baseAmountMinor: null }),
			]),
		);
		expect(
			canonical.plans.map(({ basePrice, providerPriced }) => ({ basePrice, providerPriced })),
		).toEqual([
			{
				basePrice: null,
				providerPriced: {
					billingInterval: "month",
					billingIntervalCount: 1,
					providerBindings: [apple("store_ios"), stripe("store_web")],
				},
			},
			{ basePrice: null, providerPriced: null },
			{ basePrice: null, providerPriced: null },
		]);
		expect(deprecations).toEqual([
			{
				path: "plans[0]",
				legacy: ["currency", "baseAmountMinor", "billingInterval", "providerBindings"],
				canonical: ["providerPriced"],
				message:
					"Plan-level price fields are legacy syntax; use basePrice for a price Quotum models and providerPriced for products a provider prices. baseAmountMinor and currency dropped: the provider owns this plan's price.",
			},
			{
				path: "plans[1]",
				legacy: ["currency", "baseAmountMinor", "billingInterval", "providerBindings"],
				canonical: [],
				message:
					"Plan-level price fields are legacy syntax; use basePrice for a price Quotum models and providerPriced for products a provider prices. baseAmountMinor and currency dropped: the plan has no price or provider binding.",
			},
			{
				path: "plans[2]",
				legacy: ["currency", "baseAmountMinor", "billingInterval", "providerBindings"],
				canonical: [],
				message:
					"Plan-level price fields are legacy syntax; use basePrice for a price Quotum models and providerPriced for products a provider prices. billingInterval dropped: the plan has no price or provider binding.",
			},
		]);
		// Advice, not a deprecation: provider-owned Stripe pricing has no retirement plan.
		expect(advisories).toEqual([
			{
				path: "plans[0].providerPriced.providerBindings[1]",
				message: "Use `basePrice` when Quotum should model the price.",
			},
		]);
		expect(stripeProviderPricedAdvisory).toBe(
			"Use `basePrice` when Quotum should model the price.",
		);
	});

	it("describes each legacy item and top-up spelling it accepted", () => {
		const { deprecations } = parseAuthoredIntent(legacyCatalog());
		expect(deprecations.slice(0, 4)).toEqual([
			{
				path: "plans[0].items[0]",
				legacy: ["quantity", "resetInterval", "expiresAfterSeconds", "overagePolicy"],
				canonical: [],
				message: "An access item takes only itemKind and featureKey.",
			},
			{
				path: "plans[0].items[1]",
				legacy: [
					"quantity",
					"resetInterval",
					"resetIntervalCount",
					"expiresAfterSeconds",
					"overagePolicy",
					"rollover",
				],
				canonical: ["quantity", "reset", "expiry", "allocationScope", "rollover"],
				message:
					"Use the canonical allocation item: quantity, reset, expiry, allocationScope, rollover.",
			},
			{
				path: "plans[0].items[2]",
				legacy: ["quantity", "resetInterval", "expiresAfterSeconds", "overagePolicy"],
				canonical: ["quantity", "reset", "overage", "allocationScope"],
				message: "Use the canonical meter_limit item: quantity, reset, overage, allocationScope.",
			},
			{
				path: "plans[0].items[3]",
				legacy: [
					"quantity",
					"resetInterval",
					"expiresAfterSeconds",
					"overagePolicy",
					"price",
					"allocationScope",
				],
				canonical: ["quantity", "price", "allocationScope"],
				message: "Use the canonical licensed_quantity item: quantity, price, allocationScope.",
			},
		]);
		expect(deprecations.at(-1)).toEqual({
			path: "topups[0]",
			legacy: ["expiresAfterSeconds"],
			canonical: ["expiry"],
			message: "Use expiry instead of expiresAfterSeconds.",
		});
	});

	it("spells an allowed overage and its price as one overage object", () => {
		const { canonical } = parseAuthoredIntent(
			catalog([
				legacyPlan({
					basePrice: price("pro-base", [stripe("pro")]),
					items: [
						{
							featureKey: "api_calls",
							itemKind: "meter_limit",
							quantity: "10000",
							resetInterval: "month",
							expiresAfterSeconds: null,
							overagePolicy: "allowed",
							price: price("api-overage", [stripe("api_overage")], {
								unitAmountMinor: 50,
								billingUnits: "1000",
								maximumQuantity: null,
							}),
						},
					],
				}),
			]),
		);
		expect(canonical.plans[0]?.items[0]).toMatchObject({
			itemKind: "meter_limit",
			overage: { policy: "allowed", price: { key: "api-overage", unitAmountMinor: 50 } },
		});
	});

	it("binds a plan to the products of both price blocks", () => {
		const legacy = parseAuthoredIntent(
			catalog([
				legacyPlan({
					basePrice: price("pro-base", [stripe("pro")]),
					// Before the canonical intent this list replaced the base price's product.
					providerBindings: [apple("pro_ios")],
				}),
			]),
		);
		expect(legacy.working.plans[0]?.providerBindings).toEqual([apple("pro_ios"), stripe("pro")]);
		const canonical = parseAuthoredIntent(canonicalCatalog());
		expect(canonical.working.plans[0]?.providerBindings).toEqual([
			apple("pro_ios"),
			google("pro_android"),
			stripe("pro"),
		]);
	});

	it("derives a seat plan's billing cadence from its item prices and records no plan currency", () => {
		const { canonical, working } = parseAuthoredIntent(
			catalog([
				{
					key: "team",
					name: "Team",
					version: 1,
					items: [
						{
							itemKind: "licensed_quantity",
							featureKey: "seats",
							quantity: "5",
							price: price("seat", [stripe("team_seat")], {
								billingInterval: "year",
								maximumQuantity: null,
							}),
						},
					],
				},
			]),
		);
		expect(canonical.plans[0]).toMatchObject({ basePrice: null, providerPriced: null });
		// The seat price keeps its own currency; the plan has no base price, so no plan currency
		// (a currency without a base amount violates `plan_versions_price_check`).
		expect(working.plans[0]).toMatchObject({
			billingInterval: "year",
			billingIntervalCount: 1,
			currency: null,
			baseAmountMinor: null,
		});
		expect(working.plans[0]?.items[0]?.price).toMatchObject({ currency: "USD" });
	});

	it("accepts App Store and Google Play plans priced by their store", async () => {
		const storePlan = (key: string, binding: CatalogProviderBindingIntent): AuthoredPlanIntent => ({
			key,
			name: key,
			version: 1,
			providerPriced: { billingInterval: "month", providerBindings: [binding] },
			items: [{ itemKind: "access", featureKey: "support" }],
		});
		const authored = catalog([
			storePlan("ios_pro", apple("ios_pro")),
			storePlan("android_pro", google("android_pro")),
		]);
		expect(await previewOutcome(authored)).toBe("normalized");
		const { canonical, advisories, working } = parseAuthoredIntent(authored);
		expect(advisories).toEqual([]);
		expect(canonical.plans.map(({ providerPriced }) => providerPriced)).toEqual([
			{ billingInterval: "month", billingIntervalCount: 1, providerBindings: [apple("ios_pro")] },
			{
				billingInterval: "month",
				billingIntervalCount: 1,
				providerBindings: [google("android_pro")],
			},
		]);
		expect(working.plans.map(({ billingInterval }) => billingInterval)).toEqual(["month", "month"]);
	});

	it("accepts an unpriced default plan with no items", async () => {
		expect(
			await previewOutcome(
				catalog([{ key: "free", name: "Free", version: 1, items: [] }], {
					defaultPlan: { planKey: "free", entitlementKeys: ["free_tier"] },
				}),
			),
		).toBe("normalized");
	});

	it("refuses an authored intent the canonical spelling cannot hold", async () => {
		const pro: AuthoredPlanIntent = {
			key: "pro",
			name: "Pro",
			version: 1,
			basePrice: price("pro-base", [stripe("pro")]),
			items: [],
		};
		expect(
			await previewOutcome(
				catalog([
					{
						...pro,
						providerPriced: { billingInterval: "year", providerBindings: [apple("pro_ios")] },
					},
				]),
			),
		).toBe("Plan pro price intervals must match");
		expect(
			await previewOutcome(
				catalog([
					{
						...pro,
						providerPriced: { billingInterval: "month", providerBindings: [stripe("pro")] },
					},
				]),
			),
		).toBe("Plan pro binds stripe/web/pro in both basePrice and providerPriced");
		expect(
			await previewOutcome(
				catalog([
					{
						...pro,
						currency: "USD",
						providerPriced: { billingInterval: "month", providerBindings: [apple("pro_ios")] },
					},
				]),
			),
		).toBe("Plan pro cannot combine providerPriced with the legacy plan-level price fields");
		expect(
			await previewOutcome(
				catalog([legacyPlan({ billingInterval: null, providerBindings: [apple("pro_ios")] })]),
			),
		).toBe(
			"Plan pro provider bindings without a basePrice require a billingInterval: the provider prices them on a cadence",
		);
		expect(
			await previewOutcome(
				catalog([
					legacyPlan({
						basePrice: price("pro-base", [stripe("pro")]),
						items: [
							{
								featureKey: "support",
								itemKind: "access",
								quantity: null,
								resetInterval: null,
								expiresAfterSeconds: 3600,
								overagePolicy: "blocked",
							},
						],
					}),
				]),
			),
		).toBe("Access item support cannot declare a quantity, reset, expiry or overage");
		expect(
			await previewOutcome(
				catalog([], {
					topups: [
						{
							key: "credits_1000",
							featureKey: "credits",
							quantity: "1000",
							expiry: { mode: "forever" },
							expiresAfterSeconds: null,
							providerBindings: [stripe("credits_1000")],
						},
					],
				}),
			),
		).toBe("Top-up credits_1000 sets both expiry and expiresAfterSeconds; use expiry");
	});
});

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
