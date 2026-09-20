import { z } from "zod";
import { subscriptionStatuses } from "../../billing/types";
import type {
	BillingAccountAvailableActions,
	ProviderConnectionSummary,
	ProviderEnvironmentCapabilities,
	SubscriptionAvailableActions,
} from "../../providers/capability-read-types";
import type { CatalogProviderCompatibility } from "../../providers/catalog-compatibility-types";
import {
	billingChannels,
	type CapabilityCondition,
	type CapabilityEvidence,
	type CapabilityReason,
	type CapabilityResolution,
	type CapabilityVerdict,
	type CapabilityVerification,
	capabilityBlockerKinds,
	capabilityLayers,
	capabilityOutcomes,
	capabilityStatusLabelIds,
	changeBillingModes,
	changeCollectionTimings,
	declarationAvailabilities,
	declaredProviders,
	type OperationSupport,
	type ProviderCapabilityDeclaration,
	type ProviderOperation,
	providerOperationDomains,
	providerOperations,
	type RuntimeCapabilityVerdict,
	supportLevels,
	uncertainWriteModes,
	webhookOrderings,
} from "../../shared/provider-capabilities";
import {
	CapabilityConditionSchema,
	CapabilityReasonSchema,
	type CapabilityResolutionSchema,
	catalogCompatibilityTargetSchema,
	ProviderOperationSchema,
} from "../../shared/provider-capability-schemas";
import { billingProviderValues } from "./provider-enum";
export const StripeBillingAccountSummarySchema = z.object({
	schemaVersion: z.literal(1),
	customerExists: z.boolean(),
	subscriptions: z.array(
		z.object({
			id: z.string(),
			plan: z.string(),
			status: z.enum(["trialing", "active", "past_due", "unpaid", "cancelled"]),
			currentPeriodStart: z.union([z.null(), z.string()]),
			currentPeriodEnd: z.union([z.null(), z.string()]),
			cancelAtPeriodEnd: z.boolean(),
		}),
	),
	recentInvoices: z.array(
		z.object({
			id: z.string(),
			status: z.enum(["draft", "open", "paid", "uncollectible", "void", "unknown"]),
			amountPaidCents: z.number(),
			currency: z.string(),
			paidAt: z.union([z.null(), z.string()]),
			createdAt: z.string(),
		}),
	),
});
export const SubscriptionChangeOperationSchema = z.object({
	changeId: z.string(),
	projectInstanceId: z.string(),
	projectKey: z.string(),
	status: z.enum(["cancelled", "pending", "processing", "applied", "failed"]),
	changeKind: z.enum(["upgrade", "downgrade", "quantity"]),
	effectiveMode: z.enum(["immediate", "period_end"]),
	effectiveAt: z.string(),
	prorationBehavior: z.enum(["always_invoice", "create_prorations", "none"]),
	externalSubscriptionId: z.string(),
	targetPlanVersionId: z.string(),
	items: z.array(
		z.object({
			providerSubscriptionItemId: z.string().optional(),
			externalPriceId: z.string().optional(),
			quantity: z.number().optional(),
			deleted: z.literal(true).optional(),
		}),
	),
});
export const EntitlementSnapshotSchema = z.object({
	billingAccountId: z.string(),
	entitlements: z.array(
		z.object({
			key: z.string(),
			active: z.boolean(),
			expiresAt: z.union([z.null(), z.string()]),
			metadata: z.record(z.string(), z.unknown()),
		}),
	),
	generatedAt: z.string(),
});
export const AppleWebhookResultSchema = z.object({
	status: z.enum(["processed", "skipped", "ignored"]),
	entitlements: z.union([
		z.null(),
		z.object({
			billingAccountId: z.string(),
			entitlements: z.array(
				z.object({
					key: z.string(),
					active: z.boolean(),
					expiresAt: z.union([z.null(), z.string()]),
					metadata: z.record(z.string(), z.unknown()),
				}),
			),
			generatedAt: z.string(),
		}),
	]),
});
export const GoogleWebhookResultSchema = z.object({
	processed: z.boolean(),
	eventType: z.string(),
	messageId: z.string(),
	entitlements: z
		.union([
			z.null(),
			z.object({
				billingAccountId: z.string(),
				entitlements: z.array(
					z.object({
						key: z.string(),
						active: z.boolean(),
						expiresAt: z.union([z.null(), z.string()]),
						metadata: z.record(z.string(), z.unknown()),
					}),
				),
				generatedAt: z.string(),
			}),
		])
		.optional(),
});

