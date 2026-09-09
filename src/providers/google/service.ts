import { BillingError } from "../../billing/errors";
import type { EntitlementSnapshot } from "../../billing/types";
import type {
	GooglePlayRecordingResult,
	ProviderSubscriptionReconciliationRow,
	RecordGooglePurchaseProjectionInput,
	RecordGoogleVoidedPurchaseProjectionInput,
	StoreEventReplayJobRow,
} from "../../db/repository";
import type { StoreEventReplayProviderResult } from "../../workers/store-event-replay";
import { requireNonBlank } from "../validation";
import { createGoogleObfuscatedAccountId } from "./account-link";
import type { GooglePlayConfig } from "./config";
import {
	googleProductQuantityState,
	normalizeGoogleProductPurchase,
	normalizeGoogleSubscriptionPurchase,
	normalizeGoogleTestNotification,
	normalizeStoredGoogleStoreEvent,
} from "./normalizer";
import { verifyGooglePubSubAuthorization, verifyGooglePubSubPush } from "./pubsub";
import type {
	GoogleAccountLink,
	GoogleVerifyPurchaseInput,
	GoogleWebhookResult,
	NormalizedGooglePurchase,
	VerifiedGoogleRtdn,
} from "./types";

interface GooglePlayClientDependency {
	getSubscriptionPurchase(token: string): Promise<unknown>;

	acknowledgeSubscriptionPurchase(
		subscriptionId: string,
		token: string,
		obfuscatedAccountId: string,
	): Promise<void>;

	getProductPurchase(token: string): Promise<unknown>;

	acknowledgeProductPurchase(productId: string, token: string): Promise<void>;

	consumeProductPurchase(productId: string, token: string): Promise<void>;
}

interface GooglePlayRepositoryDependency {
	getOrCreateGoogleProviderCustomer(
		billingAccountId: string,
		obfuscatedAccountId: string,
	): Promise<string>;
	getGoogleAndroidProductKind(externalProductId: string): Promise<"consumable" | "non_consumable">;
	recordGooglePurchaseAndEnqueueProjection(
		input: RecordGooglePurchaseProjectionInput,
	): Promise<GooglePlayRecordingResult>;
	recordGoogleVoidedPurchaseAndEnqueueProjection(
		input: RecordGoogleVoidedPurchaseProjectionInput,
	): Promise<GooglePlayRecordingResult>;
}

export interface GooglePlayBillingServiceDependencies {
	config: Pick<
		GooglePlayConfig,
		| "packageName"
		| "obfuscatedAccountIdSecret"
		| "previousObfuscatedAccountIdSecrets"
		| "rtdnAudience"
		| "rtdnServiceAccountEmail"
		| "rtdnAuthorizedParty"
		| "enablePublisherMutations"
	>;
	client: GooglePlayClientDependency;
	repository: GooglePlayRepositoryDependency;
	verifyRtdn?: (input: {
		authorizationHeader: string | null;
		body: unknown;
	}) => Promise<VerifiedGoogleRtdn>;
	verifyRtdnAuthorization?: (authorizationHeader: string | null) => Promise<void>;
}

export class GooglePlayBillingService {
	constructor(private readonly dependencies: GooglePlayBillingServiceDependencies) {}

	async getAccountLink(billingAccountId: string): Promise<GoogleAccountLink> {
		const normalizedBillingAccountId = requireNonBlank(billingAccountId, "billingAccountId");
		const obfuscatedAccountId = createGoogleObfuscatedAccountId(
			normalizedBillingAccountId,
			this.dependencies.config.obfuscatedAccountIdSecret,
		);

		await this.dependencies.repository.getOrCreateGoogleProviderCustomer(
			normalizedBillingAccountId,
			obfuscatedAccountId,
		);

		return { obfuscatedAccountId };
	}

	async verifyPurchase(input: GoogleVerifyPurchaseInput): Promise<EntitlementSnapshot> {
		const billingAccountId = requireNonBlank(input.billingAccountId, "billingAccountId");
		const purchaseToken = requireNonBlank(input.purchaseToken, "purchaseToken");
		await this.getAccountLink(billingAccountId);
		const acceptedAccountIds = this.googleObfuscatedAccountIds(billingAccountId);
		const command =
			input.purchaseKind === "subscription"
				? await this.verifySubscription(billingAccountId, purchaseToken)
				: await this.verifyProduct(
						billingAccountId,
						purchaseToken,
						input.purchaseKind,
						input.productId,
					);

		if (command === null) {
			throw new BillingError(
				"Google Play purchase is pending",
				"GOOGLE_PLAY_PURCHASE_PENDING",
				409,
			);
		}

		if (
			command.obfuscatedAccountId === null ||
			!acceptedAccountIds.includes(command.obfuscatedAccountId)
		) {
			throw new BillingError(
				"Google Play purchase account id does not match customer",
				"GOOGLE_PLAY_ACCOUNT_ID_MISMATCH",
				409,
			);
		}

		const result = await this.dependencies.repository.recordGooglePurchaseAndEnqueueProjection(
			toRepositoryInput(command),
		);
		const entitlements = requireProcessedEntitlements(result);

		await this.applyPublisherMutations(command);
		return entitlements;
	}

