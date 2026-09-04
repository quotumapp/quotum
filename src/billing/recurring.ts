import type { StripeProrationBehavior } from "./pricing";

export interface SubscriptionChangeInput {
	billingAccountId: string;
	externalSubscriptionId: string;
	targetPlanKey: string;
	quantities: Record<string, number>;
	effectiveMode?: "immediate" | "period_end";
	prorationBehavior?: StripeProrationBehavior;
	idempotencyKey: string;
	expectedStateFingerprint?: string;
}

export interface SubscriptionChangePreview {
	stateFingerprint: string;
	changeKind: "upgrade" | "downgrade" | "quantity";
	effectiveMode: "immediate" | "period_end";
	effectiveAt: string;
	prorationBehavior: StripeProrationBehavior;
	fromPlanVersionId: string;
	toPlanVersionId: string;
	lineItems: Array<{
		key: string;
		label: string;
		quantity: number;
		unitAmountMinor: number;
		currency: string;
		interval: "month" | "year";
		pricingModel: "flat" | "graduated" | "volume";
	}>;
}

export interface SubscriptionChangeOperation {
	changeId: string;
	projectInstanceId: string;
	projectKey: string;
	status: "pending" | "processing" | "applied" | "failed" | "cancelled";
	changeKind: "upgrade" | "downgrade" | "quantity";
	effectiveMode: "immediate" | "period_end";
	effectiveAt: string;
	prorationBehavior: StripeProrationBehavior;
	externalSubscriptionId: string;
	targetPlanVersionId: string;
	items: Array<{
		providerSubscriptionItemId?: string;
		externalPriceId?: string;
		quantity?: number;
		deleted?: true;
	}>;
}

export interface UsageInvoiceJob {
	jobKind: "period" | "adjustment";
	jobId: string;
	periodId: string;
	adjustmentId: string | null;
	projectInstanceId: string;
	projectKey: string;
	billingAccountId: string;
	externalCustomerId: string;
	externalSubscriptionId: string;
	externalProductId: string;
	featureKey: string;
	periodStartAt: string;
	periodEndAt: string;
	usageQuantity: string;
	adjustmentQuantity: string | null;
	includedQuantity: string;
	billableQuantity: string;
	amountMinor: number;
	currency: string;
}

export interface RecurringBillingRunResult {
	materializedUsagePeriods: number;
	subscriptionChangesApplied: number;
	usageInvoicesCreated: number;
	usageAdjustmentsCreated: number;
	failed: number;
}