/** Wire mirrors of the provider capability contract in `src/shared/provider-capabilities.ts`. */
export {
	CapabilityConditionSchema,
	CapabilityReasonSchema,
	CapabilityResolutionSchema,
	ProviderOperationSchema,
} from "../../shared/provider-capability-schemas";

export const CapabilityEvidenceSchema = z.object({
	tests: z.array(z.string()),
	scenarios: z.array(z.string()),
	questions: z.array(z.string()),
});

export const CapabilityVerificationSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("verified"),
		verifiedOn: z.string(),
		note: z.string().optional(),
		evidence: CapabilityEvidenceSchema,
	}),
	z.object({
		status: z.literal("conditional"),
		verifiedOn: z.string(),
		note: z.string().optional(),
		evidence: CapabilityEvidenceSchema,
	}),
	z.object({
		status: z.literal("planned"),
		trackedBy: z.string().optional(),
		blockedBy: z.object({ kind: z.enum(capabilityBlockerKinds), ref: z.string() }).optional(),
		evidence: CapabilityEvidenceSchema.optional(),
	}),
	z.object({
		status: z.literal("not_applicable"),
		evidence: CapabilityEvidenceSchema.optional(),
	}),
]);

export const ProviderOperationSupportSchema = z.object({
	level: z.enum(supportLevels),
	composedVia: z.string().optional(),
	verification: CapabilityVerificationSchema,
	conditions: z.array(CapabilityConditionSchema),
	notes: z.string().optional(),
});

const operationSupportShape = Object.fromEntries(
	providerOperations.map((operation) => [operation, ProviderOperationSupportSchema]),
) as Record<ProviderOperation, typeof ProviderOperationSupportSchema>;

export const ProviderCapabilityDeclarationSchema = z.object({
	provider: z.enum(declaredProviders),
	channel: z.enum(billingChannels),
	connectionKind: z.string(),
	availability: z.enum(declarationAvailabilities),
	writeSemantics: z.object({
		clientIdempotencyKeys: z.boolean(),
		uncertainWrite: z.enum(uncertainWriteModes),
	}),
	limits: z
		.object({
			requestsPerMinute: z.number().optional(),
			webhookRetries: z.object({ attempts: z.number(), windowHours: z.number() }).optional(),
			webhookOrdering: z.enum(webhookOrderings).optional(),
		})
		.optional(),
	changeBillingPolicies: z
		.array(
			z.object({
				billing: z.enum(changeBillingModes),
				collection: z.enum(changeCollectionTimings),
			}),
		)
		.optional(),
	operations: z.object(operationSupportShape),
});

/** The committed `contracts/v1/provider-capabilities.json` artifact. */
export const ProviderCapabilityMatrixSchema = z.object({
	schemaVersion: z.literal(1),
	domains: z.array(z.object({ id: z.enum(providerOperationDomains), title: z.string() })),
	operations: z.array(
		z.object({
			id: ProviderOperationSchema,
			domain: z.enum(providerOperationDomains),
			title: z.string(),
			description: z.string(),
		}),
	),
	labels: z.array(
		z.object({ id: z.enum(capabilityStatusLabelIds), label: z.string(), rule: z.string() }),
	),
	supportLevels: z.array(z.object({ id: z.enum(supportLevels), label: z.string() })),
	providers: z.array(ProviderCapabilityDeclarationSchema),
});

export const CapabilityVerdictSchema = z.object({
	provider: z.enum(declaredProviders),
	operation: ProviderOperationSchema,
	outcome: z.enum(capabilityOutcomes),
	level: z.enum(supportLevels),
	composedVia: z.string().optional(),
	blockingLayer: z.union([z.null(), z.enum(capabilityLayers)]),
	reasons: z.array(CapabilityReasonSchema),
});

/** Runtime surfaces report admitted providers only, so their verdicts never name a planned one. */
export const RuntimeCapabilityVerdictSchema = CapabilityVerdictSchema.extend({
	provider: z.enum(billingProviderValues()),
});

