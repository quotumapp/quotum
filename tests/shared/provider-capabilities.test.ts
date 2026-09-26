import { describe, expect, it } from "bun:test";
import * as billingTypes from "../../src/billing/types";
import {
	assertValidDeclaration,
	billingChannels,
	billingProviders,
	type CapabilityCondition,
	type CapabilityEvidence,
	type CapabilityFacts,
	type CapabilityReason,
	type CapabilityResolution,
	type CapabilityStatusLabelId,
	capabilityConditionKinds,
	capabilityLayers,
	capabilityReasonCodes,
	capabilityStatusLabel,
	capabilityStatusLabelIds,
	capabilityStatusLabels,
	changeBillingPolicies,
	conditionLayer,
	conditionReasonCode,
	declaredProviders,
	describeCondition,
	evaluateCapability,
	isBillingChannel,
	isBillingProvider,
	isDeclaredProvider,
	isProviderOperation,
	type OperationSupport,
	type ProviderCapabilityDeclaration,
	type ProviderOperation,
	plannedProviders,
	providerOperationDefinitions,
	providerOperationDomains,
	providerOperationDomainTitles,
	providerOperations,
	renderCapabilityStatus,
	supportLevelLabels,
	supportLevels,
	validateDeclaration,
} from "../../src/shared/provider-capabilities";

const evidence: CapabilityEvidence = {
	tests: ["tests/providers/stripe/service.test.ts"],
	scenarios: [],
	questions: [],
};

const notEvaluated: OperationSupport = {
	level: "not_evaluated",
	verification: { status: "not_applicable" },
	conditions: [],
};

const verifiedNative: OperationSupport = {
	level: "native",
	verification: { status: "verified", verifiedOn: "2026-09-16", evidence },
	conditions: [],
};

function conditional(conditions: CapabilityCondition[]): OperationSupport {
	return {
		level: "native",
		verification: { status: "conditional", verifiedOn: "2026-09-16", evidence },
		conditions,
	};
}

function planned(
	verification: Omit<
		Extract<OperationSupport["verification"], { status: "planned" }>,
		"status"
	> = {},
	conditions: CapabilityCondition[] = [],
): OperationSupport {
	return { level: "native", verification: { status: "planned", ...verification }, conditions };
}

function declaration(
	operations: Partial<Record<ProviderOperation, OperationSupport>> = {},
	fields: Partial<Omit<ProviderCapabilityDeclaration, "operations">> = {},
): ProviderCapabilityDeclaration {
	return {
		provider: "stripe",
		channel: "web",
		connectionKind: "stripe",
		availability: "available",
		writeSemantics: { clientIdempotencyKeys: true, uncertainWrite: "provider_idempotency" },
		...fields,
		operations: Object.fromEntries(
			providerOperations.map((operation) => [operation, operations[operation] ?? notEvaluated]),
		) as Record<ProviderOperation, OperationSupport>,
	};
}

function plannedPaddle(
	operations: Partial<Record<ProviderOperation, OperationSupport>> = {},
): ProviderCapabilityDeclaration {
	return declaration(operations, {
		provider: "paddle",
		connectionKind: "paddle",
		availability: "planned",
		writeSemantics: { clientIdempotencyKeys: false, uncertainWrite: "reconcile_required" },
	});
}

const configured = { connectionEnabled: true, connectionValidated: true, accountFlags: {} };
const renewalAt = "2026-10-01T00:00:00.000Z";

