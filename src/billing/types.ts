import { z } from "zod";
import {
	billingChannels,
	billingProviders,
	isBillingProvider,
} from "../shared/provider-capabilities";

export { billingChannels, billingProviders, isBillingProvider };
export const productTypes = ["subscription", "consumable", "non_consumable"] as const;
export const purchaseStatuses = ["completed", "refunded", "revoked", "voided"] as const;
export const subscriptionStatuses = [
	"active",
	"grace_period",
	"billing_retry",
	"cancelled",
	"expired",
	"refunded",
	"revoked",
] as const;
export const storeEventProcessingStatuses = [
	"pending",
	"processing",
	"processed",
	"skipped",
	"failed",
] as const;
export const projectionSyncStatuses = ["pending", "processing", "succeeded", "failed"] as const;
export const projectionSyncReasons = [
	"purchase_verified",
	"provider_webhook",
	"expiry_reconciliation",
	"provider_reconciliation",
	"usage_changed",
] as const;

export type BillingProvider = (typeof billingProviders)[number];
export type BillingChannel = (typeof billingChannels)[number];
export type ProductType = "subscription" | "consumable" | "non_consumable";
export type PurchaseKind = ProductType;
export type PurchaseStatus = "completed" | "refunded" | "revoked" | "voided";
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];
export type StoreEventProcessingStatus = (typeof storeEventProcessingStatuses)[number];
export type ProjectionSyncStatus = (typeof projectionSyncStatuses)[number];
export type ProjectionSyncReason = (typeof projectionSyncReasons)[number];
export type ProjectionContract = "billing_state_v1";

export interface EntitlementSnapshotItem {
	key: string;
	active: boolean;
	expiresAt: string | null;
	metadata: Record<string, unknown>;
}

export interface EntitlementSnapshot {
	billingAccountId: string;
	entitlements: EntitlementSnapshotItem[];
	generatedAt: string;
}

export interface ProjectionReversalPayload {
	provider: BillingProvider;
	channel: BillingChannel;
	reason: "refund" | "dispute";
	transactionId: string;
	originalTransactionId: string;
	productKey: string;
	creditAmount: number;
	totalCreditAmount?: number;
	quantity?: number;
	reversedAt: string;
}

export const projectionTrialEvents = ["ending", "ended"] as const;
export const projectionTrialSources = ["subscription", "plan_grant"] as const;
export type ProjectionTrialEvent = (typeof projectionTrialEvents)[number];
export type ProjectionTrialSource = (typeof projectionTrialSources)[number];

/**
 * A trial event for one trial: `ending` shortly before its end, `ended` when a trial without a
 * paid successor stops. A provider subscription names its provider identity and product; a plan
 * grant names the grant and its plan.
 */
export interface ProjectionTrialPayload {
	event: ProjectionTrialEvent;
	source: ProjectionTrialSource;
	provider?: BillingProvider;
	channel?: BillingChannel;
	externalSubscriptionId?: string;
	planGrantId?: string;
	productKey?: string;
	planKey?: string;
	trialStartsAt: string;
	trialEndsAt: string;
	/** Whether the subscription continues as a paid one after the trial unless cancelled. */
	autoRenew: boolean;
}

export interface ProjectionPayload {
	billingAccountId: string;
	generatedAt: string;
	entitlements: EntitlementSnapshot;
	balances: Array<{
		featureKey: string;
		unit: string;
		available: string;
		held: string;
		periodEndsAt: string | null;
	}>;
	reason: ProjectionSyncReason;
	purchase?: {
		provider: BillingProvider;
		channel: BillingChannel;
		purchaseKind: ProductType;
		transactionId: string;
		productKey: string;
		creditAmount: number;
		totalCreditAmount?: number;
		quantity?: number;
		refundableQuantity?: number;
		purchasedAt: string;
	};
	reversal?: ProjectionReversalPayload;
	trial?: ProjectionTrialPayload;
	/** Per-account order of state snapshots; receivers may ignore a lower value. */
	sequence?: number;
}
export type ProjectionJobPayload = ProjectionPayload;

export const entitlementSnapshotSchema = z.object({
	billingAccountId: z.string().min(1),
	entitlements: z.array(
		z.object({
			key: z.string().min(1),
			active: z.boolean(),
			expiresAt: z.string().nullable(),
			metadata: z.record(z.string(), z.unknown()),
		}),
	),
	generatedAt: z.string().min(1),
});

const projectionReversalPayloadSchema = z.object({
	provider: z.enum(billingProviders),
	channel: z.enum(billingChannels),
	reason: z.enum(["refund", "dispute"]),
	transactionId: z.string().min(1),
	originalTransactionId: z.string().min(1),
	productKey: z.string().min(1),
	creditAmount: z.number().int().nonnegative(),
	totalCreditAmount: z.number().int().nonnegative().optional(),
	quantity: z.number().int().positive().optional(),
	reversedAt: z.string().min(1),
});

