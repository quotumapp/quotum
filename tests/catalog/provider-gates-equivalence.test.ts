import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { BillingError } from "../../src/billing/errors";
import type { BillingChannel } from "../../src/billing/types";
import { CatalogControlPlane } from "../../src/catalog/control-plane";
import type {
	CatalogFeatureIntent,
	CatalogIntent,
	CatalogPlanIntent,
	CatalogPlanItemIntent,
	CatalogPriceIntent,
	CatalogProviderBindingIntent,
	CatalogTopupIntent,
} from "../../src/catalog/types";

/**
 * Pins the provider gates of `normalizeCatalog` — which constructs a non-Stripe binding may carry,
 * and in what order those rejections fire — so that rewriting them onto the capability
 * declarations cannot move a message, a code or a position. Written and proven green against
 * unchanged source first.
 */

type GatedProvider = "apple" | "google" | "stripe";

const declaredChannel: Record<GatedProvider, BillingChannel> = {
	apple: "ios",
	google: "android",
	stripe: "web",
};

interface RecordedOutcome {
	name: string;
	code: string;
	status: number;
	classification: string;
	exposeMessage: boolean;
	message: string;
}

class NormalizationSentinel extends Error {}

/** Thrown in place of opening a transaction: reaching it means normalization accepted the intent. */
const passedNormalization = new NormalizationSentinel("normalization passed");

const database = {
	transaction(): never {
		throw passedNormalization;
	},
} as never;

async function firstOutcome(catalog: CatalogIntent): Promise<RecordedOutcome | "normalized"> {
	const controlPlane = new CatalogControlPlane(database);
	try {
		await controlPlane.preview({} as never, { expectedRevision: null, actor: "test", catalog });
	} catch (error) {
		if (error === passedNormalization) return "normalized";
		if (error instanceof BillingError) {
			return {
				name: error.name,
				code: error.code,
				status: error.status,
				classification: error.classification,
				exposeMessage: error.exposeMessage,
				message: error.message,
			};
		}
		throw error;
	}
	throw new Error("Catalog preview resolved without reaching its transaction");
}

function invalidRequest(message: string): RecordedOutcome {
	return {
		name: "InvalidRequestError",
		code: "INVALID_REQUEST",
		status: 400,
		classification: "invalid_request",
		exposeMessage: true,
		message,
	};
}

const features: CatalogFeatureIntent[] = [
	{
		key: "docs_access",
		name: "Docs access",
		kind: "boolean",
		meterKind: null,
		unit: "flag",
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
		key: "api_requests",
		name: "API requests",
		kind: "metered",
		meterKind: "consumable",
		unit: "request",
		creditScale: 0,
		filterDimensions: [],
	},
];

function bindings(
	providers: readonly GatedProvider[],
	slot: string,
): CatalogProviderBindingIntent[] {
	return providers.map((provider) => ({
		provider,
		channel: declaredChannel[provider],
		productKey: `${slot}-${provider}`,
	}));
}

interface PriceSpec {
	model: "flat" | "graduated";
	providers: GatedProvider[];
}

function priceIntent(spec: PriceSpec, slot: string): CatalogPriceIntent {
	return {
		key: `price-${slot}`,
		currency: "USD",
		unitAmountMinor: 1000,
		billingUnits: "1",
		billingInterval: "month",
		minimumQuantity: 1,
		maximumQuantity: null,
		taxBehavior: "exclusive",
		pricingModel: spec.model,
		tiers: spec.model === "flat" ? [] : [{ upToQuantity: null, unitAmountMinor: 500 }],
		providerBindings: bindings(spec.providers, slot),
	};
}

type ItemSpec =
	| { kind: "access" }
	| { kind: "licensed"; price: PriceSpec }
	| { kind: "meter_limit"; price: PriceSpec | null };

const itemFeatureKeys: Record<ItemSpec["kind"], string> = {
	access: "docs_access",
	licensed: "seats",
	meter_limit: "api_requests",
};

function itemPriceSpec(item: ItemSpec): PriceSpec | null {
	return item.kind === "access" ? null : item.price;
}

