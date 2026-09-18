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
import type { CatalogProviderCompatibility } from "../../src/providers/catalog-compatibility-types";

/**
 * Pins the order in which catalog validation rejects an intent: every structural check of
 * `normalizeCatalog` in its own order first, then one capability assert that reports every binding
 * its provider's declaration cannot build. The oracle encodes what the declarations say today:
 * Stripe builds every catalog construct, while Apple and Google build top-ups but no trial, add-on
 * or explicit price component, each blocked at the provider layer.
 */

type GatedProvider = "apple" | "google" | "stripe";

const declaredChannel: Record<GatedProvider, BillingChannel> = {
	apple: "ios",
	google: "android",
	stripe: "web",
};

/** Contract order of the catalog construct operations the assert can report. */
const constructOperationOrder = [
	"catalog.trial",
	"catalog.addon",
	"catalog.topup",
	"catalog.price.flat",
	"catalog.price.licensed",
	"catalog.price.tiered",
	"catalog.price.hybrid",
	"catalog.price.postpaid_usage",
];

interface RecordedEntry {
	target: { kind: string; key: string; priceKey?: string | null };
	provider: string;
	channel: string;
	productKey: string | null;
	requiredOperations: string[];
	compatible: boolean;
	blocked: Array<{ operation: string; blockingLayer: string | null }>;
}

interface RecordedOutcome {
	name: string;
	code: string;
	status: number;
	classification: string;
	exposeMessage: boolean;
	message: string;
	providerCompatibility: RecordedEntry[] | null;
}

class NormalizationSentinel extends Error {}

/** Thrown in place of opening a transaction: reaching it means validation accepted the intent. */
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
				providerCompatibility: recordedCompatibility(error),
			};
		}
		throw error;
	}
	throw new Error("Catalog preview resolved without reaching its transaction");
}

function recordedCompatibility(error: BillingError): RecordedEntry[] | null {
	if (!Object.hasOwn(error, "details")) return null;
	const entries = (error.details as { providerCompatibility?: CatalogProviderCompatibility[] })
		.providerCompatibility;
	if (entries === undefined) throw new Error(`Unexpected details on ${error.name}`);
	return entries.map((entry) => ({
		target: entry.target,
		provider: entry.provider,
		channel: entry.channel,
		productKey: entry.productKey,
		requiredOperations: entry.requiredOperations,
		compatible: entry.compatible,
		blocked: entry.verdicts.map(({ operation, blockingLayer }) => ({ operation, blockingLayer })),
	}));
}

function invalidRequest(message: string): RecordedOutcome {
	return {
		name: "InvalidRequestError",
		code: "INVALID_REQUEST",
		status: 400,
		classification: "invalid_request",
		exposeMessage: true,
		message,
		providerCompatibility: null,
	};
}

