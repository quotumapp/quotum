import type { EntitlementSnapshot } from "../../billing/types";
import type {
	GooglePlayRecordingResult,
	StoreKitRecordingResult,
	StripeRecordingResult,
	StripeSkipReason,
} from "./types";

export function skippedStoreKitRecordingResult(): StoreKitRecordingResult {
	return { processingStatus: "skipped", billingAccountId: null, entitlements: null };
}

export function processedStoreKitRecordingResult(
	billingAccountId: string,
	entitlements: EntitlementSnapshot,
): StoreKitRecordingResult {
	return { processingStatus: "processed", billingAccountId, entitlements };
}

export function skippedGooglePlayRecordingResult(): GooglePlayRecordingResult {
	return { processingStatus: "skipped", billingAccountId: null, entitlements: null };
}

export function processedGooglePlayRecordingResult(
	billingAccountId: string,
	entitlements: EntitlementSnapshot,
): GooglePlayRecordingResult {
	return { processingStatus: "processed", billingAccountId, entitlements };
}

export function skippedStripeRecordingResult(skipReason?: StripeSkipReason): StripeRecordingResult {
	return {
		processingStatus: "skipped",
		billingAccountId: null,
		entitlements: null,
		...(skipReason === undefined ? {} : { skipReason }),
	};
}

export function processedStripeRecordingResult(
	billingAccountId: string,
	entitlements: EntitlementSnapshot,
): StripeRecordingResult {
	return { processingStatus: "processed", billingAccountId, entitlements };
}
