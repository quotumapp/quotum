/**
 * Provider capability contract: the vocabulary every provider declaration uses, the pure four-layer
 * evaluator (provider, implementation, configuration, operation), declaration validation, and the
 * single rule that turns declared fields into rendered statuses.
 */

export const billingProviders = ["apple", "google", "stripe"] as const;
/**
 * Declared ahead of implementation; never admitted by runtime enums, SQL CHECKs or any request or
 * response enum. Only the capability contract lists them, including its OpenAPI components.
 */
export const plannedProviders = ["paddle"] as const;
export const declaredProviders = [...billingProviders, ...plannedProviders] as const;
export const billingChannels = ["ios", "android", "web"] as const;

export type BillingProvider = (typeof billingProviders)[number];
export type PlannedProvider = (typeof plannedProviders)[number];
export type DeclaredProvider = (typeof declaredProviders)[number];
export type BillingChannel = (typeof billingChannels)[number];

export function isBillingProvider(value: unknown): value is BillingProvider {
	return includes(billingProviders, value);
}

export function isDeclaredProvider(value: unknown): value is DeclaredProvider {
	return includes(declaredProviders, value);
}

export function isBillingChannel(value: unknown): value is BillingChannel {
	return includes(billingChannels, value);
}

export const providerOperations = [
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
	"subscription.change.preview",
	"subscription.change.apply",
	"subscription.change.period_end",
	"subscription.cancel",
	"subscription.uncancel",
	"settlement.collect_finalized_charge",
	"adjustment.issue",
	"refund.sync",
	"topup.customer_initiated",
	"topup.automatic",
	"promotion.code_entry",
	"promotion.hosted_code",
] as const;
export type ProviderOperation = (typeof providerOperations)[number];

export function isProviderOperation(value: unknown): value is ProviderOperation {
	return includes(providerOperations, value);
}

export const providerOperationDomains = [
	"catalog",
	"checkout",
	"purchases",
	"portal",
	"payment_methods",
	"events",
	"subscription_changes",
	"settlement",
	"refunds",
	"topups",
	"promotions",
] as const;
export type ProviderOperationDomain = (typeof providerOperationDomains)[number];

export const providerOperationDomainTitles: Record<ProviderOperationDomain, string> = {
	catalog: "Catalog",
	checkout: "Checkout",
	purchases: "Purchase verification",
	portal: "Customer portal",
	payment_methods: "Payment methods",
	events: "Events and reconciliation",
	subscription_changes: "Subscription changes",
	settlement: "Usage settlement",
	refunds: "Refunds",
	topups: "Top-ups",
	promotions: "Promotions",
};

export interface ProviderOperationDefinition {
	domain: ProviderOperationDomain;
	title: string;
	description: string;
}