describe("provider capability vocabulary", () => {
	it("declares admitted, planned and declared providers and channels in contract order", () => {
		expect([...billingProviders]).toEqual(["apple", "google", "stripe"]);
		expect([...plannedProviders]).toEqual(["paddle"]);
		expect([...declaredProviders]).toEqual(["apple", "google", "stripe", "paddle"]);
		expect([...billingChannels]).toEqual(["ios", "android", "web"]);
	});

	it("is the identity billing types alias", () => {
		expect(billingTypes.billingProviders).toBe(billingProviders);
		expect(billingTypes.billingChannels).toBe(billingChannels);
		expect(billingTypes.isBillingProvider).toBe(isBillingProvider);
		expect(billingTypes.parseProvider("google")).toBe("google");
	});

	it("narrows provider, channel and operation identities", () => {
		expect(billingProviders.every((provider) => isBillingProvider(provider))).toBe(true);
		expect(isBillingProvider("paddle")).toBe(false);
		expect(isBillingProvider("Stripe")).toBe(false);
		expect(isBillingProvider(undefined)).toBe(false);
		expect(isBillingProvider(1)).toBe(false);
		expect(isDeclaredProvider("paddle")).toBe(true);
		expect(isDeclaredProvider("adyen")).toBe(false);
		expect(isBillingChannel("web")).toBe(true);
		expect(isBillingChannel("desktop")).toBe(false);
		expect(isProviderOperation("checkout.hosted")).toBe(true);
		expect(isProviderOperation("checkout")).toBe(false);
	});

	it("lists exactly the 33 provider operations in contract order", () => {
		expect([...providerOperations]).toEqual([
			"catalog.product.subscription",
			"catalog.product.consumable",
			"catalog.product.non_consumable",
			"catalog.trial",
			"catalog.addon",
			"catalog.topup",
			"catalog.price.flat",
			"catalog.price.licensed",
			"catalog.price.tiered",
			"catalog.price.hybrid",
			"catalog.price.postpaid_usage",
			"checkout.hosted",
			"checkout.plan",
			"purchase.verify",
			"portal.session",
			"payment_method.setup",
			"webhook.ingest",
			"event.replay",
			"subscription.reconcile",
			"trial.ending_notice",
			"subscription.change.preview",
			"subscription.change.apply",
			"subscription.change.period_end",
			"subscription.cancel",
			"subscription.uncancel",
			"subscription.create",
			"settlement.collect_finalized_charge",
			"adjustment.issue",
			"refund.sync",
			"topup.customer_initiated",
			"topup.automatic",
			"promotion.code_entry",
			"promotion.hosted_code",
		]);
		expect(new Set(providerOperations).size).toBe(33);
	});

	it("defines every operation with a domain, a unique title and a provider-neutral sentence", () => {
		expect(Object.keys(providerOperationDefinitions)).toEqual([...providerOperations]);
		const titles = new Set<string>();
		for (const operation of providerOperations) {
			const definition = providerOperationDefinitions[operation];
			expect(providerOperationDomains).toContain(definition.domain);
			expect(definition.title.trim()).not.toBe("");
			titles.add(definition.title);
			expect(definition.description).toMatch(/^[A-Z][^\n]+\.$/);
			expect(definition.description).not.toMatch(/\b(apple|google|stripe|paddle)\b/i);
		}
		expect(titles.size).toBe(providerOperations.length);
	});

	it("orders domains as contiguous groups of the operation order", () => {
		const domainSequence = providerOperations.map(
			(operation) => providerOperationDefinitions[operation].domain,
		);
		expect([...new Set(domainSequence)]).toEqual([...providerOperationDomains]);
		for (const domain of providerOperationDomains) {
			const first = domainSequence.indexOf(domain);
			const last = domainSequence.lastIndexOf(domain);
			expect(domainSequence.slice(first, last + 1).every((entry) => entry === domain)).toBe(true);
			expect(providerOperationDomainTitles[domain].trim()).not.toBe("");
		}
		expect(Object.keys(providerOperationDomainTitles)).toEqual([...providerOperationDomains]);
		expect(providerOperationDefinitions["adjustment.issue"].domain).toBe("settlement");
		expect(providerOperationDefinitions["subscription.reconcile"].domain).toBe("events");
	});

	it("labels support levels", () => {
		expect([...supportLevels]).toEqual([
			"native",
			"quotum_composed",
			"provider_managed",
			"unsupported",
			"not_evaluated",
		]);
		expect(supportLevelLabels).toEqual({
			native: "Native",
			quotum_composed: "Quotum-composed",
			provider_managed: "Managed by provider, mirrored by Quotum",
			unsupported: "Unsupported",
			not_evaluated: "Not evaluated",
		});
	});

	it("binds every condition kind to exactly one of the two condition layers", () => {
		expect([...capabilityLayers]).toEqual([
			"provider",
			"implementation",
			"configuration",
			"operation",
		]);
		expect(Object.keys(conditionLayer)).toEqual([...capabilityConditionKinds]);
		expect(
			capabilityConditionKinds.filter((kind) => conditionLayer[kind] === "configuration"),
		).toEqual([
			"connection_enabled",
			"connection_validated",
			"account_flag",
			"currency",
			"catalog_bound",
		]);
		expect(capabilityConditionKinds.filter((kind) => conditionLayer[kind] === "operation")).toEqual(
			[
				"subscription_state",
				"cancellation_pending",
				"collection_method",
				"billing_interval",
				"uniform_billing_interval",
				"saved_payment_method",
				"renewal_exclusion_window",
				"requires_prior",
				"amount_bounds",
				"quantity_integer",
			],
		);
		expect(Object.keys(conditionReasonCode)).toEqual([...capabilityConditionKinds]);
		for (const code of Object.values(conditionReasonCode)) {
			expect(capabilityReasonCodes).toContain(code);
		}
	});

	it("includes every required reason code", () => {
		for (const code of [
			"PROVIDER_UNSUPPORTED",
			"CAPABILITY_NOT_EVALUATED",
			"PROVIDER_MANAGED",
			"IMPLEMENTATION_PLANNED",
			"CONNECTION_DISABLED",
			"CONNECTION_VALIDATION_REQUIRED",
			"ACCOUNT_FLAG_REQUIRED",
			"CURRENCY_UNSUPPORTED",
			"CATALOG_BINDING_REQUIRED",
			"SUBSCRIPTION_STATE",
			"COLLECTION_METHOD",
			"BILLING_INTERVAL",
			"SAVED_PAYMENT_METHOD_REQUIRED",
			"RENEWAL_EXCLUSION_WINDOW",
			"PRIOR_OPERATION_REQUIRED",
			"AMOUNT_OUT_OF_BOUNDS",
			"QUANTITY_NOT_INTEGER",
			"FACT_UNAVAILABLE",
		] as const) {
			expect(capabilityReasonCodes).toContain(code);
		}
	});

	it("lists all six change billing policies once", () => {
		expect(changeBillingPolicies).toEqual([
			{ billing: "prorated", collection: "immediate" },
			{ billing: "prorated", collection: "next_renewal" },
			{ billing: "full", collection: "immediate" },
			{ billing: "full", collection: "next_renewal" },
			{ billing: "none", collection: "immediate" },
			{ billing: "none", collection: "next_renewal" },
		]);
	});
});

interface ConditionCase {
	name: string;
	condition: CapabilityCondition;
	passing: CapabilityFacts[];
	failing: Array<{
		facts: CapabilityFacts;
		observed: CapabilityReason["observed"];
		resolution: CapabilityResolution;
	}>;
	missing: Array<{ facts: CapabilityFacts; observed: CapabilityReason["observed"] }>;
}

const merchantConfiguration: CapabilityResolution = {
	kind: "merchant_configuration",
	connectionKind: "stripe",
};
const none: CapabilityResolution = { kind: "none" };

