export interface AutoTopupJob {
	jobId: string;
	projectId: string;
	projectKey: string;
	policyId: string;
	customerId: string;
	billingAccountId: string;
	externalCustomerId: string | null;
	storeProductId: string;
	externalPriceId: string | null;
	amountMinor: number;
	maximumChargeMinor: number;
	currency: string;
	attempts: number;
	consecutiveFailures: number;
	maxConsecutiveFailures: number;
}

export interface AutoTopupChargeSucceeded {
	status: "succeeded";
	externalInvoiceId: string;
	externalPaymentId: string | null;
	amountPaidMinor: number;
	currency: string;
}

export interface AutoTopupChargeActionRequired {
	status: "action_required" | "safety_limit_exceeded";
	externalInvoiceId: string | null;
	externalPaymentId: string | null;
	reason: string;
}

export type AutoTopupChargeResult = AutoTopupChargeSucceeded | AutoTopupChargeActionRequired;

export interface AutoTopupFailureResult {
	retryScheduled: boolean;
	circuitOpened: boolean;
}

export interface AutoTopupRunResult {
	claimed: number;
	succeeded: number;
	retryScheduled: number;
	actionRequired: number;
	circuitOpened: number;
	failed: number;
}