export const providerOperationDefinitions: Record<ProviderOperation, ProviderOperationDefinition> =
	{
		"catalog.product.subscription": {
			domain: "catalog",
			title: "Subscription products",
			description:
				"A published catalog may bind an auto-renewing subscription product to this provider, and Quotum grants the plan's entitlements and allocations while the provider subscription is active.",
		},
		"catalog.product.consumable": {
			domain: "catalog",
			title: "Consumable products",
			description:
				"A published catalog may bind a one-time consumable product to this provider, and Quotum credits its balance grant once per completed purchase.",
		},
		"catalog.product.non_consumable": {
			domain: "catalog",
			title: "Non-consumable products",
			description:
				"A provisioned store product on this provider may be a one-time non-consumable purchase, and Quotum grants its lasting access from the completed purchase.",
		},
		"catalog.trial": {
			domain: "catalog",
			title: "Trials",
			description:
				"A published plan may declare trial days that start the provider subscription in a trial, honoring the plan's payment-method requirement and trial-end behavior.",
		},
		"catalog.addon": {
			domain: "catalog",
			title: "Add-on plans",
			description:
				"A published catalog may bind an add-on plan that is sold as its own provider subscription and requires an active base plan on the same billing account.",
		},
		"catalog.topup": {
			domain: "catalog",
			title: "Top-up options",
			description:
				"A published catalog may bind a top-up option to a provider product, and Quotum credits the top-up quantity to a consumable metered feature when that product is paid for.",
		},
		"catalog.price.flat": {
			domain: "catalog",
			title: "Flat price components",
			description:
				"A plan version may bind an explicit flat price component, such as a base fee, to an exact provider price that Quotum sends on checkout and subscription changes.",
		},
		"catalog.price.licensed": {
			domain: "catalog",
			title: "Licensed-quantity prices",
			description:
				"A plan version may bind a licensed-quantity price, such as seats, whose explicit whole-number quantity Quotum sends to the provider on checkout and subscription changes.",
		},
		"catalog.price.tiered": {
			domain: "catalog",
			title: "Tiered prices",
			description:
				"A plan version may bind a graduated or volume tiered price component to an exact provider price.",
		},
		"catalog.price.hybrid": {
			domain: "catalog",
			title: "Hybrid prices",
			description:
				"A plan version may combine a base fee with licensed-quantity or metered-overage price components in one provider subscription.",
		},
		"catalog.price.postpaid_usage": {
			domain: "catalog",
			title: "Postpaid usage prices",
			description:
				"A plan version may declare a meter limit that allows postpaid overage priced against a provider product, which Quotum rates after each usage period closes.",
		},
		"checkout.hosted": {
			domain: "checkout",
			title: "Hosted product checkout",
			description:
				"Quotum creates a provider-hosted checkout session for one catalog product (subscription, consumable or non-consumable) and records the purchase from the provider's completion event.",
		},
		"checkout.plan": {
			domain: "checkout",
			title: "Hosted plan checkout",
			description:
				"Quotum creates a provider-hosted checkout session for a recurring plan version, with its base and licensed-quantity lines, trial and add-on rules, and records the subscription from the provider's completion event.",
		},
		"purchase.verify": {
			domain: "purchases",
			title: "Purchase verification",
			description:
				"The trusted backend submits a purchase the customer completed in the provider's native purchase flow, and Quotum verifies it with the provider's server API, records it and returns the entitlement snapshot.",
		},
		"portal.session": {
			domain: "portal",
			title: "Customer portal session",
			description:
				"Quotum creates a provider-hosted self-service session where the customer manages payment methods, invoices and subscriptions, and returns its URL.",
		},
		"payment_method.setup": {
			domain: "payment_methods",
			title: "Hosted payment method setup",
			description:
				"Quotum creates a provider-hosted page where the customer saves a payment method without a charge, and on completion makes it the billing account's default for later off-session charges.",
		},
		"webhook.ingest": {
			domain: "events",
			title: "Webhook ingestion",
			description:
				"Quotum authenticates provider notifications on the project webhook route, stores each once as a store event, and mirrors the purchase, subscription, refund and reversal state they carry.",
		},
		"event.replay": {
			domain: "events",
			title: "Stored event replay",
			description:
				"Quotum reprocesses a stored provider event from its persisted payload, through the replay worker or an operator replay request, without the provider resending it.",
		},
		"subscription.reconcile": {
			domain: "events",
			title: "Subscription reconciliation",
			description:
				"Quotum reads a subscription's current state from the provider's API, through the reconciliation worker or an operator run, and corrects local subscription state and entitlements that drifted from it.",
		},
		"subscription.change.preview": {
			domain: "subscription_changes",
			title: "Subscription change preview",
			description:
				"Quotum previews a plan or quantity change on an existing provider subscription, returning line items, effective time and proration policy, without a provider write.",
		},
		"subscription.change.apply": {
			domain: "subscription_changes",
			title: "Immediate subscription change",
			description:
				"Quotum queues an immediate plan or quantity change and its worker applies it to the provider subscription with the requested proration policy.",
		},
		"subscription.change.period_end": {
			domain: "subscription_changes",
			title: "Period-end subscription change",
			description:
				"Quotum stores a plan or quantity change effective at the end of the current period, and its worker applies it to the provider subscription when that period ends.",
		},
		"subscription.cancel": {
			domain: "subscription_changes",
			title: "Subscription cancellation",
			description:
				"Quotum ends a provider subscription, at once or at the end of the paid period, asking for no proration credit; entitlements end with access while plan allocations already granted keep their own expiry.",
		},
		"subscription.uncancel": {
			domain: "subscription_changes",
			title: "Subscription uncancellation",
			description:
				"Quotum clears a pending period-end cancellation on a provider subscription, so it renews again; a cancellation that already ended the subscription cannot be cleared this way.",
		},
		"settlement.collect_finalized_charge": {
			domain: "settlement",
			title: "Postpaid usage collection",
			description:
				"After a usage period closes, Quotum rates the postpaid overage and has the provider charge that finalized amount to the customer against the subscription.",
		},
		"adjustment.issue": {
			domain: "settlement",
			title: "Usage adjustment",
			description:
				"When usage in an already invoiced period is corrected, Quotum issues a provider-side adjustment for the rated difference against that period.",
		},
		"refund.sync": {
			domain: "refunds",
			title: "Refund and reversal sync",
			description:
				"Quotum mirrors refunds, disputes, revocations and voided purchases made in the provider, reversing the grants they funded, and never initiates a refund itself.",
		},
		"topup.customer_initiated": {
			domain: "topups",
			title: "Customer-initiated top-up",
			description:
				"The customer buys a top-up through the provider's own purchase flow when metering reports purchase_required, and Quotum credits the balance from the verified purchase or payment event.",
		},
		"topup.automatic": {
			domain: "topups",
			title: "Automatic top-up",
			description:
				"When an automatic top-up policy triggers, Quotum charges the customer's saved payment method off-session through the provider and credits the balance only after the charge succeeds.",
		},
		"promotion.code_entry": {
			domain: "promotions",
			title: "Promotion code applied by Quotum",
			description:
				"Quotum validates a promotion code the trusted backend collected, reserves one use, and passes the promotion's discount to the provider on checkout or a subscription change.",
		},
		"promotion.hosted_code": {
			domain: "promotions",
			title: "Hosted promotion code entry",
			description:
				"The provider's hosted checkout accepts codes that Quotum mirrors as provider promotion codes, and Quotum records each use from the completed checkout event.",
		},
	};

export const supportLevels = [
	"native",
	"quotum_composed",
	"provider_managed",
	"unsupported",
	"not_evaluated",
] as const;
/**
 * `quotum_composed`: Quotum builds the operation from a generic provider primitive named by
 * `composedVia`. `provider_managed`: it happens inside the provider and Quotum only mirrors the
 * outcome through `webhook.ingest`.
 */
export type SupportLevel = (typeof supportLevels)[number];

export const supportLevelLabels: Record<SupportLevel, string> = {
	native: "Native",
	quotum_composed: "Quotum-composed",
	provider_managed: "Managed by provider, mirrored by Quotum",
	unsupported: "Unsupported",
	not_evaluated: "Not evaluated",
};

export const verificationStatuses = [
	"verified",
	"conditional",
	"planned",
	"not_applicable",
] as const;
export type VerificationStatus = (typeof verificationStatuses)[number];

/** Tagged repository test paths, conformance scenario ids and assessment question ids. */
export interface CapabilityEvidence {
	tests: string[];
	scenarios: string[];
	questions: string[];
}

export const capabilityBlockerKinds = ["decision", "scenario", "question"] as const;
export type CapabilityBlockerKind = (typeof capabilityBlockerKinds)[number];

export interface CapabilityBlocker {
	kind: CapabilityBlockerKind;
	ref: string;
}

export type CapabilityVerification =
	| { status: "verified"; verifiedOn: string; note?: string; evidence: CapabilityEvidence }
	| { status: "conditional"; verifiedOn: string; note?: string; evidence: CapabilityEvidence }
	| {
			status: "planned";
			trackedBy?: string;
			blockedBy?: CapabilityBlocker;
			evidence?: CapabilityEvidence;
	  }
	| { status: "not_applicable"; evidence?: CapabilityEvidence };

export const capabilityLayers = [
	"provider",
	"implementation",
	"configuration",
	"operation",
] as const;
export type CapabilityLayer = (typeof capabilityLayers)[number];
export type CapabilityConditionLayer = Extract<CapabilityLayer, "configuration" | "operation">;

export const capabilityBillingIntervals = ["month", "year"] as const;
export type CapabilityBillingInterval = (typeof capabilityBillingIntervals)[number];
export const capabilityCollectionMethods = ["automatic", "manual"] as const;
export type CapabilityCollectionMethod = (typeof capabilityCollectionMethods)[number];