const conditionCases: ConditionCase[] = [
	{
		name: "connection_enabled",
		condition: { kind: "connection_enabled" },
		passing: [{ configuration: configured }],
		failing: [
			{
				facts: { configuration: { ...configured, connectionEnabled: false } },
				observed: { connectionEnabled: false },
				resolution: merchantConfiguration,
			},
		],
		missing: [{ facts: { operation: {} }, observed: { connectionEnabled: null } }],
	},
	{
		name: "connection_validated",
		condition: { kind: "connection_validated" },
		passing: [{ configuration: configured }],
		failing: [
			{
				facts: { configuration: { ...configured, connectionValidated: false } },
				observed: { connectionValidated: false },
				resolution: merchantConfiguration,
			},
		],
		missing: [{ facts: {}, observed: { connectionValidated: null } }],
	},
	{
		name: "account_flag with a boolean",
		condition: { kind: "account_flag", flag: "spmConsent", expected: [true] },
		passing: [{ configuration: { ...configured, accountFlags: { spmConsent: true } } }],
		failing: [
			{
				facts: { configuration: { ...configured, accountFlags: { spmConsent: false } } },
				observed: { flag: "spmConsent", value: false },
				resolution: { ...merchantConfiguration, flag: "spmConsent" },
			},
		],
		missing: [
			{ facts: { configuration: configured }, observed: { flag: "spmConsent", value: null } },
			{ facts: {}, observed: { flag: "spmConsent", value: null } },
		],
	},
	{
		name: "account_flag with strings",
		condition: { kind: "account_flag", flag: "taxMode", expected: ["registered", "test"] },
		passing: [
			{ configuration: { ...configured, accountFlags: { taxMode: "test" } } },
			{ configuration: { ...configured, accountFlags: { taxMode: "registered" } } },
		],
		failing: [
			{
				facts: { configuration: { ...configured, accountFlags: { taxMode: "disabled" } } },
				observed: { flag: "taxMode", value: "disabled" },
				resolution: { ...merchantConfiguration, flag: "taxMode" },
			},
			{
				facts: { configuration: { ...configured, accountFlags: { taxMode: true } } },
				observed: { flag: "taxMode", value: true },
				resolution: { ...merchantConfiguration, flag: "taxMode" },
			},
		],
		missing: [
			{
				facts: { configuration: configured },
				observed: { flag: "taxMode", value: null },
			},
		],
	},
	{
		name: "currency",
		condition: { kind: "currency", allowed: ["USD", "eur"] },
		passing: [
			{ configuration: { ...configured, currencies: ["usd", "EUR"] } },
			{ configuration: { ...configured, currencies: [] } },
		],
		failing: [
			{
				facts: { configuration: { ...configured, currencies: ["USD", "jpy", "GBP", "JPY"] } },
				observed: { currencies: "GBP,JPY,USD", unsupported: "GBP,JPY" },
				resolution: none,
			},
		],
		missing: [{ facts: { configuration: configured }, observed: { currencies: null } }],
	},
	{
		name: "catalog_bound",
		condition: { kind: "catalog_bound" },
		passing: [{ configuration: { ...configured, catalogBound: true } }],
		failing: [
			{
				facts: { configuration: { ...configured, catalogBound: false } },
				observed: { catalogBound: false },
				resolution: merchantConfiguration,
			},
		],
		missing: [{ facts: { configuration: configured }, observed: { catalogBound: null } }],
	},
	{
		name: "subscription_state",
		condition: { kind: "subscription_state", allowed: ["active", "grace_period"] },
		passing: [{ operation: { subscriptionState: "grace_period" } }],
		failing: [
			{
				facts: { operation: { subscriptionState: "billing_retry" } },
				observed: { subscriptionState: "billing_retry" },
				resolution: none,
			},
		],
		missing: [
			{ facts: { operation: {} }, observed: { subscriptionState: null } },
			{ facts: { configuration: configured }, observed: { subscriptionState: null } },
		],
	},
	{
		name: "cancellation_pending",
		condition: { kind: "cancellation_pending", required: true },
		passing: [{ operation: { cancellationPending: true } }],
		failing: [
			{
				facts: { operation: { cancellationPending: false } },
				observed: { cancellationPending: false },
				resolution: none,
			},
		],
		missing: [{ facts: { operation: {} }, observed: { cancellationPending: null } }],
	},
	{
		name: "collection_method",
		condition: { kind: "collection_method", allowed: ["automatic"] },
		passing: [{ operation: { collectionMethod: "automatic" } }],
		failing: [
			{
				facts: { operation: { collectionMethod: "manual" } },
				observed: { collectionMethod: "manual" },
				resolution: none,
			},
		],
		missing: [{ facts: { operation: {} }, observed: { collectionMethod: null } }],
	},
	{
		name: "billing_interval",
		condition: { kind: "billing_interval", allowed: ["month"] },
		passing: [
			{ operation: { billingIntervals: ["month", "month"] } },
			{ operation: { billingIntervals: [] } },
		],
		failing: [
			{
				facts: { operation: { billingIntervals: ["month", "year", "year"] } },
				observed: { billingIntervals: "month,year" },
				resolution: none,
			},
		],
		missing: [{ facts: { operation: {} }, observed: { billingIntervals: null } }],
	},
	{
		name: "uniform_billing_interval",
		condition: { kind: "uniform_billing_interval" },
		passing: [
			{ operation: { billingIntervals: ["year", "year"] } },
			{ operation: { billingIntervals: [] } },
		],
		failing: [
			{
				facts: { operation: { billingIntervals: ["month", "year", "month"] } },
				observed: { billingIntervals: "month,year" },
				resolution: none,
			},
		],
		missing: [{ facts: { operation: {} }, observed: { billingIntervals: null } }],
	},
	{
		name: "saved_payment_method with a resolving operation",
		condition: {
			kind: "saved_payment_method",
			required: true,
			resolveWith: "topup.customer_initiated",
		},
		passing: [{ operation: { savedPaymentMethod: true } }],
		failing: [
			{
				facts: { operation: { savedPaymentMethod: false } },
				observed: { savedPaymentMethod: false },
				resolution: { kind: "customer_action", operation: "topup.customer_initiated" },
			},
		],
		missing: [
			{ facts: { operation: {} }, observed: { savedPaymentMethod: null } },
			{
				facts: { operation: { savedPaymentMethod: "unknown" } },
				observed: { savedPaymentMethod: "unknown" },
			},
		],
	},
	{
		name: "saved_payment_method without a resolving operation",
		condition: { kind: "saved_payment_method", required: true },
		passing: [{ operation: { savedPaymentMethod: true } }],
		failing: [
			{
				facts: { operation: { savedPaymentMethod: false } },
				observed: { savedPaymentMethod: false },
				resolution: { kind: "customer_action" },
			},
		],
		missing: [{ facts: {}, observed: { savedPaymentMethod: null } }],
	},
	{
		name: "renewal_exclusion_window",
		condition: { kind: "renewal_exclusion_window", minutes: 30 },
		passing: [
			{ operation: { nextRenewalAt: renewalAt, now: "2026-09-30T23:29:59.999Z" } },
			{ operation: { nextRenewalAt: renewalAt, now: renewalAt } },
			{ operation: { nextRenewalAt: renewalAt, now: "2026-10-01T00:10:00.000Z" } },
		],
		failing: [
			{
				facts: { operation: { nextRenewalAt: renewalAt, now: "2026-09-30T23:30:00.000Z" } },
				observed: { nextRenewalAt: renewalAt, now: "2026-09-30T23:30:00.000Z", minutes: 30 },
				resolution: { kind: "wait_until", at: renewalAt },
			},
			{
				facts: { operation: { nextRenewalAt: renewalAt, now: "2026-09-30T23:59:59.999Z" } },
				observed: { nextRenewalAt: renewalAt, now: "2026-09-30T23:59:59.999Z", minutes: 30 },
				resolution: { kind: "wait_until", at: renewalAt },
			},
		],
		missing: [
			{
				facts: { operation: { now: "2026-09-30T23:45:00.000Z" } },
				observed: { nextRenewalAt: null, now: "2026-09-30T23:45:00.000Z" },
			},
			{
				facts: { operation: { nextRenewalAt: renewalAt } },
				observed: { nextRenewalAt: renewalAt, now: null },
			},
			{
				facts: { operation: { nextRenewalAt: "soon", now: "2026-09-30T23:45:00.000Z" } },
				observed: { nextRenewalAt: "soon", now: "2026-09-30T23:45:00.000Z" },
			},
		],
	},
	{
		name: "requires_prior",
		condition: { kind: "requires_prior", operation: "checkout.plan" },
		passing: [{ operation: { completedOperations: ["checkout.hosted", "checkout.plan"] } }],
		failing: [
			{
				facts: { operation: { completedOperations: ["checkout.hosted", "portal.session"] } },
				observed: { completedOperations: "checkout.hosted,portal.session" },
				resolution: { kind: "customer_action", operation: "checkout.plan" },
			},
			{
				facts: { operation: { completedOperations: [] } },
				observed: { completedOperations: "" },
				resolution: { kind: "customer_action", operation: "checkout.plan" },
			},
		],
		missing: [{ facts: { operation: {} }, observed: { completedOperations: null } }],
	},
	{
		name: "amount_bounds with both bounds",
		condition: { kind: "amount_bounds", minMinor: 100, maxMinor: 5000 },
		passing: [{ operation: { amountMinor: 100 } }, { operation: { amountMinor: 5000 } }],
		failing: [
			{
				facts: { operation: { amountMinor: 99 } },
				observed: { amountMinor: 99, minMinor: 100, maxMinor: 5000 },
				resolution: none,
			},
			{
				facts: { operation: { amountMinor: 5001 } },
				observed: { amountMinor: 5001, minMinor: 100, maxMinor: 5000 },
				resolution: none,
			},
		],
		missing: [{ facts: { operation: {} }, observed: { amountMinor: null } }],
	},
	{
		name: "amount_bounds with a minimum only",
		condition: { kind: "amount_bounds", minMinor: 100 },
		passing: [{ operation: { amountMinor: 1_000_000 } }],
		failing: [
			{
				facts: { operation: { amountMinor: 0 } },
				observed: { amountMinor: 0, minMinor: 100, maxMinor: null },
				resolution: none,
			},
		],
		missing: [{ facts: { operation: {} }, observed: { amountMinor: null } }],
	},
	{
		name: "quantity_integer",
		condition: { kind: "quantity_integer" },
		passing: [{ operation: { quantityIsInteger: true } }],
		failing: [
			{
				facts: { operation: { quantityIsInteger: false } },
				observed: { quantityIsInteger: false },
				resolution: none,
			},
		],
		missing: [{ facts: { operation: {} }, observed: { quantityIsInteger: null } }],
	},
];

