import type { BillingProvider } from "./types";

export type AutoTopupPhase = "charge" | "reconcile" | "complete";

/** The provider has conclusively rejected collection; ordinary failure policy applies. */
export class AutoTopupDefinitiveChargeError extends Error {
	constructor(
		message: string,
		readonly invoiceId: string,
		readonly paymentId: string | null,
	) {
		super(message);
		this.name = "AutoTopupDefinitiveChargeError";
	}
}

export interface AutoTopupJob {
	jobId: string;
	projectId: string;
	projectKey: string;
	provider: BillingProvider;
	providerAccountId: string | null;
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
	externalInvoiceId?: string | null;
	providerResult?: AutoTopupChargeSucceeded | null;
	completionAttempts?: number;
	phase?: AutoTopupPhase;
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

/** Persisted before collection; failures must abort the provider workflow. */
export type AutoTopupCheckpoint = (checkpoint: {
	invoiceId: string;
	phase?: AutoTopupPhase;
	result?: AutoTopupChargeSucceeded;
}) => Promise<void>;