export type CapabilityCondition =
	| { kind: "connection_enabled" }
	| { kind: "connection_validated" }
	| { kind: "account_flag"; flag: string; expected: Array<string | boolean> }
	| { kind: "currency"; allowed: string[] }
	| { kind: "catalog_bound" }
	| { kind: "subscription_state"; allowed: string[] }
	| { kind: "cancellation_pending"; required: true }
	| { kind: "collection_method"; allowed: CapabilityCollectionMethod[] }
	| { kind: "billing_interval"; allowed: CapabilityBillingInterval[] }
	| { kind: "uniform_billing_interval" }
	| { kind: "saved_payment_method"; required: true; resolveWith?: ProviderOperation }
	| { kind: "renewal_exclusion_window"; minutes: number }
	| { kind: "requires_prior"; operation: ProviderOperation }
	| { kind: "amount_bounds"; minMinor?: number; maxMinor?: number }
	| { kind: "quantity_integer" };
export type CapabilityConditionKind = CapabilityCondition["kind"];

export const capabilityConditionKinds = [
	"connection_enabled",
	"connection_validated",
	"account_flag",
	"currency",
	"catalog_bound",
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
] as const satisfies readonly CapabilityConditionKind[];

/** Every condition kind is decided at exactly one layer. */
export const conditionLayer: Record<CapabilityConditionKind, CapabilityConditionLayer> = {
	connection_enabled: "configuration",
	connection_validated: "configuration",
	account_flag: "configuration",
	currency: "configuration",
	catalog_bound: "configuration",
	subscription_state: "operation",
	cancellation_pending: "operation",
	collection_method: "operation",
	billing_interval: "operation",
	uniform_billing_interval: "operation",
	saved_payment_method: "operation",
	renewal_exclusion_window: "operation",
	requires_prior: "operation",
	amount_bounds: "operation",
	quantity_integer: "operation",
};

export function isCapabilityConditionKind(value: unknown): value is CapabilityConditionKind {
	return includes(capabilityConditionKinds, value);
}

export interface OperationSupport {
	level: SupportLevel;
	/** Required exactly when `level` is `quotum_composed`: the provider primitive Quotum builds on. */
	composedVia?: string;
	verification: CapabilityVerification;
	/** All must hold; each is evaluated at the layer `conditionLayer` assigns to its kind. */
	conditions: CapabilityCondition[];
	notes?: string;
}

export const changeBillingModes = ["prorated", "full", "none"] as const;
export type ChangeBillingMode = (typeof changeBillingModes)[number];
export const changeCollectionTimings = ["immediate", "next_renewal"] as const;
export type ChangeCollectionTiming = (typeof changeCollectionTimings)[number];

export interface ChangeBillingPolicy {
	billing: ChangeBillingMode;
	collection: ChangeCollectionTiming;
}

/** Every (billing, collection) pair; a declaration lists the pairs its provider can express. */
export const changeBillingPolicies: readonly ChangeBillingPolicy[] = changeBillingModes.flatMap(
	(billing) => changeCollectionTimings.map((collection) => ({ billing, collection })),
);

export const declarationAvailabilities = ["available", "planned"] as const;
export type DeclarationAvailability = (typeof declarationAvailabilities)[number];
export const uncertainWriteModes = ["provider_idempotency", "reconcile_required"] as const;
export type UncertainWriteMode = (typeof uncertainWriteModes)[number];
export const webhookOrderings = ["ordered", "unordered"] as const;
export type WebhookOrdering = (typeof webhookOrderings)[number];

export interface ProviderCapabilityDeclaration {
	provider: DeclaredProvider;
	channel: BillingChannel;
	/** Platform connection kind that configures this provider. */
	connectionKind: string;
	/** `planned` declarations are rendered but never admitted by the runtime. */
	availability: DeclarationAvailability;
	writeSemantics: {
		clientIdempotencyKeys: boolean;
		uncertainWrite: UncertainWriteMode;
	};
	limits?: {
		requestsPerMinute?: number;
		webhookRetries?: { attempts: number; windowHours: number };
		webhookOrdering?: WebhookOrdering;
	};
	changeBillingPolicies?: ChangeBillingPolicy[];
	operations: Record<ProviderOperation, OperationSupport>;
}

/** Timestamps are ISO strings supplied by the caller; the evaluator never reads the clock. */
export interface CapabilityConfigurationFacts {
	connectionEnabled: boolean;
	connectionValidated: boolean;
	/** Non-secret connection settings. */
	accountFlags: Record<string, string | boolean>;
	currencies?: string[];
	catalogBound?: boolean;
}

export interface CapabilityOperationFacts {
	subscriptionState?: string;
	/** Whether the subscription already ends at its period end; an uncancel needs one to clear. */
	cancellationPending?: boolean;
	collectionMethod?: CapabilityCollectionMethod;
	billingIntervals?: CapabilityBillingInterval[];
	nextRenewalAt?: string;
	now?: string;
	/** `unknown` when only a provider call could answer. */
	savedPaymentMethod?: boolean | "unknown";
	completedOperations?: ProviderOperation[];
	amountMinor?: number;
	quantityIsInteger?: boolean;
}

export interface CapabilityFacts {
	configuration?: CapabilityConfigurationFacts;
	operation?: CapabilityOperationFacts;
}

export const capabilityReasonCodes = [
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
	"CANCELLATION_NOT_PENDING",
	"COLLECTION_METHOD",
	"BILLING_INTERVAL",
	"SAVED_PAYMENT_METHOD_REQUIRED",
	"RENEWAL_EXCLUSION_WINDOW",
	"PRIOR_OPERATION_REQUIRED",
	"AMOUNT_OUT_OF_BOUNDS",
	"QUANTITY_NOT_INTEGER",
	"FACT_UNAVAILABLE",
] as const;
export type CapabilityReasonCode = (typeof capabilityReasonCodes)[number];
// Reason codes are not wire error codes: `code: "<LITERAL>"` in src/ would enter contracts/v1/errors.json.
const factUnavailable: CapabilityReasonCode = "FACT_UNAVAILABLE";
const implementationPlanned: CapabilityReasonCode = "IMPLEMENTATION_PLANNED";

