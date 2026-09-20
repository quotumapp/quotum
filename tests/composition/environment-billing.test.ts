import { describe, expect, it } from "bun:test";
import { capabilityErrorCodes } from "../../src/billing/errors";
import type {
	CatalogIntent,
	CatalogPlanIntent,
	CatalogProviderBindingIntent,
	CatalogTopupIntent,
} from "../../src/catalog/types";
import { catalogCapabilityReadiness } from "../../src/composition/environment-billing";
import type { ReadinessConnectionState } from "../../src/platform/connections/ports";
import {
	evaluateRuntimeCapability,
	type ProviderCapabilityLookup,
	providerCapabilityCatalog,
	providerCapabilityDeclaration,
} from "../../src/providers/capabilities";

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

function topup(key: string, providerBindings: CatalogProviderBindingIntent[]): CatalogTopupIntent {
	return {
		key,
		featureKey: "credits",
		quantity: "10",
		expiresAfterSeconds: null,
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

function catalogOf(plans: CatalogPlanIntent[], topups: CatalogTopupIntent[]): CatalogIntent {
	return {
		features: [
			{
				key: "credits",
				name: "Credits",
				kind: "metered",
				meterKind: "consumable",
				unit: "credit",
				creditScale: 0,
				filterDimensions: [],
			},
		],
		plans,
		topups,
		rateCards: [],
	};
}

/** A Stripe-priced plan and two top-ups sold on the web and in the App Store. */
const catalog = catalogOf(
	[
		plan("pro", {
			basePrice: {
				key: "pro-monthly",
				currency: "USD",
				unitAmountMinor: 1000,
				billingUnits: "1",
				billingInterval: "month",
				minimumQuantity: 1,
				maximumQuantity: null,
				taxBehavior: "exclusive",
				pricingModel: "flat",
				tiers: [],
				providerBindings: [stripe("pro-web")],
			},
		}),
	],
	[
		topup("pack", [stripe("pack-web"), apple("pack-ios"), apple("pack-ios-promo")]),
		topup("mega", [apple("mega-ios"), stripe("mega-web")]),
	],
);

function connection(
	kind: ReadinessConnectionState["kind"],
	overrides: Partial<ReadinessConnectionState> = {},
): ReadinessConnectionState {
	return {
		kind,
		enabled: true,
		active_version_id: "11111111-1111-4111-8111-111111111111",
		validated_at: new Date("2026-09-18T10:00:00.000Z"),
		settings: {},
		...overrides,
	};
}

const connected = [connection("projection"), connection("stripe")];

describe("catalog capability readiness", () => {
	it("reports each blocked provider operation once with its deduplicated catalog targets", () => {
		expect(capabilityErrorCodes.configuration.code).toBe("PROVIDER_CAPABILITY_NOT_CONFIGURED");
		expect(catalogCapabilityReadiness(catalog, connected)).toEqual([
			{
				code: capabilityErrorCodes.configuration.code,
				connectionKind: "apple",
				provider: "apple",
				operation: "catalog.topup",
				targets: [
					{ kind: "topup", key: "pack" },
					{ kind: "topup", key: "mega" },
				],
				reason: {
					code: "CONNECTION_DISABLED",
					layer: "configuration",
					condition: { kind: "connection_enabled" },
					observed: { connectionEnabled: false },
					resolution: { kind: "merchant_configuration", connectionKind: "apple" },
				},
			},
		]);
	});

	it("reports nothing when every bound provider is enabled and validated", () => {
		expect(catalogCapabilityReadiness(catalog, [...connected, connection("apple")])).toEqual([]);
	});

	it("reads a disabled, inactive or unvalidated connection from its row", () => {
		const reasonFor = (row: ReadinessConnectionState) =>
			catalogCapabilityReadiness(catalog, [...connected, row]).map(({ reason }) => reason?.code);

		expect(reasonFor(connection("apple", { enabled: false }))).toEqual(["CONNECTION_DISABLED"]);
		expect(
			reasonFor(
				connection("apple", { active_version_id: null, validated_at: null, settings: null }),
			),
		).toEqual(["CONNECTION_DISABLED"]);
		expect(reasonFor(connection("apple", { validated_at: null }))).toEqual([
			"CONNECTION_VALIDATION_REQUIRED",
		]);
	});

	it("judges a plain plan's own bindings on the subscription product, ahead of the top-ups", () => {
		const plain = catalogOf(
			[
				plan("pro", {
					providerBindings: [apple("pro-ios"), google("pro-android"), stripe("pro-web")],
				}),
			],
			[topup("pack", [apple("pack-ios")])],
		);

		const details = catalogCapabilityReadiness(plain, connected);
		expect(
			details.map(({ provider, operation, targets }) => ({ provider, operation, targets })),
		).toEqual([
			{
				provider: "apple",
				operation: "catalog.product.subscription",
				targets: [{ kind: "plan", key: "pro" }],
			},
			{
				provider: "google",
				operation: "catalog.product.subscription",
				targets: [{ kind: "plan", key: "pro" }],
			},
			{ provider: "apple", operation: "catalog.topup", targets: [{ kind: "topup", key: "pack" }] },
		]);
		expect(details[0]).toEqual({
			code: capabilityErrorCodes.configuration.code,
			connectionKind: "apple",
			provider: "apple",
			operation: "catalog.product.subscription",
			targets: [{ kind: "plan", key: "pro" }],
			reason: {
				code: "CONNECTION_DISABLED",
				layer: "configuration",
				condition: { kind: "connection_enabled" },
				observed: { connectionEnabled: false },
				resolution: { kind: "merchant_configuration", connectionKind: "apple" },
			},
		});
		expect(
			catalogCapabilityReadiness(plain, [...connected, connection("apple"), connection("google")]),
		).toEqual([]);
	});

	it("derives the code from the blocking layer", () => {
		const trial = catalogOf(
			[plan("trial", { trialDays: 7, providerBindings: [apple("trial-ios")] })],
			[],
		);

		expect(
			catalogCapabilityReadiness(trial, [...connected, connection("apple")]).map(
				({ code, operation, reason }) => ({ code, operation, reason: reason?.code }),
			),
		).toEqual([
			{
				code: capabilityErrorCodes.provider.code,
				operation: "catalog.trial",
				reason: "PROVIDER_MANAGED",
			},
		]);
	});

	it("leaves out undetermined verdicts", () => {
		const declaration = providerCapabilityDeclaration("stripe");
		const capabilities: ProviderCapabilityLookup = new Map(providerCapabilityCatalog).set(
			"stripe",
			{
				...declaration,
				operations: {
					...declaration.operations,
					"catalog.topup": {
						...declaration.operations["catalog.topup"],
						conditions: [{ kind: "currency", allowed: ["USD"] }],
					},
				},
			},
		);

		const facts = { connectionEnabled: true, connectionValidated: true, accountFlags: {} };
		expect(
			evaluateRuntimeCapability(
				"stripe",
				"catalog.topup",
				{ configuration: facts },
				{ through: "configuration", capabilities },
			).outcome,
		).toBe("undetermined");
		expect(
			catalogCapabilityReadiness(catalog, connected, capabilities).map(
				({ provider, operation }) => `${provider}:${operation}`,
			),
		).toEqual(["apple:catalog.topup"]);
	});
});
