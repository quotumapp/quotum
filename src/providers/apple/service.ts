import { BillingError } from "../../billing/errors";
import type { EntitlementSnapshot } from "../../billing/types";
import type {
	ProviderSubscriptionReconciliationRow,
	RecordStoreKitTransactionProjectionInput,
	StoreEventReplayJobRow,
	StoreKitRecordingResult,
} from "../../db/repository";
import type { StoreEventReplayProviderResult } from "../../workers/store-event-replay";
import {
	normalizeStoredStoreKitEvent,
	normalizeStoreKitNotification,
	normalizeStoreKitSubscriptionStatusRefresh,
	normalizeVerifiedStoreKitTransaction,
} from "./normalizer";
import type {
	AppleEnvironmentName,
	AppleVerifyPurchaseInput,
	AppleWebhookInput,
	AppleWebhookResult,
	NormalizedStoreKitTransaction,
} from "./types";

interface AppleStoreKitClientDependency {
	verifyTransaction(transactionId: string): Promise<{
		environment: "sandbox" | "production";
		transaction: Parameters<typeof normalizeVerifiedStoreKitTransaction>[0]["transaction"];
		renewalInfo: Parameters<typeof normalizeVerifiedStoreKitTransaction>[0]["renewalInfo"];
	}>;

	verifyNotification(signedPayload: string): Promise<{
		environment: "sandbox" | "production";
		notification: Parameters<typeof normalizeStoreKitNotification>[0]["notification"];
		transaction: Parameters<typeof normalizeStoreKitNotification>[0]["transaction"];
		renewalInfo: Parameters<typeof normalizeStoreKitNotification>[0]["renewalInfo"];
	}>;

	getLatestSubscriptionStatus(originalTransactionId: string): Promise<{
		environment: "sandbox" | "production";
		transaction: Parameters<typeof normalizeStoreKitSubscriptionStatusRefresh>[0]["transaction"];
		renewalInfo: Parameters<typeof normalizeStoreKitSubscriptionStatusRefresh>[0]["renewalInfo"];
		storeKitStatus: number | null;
	} | null>;
}

interface AppleStoreKitRepositoryDependency {
	getOrCreateProviderCustomerToken(billingAccountId: string, provider: "apple"): Promise<string>;
	recordStoreKitTransactionAndEnqueueProjection(
		input: RecordStoreKitTransactionProjectionInput,
	): Promise<StoreKitRecordingResult>;
}

export interface AppleStoreKitServiceDependencies {
	bundleId: string;
	environment: AppleEnvironmentName;
	client: AppleStoreKitClientDependency;
	repository: AppleStoreKitRepositoryDependency;
}

export class AppleStoreKitService {
	constructor(private readonly dependencies: AppleStoreKitServiceDependencies) {}

	async getOrCreateAppAccountToken(billingAccountId: string): Promise<string> {
		const normalizedBillingAccountId = requireNonBlank(billingAccountId, "billingAccountId");
		return this.dependencies.repository.getOrCreateProviderCustomerToken(
			normalizedBillingAccountId,
			"apple",
		);
	}

	async verifyPurchase(input: AppleVerifyPurchaseInput): Promise<EntitlementSnapshot> {
		const billingAccountId = requireNonBlank(input.billingAccountId, "billingAccountId");
		const transactionId = requireNonBlank(input.transactionId, "transactionId");
		const expectedAppAccountToken = await this.getOrCreateAppAccountToken(billingAccountId);
		const verified = await this.dependencies.client.verifyTransaction(transactionId);
		const command = normalizeVerifiedStoreKitTransaction({
			billingAccountId,
			transaction: verified.transaction,
			renewalInfo: verified.renewalInfo,
			expectedBundleId: this.dependencies.bundleId,
			expectedEnvironment: this.dependencies.environment,
		});

		if (command.appAccountToken !== expectedAppAccountToken) {
			throw new BillingError(
				"StoreKit transaction app account token does not match customer",
				"STOREKIT_ACCOUNT_TOKEN_MISMATCH",
				403,
			);
		}

		const result = await this.dependencies.repository.recordStoreKitTransactionAndEnqueueProjection(
			toRepositoryInput(command),
		);

		return requireProcessedEntitlements(result);
	}