/** The code a failing condition reports; a missing fact reports `FACT_UNAVAILABLE` instead. */
export const conditionReasonCode: Record<CapabilityConditionKind, CapabilityReasonCode> = {
	connection_enabled: "CONNECTION_DISABLED",
	connection_validated: "CONNECTION_VALIDATION_REQUIRED",
	account_flag: "ACCOUNT_FLAG_REQUIRED",
	currency: "CURRENCY_UNSUPPORTED",
	catalog_bound: "CATALOG_BINDING_REQUIRED",
	subscription_state: "SUBSCRIPTION_STATE",
	cancellation_pending: "CANCELLATION_NOT_PENDING",
	collection_method: "COLLECTION_METHOD",
	billing_interval: "BILLING_INTERVAL",
	uniform_billing_interval: "BILLING_INTERVAL",
	saved_payment_method: "SAVED_PAYMENT_METHOD_REQUIRED",
	renewal_exclusion_window: "RENEWAL_EXCLUSION_WINDOW",
	requires_prior: "PRIOR_OPERATION_REQUIRED",
	amount_bounds: "AMOUNT_OUT_OF_BOUNDS",
	quantity_integer: "QUANTITY_NOT_INTEGER",
};

export type CapabilityResolution =
	| { kind: "customer_action"; operation?: ProviderOperation }
	| { kind: "merchant_configuration"; connectionKind: string; flag?: string }
	| { kind: "wait_until"; at: string }
	| { kind: "checked_at_execution" }
	| { kind: "none" };

export type CapabilityObservedValue = string | number | boolean | null;

export interface CapabilityReason {
	code: CapabilityReasonCode;
	layer: CapabilityLayer;
	condition?: CapabilityCondition;
	observed?: Record<string, CapabilityObservedValue>;
	resolution?: CapabilityResolution;
}

export const capabilityOutcomes = ["available", "blocked", "undetermined"] as const;
export type CapabilityOutcome = (typeof capabilityOutcomes)[number];

export interface CapabilityVerdict {
	provider: DeclaredProvider;
	operation: ProviderOperation;
	outcome: CapabilityOutcome;
	level: SupportLevel;
	composedVia?: string;
	/** The layer that blocked, or null when nothing blocked. */
	blockingLayer: CapabilityLayer | null;
	/** Ordered by layer, then by declared condition order. */
	reasons: CapabilityReason[];
}

/** A verdict for an admitted provider; runtime surfaces never report planned providers. */
export interface RuntimeCapabilityVerdict extends CapabilityVerdict {
	provider: BillingProvider;
}

export const catalogCompatibilityTargetKinds = ["plan", "price", "topup"] as const;
export type CatalogCompatibilityTargetKind = (typeof catalogCompatibilityTargetKinds)[number];

/**
 * The catalog entry a binding belongs to: `key` is the plan or top-up key, and `priceKey` names
 * the plan's base or item price for a `price` target.
 */
export type CatalogCompatibilityTarget = {
	kind: CatalogCompatibilityTargetKind;
	key: string;
	priceKey?: string | null;
};

/**
 * Answers whether `operation` is possible for this declaration and facts. Layers run in order and
 * stop after `through` (default `operation`); the first blocked layer ends evaluation, while a
 * missing fact only makes the verdict undetermined.
 */
export function evaluateCapability(
	declaration: ProviderCapabilityDeclaration,
	operation: ProviderOperation,
	facts: CapabilityFacts,
	options?: { through?: CapabilityLayer },
): CapabilityVerdict {
	if (!Object.hasOwn(declaration.operations, operation)) {
		throw new Error(
			`Capability declaration for ${declaration.provider} does not declare ${operation}`,
		);
	}
	const support = declaration.operations[operation];
	const through = options?.through ?? "operation";
	const lastLayer = capabilityLayers.indexOf(through);
	if (lastLayer === -1) {
		throw new Error(`Unknown capability layer: ${String(through)}`);
	}

	const reasons: CapabilityReason[] = [];
	let blockingLayer: CapabilityLayer | null = null;
	for (const layer of capabilityLayers.slice(0, lastLayer + 1)) {
		const layerReasons = evaluateLayer(layer, declaration, support, facts);
		reasons.push(...layerReasons);
		if (layerReasons.some((reason) => reason.code !== factUnavailable)) {
			blockingLayer = layer;
			break;
		}
	}

	return {
		provider: declaration.provider,
		operation,
		outcome: blockingLayer !== null ? "blocked" : reasons.length > 0 ? "undetermined" : "available",
		level: support.level,
		...(support.composedVia === undefined ? {} : { composedVia: support.composedVia }),
		blockingLayer,
		reasons,
	};
}

function evaluateLayer(
	layer: CapabilityLayer,
	declaration: ProviderCapabilityDeclaration,
	support: OperationSupport,
	facts: CapabilityFacts,
): CapabilityReason[] {
	switch (layer) {
		case "provider":
			return providerLayerReasons(support);
		case "implementation":
			return implementationLayerReasons(declaration, support);
		case "configuration":
		case "operation":
			return support.conditions.flatMap((condition) => {
				if (conditionLayerOf(condition) !== layer) return [];
				const reason = evaluateCondition(condition, declaration, facts);
				return reason === null ? [] : [reason];
			});
	}
}

function providerLayerReasons(support: OperationSupport): CapabilityReason[] {
	const code: CapabilityReasonCode | null =
		support.level === "unsupported"
			? "PROVIDER_UNSUPPORTED"
			: support.level === "not_evaluated"
				? "CAPABILITY_NOT_EVALUATED"
				: support.level === "provider_managed"
					? "PROVIDER_MANAGED"
					: null;
	return code === null
		? []
		: [
				{
					code,
					layer: "provider",
					observed: { level: support.level },
					resolution: { kind: "none" },
				},
			];
}

function implementationLayerReasons(
	declaration: ProviderCapabilityDeclaration,
	support: OperationSupport,
): CapabilityReason[] {
	const status = support.verification.status;
	if (
		declaration.availability !== "planned" &&
		status !== "planned" &&
		status !== "not_applicable"
	) {
		return [];
	}
	return [
		{
			code: implementationPlanned,
			layer: "implementation",
			observed: { availability: declaration.availability, verificationStatus: status },
			resolution: { kind: "none" },
		},
	];
}

function conditionLayerOf(condition: CapabilityCondition): CapabilityConditionLayer {
	const layer = isCapabilityConditionKind(condition.kind) ? conditionLayer[condition.kind] : null;
	if (layer === null) {
		throw new Error(`Unknown capability condition kind: ${String(condition.kind)}`);
	}
	return layer;
}