function evaluateCondition(condition: CapabilityCondition, facts: CapabilityFacts) {
	return evaluateCapability(
		declaration({ "topup.automatic": conditional([condition]) }),
		"topup.automatic",
		facts,
	);
}

describe("evaluateCapability conditions", () => {
	it("covers every condition kind", () => {
		expect(new Set(conditionCases.map(({ condition }) => condition.kind))).toEqual(
			new Set(capabilityConditionKinds),
		);
	});

	for (const testCase of conditionCases) {
		const layer = conditionLayer[testCase.condition.kind];

		it(`${testCase.name} passes when the fact satisfies it`, () => {
			for (const facts of testCase.passing) {
				expect(evaluateCondition(testCase.condition, facts)).toEqual({
					provider: "stripe",
					operation: "topup.automatic",
					outcome: "available",
					level: "native",
					blockingLayer: null,
					reasons: [],
				});
			}
		});

		it(`${testCase.name} blocks at the ${layer} layer when the fact fails it`, () => {
			for (const failure of testCase.failing) {
				expect(evaluateCondition(testCase.condition, failure.facts)).toEqual({
					provider: "stripe",
					operation: "topup.automatic",
					outcome: "blocked",
					level: "native",
					blockingLayer: layer,
					reasons: [
						{
							code: conditionReasonCode[testCase.condition.kind],
							layer,
							condition: testCase.condition,
							observed: failure.observed,
							resolution: failure.resolution,
						},
					],
				});
			}
		});

		it(`${testCase.name} is undetermined when the fact is unavailable`, () => {
			for (const missing of testCase.missing) {
				expect(evaluateCondition(testCase.condition, missing.facts)).toEqual({
					provider: "stripe",
					operation: "topup.automatic",
					outcome: "undetermined",
					level: "native",
					blockingLayer: null,
					reasons: [
						{
							code: "FACT_UNAVAILABLE",
							layer,
							condition: testCase.condition,
							observed: missing.observed,
							resolution: { kind: "checked_at_execution" },
						},
					],
				});
			}
		});
	}

	it("reports the uniform interval failure with the billing interval code", () => {
		const verdict = evaluateCondition(
			{ kind: "uniform_billing_interval" },
			{ operation: { billingIntervals: ["month", "year"] } },
		);
		expect(verdict.reasons.map(({ code }) => code)).toEqual(["BILLING_INTERVAL"]);
	});
});