	private googleObfuscatedAccountIds(billingAccountId: string): string[] {
		const secrets = [
			this.dependencies.config.obfuscatedAccountIdSecret,
			...this.dependencies.config.previousObfuscatedAccountIdSecrets,
		];

		return secrets.map((secret) => createGoogleObfuscatedAccountId(billingAccountId, secret));
	}

	async handleRtdn(input: {
		authorizationHeader: string | null;
		body: unknown;
	}): Promise<GoogleWebhookResult> {
		const verified = await this.verifyRtdn(input);
		const notification = verified.notification;

		if (notification.testNotification !== undefined) {
			normalizeGoogleTestNotification({
				messageId: verified.messageId,
				notification,
			});
			return {
				processed: false,
				eventType: "TEST",
				messageId: verified.messageId,
				entitlements: null,
			};
		}

		if (notification.voidedPurchaseNotification !== undefined) {
			return this.handleVoidedPurchaseNotification(verified);
		}

		const command = await this.commandFromNotification(verified);
		if (command === null) {
			return {
				processed: false,
				eventType: notificationEventType(notification),
				messageId: verified.messageId,
				entitlements: null,
			};
		}

		const result = await this.dependencies.repository.recordGooglePurchaseAndEnqueueProjection(
			toRepositoryInput(command),
		);

		if (result.processingStatus === "skipped") {
			return {
				processed: false,
				eventType: command.eventType,
				messageId: verified.messageId,
				entitlements: null,
			};
		}

		const entitlements = requireProcessedEntitlements(result);
		await this.applyPublisherMutations(command);

		return {
			processed: true,
			eventType: command.eventType,
			messageId: verified.messageId,
			entitlements,
		};
	}

	async replayStoreEvent(event: StoreEventReplayJobRow): Promise<StoreEventReplayProviderResult> {
		if (event.provider !== "google" || event.channel !== "android") {
			throw new BillingError("Store event is not a Google Android event", "INVALID_REQUEST", 400);
		}

		if (event.event_type === "VOIDED_PURCHASE") {
			return this.replayVoidedPurchaseEvent(event);
		}

		const command = normalizeStoredGoogleStoreEvent({ event });
		if (command === null) {
			return { status: "ignored", reason: "google_store_event_not_recordable" };
		}

		const result = await this.dependencies.repository.recordGooglePurchaseAndEnqueueProjection(
			toRepositoryInput(command, event.id),
		);

		if (result.processingStatus === "processed") {
			await this.applyPublisherMutations(command);
			return { status: "processed" };
		}

		return { status: "retryable", reason: "google_customer_unresolved" };
	}

	async reconcileSubscription(
		subscription: ProviderSubscriptionReconciliationRow,
	): Promise<{ status: "processed" | "skipped" }> {
		if (subscription.provider !== "google") {
			throw new BillingError(
				"Provider subscription is not a Google Play subscription",
				"INVALID_REQUEST",
				400,
			);
		}

		const purchaseToken = requireNonBlank(subscription.external_subscription_id, "purchaseToken");
		const purchase = await this.dependencies.client.getSubscriptionPurchase(purchaseToken);
		const command = normalizeGoogleSubscriptionPurchase({
			billingAccountId: null,
			purchaseToken,
			purchase,
			eventType: "provider_reconciliation",
			projectionReason: "provider_reconciliation",
		});

		if (command === null) {
			return { status: "skipped" };
		}

		const result = await this.dependencies.repository.recordGooglePurchaseAndEnqueueProjection(
			toRepositoryInput(command),
		);

		return { status: result.processingStatus };
	}