	async handleNotification(input: AppleWebhookInput): Promise<AppleWebhookResult> {
		const signedPayload = requireNonBlank(input.signedPayload, "signedPayload");
		const verified = await this.dependencies.client.verifyNotification(signedPayload);
		const command = normalizeStoreKitNotification({
			notification: verified.notification,
			transaction: verified.transaction,
			renewalInfo: verified.renewalInfo,
			expectedBundleId: this.dependencies.bundleId,
			expectedEnvironment: this.dependencies.environment,
		});

		if (command === null) {
			return { status: "ignored", entitlements: null };
		}

		const result = await this.dependencies.repository.recordStoreKitTransactionAndEnqueueProjection(
			toRepositoryInput(command),
		);

		if (result.processingStatus === "skipped") {
			return { status: "skipped", entitlements: null };
		}

		return {
			status: "processed",
			entitlements: requireProcessedEntitlements(result),
		};
	}

	async replayStoreEvent(event: StoreEventReplayJobRow): Promise<StoreEventReplayProviderResult> {
		if (event.provider !== "apple" || event.channel !== "ios") {
			throw new BillingError("Store event is not an Apple iOS event", "INVALID_REQUEST", 400);
		}

		const command = normalizeStoredStoreKitEvent({
			event,
			expectedBundleId: this.dependencies.bundleId,
			expectedEnvironment: this.dependencies.environment,
		});

		if (command === null) {
			return { status: "ignored", reason: "apple_store_event_not_recordable" };
		}

		const result = await this.dependencies.repository.recordStoreKitTransactionAndEnqueueProjection(
			toRepositoryInput(command, event.id),
		);

		if (result.processingStatus === "skipped") {
			return { status: "retryable", reason: "apple_customer_unresolved" };
		}

		return { status: "processed" };
	}

	async reconcileSubscription(
		subscription: ProviderSubscriptionReconciliationRow,
	): Promise<{ status: "processed" | "skipped" }> {
		if (subscription.provider !== "apple") {
			throw new BillingError(
				"Provider subscription is not an Apple subscription",
				"INVALID_REQUEST",
				400,
			);
		}

		const verified = await this.dependencies.client.getLatestSubscriptionStatus(
			subscription.external_subscription_id,
		);

		if (verified === null) {
			return { status: "skipped" };
		}

		const command = normalizeStoreKitSubscriptionStatusRefresh({
			billingAccountId: null,
			transaction: verified.transaction,
			renewalInfo: verified.renewalInfo,
			storeKitStatus: verified.storeKitStatus,
			expectedBundleId: this.dependencies.bundleId,
			expectedEnvironment: this.dependencies.environment,
		});
		const result = await this.dependencies.repository.recordStoreKitTransactionAndEnqueueProjection(
			toRepositoryInput(command),
		);

		return { status: result.processingStatus };
	}
}

function toRepositoryInput(
	command: NormalizedStoreKitTransaction,
	replayStoreEventId?: string,
): RecordStoreKitTransactionProjectionInput {
	return {
		billingAccountId: command.billingAccountId,
		appAccountToken: command.appAccountToken,
		channel: "ios",
		externalProductId: command.externalProductId,
		purchaseKind: command.purchaseKind,
		transactionId: command.transactionId,
		originalTransactionId: command.originalTransactionId,
		webOrderLineItemId: command.webOrderLineItemId,
		purchaseStatus: command.purchaseStatus,
		subscriptionStatus: command.subscriptionStatus,
		purchasedAt: command.purchasedAt,
		expiresAt: command.expiresAt,
		autoRenew: command.autoRenew,
		invalidatedAt: command.invalidatedAt,
		invalidationReason: command.invalidationReason,
		rawPayload: command.rawPayload,
		eventType: command.eventType,
		externalEventId: command.externalEventId,
		projectionReason: command.projectionReason,
		projectionIdempotencyKey: command.projectionIdempotencyKey,
		replayStoreEventId,
	};
}

function requireProcessedEntitlements(result: StoreKitRecordingResult): EntitlementSnapshot {
	if (result.processingStatus !== "processed" || result.entitlements === null) {
		throw new BillingError(
			"StoreKit transaction did not produce an entitlement snapshot",
			"STOREKIT_RECORDING_SKIPPED",
			409,
		);
	}

	return result.entitlements;
}

function requireNonBlank(value: string, name: string): string {
	const trimmed = value.trim();
	if (trimmed === "") {
		throw new BillingError(`${name} must not be blank`, "INVALID_REQUEST", 400);
	}

	return trimmed;
}
