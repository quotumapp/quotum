import { describe, expect, it } from "bun:test";
import { CapabilityError, InvalidRequestError } from "../../src/billing/errors";
import { CatalogControlPlane } from "../../src/catalog/control-plane";
import type {
	CatalogFeatureIntent,
	CatalogIntent,
	CatalogPlanIntent,
	CatalogPriceIntent,
	CatalogProviderBindingIntent,
} from "../../src/catalog/types";
import {
	type ProviderCapabilityLookup,
	providerCapabilityCatalog,
	providerCapabilityDeclaration,
} from "../../src/providers/capabilities";
import type {
	DeclaredProvider,
	OperationSupport,
	ProviderOperation,
} from "../../src/shared/provider-capabilities";

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

	it("never admits a planned provider through its declared channel", async () => {
		const error = await previewError(
			planWith({ provider: "paddle" as never, channel: "web", productKey: "pro" }),
		);
		expect(error).toBeInstanceOf(InvalidRequestError);
		expect((error as InvalidRequestError).message).toBe(
			"paddle catalog bindings must use the undefined channel",
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