	private async replayVoidedPurchaseEvent(
		event: StoreEventReplayJobRow,
	): Promise<StoreEventReplayProviderResult> {
		const externalEventId = requireNonBlank(event.external_event_id ?? "", "externalEventId");
		const voidedPurchase = voidedPurchaseFromRawPayload(event.raw_payload);
		const quantityState = await this.voidedPurchaseQuantityState(
			requireGoogleProductType(voidedPurchase.productType),
			requireNonBlank(event.transaction_id ?? "", "purchaseToken"),
		);
		const result =
			await this.dependencies.repository.recordGoogleVoidedPurchaseAndEnqueueProjection({
				purchaseToken: requireNonBlank(event.transaction_id ?? "", "purchaseToken"),
				orderId: orderIdFromStoredVoidedPayload(event.raw_payload),
				refundType: requireGoogleRefundType(voidedPurchase.refundType),
				quantity: quantityState?.quantity ?? null,
				refundableQuantity: quantityState?.refundableQuantity ?? null,
				eventTime: dateFromMillis(
					requireStringValue(
						event.raw_payload.eventTimeMillis,
						"Google voided purchase event time",
					),
					"Google voided purchase event time",
				),
				rawPayload: event.raw_payload,
				eventType: "VOIDED_PURCHASE",
				externalEventId,
				projectionReason: "provider_webhook",
				projectionIdempotencyKey: `${externalEventId}:projection`,
				replayStoreEventId: event.id,
			});

		if (result.processingStatus === "processed") {
			return { status: "processed" };
		}

		return { status: "retryable", reason: "google_customer_unresolved" };
	}

	async verifyRtdnAuthorization(authorizationHeader: string | null): Promise<void> {
		if (this.dependencies.verifyRtdnAuthorization !== undefined) {
			return this.dependencies.verifyRtdnAuthorization(authorizationHeader);
		}

		return verifyGooglePubSubAuthorization(
			{ authorizationHeader },
			this.dependencies.config as GooglePlayConfig,
		);
	}

	private async verifySubscription(
		billingAccountId: string,
		purchaseToken: string,
	): Promise<NormalizedGooglePurchase | null> {
		const purchase = await this.dependencies.client.getSubscriptionPurchase(purchaseToken);
		return normalizeGoogleSubscriptionPurchase({ billingAccountId, purchaseToken, purchase });
	}

	private async verifyProduct(
		billingAccountId: string,
		purchaseToken: string,
		purchaseKind: "consumable" | "non_consumable",
		productId: string | undefined,
	): Promise<NormalizedGooglePurchase | null> {
		if (productId === undefined) {
			throw new BillingError(
				"productId is required for one-time Google Play purchases",
				"INVALID_REQUEST",
				400,
			);
		}

		const purchase = await this.dependencies.client.getProductPurchase(purchaseToken);
		return normalizeGoogleProductPurchase({
			billingAccountId,
			purchaseToken,
			purchaseKind,
			productId,
			purchase,
		});
	}

	private async commandFromNotification(
		verified: VerifiedGoogleRtdn,
	): Promise<NormalizedGooglePurchase | null> {
		const notification = verified.notification;

		if (notification.subscriptionNotification !== undefined) {
			const token = notification.subscriptionNotification.purchaseToken;
			const purchase = await this.dependencies.client.getSubscriptionPurchase(token);
			return normalizeGoogleSubscriptionPurchase({
				billingAccountId: null,
				purchaseToken: token,
				purchase,
				externalEventId: verified.externalEventId,
				eventType: notificationEventType(notification),
			});
		}

		if (notification.oneTimeProductNotification !== undefined) {
			const token = notification.oneTimeProductNotification.purchaseToken;
			const productId = notification.oneTimeProductNotification.sku;
			const purchaseKind =
				await this.dependencies.repository.getGoogleAndroidProductKind(productId);
			const purchase = await this.dependencies.client.getProductPurchase(token);
			return normalizeGoogleProductPurchase({
				billingAccountId: null,
				purchaseToken: token,
				purchaseKind,
				productId,
				purchase,
				externalEventId: verified.externalEventId,
				eventType: notificationEventType(notification),
			});
		}

		return null;
	}