export const CatalogProviderCompatibilitySchema = z.object({
	target: catalogCompatibilityTargetSchema,
	provider: z.enum(billingProviderValues()),
	channel: z.enum(billingChannels),
	productKey: z.union([z.null(), z.string()]),
	requiredOperations: z.array(ProviderOperationSchema),
	compatible: z.boolean(),
	verdicts: z.array(RuntimeCapabilityVerdictSchema),
});

export const ProviderConnectionSummarySchema = z.object({
	configured: z.boolean(),
	enabled: z.boolean(),
	validated: z.boolean(),
	validatedAt: z.union([z.null(), z.string()]),
	accountIdentity: z.union([z.null(), z.string()]),
});

export const ProviderEnvironmentCapabilitiesSchema = z.object({
	schemaVersion: z.literal(1),
	generatedAt: z.string(),
	providers: z.array(
		z.object({
			provider: z.enum(billingProviderValues()),
			channel: z.enum(billingChannels),
			connectionKind: z.string(),
			connection: z.union([z.null(), ProviderConnectionSummarySchema]),
			operations: z.array(RuntimeCapabilityVerdictSchema),
		}),
	),
});

export const SubscriptionAvailableActionsSchema = z.object({
	id: z.string(),
	provider: z.enum(billingProviderValues()),
	channel: z.enum(billingChannels),
	status: z.enum(subscriptionStatuses),
	planKey: z.union([z.null(), z.string()]),
	currentPeriodEnd: z.union([z.null(), z.string()]),
	cancelAtPeriodEnd: z.boolean(),
	pendingChange: z.union([
		z.null(),
		z.object({
			changeId: z.string(),
			status: z.enum(["pending", "processing"]),
			effectiveMode: z.enum(["immediate", "period_end"]),
			effectiveAt: z.string(),
		}),
	]),
	actions: z.array(RuntimeCapabilityVerdictSchema),
});

export const BillingAccountAvailableActionsSchema = z.object({
	schemaVersion: z.literal(1),
	billingAccountId: z.string(),
	customerExists: z.boolean(),
	generatedAt: z.string(),
	account: z.array(RuntimeCapabilityVerdictSchema),
	subscriptions: z.array(SubscriptionAvailableActionsSchema),
});

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;
/** Fails typechecking when a wire schema drifts from the shared contract type it mirrors. */
export type ProviderCapabilitySchemaMirrors = [
	Expect<MutuallyAssignable<z.infer<typeof ProviderOperationSchema>, ProviderOperation>>,
	Expect<MutuallyAssignable<z.infer<typeof CapabilityEvidenceSchema>, CapabilityEvidence>>,
	Expect<MutuallyAssignable<z.infer<typeof CapabilityVerificationSchema>, CapabilityVerification>>,
	Expect<MutuallyAssignable<z.infer<typeof CapabilityConditionSchema>, CapabilityCondition>>,
	Expect<MutuallyAssignable<z.infer<typeof ProviderOperationSupportSchema>, OperationSupport>>,
	Expect<
		MutuallyAssignable<
			z.infer<typeof ProviderCapabilityDeclarationSchema>,
			ProviderCapabilityDeclaration
		>
	>,
	Expect<MutuallyAssignable<z.infer<typeof CapabilityResolutionSchema>, CapabilityResolution>>,
	Expect<MutuallyAssignable<z.infer<typeof CapabilityReasonSchema>, CapabilityReason>>,
	Expect<MutuallyAssignable<z.infer<typeof CapabilityVerdictSchema>, CapabilityVerdict>>,
	Expect<
		MutuallyAssignable<z.infer<typeof RuntimeCapabilityVerdictSchema>, RuntimeCapabilityVerdict>
	>,
	Expect<
		MutuallyAssignable<
			z.infer<typeof CatalogProviderCompatibilitySchema>,
			CatalogProviderCompatibility
		>
	>,
	Expect<
		MutuallyAssignable<z.infer<typeof ProviderConnectionSummarySchema>, ProviderConnectionSummary>
	>,
	Expect<
		MutuallyAssignable<
			z.infer<typeof ProviderEnvironmentCapabilitiesSchema>,
			ProviderEnvironmentCapabilities
		>
	>,
	Expect<
		MutuallyAssignable<
			z.infer<typeof SubscriptionAvailableActionsSchema>,
			SubscriptionAvailableActions
		>
	>,
	Expect<
		MutuallyAssignable<
			z.infer<typeof BillingAccountAvailableActionsSchema>,
			BillingAccountAvailableActions
		>
	>,
];