describe("evaluateCapability layers", () => {
	const disabledConnection: CapabilityCondition = { kind: "connection_enabled" };
	const activeSubscription: CapabilityCondition = {
		kind: "subscription_state",
		allowed: ["active"],
	};
	const failingFacts: CapabilityFacts = {
		configuration: { ...configured, connectionEnabled: false },
		operation: { subscriptionState: "expired" },
	};

	it.each([
		["unsupported", "PROVIDER_UNSUPPORTED"],
		["not_evaluated", "CAPABILITY_NOT_EVALUATED"],
		["provider_managed", "PROVIDER_MANAGED"],
	] as const)("blocks %s support at the provider layer and stops there", (level, code) => {
		const support: OperationSupport = {
			level,
			verification: { status: "planned" },
			conditions: [disabledConnection, activeSubscription],
		};
		expect(
			evaluateCapability(plannedPaddle({ "refund.sync": support }), "refund.sync", failingFacts),
		).toEqual({
			provider: "paddle",
			operation: "refund.sync",
			outcome: "blocked",
			level,
			blockingLayer: "provider",
			reasons: [{ code, layer: "provider", observed: { level }, resolution: { kind: "none" } }],
		});
	});

	it("passes native and quotum-composed support through the provider layer", () => {
		const composed: OperationSupport = {
			...verifiedNative,
			level: "quotum_composed",
			composedVia: "one-time charge",
		};
		const subject = declaration({
			"checkout.hosted": verifiedNative,
			"adjustment.issue": composed,
		});
		expect(evaluateCapability(subject, "checkout.hosted", {}).outcome).toBe("available");
		const verdict = evaluateCapability(subject, "adjustment.issue", {});
		expect(verdict).toEqual({
			provider: "stripe",
			operation: "adjustment.issue",
			outcome: "available",
			level: "quotum_composed",
			composedVia: "one-time charge",
			blockingLayer: null,
			reasons: [],
		});
		expect("composedVia" in evaluateCapability(subject, "checkout.hosted", {})).toBe(false);
	});

	it("blocks a planned declaration at the implementation layer and stops there", () => {
		const support = planned({ trackedBy: "P4" }, [disabledConnection, activeSubscription]);
		expect(
			evaluateCapability(
				plannedPaddle({ "checkout.plan": support }),
				"checkout.plan",
				failingFacts,
			),
		).toEqual({
			provider: "paddle",
			operation: "checkout.plan",
			outcome: "blocked",
			level: "native",
			blockingLayer: "implementation",
			reasons: [
				{
					code: "IMPLEMENTATION_PLANNED",
					layer: "implementation",
					observed: { availability: "planned", verificationStatus: "planned" },
					resolution: { kind: "none" },
				},
			],
		});
	});

	it("blocks planned or not-applicable verification at the implementation layer", () => {
		for (const verification of [{ status: "planned" }, { status: "not_applicable" }] as const) {
			const verdict = evaluateCapability(
				declaration({ "checkout.plan": { level: "native", verification, conditions: [] } }),
				"checkout.plan",
				{},
			);
			expect(verdict.blockingLayer).toBe("implementation");
			expect(verdict.reasons).toEqual([
				{
					code: "IMPLEMENTATION_PLANNED",
					layer: "implementation",
					observed: { availability: "available", verificationStatus: verification.status },
					resolution: { kind: "none" },
				},
			]);
		}
	});

	it("blocks verified support of a planned declaration at the implementation layer", () => {
		const verdict = evaluateCapability(
			plannedPaddle({ "checkout.plan": verifiedNative }),
			"checkout.plan",
			{},
		);
		expect(verdict.outcome).toBe("blocked");
		expect(verdict.reasons.map(({ code }) => code)).toEqual(["IMPLEMENTATION_PLANNED"]);
	});

	it("stops after the first blocked layer so a lower layer never implies a higher one", () => {
		const verdict = evaluateCapability(
			declaration({ "topup.automatic": conditional([activeSubscription, disabledConnection]) }),
			"topup.automatic",
			failingFacts,
		);
		expect(verdict.outcome).toBe("blocked");
		expect(verdict.blockingLayer).toBe("configuration");
		expect(verdict.reasons.map(({ code, layer }) => [layer, code])).toEqual([
			["configuration", "CONNECTION_DISABLED"],
		]);
	});

	it("continues past an undetermined layer and orders reasons by layer", () => {
		const verdict = evaluateCapability(
			declaration({ "topup.automatic": conditional([activeSubscription, disabledConnection]) }),
			"topup.automatic",
			{ operation: { subscriptionState: "expired" } },
		);
		expect(verdict.outcome).toBe("blocked");
		expect(verdict.blockingLayer).toBe("operation");
		expect(verdict.reasons.map(({ code, layer }) => [layer, code])).toEqual([
			["configuration", "FACT_UNAVAILABLE"],
			["operation", "SUBSCRIPTION_STATE"],
		]);
	});

	it("collects every failing and unavailable condition of the blocking layer in declared order", () => {
		const verdict = evaluateCapability(
			declaration({
				"topup.automatic": conditional([
					{ kind: "catalog_bound" },
					{ kind: "account_flag", flag: "spmConsent", expected: [true] },
					disabledConnection,
					{ kind: "connection_validated" },
				]),
			}),
			"topup.automatic",
			{
				configuration: {
					...configured,
					connectionEnabled: false,
					accountFlags: { spmConsent: false },
				},
			},
		);
		expect(verdict.outcome).toBe("blocked");
		expect(verdict.reasons.map(({ code }) => code)).toEqual([
			"FACT_UNAVAILABLE",
			"ACCOUNT_FLAG_REQUIRED",
			"CONNECTION_DISABLED",
		]);
	});

	it("aggregates outcomes as available, undetermined or blocked", () => {
		const subject = declaration({
			"topup.automatic": conditional([activeSubscription, { kind: "quantity_integer" }]),
		});
		expect(
			evaluateCapability(subject, "topup.automatic", {
				operation: { subscriptionState: "active", quantityIsInteger: true },
			}).outcome,
		).toBe("available");
		const undetermined = evaluateCapability(subject, "topup.automatic", {
			operation: { subscriptionState: "active" },
		});
		expect(undetermined.outcome).toBe("undetermined");
		expect(undetermined.blockingLayer).toBeNull();
		const blocked = evaluateCapability(subject, "topup.automatic", {
			operation: { subscriptionState: "expired" },
		});
		expect(blocked.outcome).toBe("blocked");
		expect(blocked.reasons.map(({ code }) => code)).toEqual([
			"SUBSCRIPTION_STATE",
			"FACT_UNAVAILABLE",
		]);
	});

	it("stops after the requested layer", () => {
		const support = planned({}, [disabledConnection, activeSubscription]);
		const subject = declaration({
			"checkout.plan": support,
			"topup.automatic": conditional([disabledConnection, activeSubscription]),
		});

		expect(
			evaluateCapability(subject, "checkout.plan", failingFacts, { through: "provider" }),
		).toEqual({
			provider: "stripe",
			operation: "checkout.plan",
			outcome: "available",
			level: "native",
			blockingLayer: null,
			reasons: [],
		});
		expect(
			evaluateCapability(subject, "checkout.plan", failingFacts, { through: "implementation" })
				.blockingLayer,
		).toBe("implementation");
		expect(
			evaluateCapability(subject, "topup.automatic", failingFacts, { through: "implementation" })
				.outcome,
		).toBe("available");
		const throughConfiguration = evaluateCapability(
			subject,
			"topup.automatic",
			{ operation: { subscriptionState: "expired" } },
			{ through: "configuration" },
		);
		expect(throughConfiguration.outcome).toBe("undetermined");
		expect(throughConfiguration.reasons.map(({ layer }) => layer)).toEqual(["configuration"]);
		expect(
			evaluateCapability(
				subject,
				"topup.automatic",
				{ configuration: configured, operation: { subscriptionState: "expired" } },
				{ through: "configuration" },
			).outcome,
		).toBe("available");
		expect(
			evaluateCapability(subject, "topup.automatic", {
				configuration: configured,
				operation: { subscriptionState: "expired" },
			}).blockingLayer,
		).toBe("operation");
	});

	it("rejects an unknown layer, an undeclared operation and an unknown condition kind", () => {
		const subject = declaration({
			"topup.automatic": conditional([
				{ kind: "tax_registered" } as unknown as CapabilityCondition,
			]),
		});
		expect(() =>
			evaluateCapability(
				subject,
				"checkout.plan",
				{},
				{
					through: "merchant" as unknown as "operation",
				},
			),
		).toThrow("Unknown capability layer: merchant");
		const partial = { ...subject, operations: {} } as ProviderCapabilityDeclaration;
		expect(() => evaluateCapability(partial, "checkout.plan", {})).toThrow(
			"Capability declaration for stripe does not declare checkout.plan",
		);
		expect(() => evaluateCapability(subject, "topup.automatic", {})).toThrow(
			"Unknown capability condition kind: tax_registered",
		);
	});
});