function evaluateCondition(
	condition: CapabilityCondition,
	declaration: ProviderCapabilityDeclaration,
	facts: CapabilityFacts,
): CapabilityReason | null {
	const layer = conditionLayerOf(condition);
	const unavailable = (observed: Record<string, CapabilityObservedValue>): CapabilityReason => ({
		code: factUnavailable,
		layer,
		condition,
		observed,
		resolution: { kind: "checked_at_execution" },
	});
	const blocked = (
		observed: Record<string, CapabilityObservedValue>,
		resolution: CapabilityResolution = { kind: "none" },
	): CapabilityReason => ({
		code: conditionReasonCode[condition.kind],
		layer,
		condition,
		observed,
		resolution,
	});
	const merchantConfiguration = (flag?: string): CapabilityResolution => ({
		kind: "merchant_configuration",
		connectionKind: declaration.connectionKind,
		...(flag === undefined ? {} : { flag }),
	});
	const configuration = facts.configuration;
	const operation = facts.operation;

	switch (condition.kind) {
		case "connection_enabled": {
			if (configuration === undefined) return unavailable({ connectionEnabled: null });
			return configuration.connectionEnabled
				? null
				: blocked({ connectionEnabled: false }, merchantConfiguration());
		}
		case "connection_validated": {
			if (configuration === undefined) return unavailable({ connectionValidated: null });
			return configuration.connectionValidated
				? null
				: blocked({ connectionValidated: false }, merchantConfiguration());
		}
		case "account_flag": {
			const flags = configuration?.accountFlags;
			if (flags === undefined || !Object.hasOwn(flags, condition.flag)) {
				return unavailable({ flag: condition.flag, value: null });
			}
			const value = flags[condition.flag] as string | boolean;
			return condition.expected.includes(value)
				? null
				: blocked({ flag: condition.flag, value }, merchantConfiguration(condition.flag));
		}
		case "currency": {
			const currencies = configuration?.currencies;
			if (currencies === undefined) return unavailable({ currencies: null });
			const allowed = new Set(condition.allowed.map((currency) => currency.toUpperCase()));
			const seen = [...new Set(currencies.map((currency) => currency.toUpperCase()))].sort();
			const unsupported = seen.filter((currency) => !allowed.has(currency));
			return unsupported.length === 0
				? null
				: blocked({ currencies: seen.join(","), unsupported: unsupported.join(",") });
		}
		case "catalog_bound": {
			const catalogBound = configuration?.catalogBound;
			if (catalogBound === undefined) return unavailable({ catalogBound: null });
			return catalogBound ? null : blocked({ catalogBound: false }, merchantConfiguration());
		}
		case "subscription_state": {
			const state = operation?.subscriptionState;
			if (state === undefined) return unavailable({ subscriptionState: null });
			return condition.allowed.includes(state) ? null : blocked({ subscriptionState: state });
		}
		case "cancellation_pending": {
			const pending = operation?.cancellationPending;
			if (pending === undefined) return unavailable({ cancellationPending: null });
			return pending ? null : blocked({ cancellationPending: false });
		}
		case "collection_method": {
			const method = operation?.collectionMethod;
			if (method === undefined) return unavailable({ collectionMethod: null });
			return condition.allowed.includes(method) ? null : blocked({ collectionMethod: method });
		}
		case "billing_interval": {
			const intervals = operation?.billingIntervals;
			if (intervals === undefined) return unavailable({ billingIntervals: null });
			return intervals.every((interval) => condition.allowed.includes(interval))
				? null
				: blocked({ billingIntervals: distinct(intervals).join(",") });
		}
		case "uniform_billing_interval": {
			const intervals = operation?.billingIntervals;
			if (intervals === undefined) return unavailable({ billingIntervals: null });
			const seen = distinct(intervals);
			return seen.length <= 1 ? null : blocked({ billingIntervals: seen.join(",") });
		}
		case "saved_payment_method": {
			const saved = operation?.savedPaymentMethod;
			if (saved === undefined || saved === "unknown") {
				return unavailable({ savedPaymentMethod: saved ?? null });
			}
			return saved
				? null
				: blocked(
						{ savedPaymentMethod: false },
						condition.resolveWith === undefined
							? { kind: "customer_action" }
							: { kind: "customer_action", operation: condition.resolveWith },
					);
		}
		case "renewal_exclusion_window": {
			const nextRenewalAt = operation?.nextRenewalAt;
			const now = operation?.now;
			const renewalMs = nextRenewalAt === undefined ? Number.NaN : Date.parse(nextRenewalAt);
			const nowMs = now === undefined ? Number.NaN : Date.parse(now);
			if (
				nextRenewalAt === undefined ||
				now === undefined ||
				Number.isNaN(renewalMs) ||
				Number.isNaN(nowMs)
			) {
				return unavailable({ nextRenewalAt: nextRenewalAt ?? null, now: now ?? null });
			}
			const insideWindow = nowMs >= renewalMs - condition.minutes * 60_000 && nowMs < renewalMs;
			return insideWindow
				? blocked(
						{ nextRenewalAt, now, minutes: condition.minutes },
						{ kind: "wait_until", at: nextRenewalAt },
					)
				: null;
		}
		case "requires_prior": {
			const completed = operation?.completedOperations;
			if (completed === undefined) return unavailable({ completedOperations: null });
			return completed.includes(condition.operation)
				? null
				: blocked(
						{ completedOperations: completed.join(",") },
						{ kind: "customer_action", operation: condition.operation },
					);
		}
		case "amount_bounds": {
			const amountMinor = operation?.amountMinor;
			if (amountMinor === undefined) return unavailable({ amountMinor: null });
			const belowMinimum = condition.minMinor !== undefined && amountMinor < condition.minMinor;
			const aboveMaximum = condition.maxMinor !== undefined && amountMinor > condition.maxMinor;
			return belowMinimum || aboveMaximum
				? blocked({
						amountMinor,
						minMinor: condition.minMinor ?? null,
						maxMinor: condition.maxMinor ?? null,
					})
				: null;
		}
		case "quantity_integer": {
			const quantityIsInteger = operation?.quantityIsInteger;
			if (quantityIsInteger === undefined) return unavailable({ quantityIsInteger: null });
			return quantityIsInteger ? null : blocked({ quantityIsInteger: false });
		}
	}
}