function itemIntent(item: ItemSpec, slot: string): CatalogPlanItemIntent {
	const price = itemPriceSpec(item);
	return {
		featureKey: itemFeatureKeys[item.kind],
		itemKind:
			item.kind === "access"
				? "access"
				: item.kind === "licensed"
					? "licensed_quantity"
					: "meter_limit",
		quantity: item.kind === "access" ? null : item.kind === "licensed" ? "5" : "100",
		resetInterval: item.kind === "meter_limit" ? "month" : null,
		expiresAfterSeconds: null,
		overagePolicy: "blocked",
		price: price === null ? null : priceIntent(price, slot),
	};
}

interface PlanSpec {
	legacy: GatedProvider[];
	kind: "base" | "addon";
	trialDays: number | null;
	basePrice: PriceSpec | null;
	items: ItemSpec[];
}

function planIntent(spec: PlanSpec, index: number): CatalogPlanIntent {
	return {
		key: `plan_${index}`,
		name: `Plan ${index}`,
		version: 1,
		currency: "USD",
		baseAmountMinor: null,
		billingInterval: "month",
		trialDays: spec.trialDays,
		kind: spec.kind,
		basePrice: spec.basePrice === null ? null : priceIntent(spec.basePrice, `p${index}-base`),
		items: spec.items.map((item, itemIndex) => itemIntent(item, `p${index}-i${itemIndex}`)),
		providerBindings: bindings(spec.legacy, `p${index}-plan`),
	};
}

function catalogOf(plans: PlanSpec[], topups: CatalogTopupIntent[] = []): CatalogIntent {
	return { features, plans: plans.map(planIntent), topups, rateCards: [] };
}

/** The gate order as `normalizeCatalog` runs it today, and nothing else. */
function oracleOutcome(plans: PlanSpec[]): RecordedOutcome | "normalized" {
	// Phase 1: `plans.map` normalizes the base price, then each item price, plan by plan.
	for (const plan of plans) {
		if (plan.basePrice !== null) {
			const failure = priceGate(plan.basePrice, "base price");
			if (failure !== null) return failure;
		}
		for (const item of plan.items) {
			const spec = itemPriceSpec(item);
			if (spec === null) continue;
			const failure = priceGate(spec, `price for ${itemFeatureKeys[item.kind]}`);
			if (failure !== null) return failure;
		}
	}
	// Phase 2: the per-plan loop, where the trial and add-on gate is the last check.
	for (const [index, plan] of plans.entries()) {
		const planBindings = plan.legacy.length > 0 ? plan.legacy : (plan.basePrice?.providers ?? []);
		if (
			((plan.trialDays ?? 0) > 0 || plan.kind === "addon") &&
			planBindings.some((provider) => provider !== "stripe")
		) {
			return invalidRequest(
				`Plan plan_${index} trials and add-ons are currently supported only on Stripe web`,
			);
		}
	}
	return "normalized";
}

function priceGate(spec: PriceSpec, label: string): RecordedOutcome | null {
	if (spec.providers.length === 0) {
		return invalidRequest(`${label} requires at least one provider binding`);
	}
	if (spec.providers.some((provider) => provider !== "stripe")) {
		return invalidRequest(
			`${label} explicit price components are currently supported only on Stripe web`,
		);
	}
	return null;
}

const providerSetArbitrary = fc.uniqueArray(
	fc.constantFrom<GatedProvider>("apple", "google", "stripe"),
	{ maxLength: 3 },
);

const priceSpecArbitrary: fc.Arbitrary<PriceSpec> = fc.record({
	model: fc.constantFrom<"flat" | "graduated">("flat", "graduated"),
	providers: providerSetArbitrary,
});

const itemSpecArbitrary: fc.Arbitrary<ItemSpec> = fc.oneof(
	fc.constant<ItemSpec>({ kind: "access" }),
	priceSpecArbitrary.map<ItemSpec>((price) => ({ kind: "licensed", price })),
	fc
		.option(priceSpecArbitrary, { nil: null })
		.map<ItemSpec>((price) => ({ kind: "meter_limit", price })),
);

