import type {
	ConfirmReservationInput,
	ConsumeUsageResult,
	CorrectUsageInput,
	FinalizeReservationResult,
	MeteringMutationInput,
	ReleaseReservationInput,
	ReservationResult,
	ReserveUsageInput,
	UsageCorrectionResult,
} from "./metering";

export const usageOperationKinds = ["consume", "reserve", "confirm", "release", "correct"] as const;
export type UsageOperationKind = (typeof usageOperationKinds)[number];
export type UsageOperationInput =
	| MeteringMutationInput
	| ReserveUsageInput
	| ConfirmReservationInput
	| ReleaseReservationInput
	| CorrectUsageInput;
export type UsageOperationResult =
	| ConsumeUsageResult
	| ReservationResult
	| FinalizeReservationResult
	| UsageCorrectionResult;

export interface UsageOperationLookupInput {
	billingAccountId: string;
	operation: UsageOperationKind;
	operationId: string;
}

// A bounded lookup receipt. Detailed historical receipts remain on the mutation response.
export interface UsageOperationReceipt {
	allowed: boolean;
	reason: string;
	usageEventId: string | null;
	recordedAt: string | null;
	reservationId: string | null;
	reservationStatus: string | null;
	expiresAt: string | null;
	quantity: string | null;
	walletQuantity: string | null;
	originalUsageEventId: string | null;
	originalRecordedAt: string | null;
	balance: { featureKey: string; available: string; consumed: string; held: string };
}

export type UsageOperationLookupResult = {
	operation: UsageOperationKind;
	operationId: string;
} & (
	| { status: "processing"; outcome: null; completedAt: null }
	| { status: "completed"; outcome: UsageOperationReceipt; completedAt: string }
);