const projectionTrialPayloadSchema = z
	.object({
		event: z.enum(projectionTrialEvents),
		source: z.enum(projectionTrialSources),
		provider: z.enum(billingProviders).optional(),
		channel: z.enum(billingChannels).optional(),
		externalSubscriptionId: z.string().min(1).optional(),
		planGrantId: z.string().min(1).optional(),
		productKey: z.string().min(1).optional(),
		planKey: z.string().min(1).optional(),
		trialStartsAt: z.iso.datetime({ offset: true }),
		trialEndsAt: z.iso.datetime({ offset: true }),
		autoRenew: z.boolean(),
	})
	.superRefine((trial, context) => {
		const subscription = trial.source === "subscription";
		const required: Array<keyof typeof trial> = subscription
			? ["provider", "channel", "externalSubscriptionId", "productKey"]
			: ["planGrantId", "planKey"];
		const absent: Array<keyof typeof trial> = subscription
			? ["planGrantId"]
			: ["provider", "channel", "externalSubscriptionId"];
		for (const field of required) {
			if (trial[field] === undefined) {
				context.addIssue({ code: "custom", message: `${field} is required`, path: [field] });
			}
		}
		for (const field of absent) {
			if (trial[field] !== undefined) {
				context.addIssue({ code: "custom", message: `${field} is not allowed`, path: [field] });
			}
		}
		if (Date.parse(trial.trialEndsAt) <= Date.parse(trial.trialStartsAt)) {
			context.addIssue({
				code: "custom",
				message: "Trial must end after it starts",
				path: ["trialEndsAt"],
			});
		}
	});

export const projectionPayloadSchema = z
	.object({
		billingAccountId: z.string().min(1),
		generatedAt: z.iso.datetime({ offset: true }),
		entitlements: entitlementSnapshotSchema,
		balances: z.array(
			z
				.object({
					featureKey: z.string().trim().min(1),
					unit: z.string().trim().min(1),
					available: z.string().regex(/^\d+(?:\.\d+)?$/),
					held: z.string().regex(/^\d+(?:\.\d+)?$/),
					periodEndsAt: z.iso.datetime({ offset: true }).nullable(),
				})
				.strict(),
		),
		reason: z.enum(projectionSyncReasons),
		purchase: z
			.object({
				provider: z.enum(billingProviders),
				channel: z.enum(billingChannels),
				purchaseKind: z.enum(productTypes),
				transactionId: z.string().min(1),
				productKey: z.string().min(1),
				creditAmount: z.number().int().nonnegative(),
				totalCreditAmount: z.number().int().nonnegative().optional(),
				quantity: z.number().int().positive().optional(),
				refundableQuantity: z.number().int().nonnegative().optional(),
				purchasedAt: z.string().min(1),
			})
			.optional(),
		reversal: projectionReversalPayloadSchema.optional(),
		trial: projectionTrialPayloadSchema.optional(),
		sequence: z.number().int().nonnegative().optional(),
	})
	.superRefine((payload, context) => {
		if (payload.billingAccountId !== payload.entitlements.billingAccountId) {
			context.addIssue({
				code: "custom",
				message: "Projection payload user mismatch",
				path: ["entitlements", "billingAccountId"],
			});
		}

		if (payload.generatedAt !== payload.entitlements.generatedAt) {
			context.addIssue({
				code: "custom",
				message: "Projection payload generation time mismatch",
				path: ["generatedAt"],
			});
		}

		if (payload.purchase !== undefined && payload.reversal !== undefined) {
			context.addIssue({
				code: "custom",
				message: "Projection payload cannot include both purchase and reversal context",
				path: ["reversal"],
			});
		}

		if (
			payload.trial !== undefined &&
			(payload.purchase !== undefined || payload.reversal !== undefined)
		) {
			context.addIssue({
				code: "custom",
				message:
					"Projection payload cannot include trial context with purchase or reversal context",
				path: ["trial"],
			});
		}
	});

const providers = new Set<BillingProvider>(billingProviders);
const channels = new Set<BillingChannel>(billingChannels);
const supportedProductTypes = new Set<ProductType>(productTypes);
const storeEventStatuses = new Set<StoreEventProcessingStatus>(storeEventProcessingStatuses);
const projectionReasons = new Set<ProjectionSyncReason>(projectionSyncReasons);
const projectionStatuses = new Set<ProjectionSyncStatus>(projectionSyncStatuses);

export function parseProvider(value: string): BillingProvider {
	if (providers.has(value as BillingProvider)) {
		return value as BillingProvider;
	}
	throw new Error(`Unsupported billing provider: ${value}`);
}

export function parseChannel(value: string): BillingChannel {
	if (channels.has(value as BillingChannel)) {
		return value as BillingChannel;
	}
	throw new Error(`Unsupported billing channel: ${value}`);
}

export function parseProductType(value: string): ProductType {
	if (supportedProductTypes.has(value as ProductType)) {
		return value as ProductType;
	}
	throw new Error(`Unsupported product type: ${value}`);
}

export function parseProjectionSyncReason(value: string): ProjectionSyncReason {
	if (projectionReasons.has(value as ProjectionSyncReason)) {
		return value as ProjectionSyncReason;
	}
	throw new Error(`Unsupported projection sync reason: ${value}`);
}

export function parseStoreEventProcessingStatus(value: string): StoreEventProcessingStatus {
	if (storeEventStatuses.has(value as StoreEventProcessingStatus)) {
		return value as StoreEventProcessingStatus;
	}
	throw new Error(`Unsupported store event processing status: ${value}`);
}

export function parseProjectionSyncStatus(value: string): ProjectionSyncStatus {
	if (projectionStatuses.has(value as ProjectionSyncStatus)) {
		return value as ProjectionSyncStatus;
	}
	throw new Error(`Unsupported projection sync status: ${value}`);
}

export function parseProjectionPayload(value: unknown): ProjectionPayload {
	const parsed = projectionPayloadSchema.safeParse(value);

	if (!parsed.success) {
		throw new Error("Invalid projection payload");
	}

	return parsed.data;
}

export function parseProjectionJobPayload(value: unknown): ProjectionJobPayload {
	return parseProjectionPayload(value);
}

export function parseEntitlementSnapshot(value: unknown): EntitlementSnapshot {
	const parsed = entitlementSnapshotSchema.safeParse(value);

	if (!parsed.success) {
		throw new Error("Invalid entitlement snapshot");
	}

	return parsed.data;
}
