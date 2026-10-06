import { describe, expect, it } from "bun:test";
import { postV1AdminCatalogPreviewResponse200Schema } from "../../src/app/contracts/catalog-responses";
import { CapabilityError, InvalidRequestError } from "../../src/billing/errors";
import { CatalogControlPlane } from "../../src/catalog/control-plane";
import type {
	CatalogControlIntent,
	CatalogFeatureIntent,
	CatalogIntent,
	CatalogPlanIntent,
	CatalogPlanItemIntent,
	CatalogPriceIntent,
	CatalogProviderBindingIntent,
	CatalogTopupIntent,
} from "../../src/catalog/types";
import type { QueryExecutor } from "../../src/db/repository/types";
import {
	type ProviderCapabilityLookup,
	providerCapabilityCatalog,
	providerCapabilityDeclaration,
} from "../../src/providers/capabilities";
import type { CatalogProviderCompatibility } from "../../src/providers/catalog-compatibility-types";
import type { CadenceUnit } from "../../src/shared/cadence";
import type {
	DeclaredProvider,
	OperationSupport,
	ProviderOperation,
} from "../../src/shared/provider-capabilities";
import { renderDrizzleSql } from "../helpers/drizzle-sql";
import { projectInstanceContext } from "../helpers/project-context";

const feature: CatalogFeatureIntent = {
	key: "credits",
	name: "Credits",
	kind: "metered",
	meterKind: "consumable",
	unit: "credit",
	creditScale: 0,
	filterDimensions: [],
};

/** Normalization runs before the control plane touches its database. */
async function previewError(catalog: Partial<CatalogIntent>): Promise<unknown> {
	const controlPlane = new CatalogControlPlane({} as never);
	try {
		await controlPlane.preview({} as never, {
			expectedRevision: null,
			actor: "test",
			catalog: { features: [feature], plans: [], topups: [], rateCards: [], ...catalog },
		});
	} catch (error) {
		return error;
	}
	throw new Error("Catalog preview unexpectedly passed normalization");
}

function planWith(binding: CatalogProviderBindingIntent): Partial<CatalogIntent> {
	return { plans: [{ providerBindings: [binding], items: [] } as never] };
}

class NormalizationSentinel extends Error {}

/** Thrown in place of opening a transaction: reaching it means normalization accepted the intent. */
const passedNormalization = new NormalizationSentinel("normalization passed");
const sentinelDatabase = {
	transaction(): never {
		throw passedNormalization;
	},
} as never;

/** Runs the same validation against a catalog of declarations the test controls. */
async function previewWith(
	capabilities: ProviderCapabilityLookup,
	plans: CatalogPlanIntent[],
): Promise<InvalidRequestError | CapabilityError | "normalized"> {
	const controlPlane = new CatalogControlPlane(sentinelDatabase, { capabilities });
	try {
		await controlPlane.preview({} as never, {
			expectedRevision: null,
			actor: "test",
			catalog: { features: [feature], plans, topups: [], rateCards: [] },
		});
	} catch (error) {
		if (error === passedNormalization) return "normalized";
		if (error instanceof InvalidRequestError || error instanceof CapabilityError) return error;
		throw error;
	}
	throw new Error("Catalog preview resolved without reaching its transaction");
}