function issuePaths(subject: ProviderCapabilityDeclaration): string[] {
	return validateDeclaration(subject).map(({ path }) => path);
}

function withFields(fields: Record<string, unknown>): ProviderCapabilityDeclaration {
	return { ...declaration(), ...fields } as ProviderCapabilityDeclaration;
}

function withSupport(
	operation: ProviderOperation,
	support: unknown,
): ProviderCapabilityDeclaration {
	return declaration({ [operation]: support as OperationSupport });
}

describe("validateDeclaration", () => {
	it("accepts well-formed available and planned declarations", () => {
		const available = declaration(
			{
				"checkout.hosted": verifiedNative,
				"adjustment.issue": {
					level: "quotum_composed",
					composedVia: "one-time charge",
					verification: {
						status: "verified",
						verifiedOn: "2026-02-28",
						evidence: { tests: [], scenarios: ["UNC-01"], questions: [] },
					},
					conditions: [],
				},
				"topup.automatic": {
					...conditional([
						{ kind: "account_flag", flag: "spmConsent", expected: [true] },
						{
							kind: "saved_payment_method",
							required: true,
							resolveWith: "topup.customer_initiated",
						},
						{ kind: "renewal_exclusion_window", minutes: 30 },
						{ kind: "requires_prior", operation: "checkout.plan" },
						{ kind: "amount_bounds", maxMinor: 100_000 },
						{ kind: "billing_interval", allowed: ["month", "year"] },
						{ kind: "collection_method", allowed: ["automatic"] },
						{ kind: "currency", allowed: ["USD"] },
						{ kind: "subscription_state", allowed: ["active"] },
					]),
					notes: "Charges run off-session.",
				},
				"portal.session": {
					level: "native",
					verification: {
						status: "conditional",
						verifiedOn: "2026-09-16",
						note: "Needs a configured portal.",
						evidence,
					},
					conditions: [],
				},
				"settlement.collect_finalized_charge": planned({
					blockedBy: { kind: "decision", ref: "DEC-14" },
				}),
				"refund.sync": { ...verifiedNative, level: "provider_managed" },
				"webhook.ingest": {
					level: "unsupported",
					verification: { status: "not_applicable" },
					conditions: [],
				},
			},
			{
				limits: {
					requestsPerMinute: 240,
					webhookRetries: { attempts: 60, windowHours: 72 },
					webhookOrdering: "unordered",
				},
				changeBillingPolicies: [...changeBillingPolicies],
			},
		);
		expect(validateDeclaration(available)).toEqual([]);
		expect(() => assertValidDeclaration(available)).not.toThrow();

		const paddle = plannedPaddle({
			"checkout.plan": planned({ trackedBy: "P4" }),
			"subscription.change.apply": planned({ blockedBy: { kind: "scenario", ref: "LIFE-03" } }),
			"refund.sync": {
				level: "provider_managed",
				verification: { status: "not_applicable" },
				conditions: [],
			},
		});
		expect(validateDeclaration(paddle)).toEqual([]);
	});

	it.each([
		["an unknown provider", withFields({ provider: "adyen" }), ["provider"]],
		["an unknown channel", withFields({ channel: "desktop" }), ["channel"]],
		["a blank connection kind", withFields({ connectionKind: " " }), ["connectionKind"]],
		["an unknown availability", withFields({ availability: "beta" }), ["availability"]],
		["a planned admitted provider", withFields({ availability: "planned" }), ["availability"]],
		[
			"an available planned provider",
			declaration({}, { provider: "paddle", availability: "available" }),
			["availability"],
		],
		["missing write semantics", withFields({ writeSemantics: undefined }), ["writeSemantics"]],
		[
			"unknown write semantics values",
			withFields({ writeSemantics: { clientIdempotencyKeys: "yes", uncertainWrite: "retry" } }),
			["writeSemantics.clientIdempotencyKeys", "writeSemantics.uncertainWrite"],
		],
	])("reports %s", (_name, subject, paths) => {
		expect(issuePaths(subject)).toEqual(paths);
	});

	it("requires every operation id and rejects unknown ones", () => {
		const subject = declaration();
		const operations = { ...subject.operations } as Record<string, OperationSupport>;
		delete operations["refund.sync"];
		operations["subscription.pause"] = notEvaluated;
		expect(issuePaths({ ...subject, operations } as ProviderCapabilityDeclaration)).toEqual([
			"operations.refund.sync",
			"operations.subscription.pause",
		]);
		expect(issuePaths(withFields({ operations: undefined }))).toEqual(["operations"]);
	});

	it.each([
		[
			"composed support without its primitive",
			{ ...verifiedNative, level: "quotum_composed" },
			[".composedVia"],
		],
		[
			"a primitive on native support",
			{ ...verifiedNative, composedVia: "charge" },
			[".composedVia"],
		],
		["an unknown level", { ...verifiedNative, level: "partial" }, [".level"]],
		[
			"native support marked not applicable",
			{ level: "native", verification: { status: "not_applicable" }, conditions: [] },
			[".verification.status"],
		],
		[
			"unsupported support with a planned verification",
			{ level: "unsupported", verification: { status: "planned" }, conditions: [] },
			[".verification.status"],
		],
		[
			"not evaluated support claiming verification",
			{ ...verifiedNative, level: "not_evaluated" },
			[".verification.status"],
		],
		[
			"an unknown verification status",
			{ ...verifiedNative, verification: { status: "done" } },
			[".verification.status"],
		],
		[
			"a malformed verification date",
			{
				...verifiedNative,
				verification: { status: "verified", verifiedOn: "2026-9-16", evidence },
			},
			[".verification.verifiedOn"],
		],
		[
			"an impossible verification date",
			{
				...verifiedNative,
				verification: { status: "verified", verifiedOn: "2026-02-30", evidence },
			},
			[".verification.verifiedOn"],
		],
		[
			"verification without evidence",
			{ ...verifiedNative, verification: { status: "verified", verifiedOn: "2026-09-16" } },
			[".verification.evidence"],
		],
		[
			"verification backed only by questions",
			{
				...verifiedNative,
				verification: {
					status: "conditional",
					verifiedOn: "2026-09-16",
					note: "Only with a portal.",
					evidence: { tests: [], scenarios: [], questions: ["Q-PORT-01"] },
				},
			},
			[".verification.evidence"],
		],
		[
			"blank evidence entries",
			{
				...verifiedNative,
				verification: {
					status: "verified",
					verifiedOn: "2026-09-16",
					evidence: { tests: ["tests/a.test.ts", ""], scenarios: [], questions: [] },
				},
			},
			[".verification.evidence.tests"],
		],
		[
			"conditional support with neither a condition nor a note",
			{
				...verifiedNative,
				verification: { status: "conditional", verifiedOn: "2026-09-16", evidence },
			},
			[".verification"],
		],
		[
			"an unknown blocker kind",
			planned({ blockedBy: { kind: "ticket", ref: "T-1" } as never }),
			[".verification.blockedBy"],
		],
		["a blank tracking reference", planned({ trackedBy: "" }), [".verification.trackedBy"]],
		["missing conditions", { ...verifiedNative, conditions: undefined }, [".conditions"]],
		[
			"an unknown condition kind",
			conditional([{ kind: "tax_registered" } as unknown as CapabilityCondition]),
			[".conditions.0.kind"],
		],
		[
			"a prior operation that does not exist",
			conditional([{ kind: "requires_prior", operation: "checkout.paid" as ProviderOperation }]),
			[".conditions.0.operation"],
		],
		[
			"an operation that requires itself",
			conditional([{ kind: "requires_prior", operation: "topup.automatic" }]),
			[".conditions.0.operation"],
		],
		[
			"a saved payment method resolved by an unknown operation",
			conditional([
				{
					kind: "saved_payment_method",
					required: true,
					resolveWith: "checkout.paid" as ProviderOperation,
				},
			]),
			[".conditions.0.resolveWith"],
		],
		[
			"an optional saved payment method",
			conditional([{ kind: "saved_payment_method", required: false } as never]),
			[".conditions.0.required"],
		],
		[
			"an account flag without expected values",
			conditional([{ kind: "account_flag", flag: "", expected: [] }]),
			[".conditions.0.flag", ".conditions.0.expected"],
		],
		[
			"an empty currency list",
			conditional([{ kind: "currency", allowed: [] }]),
			[".conditions.0.allowed"],
		],
		[
			"a blank subscription state",
			conditional([{ kind: "subscription_state", allowed: ["active", " "] }]),
			[".conditions.0.allowed"],
		],
		[
			"an unknown collection method",
			conditional([{ kind: "collection_method", allowed: ["invoice" as never] }]),
			[".conditions.0.allowed"],
		],
		[
			"an unknown billing interval",
			conditional([{ kind: "billing_interval", allowed: ["week" as never] }]),
			[".conditions.0.allowed"],
		],
		[
			"a non-positive renewal window",
			conditional([{ kind: "renewal_exclusion_window", minutes: 0 }]),
			[".conditions.0.minutes"],
		],
		["amount bounds without a bound", conditional([{ kind: "amount_bounds" }]), [".conditions.0"]],
		[
			"inverted amount bounds",
			conditional([{ kind: "amount_bounds", minMinor: 500, maxMinor: 100 }]),
			[".conditions.0"],
		],
		[
			"fractional amount bounds",
			conditional([{ kind: "amount_bounds", minMinor: -1, maxMinor: 1.5 }]),
			[".conditions.0.minMinor", ".conditions.0.maxMinor"],
		],
	])("reports %s", (_name, support, suffixes) => {
		expect(issuePaths(withSupport("topup.automatic", support))).toEqual(
			suffixes.map((suffix) => `operations.topup.automatic${suffix}`),
		);
	});

	it("rejects verified or conditional entries in a planned declaration", () => {
		expect(
			issuePaths(
				plannedPaddle({
					"checkout.plan": verifiedNative,
					"portal.session": conditional([{ kind: "connection_enabled" }]),
				}),
			),
		).toEqual([
			"operations.checkout.plan.verification.status",
			"operations.portal.session.verification.status",
		]);
	});

	it("requires unique, known change billing policies", () => {
		expect(
			issuePaths(
				declaration(
					{},
					{
						changeBillingPolicies: [
							{ billing: "prorated", collection: "immediate" },
							{ billing: "prorated", collection: "immediate" },
							{ billing: "partial", collection: "immediate" } as never,
						],
					},
				),
			),
		).toEqual(["changeBillingPolicies.1", "changeBillingPolicies.2"]);
		expect(issuePaths(withFields({ changeBillingPolicies: "all" }))).toEqual([
			"changeBillingPolicies",
		]);
	});

	it("requires positive integer limits and a known webhook ordering", () => {
		expect(
			issuePaths(
				withFields({
					limits: {
						requestsPerMinute: 1.5,
						webhookRetries: { attempts: 0, windowHours: -72 },
						webhookOrdering: "random",
					},
				}),
			),
		).toEqual([
			"limits.requestsPerMinute",
			"limits.webhookRetries.attempts",
			"limits.webhookRetries.windowHours",
			"limits.webhookOrdering",
		]);
		expect(issuePaths(withFields({ limits: { webhookRetries: 60 } }))).toEqual([
			"limits.webhookRetries",
		]);
		expect(issuePaths(withFields({ limits: [] }))).toEqual(["limits"]);
	});

	it("throws every issue from assertValidDeclaration", () => {
		expect(() =>
			assertValidDeclaration(
				declaration(
					{ "checkout.plan": { ...verifiedNative, level: "quotum_composed" } },
					{ availability: "planned" },
				),
			),
		).toThrow(
			"Invalid capability declaration for stripe: availability: Admitted provider stripe must be available; operations.checkout.plan.composedVia: Quotum-composed support must name the primitive it composes; operations.checkout.plan.verification.status: A planned declaration cannot claim verified support",
		);
	});
});

