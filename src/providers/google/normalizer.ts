import type { ProductType, ProjectionSyncReason, SubscriptionStatus } from "../../billing/types";
import type { StoreEventReplayJobRow } from "../../db/repository";
import type { GoogleDeveloperNotification, NormalizedGooglePurchase } from "./types";

interface NormalizeSubscriptionInput {
	billingAccountId: string | null;
	purchaseToken: string;
	purchase: unknown;
	now?: Date;
	externalEventId?: string | null;
	eventType?: string;
	projectionReason?: Extract<
		ProjectionSyncReason,
		"purchase_verified" | "provider_webhook" | "provider_reconciliation"
	>;
	projectionIdempotencyKey?: string;
}

interface NormalizeProductInput {
	billingAccountId: string | null;
	purchaseToken: string;
	purchaseKind: "consumable" | "non_consumable";
	productId: string;
	purchase: unknown;
	now?: Date;
	externalEventId?: string | null;
	eventType?: string;
}

interface NormalizeVoidedPurchaseInput {
	billingAccountId: string | null;
	obfuscatedAccountId: string | null;
	externalProductId: string;
	purchaseKind: ProductType;
	purchaseToken: string;
	orderId: string | null;
	eventTimeMillis: string;
	externalEventId: string;
	rawPayload: Record<string, unknown>;
}

export function normalizeGoogleSubscriptionPurchase(
	input: NormalizeSubscriptionInput,
): NormalizedGooglePurchase | null {
	const purchase = asRecord(input.purchase, "Google subscription purchase");
	const state = requireString(purchase.subscriptionState, "Google subscription state");

	if (state === "SUBSCRIPTION_STATE_PENDING") {
		return null;
	}

	const lineItem = firstRecord(purchase.lineItems, "Google subscription line item");
	const externalProductId = requireString(lineItem.productId, "Google subscription product id");
	const expiresAt = dateFromString(lineItem.expiryTime, "Google subscription expiry time");
	const purchasedAt = dateFromString(purchase.startTime, "Google subscription start time");
	const externalAccountIdentifiers = optionalRecord(purchase.externalAccountIdentifiers);
	const obfuscatedAccountId = optionalString(
		externalAccountIdentifiers?.obfuscatedExternalAccountId,
	);
	const acknowledgementState = optionalString(purchase.acknowledgementState);
	const autoRenewingPlan = optionalRecord(lineItem.autoRenewingPlan);
	const autoRenewEnabled = optionalBoolean(autoRenewingPlan?.autoRenewEnabled);
	const now = input.now ?? new Date();
	const subscriptionStatus = deriveSubscriptionStatus(state, expiresAt, now);
	const purchaseToken = requireNonBlank(input.purchaseToken, "purchaseToken");
	const externalPriceId = optionalString(optionalRecord(lineItem.offerDetails)?.basePlanId);
	const orderId = optionalString(purchase.latestOrderId);
	const autoRenew = state === "SUBSCRIPTION_STATE_CANCELED" ? false : (autoRenewEnabled ?? false);
	const projectionReason =
		input.projectionReason ?? (input.externalEventId ? "provider_webhook" : "purchase_verified");

	return {
		billingAccountId: input.billingAccountId,
		obfuscatedAccountId,
		externalProductId,
		externalPriceId,
		purchaseKind: "subscription",
		purchaseToken,
		linkedPurchaseToken: optionalString(purchase.linkedPurchaseToken),
		orderId,
		purchaseStatus: "completed",
		subscriptionStatus,
		purchasedAt,
		expiresAt,
		autoRenew,
		acknowledgementState,
		consumptionState: null,
		quantity: 1,
		refundableQuantity: null,
		invalidatedAt: null,
		invalidationReason: null,
		rawPayload: purchase,
		eventType: input.eventType ?? (input.externalEventId ? state : "purchase_verified"),
		externalEventId: input.externalEventId ?? null,
		projectionReason,
		projectionIdempotencyKey:
			input.projectionIdempotencyKey ??
			googleSubscriptionProjectionIdempotencyKey({
				projectionReason,
				purchaseToken,
				subscriptionState: state,
				subscriptionStatus,
				autoRenew,
				externalProductId,
				externalPriceId,
				orderId,
				expiresAt,
				externalEventId: input.externalEventId ?? null,
			}),
		requiresAcknowledgement:
			acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING" && subscriptionStatus !== "expired",
		requiresConsumption: false,
	};
}