export interface CapabilityDeclarationIssue {
	path: string;
	message: string;
}

/** Structural and semantic checks every declaration must pass; an empty list means valid. */
export function validateDeclaration(
	declaration: ProviderCapabilityDeclaration,
): CapabilityDeclarationIssue[] {
	const issues: CapabilityDeclarationIssue[] = [];
	const issue = (path: string, message: string) => issues.push({ path, message });
	const input = declaration as unknown as Record<string, unknown>;

	const provider = input.provider;
	if (!isDeclaredProvider(provider)) {
		issue("provider", `Provider must be one of ${declaredProviders.join(", ")}`);
	}
	if (!isBillingChannel(input.channel)) {
		issue("channel", `Channel must be one of ${billingChannels.join(", ")}`);
	}
	if (!isNonBlankString(input.connectionKind)) {
		issue("connectionKind", "Connection kind must be a non-empty string");
	}
	const availability = input.availability;
	if (!includes(declarationAvailabilities, availability)) {
		issue("availability", "Availability must be available or planned");
	} else if (isDeclaredProvider(provider)) {
		const admitted = isBillingProvider(provider);
		if (admitted && availability !== "available") {
			issue("availability", `Admitted provider ${provider} must be available`);
		}
		if (!admitted && availability !== "planned") {
			issue("availability", `Provider ${provider} is not admitted and must be planned`);
		}
	}

	const writeSemantics = input.writeSemantics;
	if (!isRecord(writeSemantics)) {
		issue("writeSemantics", "Write semantics are required");
	} else {
		if (typeof writeSemantics.clientIdempotencyKeys !== "boolean") {
			issue("writeSemantics.clientIdempotencyKeys", "Client idempotency keys must be a boolean");
		}
		if (!includes(uncertainWriteModes, writeSemantics.uncertainWrite)) {
			issue(
				"writeSemantics.uncertainWrite",
				`Uncertain write must be one of ${uncertainWriteModes.join(", ")}`,
			);
		}
	}

	validateLimits(input.limits, issue);
	validateChangeBillingPolicies(input.changeBillingPolicies, issue);

	const operations = input.operations;
	if (!isRecord(operations)) {
		issue("operations", "Operations must declare every provider operation");
		return issues;
	}
	for (const operation of providerOperations) {
		if (!Object.hasOwn(operations, operation)) {
			issue(`operations.${operation}`, "Operation is not declared");
		}
	}
	for (const [operation, support] of Object.entries(operations)) {
		const path = `operations.${operation}`;
		if (!isProviderOperation(operation)) {
			issue(path, "Unknown provider operation");
			continue;
		}
		validateOperationSupport(path, operation, support, availability === "planned", issue);
	}
	return issues;
}

export function assertValidDeclaration(declaration: ProviderCapabilityDeclaration): void {
	const issues = validateDeclaration(declaration);
	if (issues.length > 0) {
		throw new Error(
			`Invalid capability declaration for ${String(declaration.provider)}: ${issues
				.map(({ path, message }) => `${path}: ${message}`)
				.join("; ")}`,
		);
	}
}

type IssueSink = (path: string, message: string) => void;

function validateLimits(limits: unknown, issue: IssueSink): void {
	if (limits === undefined) return;
	if (!isRecord(limits)) {
		issue("limits", "Limits must be an object");
		return;
	}
	if (limits.requestsPerMinute !== undefined && !isPositiveInteger(limits.requestsPerMinute)) {
		issue("limits.requestsPerMinute", "Requests per minute must be a positive integer");
	}
	const retries = limits.webhookRetries;
	if (retries !== undefined) {
		if (!isRecord(retries)) {
			issue("limits.webhookRetries", "Webhook retries must be an object");
		} else {
			if (!isPositiveInteger(retries.attempts)) {
				issue(
					"limits.webhookRetries.attempts",
					"Webhook retry attempts must be a positive integer",
				);
			}
			if (!isPositiveInteger(retries.windowHours)) {
				issue(
					"limits.webhookRetries.windowHours",
					"Webhook retry window hours must be a positive integer",
				);
			}
		}
	}
	if (limits.webhookOrdering !== undefined && !includes(webhookOrderings, limits.webhookOrdering)) {
		issue("limits.webhookOrdering", "Webhook ordering must be ordered or unordered");
	}
}

function validateChangeBillingPolicies(policies: unknown, issue: IssueSink): void {
	if (policies === undefined) return;
	if (!Array.isArray(policies)) {
		issue("changeBillingPolicies", "Change billing policies must be an array");
		return;
	}
	const seen = new Set<string>();
	for (const [index, policy] of policies.entries()) {
		const path = `changeBillingPolicies.${index}`;
		if (
			!isRecord(policy) ||
			!includes(changeBillingModes, policy.billing) ||
			!includes(changeCollectionTimings, policy.collection)
		) {
			issue(path, "Change billing policy must pair a known billing mode and collection timing");
			continue;
		}
		const key = `${policy.billing}/${policy.collection}`;
		if (seen.has(key)) issue(path, `Change billing policy ${key} is listed more than once`);
		seen.add(key);
	}
}