/** The declared catalog with one provider's support for one operation replaced. */
function catalogDeclaring(
	provider: DeclaredProvider,
	operation: ProviderOperation,
	support: OperationSupport,
): ProviderCapabilityLookup {
	const declaration = providerCapabilityDeclaration(provider);
	return new Map(providerCapabilityCatalog).set(provider, {
		...declaration,
		operations: { ...declaration.operations, [operation]: support },
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

function flatPrice(bindings: CatalogProviderBindingIntent[]): CatalogPriceIntent {
	return {
		key: "pro-base",
		currency: "USD",
		unitAmountMinor: 1000,
		billingUnits: "1",
		billingInterval: "month",
		minimumQuantity: 1,
		maximumQuantity: null,
		taxBehavior: "exclusive",
		pricingModel: "flat",
		tiers: [],
		providerBindings: bindings,
	};
}

function plan(overrides: Partial<CatalogPlanIntent>): CatalogPlanIntent {
	return {
		key: "pro",
		name: "Pro",
		version: 1,
		currency: "USD",
		baseAmountMinor: null,
		billingInterval: "month",
		trialDays: null,
		kind: "base",
		basePrice: null,
		items: [],
		providerBindings: [],
		...overrides,
	};
}

const appleBinding: CatalogProviderBindingIntent = {
	provider: "apple",
	channel: "ios",
	productKey: "pro",
};
const stripeBinding: CatalogProviderBindingIntent = {
	provider: "stripe",
	channel: "web",
	productKey: "pro",
};

describe("catalog control plane provider bindings", () => {
	it("rejects a binding outside its provider's declared channel with the same message", async () => {
		const cases = [
			["apple", "web", "apple catalog bindings must use the ios channel"],
			["google", "ios", "google catalog bindings must use the android channel"],
			["stripe", "android", "stripe catalog bindings must use the web channel"],
		] as const;
		for (const [provider, channel, message] of cases) {
			const error = await previewError(planWith({ provider, channel, productKey: "pro" }));
			expect(error).toBeInstanceOf(InvalidRequestError);
			expect((error as InvalidRequestError).code).toBe("INVALID_REQUEST");
			expect((error as InvalidRequestError).message).toBe(message);
		}
	});

	it("accepts each admitted provider's declared channel", async () => {
		for (const [provider, channel] of [
			["apple", "ios"],
			["google", "android"],
			["stripe", "web"],
		] as const) {
			const error = await previewError(planWith({ provider, channel, productKey: "pro" }));
			expect((error as Error).message).not.toContain("catalog bindings must use");
		}
	});

	it("never admits an unknown provider through a valid channel", async () => {
		const error = await previewError(
			planWith({ provider: "adyen" as never, channel: "web", productKey: "pro" }),
		);
		expect(error).toBeInstanceOf(InvalidRequestError);
		expect((error as InvalidRequestError).message).toBe(
			"adyen catalog bindings must use the undefined channel",
		);
	});

	it("checks top-up bindings the same way", async () => {
		const error = await previewError({
			topups: [
				{
					key: "pack",
					featureKey: "credits",
					quantity: "10",
					expiresAfterSeconds: null,
					providerBindings: [{ provider: "google", channel: "web", productKey: "pack" }],
				},
			],
		});
		expect((error as InvalidRequestError).message).toBe(
			"google catalog bindings must use the android channel",
		);
	});
});

/** The wire-visible parts of a capability rejection, with the entries reduced to what they name. */
function capabilityRejection(error: unknown) {
	expect(error).toBeInstanceOf(CapabilityError);
	const rejection = error as CapabilityError;
	return {
		code: rejection.code,
		status: rejection.status,
		classification: rejection.classification,
		message: rejection.message,
		entries:
			"providerCompatibility" in rejection.details
				? rejection.details.providerCompatibility.map((entry) => ({
						target: entry.target,
						provider: entry.provider,
						blocked: entry.verdicts.map(({ operation, blockingLayer }) => ({
							operation,
							blockingLayer,
						})),
					}))
				: null,
	};
}

describe("catalog control plane capability injection", () => {
	it("accepts an Apple trial plan once the Apple declaration implements catalog.trial", async () => {
		const trialPlan = plan({ trialDays: 7, providerBindings: [appleBinding] });
		const declared = await previewWith(providerCapabilityCatalog, [trialPlan]);
		expect(capabilityRejection(declared)).toEqual({
			code: "PROVIDER_CAPABILITY_UNSUPPORTED",
			status: 400,
			classification: "invalid_request",
			message: "Plan pro cannot bind apple: catalog.trial is not supported",
			entries: [
				{
					target: { kind: "plan", key: "pro" },
					provider: "apple",
					blocked: [{ operation: "catalog.trial", blockingLayer: "provider" }],
				},
			],
		});
		const injected = catalogDeclaring("apple", "catalog.trial", nativelyVerified);
		expect(await previewWith(injected, [trialPlan])).toBe("normalized");
	});

	it("rejects a Stripe add-on once Stripe drops catalog.addon", async () => {
		const addonPlan = plan({ kind: "addon", providerBindings: [stripeBinding] });
		expect(await previewWith(providerCapabilityCatalog, [addonPlan])).toBe("normalized");
		const injected = catalogDeclaring("stripe", "catalog.addon", unsupported);
		expect(capabilityRejection(await previewWith(injected, [addonPlan]))).toEqual({
			code: "PROVIDER_CAPABILITY_UNSUPPORTED",
			status: 400,
			classification: "invalid_request",
			message: "Plan pro cannot bind stripe: catalog.addon is not supported",
			entries: [
				{
					target: { kind: "plan", key: "pro" },
					provider: "stripe",
					blocked: [{ operation: "catalog.addon", blockingLayer: "provider" }],
				},
			],
		});
	});

	it("accepts an Apple base price once the Apple declaration implements catalog.price.flat", async () => {
		const pricedPlan = plan({ basePrice: flatPrice([appleBinding]) });
		const declared = await previewWith(providerCapabilityCatalog, [pricedPlan]);
		expect(capabilityRejection(declared)).toEqual({
			code: "PROVIDER_CAPABILITY_UNSUPPORTED",
			status: 400,
			classification: "invalid_request",
			message: "Plan pro price pro-base cannot bind apple: catalog.price.flat is not supported",
			entries: [
				{
					target: { kind: "price", key: "pro", priceKey: "pro-base" },
					provider: "apple",
					blocked: [{ operation: "catalog.price.flat", blockingLayer: "provider" }],
				},
			],
		});
		const injected = catalogDeclaring("apple", "catalog.price.flat", nativelyVerified);
		expect(await previewWith(injected, [pricedPlan])).toBe("normalized");
	});

	it("rejects a Stripe base price once Stripe drops the pricing model it declares", async () => {
		const pricedPlan = plan({ basePrice: flatPrice([stripeBinding]) });
		expect(await previewWith(providerCapabilityCatalog, [pricedPlan])).toBe("normalized");
		const injected = catalogDeclaring("stripe", "catalog.price.flat", unsupported);
		expect(capabilityRejection(await previewWith(injected, [pricedPlan]))).toEqual({
			code: "PROVIDER_CAPABILITY_UNSUPPORTED",
			status: 400,
			classification: "invalid_request",
			message: "Plan pro price pro-base cannot bind stripe: catalog.price.flat is not supported",
			entries: [
				{
					target: { kind: "price", key: "pro", priceKey: "pro-base" },
					provider: "stripe",
					blocked: [{ operation: "catalog.price.flat", blockingLayer: "provider" }],
				},
			],
		});
	});

	it("reads the expected binding channel from the injected declaration", async () => {
		const injected = new Map(providerCapabilityCatalog).set("apple", {
			...providerCapabilityDeclaration("apple"),
			channel: "web",
		});
		const error = await previewWith(injected, [plan({ providerBindings: [appleBinding] })]);
		expect((error as InvalidRequestError).message).toBe(
			"apple catalog bindings must use the web channel",
		);
	});
});

/** Answers a preview for an environment that has never published a catalog. */
class EmptyCatalogDatabase {
	async execute<T>(query: unknown): Promise<T[]> {
		return this.answer(renderDrizzleSql(query)) as T[];
	}

	async transaction<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T> {
		return await callback(this);
	}

	private answer(text: string): Record<string, unknown>[] {
		if (text.includes("FROM projects WHERE id") && text.includes("FOR UPDATE")) {
			return [{ id: projectInstanceContext().projectInstanceId }];
		}
		if (text.includes("SELECT key, kind, meter_kind")) return [];
		if (text.includes("FROM plan_versions version")) return [];
		if (text.includes("SELECT p.id, cr.id AS revision_id")) {
			return [
				{ id: projectInstanceContext().projectInstanceId, revision_id: null, revision: null },
			];
		}
		if (text.includes("SELECT draft.intent")) return [];
		if (text.includes("SELECT key, active FROM features")) return [];
		if (text.includes("SELECT key, active FROM plans")) return [];
		if (text.includes("SELECT DISTINCT key FROM topup_options")) return [];
		if (text.includes("FROM subscriptions")) return [{ count: "0" }];
		if (text.includes("INSERT INTO catalog_drafts")) return [{ id: "1" }];
		// A monthly store product behind every binding, as the plans below are billed.
		if (text.includes("FROM store_products sp")) {
			return [{ id: "1", billing_period: "month", billing_period_count: 1 }];
		}
		throw new Error(`Unscripted query: ${text}`);
	}
}

const googleBinding: CatalogProviderBindingIntent = {
	provider: "google",
	channel: "android",
	productKey: "pack",
};

function pack(bindings: CatalogProviderBindingIntent[]): CatalogTopupIntent {
	return {
		key: "pack",
		featureKey: "credits",
		quantity: "10",
		expiresAfterSeconds: null,
		providerBindings: bindings,
	};
}

async function preview(plans: CatalogPlanIntent[], topups: CatalogTopupIntent[]) {
	return await new CatalogControlPlane(new EmptyCatalogDatabase()).preview(
		projectInstanceContext(),
		{
			expectedRevision: null,
			actor: "test",
			catalog: { features: [feature], plans, topups, rateCards: [] },
		},
	);
}

/** Each entry with its verdicts reduced to the operation and its reason codes. */
function summarized(entries: CatalogProviderCompatibility[]) {
	return entries.map(({ target, provider, channel, productKey, compatible, verdicts }) => ({
		target,
		provider,
		channel,
		productKey,
		compatible,
		blocked: verdicts.map(({ operation, reasons }) => [operation, reasons.map(({ code }) => code)]),
	}));
}

type SummarizedEntry = ReturnType<typeof summarized>[number];

describe("catalog control plane integer and price key bounds", () => {
	const price = (key: string, overrides: Partial<CatalogPriceIntent> = {}): CatalogPriceIntent => ({
		key,
		currency: "USD",
		unitAmountMinor: 1000,
		billingUnits: "1",
		billingInterval: "month",
		minimumQuantity: 1,
		maximumQuantity: null,
		taxBehavior: "exclusive",
		pricingModel: "flat",
		tiers: [],
		providerBindings: [stripeBinding],
		...overrides,
	});
	const tooLarge = 2 ** 31;

	it("refuses an integer that no Postgres column holds before touching the database", async () => {
		const cases: Array<[Partial<CatalogPlanIntent>, string]> = [
			[{ version: tooLarge }, `Plan pro version cannot exceed ${2 ** 31 - 1}`],
			[
				{ tierRank: tooLarge },
				`Plan pro tierRank must be a whole number from ${-(2 ** 31)} to ${2 ** 31 - 1}`,
			],
			[
				{ tierRank: -tooLarge - 1 },
				`Plan pro tierRank must be a whole number from ${-(2 ** 31)} to ${2 ** 31 - 1}`,
			],
			[
				{ basePrice: price("pro", { minimumQuantity: tooLarge }) },
				`base price quantities cannot exceed ${2 ** 31 - 1}`,
			],
			[
				{ basePrice: price("pro", { maximumQuantity: tooLarge }) },
				`base price quantities cannot exceed ${2 ** 31 - 1}`,
			],
		];
		for (const [overrides, message] of cases) {
			const refused = await previewError({
				plans: [plan({ providerBindings: [stripeBinding], ...overrides })],
			});
			expect((refused as InvalidRequestError).message).toBe(message);
		}
	});

	it("names a price key a plan uses twice", async () => {
		const seats: CatalogFeatureIntent = {
			...feature,
			key: "seats",
			meterKind: "non_consumable",
		};
		const refused = await previewError({
			features: [feature, seats],
			plans: [
				plan({
					basePrice: price("pro"),
					providerBindings: [stripeBinding],
					items: [
						{
							featureKey: "seats",
							itemKind: "licensed_quantity",
							quantity: "5",
							resetInterval: null,
							expiresAfterSeconds: null,
							overagePolicy: "blocked",
							allocationScope: "license_pool",
							price: price("pro", { providerBindings: [appleBinding] }),
						},
					],
				}),
			],
		});
		expect((refused as InvalidRequestError).message).toBe(
			"Plan pro uses price key pro more than once",
		);
	});
});

describe("catalog control plane preview binding cadence", () => {
	it("refuses a plan whose binding sells another cadence than the plan bills", async () => {
		// The database answers with a monthly store product behind every binding.
		await expect(
			preview([plan({ billingInterval: "year", providerBindings: [stripeBinding] })], []),
		).rejects.toMatchObject({
			code: "PROVIDER_BINDING_NOT_READY",
			status: 409,
			message: "Provider binding stripe/web/pro sells every month but plan pro bills every year",
		});
		const accepted = await preview(
			[plan({ billingInterval: "month", providerBindings: [stripeBinding] })],
			[],
		);
		expect(accepted.impact.planVersionsCreated).toBe(1);
	});
});

describe("catalog control plane preview provider compatibility", () => {
	const trialPlan = plan({ trialDays: 7, providerBindings: [stripeBinding] });
	const packBindings = [
		{ ...appleBinding, productKey: "pack" },
		googleBinding,
		{ ...stripeBinding, productKey: "pack" },
	];

	it("reports every bound entry as compatible, then the admitted providers left unbound", async () => {
		const result = await preview([trialPlan], [pack(packBindings)]);
		expect(summarized(result.providerCompatibility)).toEqual([
			{
				target: { kind: "plan", key: "pro" },
				provider: "stripe",
				channel: "web",
				productKey: "pro",
				compatible: true,
				blocked: [],
			},
			...(
				[
					["apple", "ios"],
					["google", "android"],
				] as const
			).map(
				([provider, channel]): SummarizedEntry => ({
					target: { kind: "plan", key: "pro" },
					provider,
					channel,
					productKey: null,
					compatible: false,
					blocked: [["catalog.trial", ["PROVIDER_MANAGED"]]],
				}),
			),
			{
				target: { kind: "plan", key: "pro" },
				provider: "paddle",
				channel: "web",
				productKey: null,
				compatible: false,
				blocked: [["catalog.trial", ["IMPLEMENTATION_PLANNED"]]],
			},
			...packBindings.map(
				({ provider, channel }): SummarizedEntry => ({
					target: { kind: "topup", key: "pack" },
					provider,
					channel,
					productKey: "pack",
					compatible: true,
					blocked: [],
				}),
			),
			{
				target: { kind: "topup", key: "pack" },
				provider: "paddle",
				channel: "web",
				productKey: null,
				compatible: false,
				blocked: [["catalog.topup", ["IMPLEMENTATION_PLANNED"]]],
			},
		]);
		expect(
			result.providerCompatibility
				.filter(({ productKey }) => productKey !== null)
				.every(({ compatible }) => compatible),
		).toBe(true);
		const parsed = postV1AdminCatalogPreviewResponse200Schema.parse({
			success: true,
			data: result,
		});
		expect(parsed.data.providerCompatibility).toEqual(result.providerCompatibility);
	});

	it("reports the same entries whatever order the intent lists its bindings in", async () => {
		const first = await preview([trialPlan], [pack(packBindings)]);
		const reversed = await preview([trialPlan], [pack([...packBindings].reverse())]);
		const again = await preview([trialPlan], [pack(packBindings)]);
		expect(reversed.providerCompatibility).toEqual(first.providerCompatibility);
		expect(again.providerCompatibility).toEqual(first.providerCompatibility);
	});

	it("adds no entries for a plain base plan", async () => {
		const result = await preview([plan({ providerBindings: [stripeBinding] })], []);
		expect(result.providerCompatibility).toEqual([]);
	});
});

function resettingItem(
	itemKind: "meter_limit" | "allocation",
	resetInterval: CadenceUnit,
): CatalogPlanItemIntent {
	return {
		featureKey: "credits",
		itemKind,
		quantity: "12000",
		resetInterval,
		expiresAfterSeconds: null,
		overagePolicy: "blocked",
		price: null,
	};
}

/** A plan billed every `billingInterval` whose one item resets every `resetInterval`. */
function resettingPlan(
	itemKind: "meter_limit" | "allocation",
	resetInterval: "month" | "year",
	billingInterval: "month" | "year" | null,
): CatalogPlanIntent {
	return plan({ billingInterval, items: [resettingItem(itemKind, resetInterval)] });
}

/** Answers the control plane from one stored intent and one previewed draft; records every write. */
class StoredCatalogDatabase {
	readonly writes: string[] = [];

	constructor(private readonly stored: CatalogIntent) {}

	async execute<T>(query: unknown): Promise<T[]> {
		return this.answer(renderDrizzleSql(query)) as T[];
	}

	async transaction<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T> {
		return await callback(this);
	}

	private answer(text: string): Record<string, unknown>[] {
		if (text.includes("FROM projects WHERE id") && text.includes("FOR UPDATE")) {
			return [{ id: projectInstanceContext().projectInstanceId }];
		}
		if (text.includes("SELECT key, kind, meter_kind")) {
			return this.stored.features.map((feature) => ({
				key: feature.key,
				kind: feature.kind,
				meter_kind: feature.meterKind,
				unit: feature.unit,
				credit_scale: feature.creditScale,
				filter_dimensions: feature.filterDimensions,
			}));
		}
		if (text.includes("FROM plan_versions version")) {
			return this.stored.plans.map(({ key, version }) => ({ key, version }));
		}
		if (text.includes("SELECT p.id, cr.id AS revision_id")) {
			return [{ id: projectInstanceContext().projectInstanceId, revision_id: "7", revision: 1 }];
		}
		if (text.includes("SELECT revision.intent_hash")) {
			return [
				{
					intent_hash: "a".repeat(64),
					published_at: "2026-09-01T00:00:00.000Z",
					intent: this.stored,
				},
			];
		}
		if (text.includes("SELECT draft.intent")) return [{ intent: this.stored }];
		if (text.includes("FROM catalog_drafts")) {
			return [
				{
					intent_hash: "b".repeat(64),
					intent: this.stored,
					base_revision: 1,
					next_revision: 2,
					status: "previewed",
					expires_at: "2999-01-01T00:00:00.000Z",
					published_revision_id: null,
				},
			];
		}
		if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(text)) {
			this.writes.push(text);
			return [{ id: "1" }];
		}
		if (text.includes("SELECT key, active FROM features")) {
			return this.stored.features.map(({ key }) => ({ key, active: true }));
		}
		if (text.includes("SELECT key, active FROM plans")) {
			return this.stored.plans.map(({ key }) => ({ key, active: true }));
		}
		if (text.includes("SELECT DISTINCT key FROM topup_options")) return [];
		if (text.includes("FROM subscriptions")) return [{ count: "0" }];
		// A monthly store product behind every binding, as the plans below are billed.
		if (text.includes("FROM store_products sp")) {
			return [{ id: "1", billing_period: "month", billing_period_count: 1 }];
		}
		throw new Error(`Unscripted query: ${text}`);
	}
}

describe("catalog control plane reset intervals", () => {
	it("rejects an item quantity or rollover cap finer than its feature's credit scale", async () => {
		// `credits` has creditScale 0: a 0.5 allowance would publish and then fail every read.
		for (const itemKind of ["meter_limit", "allocation"] as const) {
			const error = await previewWith(providerCapabilityCatalog, [
				plan({ items: [{ ...resettingItem(itemKind, "month"), quantity: "0.5" }] }),
			]);
			expect(error).toBeInstanceOf(InvalidRequestError);
			expect((error as InvalidRequestError).message).toBe(
				"Plan pro item credits quantity supports at most 0 decimal places",
			);
		}
		const rollover = await previewWith(providerCapabilityCatalog, [
			plan({
				items: [
					{
						...resettingItem("allocation", "month"),
						rollover: { maxQuantity: "1.5", expiry: { mode: "forever" } },
					},
				],
			}),
		]);
		expect(rollover).toBeInstanceOf(InvalidRequestError);
		expect((rollover as InvalidRequestError).message).toBe(
			"Plan pro item credits rollover maxQuantity supports at most 0 decimal places",
		);
		expect(
			await previewWith(providerCapabilityCatalog, [
				plan({ items: [{ ...resettingItem("allocation", "month"), quantity: "12000.000" }] }),
			]),
		).toBe("normalized");
	});

	it("rejects an item that resets less often than its plan bills", async () => {
		// Windows and grants reset with every provider period, so a yearly 12,000 on a monthly plan
		// would silently become 12,000 a month.
		for (const itemKind of ["meter_limit", "allocation"] as const) {
			const error = await previewWith(providerCapabilityCatalog, [
				resettingPlan(itemKind, "year", "month"),
			]);
			expect(error).toBeInstanceOf(InvalidRequestError);
			expect((error as InvalidRequestError).code).toBe("INVALID_REQUEST");
			expect((error as InvalidRequestError).message).toBe(
				"Plan pro item credits cannot reset every year on a plan billed every month",
			);
		}
	});

	it("accepts an item that resets as often as or more often than its plan bills", async () => {
		for (const itemKind of ["meter_limit", "allocation"] as const) {
			for (const [resetInterval, billingInterval] of [
				["month", "month"],
				["month", "year"],
				["year", "year"],
				["year", null],
			] as const) {
				expect(
					await previewWith(providerCapabilityCatalog, [
						resettingPlan(itemKind, resetInterval, billingInterval),
					]),
				).toBe("normalized");
			}
		}
	});

	it("keeps a catalog published before the rule readable and replaceable", async () => {
		const stored: CatalogIntent = {
			features: [feature],
			plans: [resettingPlan("meter_limit", "year", "month")],
			topups: [],
			rateCards: [],
		};
		const controlPlane = new CatalogControlPlane(new StoredCatalogDatabase(stored));
		const current = await controlPlane.getPublished(projectInstanceContext());
		expect(current.catalog?.plans[0]?.items[0]).toMatchObject({
			itemKind: "meter_limit",
			reset: { interval: "year", intervalCount: 1 },
		});
		const replacement = await controlPlane.preview(projectInstanceContext(), {
			expectedRevision: 1,
			actor: "test",
			catalog: {
				...stored,
				plans: [{ ...resettingPlan("meter_limit", "month", "month"), version: 2 }],
			},
		});
		expect(replacement.nextRevision).toBe(2);
	});

	it("rejects publishing a draft previewed before the rule, before writing anything", async () => {
		const stored: CatalogIntent = {
			features: [feature],
			plans: [resettingPlan("allocation", "year", "month")],
			topups: [],
			rateCards: [],
		};
		const database = new StoredCatalogDatabase(stored);
		const rejection = await new CatalogControlPlane(database)
			.publish(projectInstanceContext(), {
				expectedRevision: 1,
				actor: "test",
				previewToken: "c".repeat(64),
				catalog: stored,
			})
			.then(() => null)
			.catch((error: unknown) => error);
		expect(rejection).toBeInstanceOf(InvalidRequestError);
		expect((rejection as InvalidRequestError).message).toBe(
			"Plan pro item credits cannot reset every year on a plan billed every month",
		);
		expect(database.writes).toEqual([]);
	});
});

describe("catalog control plane cadences", () => {
	const item = (overrides: Partial<CatalogPlanItemIntent>): CatalogPlanItemIntent => ({
		...resettingItem("meter_limit", "month"),
		...overrides,
	});
	const messageOf = async (plans: CatalogPlanIntent[]) => {
		const result = await previewWith(providerCapabilityCatalog, plans);
		return result === "normalized" ? result : result.message;
	};

	it("accepts resets shorter than a month that fit the billing interval", async () => {
		for (const [resetInterval, resetIntervalCount, billingInterval] of [
			["day", 1, "month"],
			["day", 28, "month"],
			["week", 4, "month"],
			["quarter", 1, "year"],
			["month", 6, "year"],
			["week", 2, null],
		] as const) {
			expect(
				await messageOf([
					plan({ billingInterval, items: [item({ resetInterval, resetIntervalCount })] }),
				]),
			).toBe("normalized");
		}
	});

	it("rejects a reset that does not fit every billing period", async () => {
		expect(
			await messageOf([plan({ items: [item({ resetInterval: "day", resetIntervalCount: 29 })] })]),
		).toBe("Plan pro item credits cannot reset every 29 × day on a plan billed every month");
		expect(
			await messageOf([
				plan({
					billingInterval: null,
					items: [item({ resetInterval: "year", resetIntervalCount: 4 })],
				}),
			]),
		).toBe("Plan pro item credits reset cannot span more than 3 × year");
	});

	it("accepts hourly meter limits but not hourly allocations or rollover expiry", async () => {
		expect(
			await messageOf([plan({ items: [item({ resetInterval: "hour", resetIntervalCount: 5 })] })]),
		).toBe("normalized");
		expect(
			await messageOf([plan({ items: [item({ itemKind: "allocation", resetInterval: "hour" })] })]),
		).toBe(
			"Plan pro item credits reset cannot be hourly: allocations are granted by periodic maintenance",
		);
		expect(
			await messageOf([
				plan({
					items: [
						{
							...resettingItem("allocation", "day"),
							rollover: {
								maxQuantity: null,
								expiry: { mode: "after", interval: "hour", intervalCount: 12 },
							},
						},
					],
				}),
			]),
		).toBe(
			"Plan pro item credits rollover expiry cannot be hourly: allocations are granted by periodic maintenance",
		);
	});

	it("rejects counts that are out of range or have no interval", async () => {
		for (const resetIntervalCount of [0, 1.5, 1001]) {
			expect(
				await messageOf([plan({ items: [item({ resetInterval: "day", resetIntervalCount })] })]),
			).toBe("Plan pro item credits reset count must be a whole number from 1 to 1000");
		}
		expect(
			await messageOf([
				plan({
					items: [
						{ ...item({ itemKind: "allocation" }), resetInterval: null, resetIntervalCount: 2 },
					],
				}),
			]),
		).toBe("Plan pro item credits resetIntervalCount requires a resetInterval");
	});

	it("allows postpaid overage only on resets of a month or longer", async () => {
		const overage = (resetInterval: "week" | "month") =>
			plan({
				items: [
					item({
						resetInterval,
						overagePolicy: "allowed",
						price: { ...flatPrice([stripeBinding]), key: "credits-overage" },
					}),
				],
			});
		expect(await messageOf([overage("week")])).toBe(
			"Plan pro item credits can allow postpaid overage only with a reset of a month or longer; overage is invoiced once per window",
		);
		expect(await messageOf([overage("month")])).toBe("normalized");
	});

	it("requires every meter limit an add-on adds to to be a hard cap with the same reset", async () => {
		const addOn = (overrides: Partial<CatalogPlanItemIntent>) =>
			plan({ key: "boost", name: "Boost", kind: "addon", items: [item(overrides)] });
		const refused =
			"Meter limits on credits must all be blocked caps with the same reset, because add-on boost adds to them";
		expect(await messageOf([plan({ items: [item({})] }), addOn({ quantity: "50" })])).toBe(
			"normalized",
		);
		// Base plans may limit a feature differently while no add-on limits it.
		expect(
			await messageOf([
				plan({ items: [item({ resetInterval: "day" })] }),
				plan({ key: "team", name: "Team", items: [item({})] }),
			]),
		).toBe("normalized");
		expect(await messageOf([plan({ items: [item({ resetInterval: "day" })] }), addOn({})])).toBe(
			refused,
		);
		expect(
			await messageOf([
				plan({ items: [item({ resetInterval: "day" })] }),
				addOn({ resetInterval: "day", resetIntervalCount: 2 }),
			]),
		).toBe(refused);
		const overage = item({
			overagePolicy: "allowed",
			price: { ...flatPrice([stripeBinding]), key: "credits-overage" },
		});
		expect(await messageOf([plan({ items: [overage] }), addOn({})])).toBe(refused);
		// An add-on alone decides its own limit, overage included.
		expect(
			await messageOf([plan({}), plan({ key: "boost", kind: "addon", items: [overage] })]),
		).toBe("normalized");
	});

	it("requires one declared scope on every meter limit an add-on can be held with", async () => {
		const entity = (overrides: Partial<CatalogPlanItemIntent>) =>
			item({ ...overrides, allocationScope: "entity" });
		const addOn = plan({ key: "boost", name: "Boost", kind: "addon", items: [entity({})] });
		expect(await messageOf([plan({ items: [item({})] }), addOn])).toBe(
			"Meter limits on credits must all declare the same allocationScope, because add-on boost can be held together with them",
		);
		expect(await messageOf([plan({ items: [entity({})] }), addOn])).toBe("normalized");
		// Base plans are exclusive, so they may differ while no add-on limits the feature.
		expect(
			await messageOf([
				plan({ items: [item({})] }),
				plan({ key: "team", name: "Team", items: [entity({})] }),
			]),
		).toBe("normalized");
	});

	it("keeps entity scope to hard caps, since postpaid overage applies its allowance once", async () => {
		const postpaid = (allocationScope: "account" | "entity") =>
			plan({
				items: [
					item({
						resetInterval: "month",
						overagePolicy: "allowed",
						allocationScope,
						price: { ...flatPrice([stripeBinding]), key: "credits-overage" },
					}),
				],
			});
		expect(await messageOf([postpaid("entity")])).toBe(
			"Meter limit credits on plan pro allows postpaid overage, so it must cap the account: entity scope is only available to blocked limits",
		);
		expect(await messageOf([postpaid("account")])).toBe("normalized");
	});

	it("normalizes counts and the earlier rollover spelling in a stored catalog", async () => {
		const stored: CatalogIntent = {
			features: [feature],
			plans: [
				plan({
					items: [
						{
							...resettingItem("allocation", "month"),
							rollover: { maxQuantity: null, expiry: { mode: "months", months: 3 } },
						},
					],
				}),
			],
			topups: [],
			rateCards: [],
		};
		const published = await new CatalogControlPlane(new StoredCatalogDatabase(stored)).getPublished(
			projectInstanceContext(),
		);
		expect(published.catalog?.plans[0]?.items[0]).toMatchObject({
			reset: { interval: "month", intervalCount: 1 },
			rollover: {
				maxQuantity: null,
				expiry: { mode: "after", interval: "month", intervalCount: 3 },
			},
		});
		expect(
			await messageOf([
				plan({
					items: [
						{
							...resettingItem("allocation", "week"),
							rollover: {
								maxQuantity: null,
								expiry: { mode: "after", interval: "year", intervalCount: 11 },
							},
						},
					],
				}),
			]),
		).toBe("Plan pro item credits rollover expiry cannot span more than 10 × year");
	});

	it("checks plan control cadences and treats equal windows as duplicates", async () => {
		const control = (overrides: Partial<CatalogControlIntent>): CatalogControlIntent => ({
			controlKind: "usage_limit",
			featureKey: "credits",
			currency: null,
			limitValue: "100",
			interval: "day",
			...overrides,
		});
		const withControls = (controls: CatalogControlIntent[]) =>
			messageOf([plan({ items: [item({})], controls })]);
		expect(await withControls([control({}), control({ interval: "week", intervalCount: 2 })])).toBe(
			"normalized",
		);
		expect(await withControls([control({ interval: "hour" }), control({ interval: "day" })])).toBe(
			"normalized",
		);
		expect(await withControls([control({ interval: "lifetime", intervalCount: 2 })])).toBe(
			"Plan pro control with a lifetime interval takes no intervalCount",
		);
		expect(await withControls([control({ interval: "year", intervalCount: 4 })])).toBe(
			"Plan pro control cannot span more than 3 × year",
		);
		expect(
			await withControls([
				control({ interval: "quarter" }),
				control({ interval: "month", intervalCount: 3, limitValue: "50" }),
			]),
		).toBe("Duplicate plan pro control values are not allowed");
	});

	it("binds a plan only to providers that sell its billing interval", async () => {
		const quarterly = plan({
			billingInterval: "quarter",
			items: [item({ resetInterval: "month" })],
			providerBindings: [appleBinding, stripeBinding],
		});
		expect(await messageOf([quarterly])).toBe("normalized");

		const fourMonthly = plan({
			billingInterval: "month",
			billingIntervalCount: 4,
			items: [item({ resetInterval: "month" })],
			providerBindings: [appleBinding, stripeBinding],
		});
		const error = await previewWith(providerCapabilityCatalog, [fourMonthly]);
		expect(error).toBeInstanceOf(CapabilityError);
		expect((error as CapabilityError).message).toBe(
			"Plan pro cannot bind apple: it does not bill every 4 × month",
		);
		expect((error as CapabilityError).code).toBe("PROVIDER_CAPABILITY_UNSUPPORTED");
		expect((error as CapabilityError).details).toMatchObject({
			providerCompatibility: [
				{
					target: { kind: "plan", key: "pro" },
					provider: "apple",
					compatible: false,
					verdicts: [
						{
							operation: "catalog.product.subscription",
							outcome: "blocked",
							blockingLayer: "provider",
							reasons: [
								{
									code: "BILLING_INTERVAL",
									observed: { billingInterval: "month", billingIntervalCount: 4 },
								},
							],
						},
					],
				},
			],
		});
	});

	it("checks billing interval shape and price agreement", async () => {
		expect(
			await messageOf([plan({ billingInterval: "week", billingIntervalCount: 157, items: [] })]),
		).toBe("Plan pro billing interval cannot span more than 3 × year");
		expect(
			await messageOf([plan({ billingInterval: null, billingIntervalCount: 2, items: [] })]),
		).toBe("Plan pro billingIntervalCount requires a billingInterval");
		expect(
			await messageOf([
				plan({
					billingInterval: "quarter",
					items: [
						item({
							resetInterval: "month",
							overagePolicy: "allowed",
							price: {
								...flatPrice([stripeBinding]),
								key: "credits-overage",
								billingInterval: "month",
								billingIntervalCount: 3,
							},
						}),
					],
				}),
			]),
		).toBe("normalized");
		expect(
			await messageOf([
				plan({
					billingInterval: "quarter",
					items: [
						item({
							resetInterval: "month",
							overagePolicy: "allowed",
							price: { ...flatPrice([stripeBinding]), key: "credits-overage" },
						}),
					],
				}),
			]),
		).toBe("Plan pro price intervals must match");
	});
});

describe("catalog control plane default plan", () => {
	const freePlan: CatalogPlanIntent = {
		key: "free",
		name: "Free",
		version: 1,
		currency: null,
		baseAmountMinor: null,
		billingInterval: null,
		trialDays: null,
		items: [
			{
				featureKey: "credits",
				itemKind: "allocation",
				quantity: "100",
				resetInterval: "month",
				expiresAfterSeconds: null,
				overagePolicy: "blocked",
			},
		],
		providerBindings: [],
	};

	async function previewDefault(
		plan: CatalogPlanIntent,
		planKey = plan.key,
	): Promise<InvalidRequestError | CapabilityError | "normalized"> {
		const controlPlane = new CatalogControlPlane(sentinelDatabase);
		try {
			await controlPlane.preview({} as never, {
				expectedRevision: null,
				actor: "test",
				catalog: {
					features: [feature],
					plans: [plan],
					topups: [],
					rateCards: [],
					defaultPlan: { planKey },
				},
			});
		} catch (error) {
			if (error === passedNormalization) return "normalized";
			if (error instanceof InvalidRequestError || error instanceof CapabilityError) return error;
			throw error;
		}
		throw new Error("Catalog preview resolved without reaching its transaction");
	}

	async function refusal(plan: CatalogPlanIntent, planKey?: string): Promise<string> {
		const error = await previewDefault(plan, planKey);
		if (!(error instanceof InvalidRequestError)) throw new Error("expected a refusal");
		expect(error.code).toBe("INVALID_REQUEST");
		return error.message;
	}

	it("accepts a public, unpriced base plan whose allocations reset", async () => {
		expect(await previewDefault(freePlan)).toBe("normalized");
		expect(
			await previewDefault({
				...freePlan,
				items: [
					{
						featureKey: "credits",
						itemKind: "meter_limit",
						quantity: "50",
						resetInterval: "day",
						expiresAfterSeconds: null,
						overagePolicy: "blocked",
					},
				],
			}),
		).toBe("normalized");
	});

	it("refuses a plan a grant cannot hold without a provider", async () => {
		const item = freePlan.items[0] as CatalogPlanItemIntent;
		expect(await refusal(freePlan, "missing")).toBe(
			"Default plan missing must be an active plan of this catalog",
		);
		expect(await refusal({ ...freePlan, kind: "addon" })).toBe(
			"Default plan free must be a base plan",
		);
		expect(
			await refusal({
				...freePlan,
				visibility: "customer_specific",
				customerBillingAccountId: "acct_1",
			}),
		).toBe("Default plan free must be public");
		// A plan-level amount with neither a price nor a binding charges nothing: it is dropped as
		// legacy syntax, and the plan stays unpriced.
		expect(await previewDefault({ ...freePlan, currency: "USD", baseAmountMinor: 0 })).toBe(
			"normalized",
		);
		expect(
			await refusal({
				...freePlan,
				billingInterval: "month",
				providerBindings: [{ productKey: "free", provider: "stripe", channel: "web" }],
			}),
		).toBe("Default plan free must have no price or provider binding");
		expect(await refusal({ ...freePlan, trialDays: 7 })).toBe(
			"Default plan free cannot declare a trial",
		);
		expect(await refusal({ ...freePlan, items: [{ ...item, allocationScope: "entity" }] })).toBe(
			"Default plan free item credits must be allocated to the account",
		);
		expect(
			await refusal({
				...freePlan,
				items: [{ ...item, rollover: { maxQuantity: null, expiry: { mode: "forever" } } }],
			}),
		).toBe("Default plan free item credits cannot roll over");
		expect(await refusal({ ...freePlan, items: [{ ...item, resetInterval: null }] })).toBe(
			"Default plan free allocation credits must reset",
		);
	});

	it("keeps a catalog without the marker unchanged and canonicalizes the marker's keys", async () => {
		const unmarked: CatalogIntent = {
			features: [feature],
			plans: [freePlan],
			topups: [],
			rateCards: [],
		};
		const read = async (stored: CatalogIntent) =>
			(
				await new CatalogControlPlane(new StoredCatalogDatabase(stored)).getPublished(
					projectInstanceContext(),
				)
			).catalog;

		expect(await read(unmarked)).not.toHaveProperty("defaultPlan");
		expect(await read({ ...unmarked, defaultPlan: null })).not.toHaveProperty("defaultPlan");
		expect(
			(
				await read({
					...unmarked,
					defaultPlan: { planKey: " free ", entitlementKeys: [" b", "a", "a"] },
				})
			)?.defaultPlan,
		).toEqual({ planKey: "free", entitlementKeys: ["a", "b"] });
		expect((await read({ ...unmarked, defaultPlan: { planKey: "free" } }))?.defaultPlan).toEqual({
			planKey: "free",
			entitlementKeys: [],
		});
	});
});

describe("catalog control plane price spellings", () => {
	const basePrice = (overrides: Partial<CatalogPriceIntent> = {}): CatalogPriceIntent => ({
		...flatPrice([stripeBinding]),
		...overrides,
	});
	const outcome = async (candidate: CatalogPlanIntent): Promise<string> => {
		const result = await previewWith(providerCapabilityCatalog, [candidate]);
		return result === "normalized" ? result : result.message;
	};
	const pricedItem = (
		itemKind: "meter_limit" | "allocation",
		overagePolicy: "blocked" | "allowed",
	): CatalogPlanIntent =>
		plan({
			items: [
				{
					...resettingItem(itemKind, "month"),
					overagePolicy,
					price: { ...flatPrice([stripeBinding]), key: "credits-overage" },
				},
			],
		});

	it("refuses a legacy price field that disagrees with basePrice", async () => {
		// Normalization keeps basePrice, so each of these published one value and dropped the other.
		expect(
			await outcome(
				plan({ baseAmountMinor: 1000, basePrice: basePrice({ unitAmountMinor: 2000 }) }),
			),
		).toBe("Plan pro baseAmountMinor 1000 conflicts with basePrice unitAmountMinor 2000");
		expect(await outcome(plan({ currency: " eur ", basePrice: basePrice() }))).toBe(
			"Plan pro currency EUR conflicts with basePrice currency USD",
		);
		expect(await outcome(plan({ billingInterval: "year", basePrice: basePrice() }))).toBe(
			"Plan pro billingInterval year conflicts with basePrice billingInterval month",
		);
		expect(await outcome(plan({ billingIntervalCount: 3, basePrice: basePrice() }))).toBe(
			"Plan pro billingIntervalCount 3 conflicts with basePrice billingIntervalCount 1",
		);
		expect(
			await outcome(
				plan({
					providerBindings: [{ ...stripeBinding, productKey: "pro_legacy" }, appleBinding],
					basePrice: basePrice(),
				}),
			),
		).toBe(
			"Plan pro providerBindings stripe/web pro_legacy conflict with basePrice providerBindings stripe/web pro",
		);
	});

	it("accepts agreeing, absent and store-only legacy spellings", async () => {
		for (const accepted of [
			plan({
				currency: " usd ",
				baseAmountMinor: 1000,
				billingIntervalCount: 1,
				basePrice: basePrice(),
				providerBindings: [stripeBinding, appleBinding],
			}),
			plan({ currency: null, billingInterval: null, basePrice: basePrice() }),
			// App Store products carry no Quotum price; their binding is not a second spelling.
			plan({ basePrice: basePrice(), providerBindings: [appleBinding] }),
			plan({ baseAmountMinor: 1000, providerBindings: [stripeBinding] }),
		]) {
			expect(await outcome(accepted)).toBe("normalized");
		}
	});

	it("refuses a price on an allocation or on a meter limit that blocks overage", async () => {
		expect(await outcome(pricedItem("allocation", "blocked"))).toBe(
			"Plan pro allocation credits cannot declare a price: allowances are not billed",
		);
		expect(await outcome(pricedItem("meter_limit", "blocked"))).toBe(
			"Plan pro meter limit credits cannot declare a price while it blocks overage: only allowed overage is billed",
		);
		expect(await outcome(pricedItem("meter_limit", "allowed"))).toBe("normalized");
	});

	it("keeps a catalog stored with a never-billed price readable and refuses it unchanged", async () => {
		const stored: CatalogIntent = {
			features: [feature],
			plans: [pricedItem("meter_limit", "blocked")],
			topups: [],
			rateCards: [],
		};
		const controlPlane = new CatalogControlPlane(new StoredCatalogDatabase(stored));
		const current = await controlPlane.getPublished(projectInstanceContext());
		// The canonical read-back has no place for a price that never charges; preview of the stored
		// intent as submitted still refuses it.
		expect(current.catalog?.plans[0]?.items[0]).toMatchObject({
			itemKind: "meter_limit",
			overage: { policy: "blocked" },
		});
		const unchanged = await controlPlane
			.preview(projectInstanceContext(), { expectedRevision: 1, actor: "test", catalog: stored })
			.then(() => null)
			.catch((error: unknown) => error);
		expect(unchanged).toBeInstanceOf(InvalidRequestError);
		expect((unchanged as InvalidRequestError).message).toBe(
			"Plan pro meter limit credits cannot declare a price while it blocks overage: only allowed overage is billed",
		);
	});

	it("rejects publishing a draft whose submitted spellings disagree, before writing anything", async () => {
		const submitted: CatalogIntent = {
			features: [feature],
			plans: [plan({ baseAmountMinor: 1000, basePrice: basePrice({ unitAmountMinor: 2000 }) })],
			topups: [],
			rateCards: [],
		};
		const database = new StoredCatalogDatabase(submitted);
		const rejection = await new CatalogControlPlane(database)
			.publish(projectInstanceContext(), {
				expectedRevision: 1,
				actor: "test",
				previewToken: "c".repeat(64),
				catalog: submitted,
			})
			.then(() => null)
			.catch((error: unknown) => error);
		expect(rejection).toBeInstanceOf(InvalidRequestError);
		expect((rejection as InvalidRequestError).message).toBe(
			"Plan pro baseAmountMinor 1000 conflicts with basePrice unitAmountMinor 2000",
		);
		expect(database.writes).toEqual([]);
	});
});
