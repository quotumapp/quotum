import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { CatalogProviderCompatibilitySchema } from "../../src/app/contracts/provider-responses";
import { CapabilityError, classifyBillingError } from "../../src/billing/errors";
import { CatalogControlPlane } from "../../src/catalog/control-plane";
import {
	assertCatalogProviderCompatibility,
	catalogCapabilityTargets,
	catalogProviderCompatibility,
} from "../../src/catalog/provider-compatibility";
import type {
	CatalogFeatureIntent,
	CatalogIntent,
	CatalogPlanIntent,
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
import type {
	DeclaredProvider,
	OperationSupport,
	ProviderCapabilityDeclaration,
	ProviderOperation,
} from "../../src/shared/provider-capabilities";
import { renderDrizzleSql } from "../helpers/drizzle-sql";
import { projectInstanceContext } from "../helpers/project-context";

const features: CatalogFeatureIntent[] = [
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
		key: "credits",
		name: "Credits",
		kind: "metered",
		meterKind: "consumable",
		unit: "credit",
		creditScale: 0,
		filterDimensions: [],
	},
];

const apple = (productKey: string): CatalogProviderBindingIntent => ({
	provider: "apple",
	channel: "ios",
	productKey,
});
const google = (productKey: string): CatalogProviderBindingIntent => ({
	provider: "google",
	channel: "android",
	productKey,
});
const stripe = (productKey: string): CatalogProviderBindingIntent => ({
	provider: "stripe",
	channel: "web",
	productKey,
});

function flatPrice(
	key: string,
	providerBindings: CatalogProviderBindingIntent[],
): CatalogPriceIntent {
	return {
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
		providerBindings,
	};
}