function validateOperationSupport(
	path: string,
	operation: ProviderOperation,
	support: unknown,
	plannedDeclaration: boolean,
	issue: IssueSink,
): void {
	if (!isRecord(support)) {
		issue(path, "Operation support must be an object");
		return;
	}
	const level = support.level;
	if (!includes(supportLevels, level)) {
		issue(`${path}.level`, `Support level must be one of ${supportLevels.join(", ")}`);
	}
	if (level === "quotum_composed" && !isNonBlankString(support.composedVia)) {
		issue(`${path}.composedVia`, "Quotum-composed support must name the primitive it composes");
	}
	if (level !== "quotum_composed" && support.composedVia !== undefined) {
		issue(`${path}.composedVia`, "Only quotum_composed support may name a composed primitive");
	}
	if (support.notes !== undefined && typeof support.notes !== "string") {
		issue(`${path}.notes`, "Notes must be a string");
	}

	const conditions = support.conditions;
	if (!Array.isArray(conditions)) {
		issue(`${path}.conditions`, "Conditions must be an array");
	} else {
		for (const [index, condition] of conditions.entries()) {
			validateCondition(`${path}.conditions.${index}`, operation, condition, issue);
		}
	}

	const verification = support.verification;
	const verificationPath = `${path}.verification`;
	if (!isRecord(verification) || !includes(verificationStatuses, verification.status)) {
		issue(
			`${verificationPath}.status`,
			`Verification status must be one of ${verificationStatuses.join(", ")}`,
		);
		return;
	}
	const status = verification.status;
	if ((level === "native" || level === "quotum_composed") && status === "not_applicable") {
		issue(`${verificationPath}.status`, `${String(level)} support cannot be not_applicable`);
	}
	if ((level === "unsupported" || level === "not_evaluated") && status !== "not_applicable") {
		issue(`${verificationPath}.status`, `${String(level)} support must be not_applicable`);
	}
	if (plannedDeclaration && (status === "verified" || status === "conditional")) {
		issue(`${verificationPath}.status`, `A planned declaration cannot claim ${status} support`);
	}

	if (verification.evidence !== undefined || status === "verified" || status === "conditional") {
		validateEvidence(`${verificationPath}.evidence`, verification.evidence, issue);
	}
	if (status === "verified" || status === "conditional") {
		if (!isIsoDate(verification.verifiedOn)) {
			issue(`${verificationPath}.verifiedOn`, "Verified on must be a YYYY-MM-DD date");
		}
		const evidence = verification.evidence;
		if (
			isRecord(evidence) &&
			nonEmptyStrings(evidence.tests).length + nonEmptyStrings(evidence.scenarios).length === 0
		) {
			issue(
				`${verificationPath}.evidence`,
				`${status} support must cite at least one test or scenario`,
			);
		}
	}
	if (verification.note !== undefined && typeof verification.note !== "string") {
		issue(`${verificationPath}.note`, "Note must be a string");
	}
	if (
		status === "conditional" &&
		(!Array.isArray(conditions) || conditions.length === 0) &&
		!isNonBlankString(verification.note)
	) {
		issue(verificationPath, "Conditional support must declare a condition or a note");
	}
	if (status === "planned") {
		if (verification.trackedBy !== undefined && !isNonBlankString(verification.trackedBy)) {
			issue(`${verificationPath}.trackedBy`, "Tracked by must be a non-empty string");
		}
		const blockedBy = verification.blockedBy;
		if (
			blockedBy !== undefined &&
			(!isRecord(blockedBy) ||
				!includes(capabilityBlockerKinds, blockedBy.kind) ||
				!isNonBlankString(blockedBy.ref))
		) {
			issue(
				`${verificationPath}.blockedBy`,
				"Blocker must be a decision, scenario or question with a reference",
			);
		}
	}
}

function validateEvidence(path: string, evidence: unknown, issue: IssueSink): void {
	if (!isRecord(evidence)) {
		issue(path, "Evidence must list tests, scenarios and questions");
		return;
	}
	for (const field of ["tests", "scenarios", "questions"] as const) {
		const values = evidence[field];
		if (!Array.isArray(values) || values.some((value) => !isNonBlankString(value))) {
			issue(`${path}.${field}`, "Evidence entries must be non-empty strings");
		}
	}
}

function validateCondition(
	path: string,
	operation: ProviderOperation,
	condition: unknown,
	issue: IssueSink,
): void {
	if (!isRecord(condition) || !isCapabilityConditionKind(condition.kind)) {
		issue(`${path}.kind`, "Unknown capability condition kind");
		return;
	}
	switch (condition.kind) {
		case "connection_enabled":
		case "connection_validated":
		case "catalog_bound":
		case "uniform_billing_interval":
		case "quantity_integer":
			return;
		case "account_flag":
			if (!isNonBlankString(condition.flag)) {
				issue(`${path}.flag`, "Account flag must be named");
			}
			if (
				!Array.isArray(condition.expected) ||
				condition.expected.length === 0 ||
				condition.expected.some((value) => typeof value !== "string" && typeof value !== "boolean")
			) {
				issue(`${path}.expected`, "Account flag must expect at least one string or boolean");
			}
			return;
		case "currency":
		case "subscription_state":
			if (
				!Array.isArray(condition.allowed) ||
				condition.allowed.length === 0 ||
				condition.allowed.some((value) => !isNonBlankString(value))
			) {
				issue(`${path}.allowed`, "Allowed values must be a non-empty list of strings");
			}
			return;
		case "collection_method":
			validateAllowed(path, condition.allowed, capabilityCollectionMethods, issue);
			return;
		case "billing_interval":
			validateAllowed(path, condition.allowed, capabilityBillingIntervals, issue);
			return;
		case "cancellation_pending":
			if (condition.required !== true) {
				issue(`${path}.required`, "Cancellation pending condition must be required");
			}
			return;
		case "saved_payment_method":
			if (condition.required !== true) {
				issue(`${path}.required`, "Saved payment method condition must be required");
			}
			if (condition.resolveWith !== undefined && !isProviderOperation(condition.resolveWith)) {
				issue(`${path}.resolveWith`, "Resolve with must be a provider operation");
			}
			return;
		case "renewal_exclusion_window":
			if (!isPositiveInteger(condition.minutes)) {
				issue(`${path}.minutes`, "Renewal exclusion window must be a positive integer of minutes");
			}
			return;
		case "requires_prior":
			if (!isProviderOperation(condition.operation)) {
				issue(`${path}.operation`, "Prior operation must be a provider operation");
			} else if (condition.operation === operation) {
				issue(`${path}.operation`, "An operation cannot require itself");
			}
			return;
		case "amount_bounds": {
			const { minMinor, maxMinor } = condition;
			if (minMinor === undefined && maxMinor === undefined) {
				issue(path, "Amount bounds must set a minimum or a maximum");
			}
			if (minMinor !== undefined && !isNonNegativeInteger(minMinor)) {
				issue(`${path}.minMinor`, "Minimum must be a non-negative integer");
			}
			if (maxMinor !== undefined && !isNonNegativeInteger(maxMinor)) {
				issue(`${path}.maxMinor`, "Maximum must be a non-negative integer");
			}
			if (isNonNegativeInteger(minMinor) && isNonNegativeInteger(maxMinor) && minMinor > maxMinor) {
				issue(path, "Minimum cannot exceed maximum");
			}
			return;
		}
	}
}