const planSpecArbitrary: fc.Arbitrary<PlanSpec> = fc.record({
	legacy: providerSetArbitrary,
	kind: fc.constantFrom<"base" | "addon">("base", "addon"),
	trialDays: fc.constantFrom<number | null>(null, 0, 7),
	basePrice: fc.option(priceSpecArbitrary, { nil: null }),
	items: fc.uniqueArray(itemSpecArbitrary, { maxLength: 3, selector: (item) => item.kind }),
});

describe("catalog provider gates", () => {
	it("matches the recorded gate order across a generated catalog corpus", async () => {
		const seen = new Set<string>();
		await fc.assert(
			fc.asyncProperty(
				fc.array(planSpecArbitrary, { minLength: 1, maxLength: 2 }),
				async (plans) => {
					const expected = oracleOutcome(plans);
					seen.add(expected === "normalized" ? "normalized" : expected.message);
					expect(await firstOutcome(catalogOf(plans))).toEqual(expected);
				},
			),
			{ seed: 42, numRuns: 500 },
		);
		// The corpus is worthless unless it reaches every branch of the recorded order.
		expect([...seen].sort()).toEqual([
			"Plan plan_0 trials and add-ons are currently supported only on Stripe web",
			"Plan plan_1 trials and add-ons are currently supported only on Stripe web",
			"base price explicit price components are currently supported only on Stripe web",
			"base price requires at least one provider binding",
			"normalized",
			"price for api_requests explicit price components are currently supported only on Stripe web",
			"price for api_requests requires at least one provider binding",
			"price for seats explicit price components are currently supported only on Stripe web",
			"price for seats requires at least one provider binding",
		]);
	});

	it("checks a plan binding's channel before the base price gate", async () => {
		const plan = planIntent(
			{
				legacy: [],
				kind: "base",
				trialDays: null,
				basePrice: { model: "flat", providers: ["apple"] },
				items: [],
			},
			0,
		);
		plan.providerBindings = [{ provider: "apple", channel: "web", productKey: "p0-plan-apple" }];
		expect(await firstOutcome({ features, plans: [plan], topups: [], rateCards: [] })).toEqual(
			invalidRequest("apple catalog bindings must use the ios channel"),
		);
	});

	it("checks a price binding's channel before the price gate", async () => {
		const plan = planIntent(
			{
				legacy: [],
				kind: "base",
				trialDays: null,
				basePrice: { model: "flat", providers: ["google"] },
				items: [],
			},
			0,
		);
		(plan.basePrice as CatalogPriceIntent).providerBindings = [
			{ provider: "google", channel: "web", productKey: "p0-base-google" },
		];
		expect(await firstOutcome({ features, plans: [plan], topups: [], rateCards: [] })).toEqual(
			invalidRequest("google catalog bindings must use the android channel"),
		);
	});

	it("rejects empty base-price bindings before it reaches the gate", async () => {
		const outcome = await firstOutcome(
			catalogOf([
				{
					legacy: [],
					kind: "base",
					trialDays: null,
					basePrice: { model: "flat", providers: [] },
					items: [{ kind: "licensed", price: { model: "flat", providers: ["apple"] } }],
				},
			]),
		);
		expect(outcome).toEqual(invalidRequest("base price requires at least one provider binding"));
	});

	it("rejects a non-Stripe price binding before it validates its tiers", async () => {
		const plan = planIntent(
			{
				legacy: [],
				kind: "base",
				trialDays: null,
				basePrice: { model: "graduated", providers: ["apple"] },
				items: [],
			},
			0,
		);
		(plan.basePrice as CatalogPriceIntent).tiers = [
			{ upToQuantity: null, unitAmountMinor: 100 },
			{ upToQuantity: "10", unitAmountMinor: 50 },
		];
		expect(await firstOutcome({ features, plans: [plan], topups: [], rateCards: [] })).toEqual(
			invalidRequest(
				"base price explicit price components are currently supported only on Stripe web",
			),
		);
	});

	it("reports a later plan's price gate before an earlier plan's trial gate", async () => {
		const outcome = await firstOutcome(
			catalogOf([
				{ legacy: ["apple"], kind: "base", trialDays: 7, basePrice: null, items: [] },
				{
					legacy: [],
					kind: "base",
					trialDays: null,
					basePrice: { model: "flat", providers: ["apple"] },
					items: [],
				},
			]),
		);
		expect(outcome).toEqual(
			invalidRequest(
				"base price explicit price components are currently supported only on Stripe web",
			),
		);
	});

	it("reports an invalid plan version before the trial gate", async () => {
		const plan = planIntent(
			{ legacy: ["apple"], kind: "base", trialDays: 7, basePrice: null, items: [] },
			0,
		);
		plan.version = 0;
		expect(await firstOutcome({ features, plans: [plan], topups: [], rateCards: [] })).toEqual(
			invalidRequest("Plan plan_0 version must be a positive integer"),
		);
	});

	it("reports an access item's price gate before the access item rejects its price", async () => {
		const plan = planIntent(
			{ legacy: [], kind: "base", trialDays: null, basePrice: null, items: [{ kind: "access" }] },
			0,
		);
		const item = plan.items[0];
		if (item === undefined) throw new Error("Expected one generated plan item");
		item.price = priceIntent({ model: "flat", providers: ["apple"] }, "p0-i0");
		expect(await firstOutcome({ features, plans: [plan], topups: [], rateCards: [] })).toEqual(
			invalidRequest(
				"price for docs_access explicit price components are currently supported only on Stripe web",
			),
		);
	});

	it("reports the trial gate before it normalizes an invalid top-up", async () => {
		const outcome = await firstOutcome(
			catalogOf(
				[{ legacy: ["apple"], kind: "base", trialDays: 7, basePrice: null, items: [] }],
				[
					{
						key: "pack",
						featureKey: "docs_access",
						quantity: "1",
						expiresAfterSeconds: null,
						providerBindings: [{ provider: "apple", channel: "web", productKey: "pack-apple" }],
					},
				],
			),
		);
		expect(outcome).toEqual(
			invalidRequest("Plan plan_0 trials and add-ons are currently supported only on Stripe web"),
		);
	});

	it("normalizes a plain Apple or Google plan", async () => {
		for (const provider of ["apple", "google"] as const) {
			expect(
				await firstOutcome(
					catalogOf([
						{ legacy: [provider], kind: "base", trialDays: null, basePrice: null, items: [] },
					]),
				),
			).toBe("normalized");
		}
	});

	it("normalizes an add-on that declares no provider binding at all", async () => {
		const outcome = await firstOutcome(
			catalogOf([{ legacy: [], kind: "addon", trialDays: 7, basePrice: null, items: [] }]),
		);
		expect(outcome).toBe("normalized");
	});

	it("falls back to the base price's bindings when a trial plan declares none", async () => {
		const stripeBase = await firstOutcome(
			catalogOf([
				{
					legacy: [],
					kind: "addon",
					trialDays: 7,
					basePrice: { model: "flat", providers: ["stripe"] },
					items: [],
				},
			]),
		);
		expect(stripeBase).toBe("normalized");
		const appleLegacy = await firstOutcome(
			catalogOf([
				{
					legacy: ["apple"],
					kind: "addon",
					trialDays: 7,
					basePrice: { model: "flat", providers: ["stripe"] },
					items: [],
				},
			]),
		);
		expect(appleLegacy).toEqual(
			invalidRequest("Plan plan_0 trials and add-ons are currently supported only on Stripe web"),
		);
	});

	it("normalizes a Stripe add-on with a trial, a priced seat item and a tiered base price", async () => {
		const outcome = await firstOutcome(
			catalogOf([
				{
					legacy: ["stripe"],
					kind: "addon",
					trialDays: 7,
					basePrice: { model: "graduated", providers: ["stripe"] },
					items: [
						{ kind: "licensed", price: { model: "flat", providers: ["stripe"] } },
						{ kind: "meter_limit", price: null },
					],
				},
			]),
		);
		expect(outcome).toBe("normalized");
	});
});