function googleSubscriptionProjectionIdempotencyKey(input: {
	projectionReason: Extract<
		ProjectionSyncReason,
		"purchase_verified" | "provider_webhook" | "provider_reconciliation"
	>;
	purchaseToken: string;
	subscriptionState: string;
	subscriptionStatus: SubscriptionStatus;
	autoRenew: boolean;
	externalProductId: string;
	externalPriceId: string | null;
	orderId: string | null;
	expiresAt: Date;
	externalEventId: string | null;
}): string {
	if (input.projectionReason === "purchase_verified") {
		return `google:${input.purchaseToken}:purchase_verified`;
	}

	if (input.projectionReason === "provider_reconciliation") {
		return [
			"google",
			input.purchaseToken,
			"provider_reconciliation",
			input.subscriptionState,
			input.subscriptionStatus,
			`auto_renew:${input.autoRenew}`,
			input.externalProductId,
			input.externalPriceId ?? "no_price",
			input.orderId ?? "no_order",
			input.expiresAt.toISOString(),
		].join(":");
	}

	if (input.externalEventId === null) {
		throw new Error("externalEventId is required for provider webhook projection keys");
	}

	return `${input.externalEventId}:projection`;
}

export function normalizeGoogleProductPurchase(
	input: NormalizeProductInput,
): NormalizedGooglePurchase | null {
	const purchase = asRecord(input.purchase, "Google product purchase");
	const stateContext = optionalRecord(purchase.purchaseStateContext);
	const purchaseState = requireString(stateContext?.purchaseState, "Google product purchase state");

	if (purchaseState === "PENDING") {
		return null;
	}

	const lineItem = firstRecord(purchase.productLineItem, "Google product line item");
	const quantityState = googleProductQuantityState(purchase);
	const externalProductId = optionalString(lineItem.productId) ?? input.productId;
	const acknowledgementState = optionalString(purchase.acknowledgementState);
	const projectionReason = input.externalEventId ? "provider_webhook" : "purchase_verified";
	const purchaseStatus = normalizeProductPurchaseStatus(purchaseState);
	const purchasedAt =
		purchaseStatus === "voided"
			? (optionalDateFromString(purchase.purchaseCompletionTime) ?? input.now ?? new Date())
			: dateFromString(purchase.purchaseCompletionTime, "Google product purchase completion time");

	return {
		billingAccountId: input.billingAccountId,
		obfuscatedAccountId: optionalString(purchase.obfuscatedExternalAccountId),
		externalProductId,
		externalPriceId: null,
		purchaseKind: input.purchaseKind,
		purchaseToken: requireNonBlank(input.purchaseToken, "purchaseToken"),
		linkedPurchaseToken: null,
		orderId: optionalString(purchase.orderId),
		purchaseStatus,
		subscriptionStatus: null,
		purchasedAt,
		expiresAt: null,
		autoRenew: null,
		acknowledgementState,
		consumptionState: quantityState.consumptionState,
		quantity: quantityState.quantity,
		refundableQuantity: quantityState.refundableQuantity,
		invalidatedAt: purchaseStatus === "voided" ? purchasedAt : null,
		invalidationReason: purchaseStatus === "voided" ? "canceled" : null,
		rawPayload: purchase,
		eventType: input.eventType ?? (input.externalEventId ? purchaseState : "purchase_verified"),
		externalEventId: input.externalEventId ?? null,
		projectionReason,
		projectionIdempotencyKey:
			projectionReason === "purchase_verified"
				? `google:${input.purchaseToken}:purchase_verified`
				: `${input.externalEventId}:projection`,
		requiresAcknowledgement:
			input.purchaseKind === "non_consumable" &&
			purchaseStatus === "completed" &&
			acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING",
		requiresConsumption: input.purchaseKind === "consumable" && purchaseStatus === "completed",
	};
}

export interface GoogleProductQuantityState {
	quantity: number;
	refundableQuantity: number | null;
	consumptionState: string | null;
}

export function googleProductQuantityState(purchaseValue: unknown): GoogleProductQuantityState {
	const purchase = asRecord(purchaseValue, "Google product purchase");
	const lineItem = firstRecord(purchase.productLineItem, "Google product line item");
	const productOfferDetails = optionalRecord(lineItem.productOfferDetails);
	const quantity = optionalNumber(productOfferDetails?.quantity) ?? 1;
	const refundableQuantity = optionalNumber(productOfferDetails?.refundableQuantity);

	if (!Number.isInteger(quantity) || quantity <= 0) {
		throw new Error("Google product purchase quantity must be a positive integer");
	}
	if (
		refundableQuantity !== null &&
		(!Number.isInteger(refundableQuantity) ||
			refundableQuantity < 0 ||
			refundableQuantity > quantity)
	) {
		throw new Error("Google product purchase refundable quantity is invalid");
	}

	return {
		quantity,
		refundableQuantity,
		consumptionState: optionalString(productOfferDetails?.consumptionState),
	};
}