function validateAllowed(
	path: string,
	allowed: unknown,
	known: readonly string[],
	issue: IssueSink,
): void {
	if (
		!Array.isArray(allowed) ||
		allowed.length === 0 ||
		allowed.some((value) => !known.includes(value))
	) {
		issue(`${path}.allowed`, `Allowed values must be a non-empty list of ${known.join(", ")}`);
	}
}

export const capabilityStatusLabelIds = [
	"supported",
	"conditional",
	"conditional_not_implemented",
	"planned",
	"requires_policy_decision",
	"requires_semantic_validation",
	"managed_by_provider",
	"unsupported",
	"not_evaluated",
] as const;
export type CapabilityStatusLabelId = (typeof capabilityStatusLabelIds)[number];

export interface CapabilityStatusLabel {
	id: CapabilityStatusLabelId;
	label: string;
	rule: string;
}

/** Rendered statuses in display order; `capabilityStatusLabel` applies the rules by precedence. */
export const capabilityStatusLabels: readonly CapabilityStatusLabel[] = [
	{
		id: "supported",
		label: "Supported",
		rule: "Level is native or quotum_composed, verification is verified, and no conditions are declared.",
	},
	{
		id: "conditional",
		label: "Conditional",
		rule: "Level is native or quotum_composed, and verification is conditional or verified with at least one condition.",
	},
	{
		id: "conditional_not_implemented",
		label: "Conditional; not implemented",
		rule: "Level is native or quotum_composed, verification is planned without a blocker, and at least one condition is declared.",
	},
	{
		id: "planned",
		label: "Planned",
		rule: "Level is native or quotum_composed, verification is planned without a blocker, and no conditions are declared.",
	},
	{
		id: "requires_policy_decision",
		label: "Requires policy decision",
		rule: "Level is native or quotum_composed, and verification is planned with a decision blocker.",
	},
	{
		id: "requires_semantic_validation",
		label: "Requires semantic validation",
		rule: "Level is native or quotum_composed, and verification is planned with a scenario or question blocker.",
	},
	{
		id: "managed_by_provider",
		label: "Managed by provider",
		rule: "Level is provider_managed, whatever the verification.",
	},
	{
		id: "unsupported",
		label: "Unsupported",
		rule: "Level is unsupported.",
	},
	{
		id: "not_evaluated",
		label: "Not evaluated",
		rule: "Level is not_evaluated.",
	},
];

export function capabilityStatusLabel(support: OperationSupport): CapabilityStatusLabelId {
	if (support.level === "unsupported") return "unsupported";
	if (support.level === "not_evaluated") return "not_evaluated";
	if (support.level === "provider_managed") return "managed_by_provider";
	const verification = support.verification;
	const hasConditions = support.conditions.length > 0;
	if (verification.status === "verified") return hasConditions ? "conditional" : "supported";
	if (verification.status === "conditional") return "conditional";
	const blockedBy = verification.status === "planned" ? verification.blockedBy : undefined;
	if (blockedBy?.kind === "decision") return "requires_policy_decision";
	if (blockedBy !== undefined) return "requires_semantic_validation";
	return hasConditions ? "conditional_not_implemented" : "planned";
}

/** The rendered status text, with the blocker reference for blocked statuses. */
export function renderCapabilityStatus(support: OperationSupport): string {
	const id = capabilityStatusLabel(support);
	const label = capabilityStatusLabels.find((entry) => entry.id === id)?.label ?? id;
	if (id !== "requires_policy_decision" && id !== "requires_semantic_validation") return label;
	const ref = support.verification.status === "planned" ? support.verification.blockedBy?.ref : "";
	return ref === undefined || ref === "" ? label : `${label} (${ref})`;
}

/** One deterministic English sentence for renderers. */
export function describeCondition(condition: CapabilityCondition): string {
	switch (condition.kind) {
		case "connection_enabled":
			return "The provider connection must be enabled.";
		case "connection_validated":
			return "The provider connection must be validated.";
		case "account_flag":
			return `The connection setting ${JSON.stringify(condition.flag)} must be ${alternatives(
				condition.expected.map((value) =>
					typeof value === "string" ? JSON.stringify(value) : String(value),
				),
			)}.`;
		case "currency":
			return `The currency must be ${alternatives(condition.allowed)}.`;
		case "catalog_bound":
			return "The catalog item must be bound to a product on this provider.";
		case "subscription_state":
			return `The subscription state must be ${alternatives(condition.allowed)}.`;
		case "cancellation_pending":
			return "The subscription must have a cancellation pending at its period end.";
		case "collection_method":
			return `The subscription must use ${alternatives(condition.allowed)} collection.`;
		case "billing_interval":
			return `Recurring prices must bill ${alternatives(
				condition.allowed.map((interval) => (interval === "month" ? "monthly" : "yearly")),
			)}.`;
		case "uniform_billing_interval":
			return "All recurring prices must share one billing interval.";
		case "saved_payment_method":
			return condition.resolveWith === undefined
				? "The customer must have a saved payment method."
				: `The customer must have a saved payment method; without one, use ${condition.resolveWith}.`;
		case "renewal_exclusion_window":
			return `The operation is unavailable during the ${condition.minutes} ${
				condition.minutes === 1 ? "minute" : "minutes"
			} before the next renewal.`;
		case "requires_prior":
			return `The customer must first complete ${condition.operation}.`;
		case "amount_bounds":
			if (condition.minMinor !== undefined && condition.maxMinor !== undefined) {
				return `The amount must be between ${condition.minMinor} and ${condition.maxMinor} minor units.`;
			}
			if (condition.minMinor !== undefined) {
				return `The amount must be at least ${condition.minMinor} minor units.`;
			}
			if (condition.maxMinor !== undefined) {
				return `The amount must be at most ${condition.maxMinor} minor units.`;
			}
			return "The amount must be within the declared bounds.";
		case "quantity_integer":
			return "Quantities must be whole numbers.";
	}
}

function alternatives(values: readonly string[]): string {
	if (values.length === 0) return "none";
	if (values.length === 1) return values[0] as string;
	return `${values.slice(0, -1).join(", ")} or ${values.at(-1)}`;
}

function distinct<T extends string>(values: readonly T[]): T[] {
	return [...new Set(values)];
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
	return typeof value === "string" && value.trim() !== "";
}

function nonEmptyStrings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter(isNonBlankString) : [];
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIsoDate(value: unknown): boolean {
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