	private async handleVoidedPurchaseNotification(
		verified: VerifiedGoogleRtdn,
	): Promise<GoogleWebhookResult> {
		const notification = verified.notification;
		const voidedPurchase = notification.voidedPurchaseNotification;
		if (voidedPurchase === undefined) {
			throw new Error("Google Play RTDN is not a voided purchase notification");
		}
		const purchaseToken = requireNonBlank(voidedPurchase.purchaseToken, "purchaseToken");
		const quantityState = await this.voidedPurchaseQuantityState(
			voidedPurchase.productType,
			purchaseToken,
		);

		const result =
			await this.dependencies.repository.recordGoogleVoidedPurchaseAndEnqueueProjection({
				purchaseToken,
				orderId: voidedPurchase.orderId ?? null,
				refundType: requireGoogleRefundType(voidedPurchase.refundType),
				quantity: quantityState?.quantity ?? null,
				refundableQuantity: quantityState?.refundableQuantity ?? null,
				eventTime: dateFromMillis(
					notification.eventTimeMillis,
					"Google voided purchase event time",
				),
				rawPayload: notification as unknown as Record<string, unknown>,
				eventType: "VOIDED_PURCHASE",
				externalEventId: googleVoidedPurchaseExternalEventId(notification),
				projectionReason: "provider_webhook",
				projectionIdempotencyKey: `${googleVoidedPurchaseExternalEventId(notification)}:projection`,
			});

		if (result.processingStatus === "skipped") {
			return {
				processed: false,
				eventType: "VOIDED_PURCHASE",
				messageId: verified.messageId,
				entitlements: null,
			};
		}

		return {
			processed: true,
			eventType: "VOIDED_PURCHASE",
			messageId: verified.messageId,
			entitlements: requireProcessedEntitlements(result),
		};
	}

	private async voidedPurchaseQuantityState(
		productType: number,
		purchaseToken: string,
	): Promise<ReturnType<typeof googleProductQuantityState> | null> {
		if (productType !== 2) {
			return null;
		}

		return googleProductQuantityState(
			await this.dependencies.client.getProductPurchase(purchaseToken),
		);
	}

	private verifyRtdn(input: {
		authorizationHeader: string | null;
		body: unknown;
	}): Promise<VerifiedGoogleRtdn> {
		if (this.dependencies.verifyRtdn !== undefined) {
			return this.dependencies.verifyRtdn(input);
		}

		return verifyGooglePubSubPush(input, this.dependencies.config as GooglePlayConfig);
	}

	private async applyPublisherMutations(command: NormalizedGooglePurchase): Promise<void> {
		if (!this.dependencies.config.enablePublisherMutations) {
			return;
		}

		if (command.purchaseKind === "subscription" && command.requiresAcknowledgement) {
			if (command.obfuscatedAccountId === null) {
				return;
			}

			await this.dependencies.client.acknowledgeSubscriptionPurchase(
				command.externalProductId,
				command.purchaseToken,
				command.obfuscatedAccountId,
			);
			return;
		}

		if (command.purchaseKind === "non_consumable" && command.requiresAcknowledgement) {
			await this.dependencies.client.acknowledgeProductPurchase(
				command.externalProductId,
				command.purchaseToken,
			);
			return;
		}

		if (command.purchaseKind === "consumable" && command.requiresConsumption) {
			await this.dependencies.client.consumeProductPurchase(
				command.externalProductId,
				command.purchaseToken,
			);
		}
	}
}

function toRepositoryInput(
	command: NormalizedGooglePurchase,
	replayStoreEventId?: string,
): RecordGooglePurchaseProjectionInput {
	return {
		billingAccountId: command.billingAccountId,
		obfuscatedAccountId: command.obfuscatedAccountId,
		externalProductId: command.externalProductId,
		externalPriceId: command.externalPriceId,
		purchaseKind: command.purchaseKind,
		purchaseToken: command.purchaseToken,
		linkedPurchaseToken: command.linkedPurchaseToken,
		orderId: command.orderId,
		purchaseStatus: command.purchaseStatus,
		subscriptionStatus: command.subscriptionStatus,
		purchasedAt: command.purchasedAt,
		expiresAt: command.expiresAt,
		autoRenew: command.autoRenew,
		acknowledgementState: command.acknowledgementState,
		consumptionState: command.consumptionState,
		quantity: command.quantity,
		refundableQuantity: command.refundableQuantity,
		invalidatedAt: command.invalidatedAt,
		invalidationReason: command.invalidationReason,
		rawPayload: command.rawPayload,
		eventType: command.eventType,
		externalEventId: googleStoreEventExternalEventId(command),
		projectionReason: command.projectionReason,
		projectionIdempotencyKey: command.projectionIdempotencyKey,
		replayStoreEventId,
	};
}

function googleStoreEventExternalEventId(command: NormalizedGooglePurchase): string | null {
	if (command.externalEventId !== null) {
		return command.externalEventId;
	}

	if (command.projectionReason === "purchase_verified") {
		return `google:${command.purchaseToken}:purchase_verified`;
	}

	return null;
}

function requireProcessedEntitlements(result: GooglePlayRecordingResult): EntitlementSnapshot {
	if (result.processingStatus !== "processed" || result.entitlements === null) {
		throw new BillingError(
			"Google Play purchase did not produce an entitlement snapshot",
			"GOOGLE_PLAY_RECORDING_SKIPPED",
			409,
		);
	}

	return result.entitlements;
}