describe("capability status labels", () => {
	const conditions: CapabilityCondition[] = [{ kind: "connection_enabled" }];
	const cases: Array<[string, OperationSupport, CapabilityStatusLabelId]> = [
		["unsupported support", { ...notEvaluated, level: "unsupported" }, "unsupported"],
		[
			"unsupported support even with a decision blocker",
			{ ...planned({ blockedBy: { kind: "decision", ref: "DEC-14" } }), level: "unsupported" },
			"unsupported",
		],
		["not evaluated support", notEvaluated, "not_evaluated"],
		[
			"provider-managed support that is verified",
			{ ...verifiedNative, level: "provider_managed" },
			"managed_by_provider",
		],
		[
			"provider-managed support with a blocker and conditions",
			{
				...planned({ blockedBy: { kind: "decision", ref: "DEC-14" } }, conditions),
				level: "provider_managed",
			},
			"managed_by_provider",
		],
		["native verified support without conditions", verifiedNative, "supported"],
		[
			"composed verified support without conditions",
			{ ...verifiedNative, level: "quotum_composed", composedVia: "charge" },
			"supported",
		],
		["verified support with conditions", { ...verifiedNative, conditions }, "conditional"],
		[
			"conditional support with a note only",
			{
				...verifiedNative,
				verification: { status: "conditional", verifiedOn: "2026-09-16", note: "n", evidence },
			},
			"conditional",
		],
		["conditional support with conditions", conditional(conditions), "conditional"],
		[
			"planned support blocked by a decision",
			planned({ blockedBy: { kind: "decision", ref: "DEC-14" } }),
			"requires_policy_decision",
		],
		[
			"planned support blocked by a decision despite conditions",
			planned({ blockedBy: { kind: "decision", ref: "DEC-14" } }, conditions),
			"requires_policy_decision",
		],
		[
			"planned support blocked by a scenario",
			planned({ blockedBy: { kind: "scenario", ref: "UNC-03" } }, conditions),
			"requires_semantic_validation",
		],
		[
			"planned support blocked by a question",
			planned({ blockedBy: { kind: "question", ref: "Q-SET-02" } }),
			"requires_semantic_validation",
		],
		[
			"planned support with conditions",
			planned({ trackedBy: "P4" }, conditions),
			"conditional_not_implemented",
		],
		["planned support", planned({ trackedBy: "P4" }), "planned"],
		["native support marked not applicable", { ...notEvaluated, level: "native" }, "planned"],
	];

	it.each(cases)("labels %s", (_name, support, id) => {
		expect(capabilityStatusLabel(support)).toBe(id);
	});

	it("publishes one ordered label table covering every status", () => {
		expect(capabilityStatusLabels.map(({ id }) => id)).toEqual([...capabilityStatusLabelIds]);
		expect(capabilityStatusLabels.map(({ label }) => label)).toEqual([
			"Supported",
			"Conditional",
			"Conditional; not implemented",
			"Planned",
			"Requires policy decision",
			"Requires semantic validation",
			"Managed by provider",
			"Unsupported",
			"Not evaluated",
		]);
		for (const { rule } of capabilityStatusLabels) {
			expect(rule).toMatch(/^[A-Z][^.]+\.$/);
		}
		expect(new Set(cases.map(([, , id]) => id))).toEqual(new Set(capabilityStatusLabelIds));
	});

	it("renders the label text with the blocker reference", () => {
		expect(renderCapabilityStatus(verifiedNative)).toBe("Supported");
		expect(renderCapabilityStatus(planned({ trackedBy: "P4" }, conditions))).toBe(
			"Conditional; not implemented",
		);
		expect(renderCapabilityStatus({ ...verifiedNative, level: "provider_managed" })).toBe(
			"Managed by provider",
		);
		expect(
			renderCapabilityStatus(planned({ blockedBy: { kind: "decision", ref: "DEC-14" } })),
		).toBe("Requires policy decision (DEC-14)");
		expect(
			renderCapabilityStatus(planned({ blockedBy: { kind: "scenario", ref: "UNC-03" } })),
		).toBe("Requires semantic validation (UNC-03)");
		expect(renderCapabilityStatus(notEvaluated)).toBe("Not evaluated");
	});
});

