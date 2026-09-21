import type { StripeProrationBehavior } from "./pricing";
import type { BillingProvider, SubscriptionStatus } from "./types";

export interface SubscriptionChangeInput {
	billingAccountId: string;
	externalSubscriptionId: string;
	targetPlanKey: string;
	quantities: Record<string, number>;
	effectiveMode?: "immediate" | "period_end";
	prorationBehavior?: StripeProrationBehavior;
	idempotencyKey: string;
	expectedStateFingerprint?: string;
	/** A validated discount to reserve with the change and apply to the Stripe subscription. */
	promotion?: {
		promotionCodeId: string;
		idempotencyKey: string;
		effectSnapshot: Record<string, unknown>;
		stripeCouponId: string;
	};
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

/** What Quotum knows locally before it asks Stripe to end or keep a subscription. */
export interface SubscriptionCancellationContext {
	customerId: string;
	externalSubscriptionId: string;
	status: SubscriptionStatus;
	planKind: "base" | "addon";
	planVersionId: string | null;
	cancelAtPeriodEnd: boolean;
	currentPeriodEnd: string | null;
	/** A queued change for this subscription; a cancel supersedes a pending one. */
	pendingChange: { id: string; status: "pending" | "processing" } | null;
	/** Live add-on subscriptions on the same account, which a base plan cannot be cancelled over. */
	activeAddOnSubscriptionIds: string[];
	/** When the open postpaid usage window closes, which a cancellation never brings forward. */
	postpaidUsageSettlesAt: string | null;
	stateFingerprint: string;
}

export interface SubscriptionChangeOperation {
	changeId: string;
	projectInstanceId: string;
	projectKey: string;
	provider: BillingProvider;
	providerAccountId: string | null;
	status: "pending" | "processing" | "applied" | "failed" | "cancelled";
	/** Local status of the subscription the change targets; an ended one can no longer be changed. */
	subscriptionStatus: SubscriptionStatus;
	changeKind: "upgrade" | "downgrade" | "quantity";
	effectiveMode: "immediate" | "period_end";
	effectiveAt: string;
	prorationBehavior: StripeProrationBehavior;
	externalSubscriptionId: string;
	targetPlanVersionId: string;
	/** Stripe coupon reserved with this change, added to the subscription's existing discounts. */
	discountCouponId: string | null;
	promotionRedemption: { id: string; status: "reserved" | "applied" } | null;
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
	provider: BillingProvider;
	providerAccountId: string | null;
	billingAccountId: string;
	externalCustomerId: string;
	externalSubscriptionId: string;
	/** Local status of the subscription the window belongs to, read when the job was claimed. */
	subscriptionStatus: SubscriptionStatus;
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
	/** Changes ended without being applied because their subscription can no longer change. */
	subscriptionChangesCancelled: number;
	usageInvoicesCreated: number;
	usageAdjustmentsCreated: number;
	failed: number;
}