function notificationEventType(notification: VerifiedGoogleRtdn["notification"]): string {
	if (notification.subscriptionNotification !== undefined) {
		return (
			subscriptionNotificationEventTypes[notification.subscriptionNotification.notificationType] ??
			`SUBSCRIPTION_NOTIFICATION_${notification.subscriptionNotification.notificationType}`
		);
	}

	if (notification.oneTimeProductNotification !== undefined) {
		return (
			oneTimeProductNotificationEventTypes[
				notification.oneTimeProductNotification.notificationType
			] ??
			`ONE_TIME_PRODUCT_NOTIFICATION_${notification.oneTimeProductNotification.notificationType}`
		);
	}

	if (notification.voidedPurchaseNotification !== undefined) {
		return "VOIDED_PURCHASE";
	}

	return "UNKNOWN";
}

const subscriptionNotificationEventTypes: Record<number, string> = {
	1: "SUBSCRIPTION_RECOVERED",
	2: "SUBSCRIPTION_RENEWED",
	3: "SUBSCRIPTION_CANCELED",
	4: "SUBSCRIPTION_PURCHASED",
	5: "SUBSCRIPTION_ON_HOLD",
	6: "SUBSCRIPTION_IN_GRACE_PERIOD",
	7: "SUBSCRIPTION_RESTARTED",
	8: "SUBSCRIPTION_PRICE_CHANGE_CONFIRMED",
	9: "SUBSCRIPTION_DEFERRED",
	10: "SUBSCRIPTION_PAUSED",
	11: "SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED",
	12: "SUBSCRIPTION_REVOKED",
	13: "SUBSCRIPTION_EXPIRED",
	17: "SUBSCRIPTION_ITEMS_CHANGED",
	18: "SUBSCRIPTION_CANCELLATION_SCHEDULED",
	19: "SUBSCRIPTION_PRICE_CHANGE_UPDATED",
	20: "SUBSCRIPTION_PENDING_PURCHASE_CANCELED",
	22: "SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED",
};

const oneTimeProductNotificationEventTypes: Record<number, string> = {
	1: "ONE_TIME_PRODUCT_PURCHASED",
	2: "ONE_TIME_PRODUCT_CANCELED",
};

function googleVoidedPurchaseExternalEventId(
	notification: VerifiedGoogleRtdn["notification"],
): string {
	const voidedPurchase = notification.voidedPurchaseNotification;
	if (voidedPurchase === undefined) {
		throw new Error("Google Play RTDN is not a voided purchase notification");
	}

	return [
		"google",
		"voided",
		requireNonBlank(voidedPurchase.purchaseToken, "purchaseToken"),
		requireNonBlank(notification.eventTimeMillis, "eventTimeMillis"),
		String(voidedPurchase.productType),
		String(voidedPurchase.refundType),
		voidedPurchase.orderId ?? "no_order",
	].join(":");
}

function orderIdFromStoredVoidedPayload(rawPayload: Record<string, unknown>): string | null {
	const orderId = voidedPurchaseFromRawPayload(rawPayload).orderId;
	return typeof orderId === "string" && orderId.trim() !== "" ? orderId : null;
}

function voidedPurchaseFromRawPayload(
	rawPayload: Record<string, unknown>,
): Record<string, unknown> {
	const voidedPurchase = rawPayload.voidedPurchaseNotification;
	if (
		typeof voidedPurchase !== "object" ||
		voidedPurchase === null ||
		Array.isArray(voidedPurchase)
	) {
		throw new Error("Google stored voided purchase event is missing notification data");
	}

	return voidedPurchase as Record<string, unknown>;
}

function requireGoogleRefundType(value: unknown): 1 | 2 {
	if (value === 1 || value === 2) {
		return value;
	}

	throw new Error("Google voided purchase refund type is invalid");
}

function requireGoogleProductType(value: unknown): 1 | 2 {
	if (value === 1 || value === 2) {
		return value;
	}

	throw new Error("Google voided purchase product type is invalid");
}

function requireStringValue(value: unknown, name: string): string {
	if (typeof value !== "string") {
		throw new Error(`${name} is required`);
	}

	return value;
}

function dateFromMillis(value: string, name: string): Date {
	const millis = Number.parseInt(value, 10);
	if (String(millis) !== value || millis < 0) {
		throw new Error(`${name} is invalid`);
	}

	return new Date(millis);
}