function capabilityRejection(entries: RecordedEntry[]): RecordedOutcome {
	const [first] = entries;
	if (first === undefined) throw new Error("A capability rejection needs an entry");
	const operations = first.blocked.map(({ operation }) => operation);
	const listed =
		operations.length === 1
			? operations[0]
			: `${operations.slice(0, -1).join(", ")} and ${operations.at(-1)}`;
	const label =
		first.target.kind === "plan"
			? `Plan ${first.target.key}`
			: `Plan ${first.target.key} price ${first.target.priceKey}`;
	const more = entries.length > 1 ? ` (and ${entries.length - 1} more)` : "";
	return {
		name: "CapabilityError",
		code: "PROVIDER_CAPABILITY_UNSUPPORTED",
		status: 400,
		classification: "invalid_request",
		exposeMessage: true,
		message: `${label} cannot bind ${first.provider}: ${listed} ${
			operations.length === 1 ? "is" : "are"
		} not supported${more}`,
		providerCompatibility: entries,
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

interface TopupSpec {
	featureKey: "api_requests" | "docs_access";
	providers: GatedProvider[];
}

function topupIntent(spec: TopupSpec): CatalogTopupIntent {
	return {
		key: "pack",
		featureKey: spec.featureKey,
		quantity: "10",
		expiresAfterSeconds: null,
		providerBindings: bindings(spec.providers, "pack"),
	};
}

function catalogOf(plans: PlanSpec[], topups: CatalogTopupIntent[] = []): CatalogIntent {
	return { features, plans: plans.map(planIntent), topups, rateCards: [] };
}

/** Normalization sorts bindings by `provider:channel:productKey`, so by provider here. */
function sortedProviders(providers: readonly GatedProvider[]): GatedProvider[] {
	return [...providers].sort();
}

function inContractOrder(operations: string[]): string[] {
	return constructOperationOrder.filter((operation) => operations.includes(operation));
}

function priceOperations(plan: PlanSpec, spec: PriceSpec, item: ItemSpec | null): string[] {
	const operations = [spec.model === "flat" ? "catalog.price.flat" : "catalog.price.tiered"];
	if (item !== null) {
		operations.push(
			item.kind === "licensed" ? "catalog.price.licensed" : "catalog.price.postpaid_usage",
		);
	}
	const pricedItem = plan.items.some((candidate) => itemPriceSpec(candidate) !== null);
	if (plan.basePrice !== null && pricedItem) operations.push("catalog.price.hybrid");
	return inContractOrder(operations);
}

/** The entries a non-Stripe binding produces: it needs every operation and builds none. */
function blockedEntries(
	target: RecordedEntry["target"],
	providers: readonly GatedProvider[],
	slot: string,
	requiredOperations: string[],
): RecordedEntry[] {
	return sortedProviders(providers)
		.filter((provider) => provider !== "stripe")
		.map((provider) => ({
			target,
			provider,
			channel: declaredChannel[provider],
			productKey: `${slot}-${provider}`,
			requiredOperations,
			compatible: false,
			blocked: requiredOperations.map((operation) => ({ operation, blockingLayer: "provider" })),
		}));
}

/** The rejection order of catalog validation, and nothing else. */
function oracleOutcome(plans: PlanSpec[], topup: TopupSpec | null): RecordedOutcome | "normalized" {
	// Structural, phase 1: `plans.map` normalizes the base price, then each item price, per plan.
	for (const plan of plans) {
		if (plan.basePrice !== null && plan.basePrice.providers.length === 0) {
			return invalidRequest("base price requires at least one provider binding");
		}
		for (const item of plan.items) {
			const spec = itemPriceSpec(item);
			if (spec !== null && spec.providers.length === 0) {
				return invalidRequest(
					`price for ${itemFeatureKeys[item.kind]} requires at least one provider binding`,
				);
			}
		}
	}
	// Structural, phase 2: every generated plan passes the per-plan checks, so top-ups come next.
	if (topup !== null && topup.featureKey !== "api_requests") {
		return invalidRequest("Top-up pack must grant a consumable metered feature");
	}
	// Structural, phase 3: a top-up's wallet cannot also be a meter limit's usage window.
	const meterLimited = plans.some((plan) => plan.items.some((item) => item.kind === "meter_limit"));
	if (topup !== null && meterLimited) {
		return invalidRequest(
			"Feature api_requests cannot use both a usage window and an allocation stack",
		);
	}
	// The capability assert: every incompatible binding, plan by plan, then top-ups (all built).
	const entries: RecordedEntry[] = [];
	for (const [index, plan] of plans.entries()) {
		const key = `plan_${index}`;
		if ((plan.trialDays ?? 0) > 0 || plan.kind === "addon") {
			const fallback = plan.legacy.length === 0;
			const operations = inContractOrder([
				...((plan.trialDays ?? 0) > 0 ? ["catalog.trial"] : []),
				...(plan.kind === "addon" ? ["catalog.addon"] : []),
			]);
			entries.push(
				...blockedEntries(
					{ kind: "plan", key },
					fallback ? (plan.basePrice?.providers ?? []) : plan.legacy,
					fallback ? `p${index}-base` : `p${index}-plan`,
					operations,
				),
			);
		}
		if (plan.basePrice !== null) {
			entries.push(
				...blockedEntries(
					{ kind: "price", key, priceKey: `price-p${index}-base` },
					plan.basePrice.providers,
					`p${index}-base`,
					priceOperations(plan, plan.basePrice, null),
				),
			);
		}
		for (const [itemIndex, item] of plan.items.entries()) {
			const spec = itemPriceSpec(item);
			if (spec === null) continue;
			entries.push(
				...blockedEntries(
					{ kind: "price", key, priceKey: `price-p${index}-i${itemIndex}` },
					spec.providers,
					`p${index}-i${itemIndex}`,
					priceOperations(plan, spec, item),
				),
			);
		}
	}
	return entries.length === 0 ? "normalized" : capabilityRejection(entries);
}

function planProviders(plan: PlanSpec): GatedProvider[] {
	return [
		...plan.legacy,
		...(plan.basePrice?.providers ?? []),
		...plan.items.flatMap((item) => itemPriceSpec(item)?.providers ?? []),
	];
}

/** The branches an outcome reaches; the corpus must reach all of them. */
function branches(plans: PlanSpec[], outcome: RecordedOutcome | "normalized"): string[] {
	if (outcome === "normalized") return ["normalized"];
	const entries = outcome.providerCompatibility;
	if (entries === null) return [outcome.message];
	const [first] = entries;
	if (first === undefined) throw new Error("A capability rejection needs an entry");
	const reached = [
		first.target.kind === "plan"
			? "capability: plan first"
			: first.target.priceKey?.endsWith("-base")
				? "capability: base price first"
				: "capability: item price first",
		entries.length === 1 ? "capability: one binding" : "capability: several bindings",
	];
	if (new Set(entries.map(({ target }) => target.key)).size > 1) {
		reached.push("capability: across plans");
	}
	if (first.blocked.length > 1) reached.push("capability: several operations");
	if (
		entries.some(
			({ target, productKey }) => target.kind === "plan" && productKey?.includes("-base-"),
		)
	) {
		reached.push("capability: plan through base-price bindings");
	}
	if (plans.some((plan) => planProviders(plan).includes("stripe"))) {
		reached.push("capability: next to a Stripe binding");
	}
	return reached;
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

const topupSpecArbitrary: fc.Arbitrary<TopupSpec | null> = fc.oneof(
	{ weight: 3, arbitrary: fc.constant(null) },
	{
		weight: 1,
		arbitrary: fc.record({
			featureKey: fc.constantFrom<TopupSpec["featureKey"]>("api_requests", "docs_access"),
			providers: providerSetArbitrary,
		}),
	},
);

describe("catalog validation order", () => {
	it("matches the recorded rejection order across a generated catalog corpus", async () => {
		const seen = new Set<string>();
		await fc.assert(
			fc.asyncProperty(
				fc.array(planSpecArbitrary, { minLength: 1, maxLength: 2 }),
				topupSpecArbitrary,
				async (plans, topup) => {
					const expected = oracleOutcome(plans, topup);
					for (const branch of branches(plans, expected)) seen.add(branch);
					const topups = topup === null ? [] : [topupIntent(topup)];
					expect(await firstOutcome(catalogOf(plans, topups))).toEqual(expected);
				},
			),
			{ seed: 42, numRuns: 500 },
		);
		// The corpus is worthless unless it reaches every branch of the recorded order.
		expect([...seen].sort()).toEqual([
			"Feature api_requests cannot use both a usage window and an allocation stack",
			"Top-up pack must grant a consumable metered feature",
			"base price requires at least one provider binding",
			"capability: across plans",
			"capability: base price first",
			"capability: item price first",
			"capability: next to a Stripe binding",
			"capability: one binding",
			"capability: plan first",
			"capability: plan through base-price bindings",
			"capability: several bindings",
			"capability: several operations",
			"normalized",
			"price for api_requests requires at least one provider binding",
			"price for seats requires at least one provider binding",
		]);
	});

	it("checks a plan binding's channel before the capability assert", async () => {
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

	it("checks a price binding's channel before the capability assert", async () => {
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

	it("rejects empty base-price bindings before the capability assert", async () => {
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

	it("validates a non-Stripe price's tiers before the capability assert", async () => {
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
			invalidRequest("base price only the final tier can be unbounded"),
		);
	});

	it("reports every plan's capability problems in one rejection, in catalog order", async () => {
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
			capabilityRejection([
				{
					target: { kind: "plan", key: "plan_0" },
					provider: "apple",
					channel: "ios",
					productKey: "p0-plan-apple",
					requiredOperations: ["catalog.trial"],
					compatible: false,
					blocked: [{ operation: "catalog.trial", blockingLayer: "provider" }],
				},
				{
					target: { kind: "price", key: "plan_1", priceKey: "price-p1-base" },
					provider: "apple",
					channel: "ios",
					productKey: "p1-base-apple",
					requiredOperations: ["catalog.price.flat"],
					compatible: false,
					blocked: [{ operation: "catalog.price.flat", blockingLayer: "provider" }],
				},
			]),
		);
		expect((outcome as RecordedOutcome).message).toBe(
			"Plan plan_0 cannot bind apple: catalog.trial is not supported (and 1 more)",
		);
	});

	it("reports an invalid plan version before the capability assert", async () => {
		const plan = planIntent(
			{ legacy: ["apple"], kind: "base", trialDays: 7, basePrice: null, items: [] },
			0,
		);
		plan.version = 0;
		expect(await firstOutcome({ features, plans: [plan], topups: [], rateCards: [] })).toEqual(
			invalidRequest("Plan plan_0 version must be a positive integer"),
		);
	});

	it("rejects an access item's price before the capability assert", async () => {
		const plan = planIntent(
			{ legacy: [], kind: "base", trialDays: null, basePrice: null, items: [{ kind: "access" }] },
			0,
		);
		const item = plan.items[0];
		if (item === undefined) throw new Error("Expected one generated plan item");
		item.price = priceIntent({ model: "flat", providers: ["apple"] }, "p0-i0");
		expect(await firstOutcome({ features, plans: [plan], topups: [], rateCards: [] })).toEqual(
			invalidRequest("Access item docs_access cannot declare a price"),
		);
	});

	it("rejects an invalid top-up before the capability assert", async () => {
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
		expect(outcome).toEqual(invalidRequest("Top-up pack must grant a consumable metered feature"));
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
			capabilityRejection([
				{
					target: { kind: "plan", key: "plan_0" },
					provider: "apple",
					channel: "ios",
					productKey: "p0-plan-apple",
					requiredOperations: ["catalog.trial", "catalog.addon"],
					compatible: false,
					blocked: [
						{ operation: "catalog.trial", blockingLayer: "provider" },
						{ operation: "catalog.addon", blockingLayer: "provider" },
					],
				},
			]),
		);
		expect((appleLegacy as RecordedOutcome).message).toBe(
			"Plan plan_0 cannot bind apple: catalog.trial and catalog.addon are not supported",
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

	it("normalizes Apple, Google and Stripe top-up bindings", async () => {
		const outcome = await firstOutcome(
			catalogOf(
				[{ legacy: ["apple"], kind: "base", trialDays: null, basePrice: null, items: [] }],
				[topupIntent({ featureKey: "api_requests", providers: ["apple", "google", "stripe"] })],
			),
		);
		expect(outcome).toBe("normalized");
	});
});