export function normalizeGoogleVoidedPurchase(
	input: NormalizeVoidedPurchaseInput,
): NormalizedGooglePurchase {
	const invalidatedAt = dateFromMillis(input.eventTimeMillis, "Google voided purchase event time");

	return {
		billingAccountId: input.billingAccountId,
		obfuscatedAccountId: input.obfuscatedAccountId,
		externalProductId: input.externalProductId,
		externalPriceId: null,
		purchaseKind: input.purchaseKind,
		purchaseToken: requireNonBlank(input.purchaseToken, "purchaseToken"),
		linkedPurchaseToken: null,
		orderId: input.orderId,
		purchaseStatus: "voided",
		subscriptionStatus: input.purchaseKind === "subscription" ? "expired" : null,
		purchasedAt: invalidatedAt,
		expiresAt: input.purchaseKind === "subscription" ? invalidatedAt : null,
		autoRenew: input.purchaseKind === "subscription" ? false : null,
		acknowledgementState: null,
		consumptionState: null,
		quantity: 1,
		refundableQuantity: null,
		invalidatedAt,
		invalidationReason: "voided_purchase",
		rawPayload: input.rawPayload,
		eventType: "VOIDED_PURCHASE",
		externalEventId: input.externalEventId,
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: `${input.externalEventId}:projection`,
		requiresAcknowledgement: false,
		requiresConsumption: false,
	};
}

export function normalizeStoredGoogleStoreEvent(input: {
	event: StoreEventReplayJobRow;
}): NormalizedGooglePurchase | null {
	if (input.event.purchase_kind === "subscription") {
		return normalizeGoogleSubscriptionPurchase({
			billingAccountId: null,
			purchaseToken: requireNonBlank(input.event.transaction_id ?? "", "purchaseToken"),
			purchase: input.event.raw_payload,
			externalEventId: input.event.external_event_id,
			eventType: input.event.event_type,
		});
	}

	if (
		input.event.purchase_kind === "non_consumable" ||
		input.event.purchase_kind === "consumable"
	) {
		return normalizeGoogleProductPurchase({
			billingAccountId: null,
			purchaseToken: requireNonBlank(input.event.transaction_id ?? "", "purchaseToken"),
			purchaseKind: input.event.purchase_kind,
			productId: productIdFromStoredGooglePayload(input.event.raw_payload),
			purchase: input.event.raw_payload,
			externalEventId: input.event.external_event_id,
			eventType: input.event.event_type,
		});
	}

	return null;
}

export function normalizeGoogleTestNotification(input: {
	messageId: string;
	notification: GoogleDeveloperNotification;
}): null {
	if (input.notification.testNotification === undefined) {
		throw new Error("Google Play RTDN is not a test notification");
	}

	return null;
}

function productIdFromStoredGooglePayload(rawPayload: Record<string, unknown>): string {
	const productLineItem = rawPayload.productLineItem;
	if (!Array.isArray(productLineItem) || productLineItem.length === 0) {
		throw new Error("Google stored product event is missing product id");
	}

	const lineItem = optionalRecord(productLineItem[0]);
	const productId = optionalString(lineItem?.productId);
	if (productId === null) {
		throw new Error("Google stored product event is missing product id");
	}

	return productId;
}

function deriveSubscriptionStatus(state: string, expiresAt: Date, now: Date): SubscriptionStatus {
	switch (state) {
		case "SUBSCRIPTION_STATE_ACTIVE":
			return expiresAt > now ? "active" : "expired";
		case "SUBSCRIPTION_STATE_IN_GRACE_PERIOD":
			return "grace_period";
		case "SUBSCRIPTION_STATE_ON_HOLD":
			return "billing_retry";
		case "SUBSCRIPTION_STATE_CANCELED":
			return expiresAt > now ? "active" : "expired";
		case "SUBSCRIPTION_STATE_PAUSED":
			return "cancelled";
		case "SUBSCRIPTION_STATE_EXPIRED":
			return "expired";
		default:
			return "cancelled";
	}
}

function normalizeProductPurchaseStatus(state: string): "completed" | "voided" {
	if (state === "PURCHASED") {
		return "completed";
	}

	if (state === "CANCELLED") {
		return "voided";
	}

	throw new Error(`Unsupported Google product purchase state: ${state}`);
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${name} must be an object`);
	}

	return value as Record<string, unknown>;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}

	return value as Record<string, unknown>;
}

function firstRecord(value: unknown, name: string): Record<string, unknown> {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${name} is required`);
	}

	return asRecord(value[0], name);
}

function requireString(value: unknown, name: string): string {
	const parsed = optionalString(value);
	if (parsed === null) {
		throw new Error(`${name} is required`);
	}

	return parsed;
}

function optionalString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}

	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function optionalBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function optionalNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requireNonBlank(value: string, name: string): string {
	const trimmed = value.trim();
	if (trimmed === "") {
		throw new Error(`${name} is required`);
	}

	return trimmed;
}

function dateFromString(value: unknown, name: string): Date {
	const raw = requireString(value, name);
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) {
		throw new Error(`${name} is invalid`);
	}

	return parsed;
}

function optionalDateFromString(value: unknown): Date | null {
	if (typeof value !== "string" || value.trim() === "") {
		return null;
	}

	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateFromMillis(value: string, name: string): Date {
	const millis = Number.parseInt(value, 10);
	if (String(millis) !== value || millis < 0) {
		throw new Error(`${name} is invalid`);
	}

	return new Date(millis);
}
