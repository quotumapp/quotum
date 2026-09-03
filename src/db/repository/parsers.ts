import type { PurchaseKind, SubscriptionStatus } from "../../billing/types";
import {
	parseChannel,
	parseProductType,
	parseProjectionJobPayload,
	parseProjectionSyncReason,
	parseProjectionSyncStatus,
	parseProvider,
	parseStoreEventProcessingStatus,
	subscriptionStatuses,
} from "../../billing/types";
import type {
	ProjectionSyncJobRow,
	ProviderSubscriptionReconciliationRow,
	StoreEventReplayJobRow,
	StripeWebStoreProductRow,
} from "./types";
import { toIsoStringOrNull, toRequiredIsoString } from "./validation";

export function parseProjectionSyncJobRow(row: unknown): ProjectionSyncJobRow {
	const raw = row as ProjectionSyncJobRow;
	const reason = parseProjectionSyncReason(String(raw.reason));
	const status = parseProjectionSyncStatus(String(raw.status));
	const payload = parseProjectionJobPayload(raw.payload);

	if (payload.reason !== reason) {
		throw new Error("Invalid projection payload");
	}

	return {
		...raw,
		reason,
		payload,
		status,
		reprojection_requested: raw.reprojection_requested === true,
		next_attempt_at: toIsoStringOrNull(raw.next_attempt_at),
		locked_at: toIsoStringOrNull(raw.locked_at),
		created_at: toRequiredIsoString(raw.created_at),
		updated_at: toRequiredIsoString(raw.updated_at),
	};
}

export function parseStoreEventReplayJobRow(row: unknown): StoreEventReplayJobRow {
	if (typeof row !== "object" || row === null) {
		throw new Error("Invalid store event replay job");
	}

	const raw = row as StoreEventReplayJobRow;
	const provider = parseProvider(String(raw.provider));
	const channel = parseChannel(String(raw.channel));
	const purchaseKind =
		raw.purchase_kind === null
			? null
			: (parseProductType(String(raw.purchase_kind)) as PurchaseKind);
	const processingStatus = parseStoreEventProcessingStatus(String(raw.processing_status));

	if (!isRecord(raw.raw_payload)) {
		throw new Error("Invalid store event replay job");
	}

	return {
		...raw,
		provider,
		channel,
		purchase_kind: purchaseKind,
		processing_status: processingStatus,
		raw_payload: raw.raw_payload,
		next_attempt_at: toIsoStringOrNull(raw.next_attempt_at),
		processed_at: toIsoStringOrNull(raw.processed_at),
		locked_at: toIsoStringOrNull(raw.locked_at),
		created_at: toRequiredIsoString(raw.created_at),
		updated_at: toRequiredIsoString(raw.updated_at),
	};
}

export function parseProviderSubscriptionReconciliationRow(
	row: unknown,
): ProviderSubscriptionReconciliationRow {
	if (typeof row !== "object" || row === null) {
		throw new Error("Invalid provider subscription reconciliation row");
	}

	const raw = row as ProviderSubscriptionReconciliationRow;
	const provider = parseProvider(String(raw.provider));
	const channel = parseChannel(String(raw.channel));
	const status = parseSubscriptionStatus(String(raw.status));

	return {
		...raw,
		provider,
		channel,
		status,
		expires_at: toIsoStringOrNull(raw.expires_at),
	};
}

export function parseSubscriptionStatus(value: string): SubscriptionStatus {
	if (subscriptionStatuses.includes(value as SubscriptionStatus)) {
		return value as SubscriptionStatus;
	}

	throw new Error(`Unsupported subscription status: ${value}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStripeWebStoreProductRow(row: unknown): StripeWebStoreProductRow {
	const errorMessage = "Invalid Stripe web store product";
	if (!isRecord(row)) {
		throw new Error(errorMessage);
	}

	let productType: PurchaseKind;
	try {
		productType = parseProductType(String(row.productType)) as PurchaseKind;
	} catch {
		throw new Error(errorMessage);
	}

	const creditAmount = parseNonnegativeInteger(row.creditAmount, errorMessage);
	const priceAmount =
		row.priceAmount === null ? null : parseNonnegativeInteger(row.priceAmount, errorMessage);

	if (row.currency !== null && typeof row.currency !== "string") {
		throw new Error(errorMessage);
	}

	return {
		storeProductId: parseRequiredString(row.storeProductId, errorMessage),
		productId: parseRequiredString(row.productId, errorMessage),
		productKey: parseRequiredString(row.productKey, errorMessage),
		productType,
		creditAmount,
		externalProductId: parseRequiredString(row.externalProductId, errorMessage),
		externalPriceId: parseRequiredString(row.externalPriceId, errorMessage),
		billingPeriod: parseRequiredString(row.billingPeriod, errorMessage),
		currency: row.currency,
		priceAmount,
	};
}

export function parseRequiredString(value: unknown, errorMessage: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(errorMessage);
	}

	return value;
}

export function parseNonnegativeInteger(value: unknown, errorMessage: string): number {
	if (typeof value !== "number" && typeof value !== "string") {
		throw new Error(errorMessage);
	}

	if (typeof value === "string" && value.trim() === "") {
		throw new Error(errorMessage);
	}

	const parsed = Number(value);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
		throw new Error(errorMessage);
	}

	return parsed;
}

export function parseNullableNonnegativeInteger(
	value: unknown,
	errorMessage: string,
): number | null {
	try {
		return parseNonnegativeInteger(value ?? 0, errorMessage);
	} catch {
		return null;
	}
}