function plan(key: string, overrides: Partial<CatalogPlanIntent>): CatalogPlanIntent {
	return {
		key,
		name: key,
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

function topup(key: string, providerBindings: CatalogProviderBindingIntent[]): CatalogTopupIntent {
	return {
		key,
		featureKey: "credits",
		quantity: "10",
		expiresAfterSeconds: null,
		providerBindings,
	};
}

function catalogOf(plans: CatalogPlanIntent[], topups: CatalogTopupIntent[] = []): CatalogIntent {
	return { features, plans, topups, rateCards: [] };
}

/** A plan with a trial, an add-on, a hybrid priced plan and a top-up, bound across providers. */
const mixedCatalog = catalogOf(
	[
		plan("trial", { trialDays: 7, providerBindings: [apple("trial-apple"), stripe("trial-web")] }),
		plan("plain", { providerBindings: [google("plain-google")] }),
		plan("addon", {
			kind: "addon",
			basePrice: flatPrice("addon-base", [google("addon-google"), stripe("addon-web")]),
			items: [
				{
					featureKey: "seats",
					itemKind: "licensed_quantity",
					quantity: "5",
					resetInterval: null,
					expiresAfterSeconds: null,
					overagePolicy: "blocked",
					price: flatPrice("addon-seats", [stripe("addon-seats-web")]),
				},
			],
		}),
	],
	[topup("pack", [apple("pack-apple"), google("pack-google"), stripe("pack-web")])],
);

/** The declared catalog with one provider's declaration patched. */
function catalogDeclaring(
	provider: DeclaredProvider,
	patch: (declaration: ProviderCapabilityDeclaration) => Partial<ProviderCapabilityDeclaration>,
): ProviderCapabilityLookup {
	const declaration = providerCapabilityDeclaration(provider);
	return new Map(providerCapabilityCatalog).set(provider, {
		...declaration,
		...patch(declaration),
	});
}

function withSupport(
	provider: DeclaredProvider,
	operation: ProviderOperation,
	support: OperationSupport,
): ProviderCapabilityLookup {
	return catalogDeclaring(provider, (declaration) => ({
		operations: { ...declaration.operations, [operation]: support },
	}));
}

const nativelyVerified: OperationSupport = {
	level: "native",
	verification: {
		status: "verified",
		verifiedOn: "2026-09-18",
		evidence: { tests: [], scenarios: [], questions: [] },
	},
	conditions: [],
};

const unsupported: OperationSupport = {
	level: "unsupported",
	verification: { status: "not_applicable" },
	conditions: [],
};

function capabilityErrorOf(run: () => unknown): CapabilityError {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(CapabilityError);
		return error as CapabilityError;
	}
	throw new Error("Expected a capability error");
}

function reported(error: CapabilityError) {
	if (!("providerCompatibility" in error.details)) throw new Error("Expected catalog details");
	return error.details.providerCompatibility.map(({ target, provider, verdicts }) => ({
		target,
		provider,
		blocked: verdicts.map(({ operation }) => operation),
	}));
}

describe("catalog capability targets", () => {
	it("lists trial and add-on plans, then prices, per plan in catalog order, then top-ups", () => {
		expect(
			catalogCapabilityTargets(mixedCatalog).map(({ target, construct, bindings }) => ({
				target,
				construct: construct.kind,
				bindings: bindings.map(({ productKey }) => productKey),
			})),
		).toEqual([
			{
				target: { kind: "plan", key: "trial" },
				construct: "plan",
				bindings: ["trial-apple", "trial-web"],
			},
			{
				target: { kind: "plan", key: "addon" },
				construct: "plan",
				bindings: ["addon-google", "addon-web"],
			},
			{
				target: { kind: "price", key: "addon", priceKey: "addon-base" },
				construct: "price",
				bindings: ["addon-google", "addon-web"],
			},
			{
				target: { kind: "price", key: "addon", priceKey: "addon-seats" },
				construct: "price",
				bindings: ["addon-seats-web"],
			},
			{
				target: { kind: "topup", key: "pack" },
				construct: "topup",
				bindings: ["pack-apple", "pack-google", "pack-web"],
			},
		]);
	});

	it("uses a plan's own bindings over its base price's", () => {
		const addon = plan("addon", {
			kind: "addon",
			providerBindings: [stripe("addon-plan-web")],
			basePrice: flatPrice("addon-base", [google("addon-google")]),
		});
		const [planTarget] = catalogCapabilityTargets(catalogOf([addon]));
		expect(planTarget?.bindings).toEqual([stripe("addon-plan-web")]);
	});
});

describe("catalog provider compatibility", () => {
	it("reports every binding with its required operations and only the blocked verdicts", () => {
		const entries = catalogProviderCompatibility(mixedCatalog);
		expect(
			entries.map(({ target, provider, productKey, requiredOperations, compatible, verdicts }) => ({
				target: target.priceKey ?? `${target.kind}:${target.key}`,
				provider,
				productKey,
				requiredOperations,
				compatible,
				blocked: verdicts.map(({ operation, outcome, blockingLayer }) => [
					operation,
					outcome,
					blockingLayer,
				]),
			})),
		).toEqual([
			{
				target: "plan:trial",
				provider: "apple",
				productKey: "trial-apple",
				requiredOperations: ["catalog.trial"],
				compatible: false,
				blocked: [["catalog.trial", "blocked", "provider"]],
			},
			{
				target: "plan:trial",
				provider: "stripe",
				productKey: "trial-web",
				requiredOperations: ["catalog.trial"],
				compatible: true,
				blocked: [],
			},
			{
				target: "plan:addon",
				provider: "google",
				productKey: "addon-google",
				requiredOperations: ["catalog.addon"],
				compatible: false,
				blocked: [["catalog.addon", "blocked", "provider"]],
			},
			{
				target: "plan:addon",
				provider: "stripe",
				productKey: "addon-web",
				requiredOperations: ["catalog.addon"],
				compatible: true,
				blocked: [],
			},
			{
				target: "addon-base",
				provider: "google",
				productKey: "addon-google",
				requiredOperations: ["catalog.price.flat", "catalog.price.hybrid"],
				compatible: false,
				blocked: [
					["catalog.price.flat", "blocked", "provider"],
					["catalog.price.hybrid", "blocked", "provider"],
				],
			},
			{
				target: "addon-base",
				provider: "stripe",
				productKey: "addon-web",
				requiredOperations: ["catalog.price.flat", "catalog.price.hybrid"],
				compatible: true,
				blocked: [],
			},
			{
				target: "addon-seats",
				provider: "stripe",
				productKey: "addon-seats-web",
				requiredOperations: [
					"catalog.price.flat",
					"catalog.price.licensed",
					"catalog.price.hybrid",
				],
				compatible: true,
				blocked: [],
			},
			...(["apple", "google", "stripe"] as const).map((provider) => ({
				target: "topup:pack",
				provider,
				productKey: `pack-${provider === "stripe" ? "web" : provider}`,
				requiredOperations: ["catalog.topup" as const],
				compatible: true,
				blocked: [],
			})),
		]);
	});

	it("matches the wire schema it is published under", () => {
		const entries = catalogProviderCompatibility(mixedCatalog);
		expect(z.array(CatalogProviderCompatibilitySchema).parse(entries)).toEqual(entries);
		for (const verdict of entries.flatMap(({ verdicts }) => verdicts)) {
			expect(verdict.reasons.length).toBeGreaterThan(0);
		}
	});
});

describe("catalog provider compatibility assert", () => {
	it("accepts a catalog whose bindings are all compatible", () => {
		const compatible = catalogOf(
			[plan("trial", { trialDays: 7, providerBindings: [stripe("trial-web")] })],
			[topup("pack", [apple("pack-apple"), google("pack-google")])],
		);
		expect(() =>
			assertCatalogProviderCompatibility(compatible, providerCapabilityCatalog),
		).not.toThrow();
	});

	it("aggregates every incompatible binding across plans into one error", () => {
		const error = capabilityErrorOf(() =>
			assertCatalogProviderCompatibility(mixedCatalog, providerCapabilityCatalog),
		);
		expect({
			code: error.code,
			status: error.status,
			classification: error.classification,
			exposeMessage: error.exposeMessage,
			blockingLayer: error.blockingLayer,
			message: error.message,
		}).toEqual({
			code: "PROVIDER_CAPABILITY_UNSUPPORTED",
			status: 400,
			classification: "invalid_request",
			exposeMessage: true,
			blockingLayer: "provider",
			message: "Plan trial cannot bind apple: catalog.trial is not supported (and 2 more)",
		});
		expect(reported(error)).toEqual([
			{ target: { kind: "plan", key: "trial" }, provider: "apple", blocked: ["catalog.trial"] },
			{ target: { kind: "plan", key: "addon" }, provider: "google", blocked: ["catalog.addon"] },
			{
				target: { kind: "price", key: "addon", priceKey: "addon-base" },
				provider: "google",
				blocked: ["catalog.price.flat", "catalog.price.hybrid"],
			},
		]);
		expect(classifyBillingError(error)).toEqual({
			code: "PROVIDER_CAPABILITY_UNSUPPORTED",
			message: "Plan trial cannot bind apple: catalog.trial is not supported (and 2 more)",
			status: 400,
			classification: "invalid_request",
			details: error.details,
		});
	});

	it("reports the same rejection whatever order the intent lists its bindings in", async () => {
		const reversed: CatalogIntent = {
			...mixedCatalog,
			plans: mixedCatalog.plans.map((entry) => ({
				...entry,
				providerBindings: [...entry.providerBindings].reverse(),
				basePrice:
					entry.basePrice === null || entry.basePrice === undefined
						? entry.basePrice
						: {
								...entry.basePrice,
								providerBindings: [...entry.basePrice.providerBindings].reverse(),
							},
			})),
			topups: mixedCatalog.topups.map((entry) => ({
				...entry,
				providerBindings: [...entry.providerBindings].reverse(),
			})),
		};
		const [first, second, again] = await Promise.all(
			[mixedCatalog, reversed, mixedCatalog].map((catalog) => previewRejection(catalog)),
		);
		expect(second).toEqual(first);
		expect(again).toEqual(first);
		expect(first).toMatchObject({
			message: "Plan trial cannot bind apple: catalog.trial is not supported (and 2 more)",
		});
	});

	it("follows an injected hypothetical declaration", () => {
		const trial = catalogOf([
			plan("trial", {
				trialDays: 7,
				providerBindings: [apple("trial-apple"), google("trial-google")],
			}),
		]);
		const googleTrials = withSupport("google", "catalog.trial", nativelyVerified);
		const error = capabilityErrorOf(() => assertCatalogProviderCompatibility(trial, googleTrials));
		expect(error.message).toBe("Plan trial cannot bind apple: catalog.trial is not supported");
		expect(reported(error).map(({ provider }) => provider)).toEqual(["apple"]);

		const plannedStripe = catalogDeclaring("stripe", () => ({ availability: "planned" }));
		const stripeTrial = catalogOf([
			plan("trial", { trialDays: 7, providerBindings: [stripe("t")] }),
		]);
		const planned = capabilityErrorOf(() =>
			assertCatalogProviderCompatibility(stripeTrial, plannedStripe),
		);
		expect(planned.blockingLayer).toBe("implementation");
		expect(planned.code).toBe("PROVIDER_CAPABILITY_UNSUPPORTED");
		expect(planned.status).toBe(400);
		if (!("providerCompatibility" in planned.details)) throw new Error("Expected catalog details");
		expect(
			planned.details.providerCompatibility[0]?.verdicts[0]?.reasons.map(({ code }) => code),
		).toEqual(["IMPLEMENTATION_PLANNED"]);
	});

	it("gates top-up bindings on catalog.topup", () => {
		const pack = catalogOf(
			[],
			[topup("pack", [apple("pack-apple"), google("pack-google"), stripe("pack-web")])],
		);
		expect(() => assertCatalogProviderCompatibility(pack, providerCapabilityCatalog)).not.toThrow();
		const googleWithoutTopups = withSupport("google", "catalog.topup", unsupported);
		const error = capabilityErrorOf(() =>
			assertCatalogProviderCompatibility(pack, googleWithoutTopups),
		);
		expect(error.message).toBe("Top-up pack cannot bind google: catalog.topup is not supported");
		expect(reported(error)).toEqual([
			{ target: { kind: "topup", key: "pack" }, provider: "google", blocked: ["catalog.topup"] },
		]);
	});
});

class NormalizationSentinel extends Error {}
const passedNormalization = new NormalizationSentinel("normalization passed");

async function previewRejection(
	catalog: CatalogIntent,
	capabilities: ProviderCapabilityLookup = providerCapabilityCatalog,
): Promise<{ message: string; details: unknown } | "normalized"> {
	const database = {
		transaction(): never {
			throw passedNormalization;
		},
	} as never;
	try {
		await new CatalogControlPlane(database, { capabilities }).preview({} as never, {
			expectedRevision: null,
			actor: "test",
			catalog,
		});
	} catch (error) {
		if (error === passedNormalization) return "normalized";
		if (error instanceof CapabilityError) return { message: error.message, details: error.details };
		throw error;
	}
	throw new Error("Catalog preview resolved without reaching its transaction");
}

/** Answers the control plane's reads from one published catalog, and records a new draft. */
class PublishedCatalogDatabase {
	readonly drafts: unknown[] = [];
	/** True from a stored-intent read until the next query. */
	readingStoredIntent = false;

	constructor(private readonly published: CatalogIntent) {}

	async execute<T>(query: unknown): Promise<T[]> {
		return (await this.answer(renderDrizzleSql(query))) as T[];
	}

	async transaction<T>(callback: (tx: QueryExecutor) => Promise<T>): Promise<T> {
		return await callback(this);
	}

	private async answer(text: string): Promise<Record<string, unknown>[]> {
		this.readingStoredIntent =
			text.includes("SELECT revision.intent_hash") || text.includes("SELECT draft.intent");
		if (text.includes("SELECT p.id, cr.id AS revision_id")) {
			return [{ id: projectInstanceContext().projectInstanceId, revision_id: "7", revision: 1 }];
		}
		if (text.includes("SELECT revision.intent_hash")) {
			return [
				{
					intent_hash: "a".repeat(64),
					published_at: "2026-09-01T00:00:00.000Z",
					intent: this.published,
				},
			];
		}
		if (text.includes("SELECT draft.intent")) return [{ intent: this.published }];
		if (text.includes("SELECT key, active FROM features")) {
			return this.published.features.map(({ key }) => ({ key, active: true }));
		}
		if (text.includes("SELECT key, active FROM plans")) {
			return this.published.plans.map(({ key }) => ({ key, active: true }));
		}
		if (text.includes("SELECT DISTINCT key FROM topup_options")) {
			return this.published.topups.map(({ key }) => ({ key }));
		}
		if (text.includes("FROM subscriptions")) return [{ count: "0" }];
		if (text.includes("INSERT INTO catalog_drafts")) {
			this.drafts.push(text);
			return [{ id: "1" }];
		}
		throw new Error(`Unscripted query: ${text}`);
	}
}

describe("stored catalogs after a declaration changes", () => {
	const published = catalogOf([
		plan("pro", {
			trialDays: 14,
			basePrice: flatPrice("pro-monthly", [stripe("pro-web")]),
		}),
	]);
	const withoutStripeTrials = withSupport("stripe", "catalog.trial", unsupported);
	const withoutTrial = catalogOf([
		plan("pro", {
			version: 2,
			basePrice: flatPrice("pro-monthly", [stripe("pro-web")]),
		}),
	]);

	it("reads stored catalogs through the injected declarations", async () => {
		for (const read of [
			(controlPlane: CatalogControlPlane) => controlPlane.getPublished(projectInstanceContext()),
			(controlPlane: CatalogControlPlane) =>
				controlPlane.preview(projectInstanceContext(), {
					expectedRevision: 1,
					actor: "test",
					catalog: withoutTrial,
				}),
		]) {
			const database = new PublishedCatalogDatabase(published);
			const storedReadLookups: string[] = [];
			const capabilities: ProviderCapabilityLookup = {
				get(provider) {
					if (database.readingStoredIntent) storedReadLookups.push(provider);
					return withoutStripeTrials.get(provider);
				},
			};
			await read(new CatalogControlPlane(database, { capabilities }));
			expect(storedReadLookups).toContain("stripe");
		}
	});

	it("keeps the published catalog readable", async () => {
		const controlPlane = new CatalogControlPlane(new PublishedCatalogDatabase(published), {
			capabilities: withoutStripeTrials,
		});
		const current = await controlPlane.getPublished(projectInstanceContext());
		expect(current.revision).toBe(1);
		expect(current.catalog?.plans.map(({ key, trialDays }) => ({ key, trialDays }))).toEqual([
			{ key: "pro", trialDays: 14 },
		]);
	});

	it("previews another change without re-validating the stored catalog", async () => {
		const database = new PublishedCatalogDatabase(published);
		const controlPlane = new CatalogControlPlane(database, { capabilities: withoutStripeTrials });
		const preview = await controlPlane.preview(projectInstanceContext(), {
			expectedRevision: 1,
			actor: "test",
			catalog: withoutTrial,
		});
		expect(preview.baseRevision).toBe(1);
		expect(preview.nextRevision).toBe(2);
		expect(preview.impact.planVersionsCreated).toBe(1);
		expect(database.drafts).toHaveLength(1);
	});

	it("still rejects a new intent that keeps the dropped capability", async () => {
		expect(await previewRejection(published, withoutStripeTrials)).toEqual({
			message: "Plan pro cannot bind stripe: catalog.trial is not supported",
			details: {
				providerCompatibility: [
					expect.objectContaining({
						target: { kind: "plan", key: "pro" },
						provider: "stripe",
						productKey: "pro-web",
					}),
				],
			},
		});
	});
});