describe("describeCondition", () => {
	const descriptions: Array<[CapabilityCondition, string]> = [
		[{ kind: "connection_enabled" }, "The provider connection must be enabled."],
		[{ kind: "connection_validated" }, "The provider connection must be validated."],
		[
			{ kind: "account_flag", flag: "spmConsent", expected: [true] },
			'The connection setting "spmConsent" must be true.',
		],
		[
			{ kind: "account_flag", flag: "taxMode", expected: ["registered", "test", false] },
			'The connection setting "taxMode" must be "registered", "test" or false.',
		],
		[{ kind: "currency", allowed: ["USD"] }, "The currency must be USD."],
		[{ kind: "currency", allowed: ["EUR", "USD"] }, "The currency must be EUR or USD."],
		[{ kind: "catalog_bound" }, "The catalog item must be bound to a product on this provider."],
		[
			{ kind: "subscription_state", allowed: ["active", "grace_period"] },
			"The subscription state must be active or grace_period.",
		],
		[
			{ kind: "cancellation_pending", required: true },
			"The subscription must have a cancellation pending at its period end.",
		],
		[
			{ kind: "collection_method", allowed: ["automatic"] },
			"The subscription must use automatic collection.",
		],
		[
			{ kind: "billing_interval", allowed: ["month", "year"] },
			"Recurring prices must bill monthly or yearly.",
		],
		[{ kind: "uniform_billing_interval" }, "All recurring prices must share one billing interval."],
		[
			{ kind: "saved_payment_method", required: true },
			"The customer must have a saved payment method.",
		],
		[
			{ kind: "saved_payment_method", required: true, resolveWith: "topup.customer_initiated" },
			"The customer must have a saved payment method; without one, use topup.customer_initiated.",
		],
		[
			{ kind: "renewal_exclusion_window", minutes: 30 },
			"The operation is unavailable during the 30 minutes before the next renewal.",
		],
		[
			{ kind: "renewal_exclusion_window", minutes: 1 },
			"The operation is unavailable during the 1 minute before the next renewal.",
		],
		[
			{ kind: "requires_prior", operation: "checkout.plan" },
			"The customer must first complete checkout.plan.",
		],
		[
			{ kind: "amount_bounds", minMinor: 100, maxMinor: 5000 },
			"The amount must be between 100 and 5000 minor units.",
		],
		[{ kind: "amount_bounds", minMinor: 100 }, "The amount must be at least 100 minor units."],
		[{ kind: "amount_bounds", maxMinor: 5000 }, "The amount must be at most 5000 minor units."],
		[{ kind: "amount_bounds" }, "The amount must be within the declared bounds."],
		[{ kind: "quantity_integer" }, "Quantities must be whole numbers."],
	];

	it.each(descriptions)("describes %o", (condition, sentence) => {
		expect(describeCondition(condition)).toBe(sentence);
	});

	it("describes every condition kind", () => {
		expect(new Set(descriptions.map(([condition]) => condition.kind))).toEqual(
			new Set(capabilityConditionKinds),
		);
	});
});
