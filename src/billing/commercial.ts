import type { StripeProrationBehavior } from "./pricing";
import type { CommercialPromotion, PromotionDiscountDuration } from "./promotions";
import type { BillingProvider } from "./types";

export type CommercialActionIntent =
	| {
			kind: "checkout_plan";
			planKey: string;
			quantities: Record<string, number>;
			email?: string | null;
			successUrl?: string | null;
			cancelUrl?: string | null;
			expiresAt?: number;
			promotionCode?: string | null;
			allowPromotionCodes?: boolean;
	  }
	| {
			kind: "checkout_product";
			productKey: string;
			email?: string | null;
			successUrl?: string | null;
			cancelUrl?: string | null;
			expiresAt?: number;
			promotionCode?: string | null;
			allowPromotionCodes?: boolean;
	  }
	| {
			kind: "subscription_change";
			externalSubscriptionId: string;
			targetPlanKey: string;
			quantities: Record<string, number>;
			effectiveMode?: "immediate" | "period_end";
			prorationBehavior?: StripeProrationBehavior;
			promotionCode?: string | null;
	  }
	| {
			kind: "cancel";
			externalSubscriptionId: string;
			/** `immediate` ends access now; `period_end` keeps it until the paid period ends. */
			effectiveMode: "immediate" | "period_end";
	  }
	| {
			kind: "uncancel";
			externalSubscriptionId: string;
	  };

/** What a preview says a cancellation would do; `none` when the state already holds. */
export type CommercialCancellationAction = "cancel" | "uncancel" | "none";

export interface CommercialLineItem {
	key: string;
	label: string;
	quantity: number;
	unitAmountMinor: number;
	currency: string;
	interval: "month" | "year" | null;
	pricingModel: "flat" | "graduated" | "volume";
	/** Null when Stripe prices the line, such as tiered pricing. */
	subtotalMinor?: number | null;
	discountMinor?: number | null;
	totalMinor?: number | null;
}

export interface CommercialPreviewPromotion {
	promotionKey: string;
	promotionName: string;
	promotionCodeId: string;
	code: string;
	discount: {
		type: "percent" | "amount";
		percentOffBps: number | null;
		amountOffMinor: number | null;
		currency: string | null;
		duration: PromotionDiscountDuration;
		durationMonths: number | null;
	};
}

export interface CommercialPreviewNextCycle {
	interval: "month" | "year";
	currency: string | null;
	subtotalMinor: number | null;
	discountMinor: number | null;
	totalMinor: number | null;
	discountStatus: "none" | "applies" | "ended" | "provider_calculated";
}

/**
 * The effects a cancel or uncancel preview reports. Access and entitlements end together; plan
 * allocations already granted for the paid period keep their own expiry, and postpaid usage in the
 * open period is not accelerated, so it settles when that window ends.
 */
export interface CommercialPreviewCancellation {
	action: CommercialCancellationAction;
	/** When the subscription and its entitlements end; null when nothing would change. */
	accessEndsAt: string | null;
	/** The `cancel_at_period_end` state the execution would leave behind. */
	cancelAtPeriodEnd: boolean;
	/** Granted plan allocations are never clawed back by a cancellation. */
	keepsGrantedAllocations: boolean;
	/** When open postpaid usage settles, which a cancellation never brings forward. */
	postpaidUsageSettlesAt: string | null;
	/** A queued subscription change this cancellation would mark `cancelled`. */
	supersedesChangeId: string | null;
	/** Add-on subscriptions on the same account; a base plan cannot be cancelled while any is active. */
	activeAddOnSubscriptionIds: string[];
}

export interface CommercialActionPreview {
	schemaVersion: 1;
	previewToken: string;
	intentHash: string;
	stateFingerprint: string;
	expiresAt: string;
	billingAccountId: string;
	action: CommercialActionIntent["kind"] | "none";
	provider: BillingProvider;
	lineItems: CommercialLineItem[];
	estimatedTotalMinor: number | null;
	subtotalMinor: number | null;
	discountTotalMinor: number | null;
	currency: string | null;
	amountStatus: "exact" | "provider_calculated";
	promotionCodeEntry: "none" | "code" | "hosted";
	promotion: CommercialPreviewPromotion | null;
	nextCycle: CommercialPreviewNextCycle | null;
	cancellation: CommercialPreviewCancellation | null;
	effectiveMode: "immediate" | "period_end" | null;
	effectiveAt: string | null;
	prorationBehavior: StripeProrationBehavior | null;
	changeKind: "upgrade" | "downgrade" | "quantity" | null;
	fromPlanVersionId: string | null;
	toPlanVersionId: string | null;
	targetId: string;
	warnings: string[];
}

export interface StoredCommercialActionPreview {
	intent: CommercialActionIntent;
	preview: CommercialActionPreview;
	status: "previewed" | "executing" | "executed";
	executionIdempotencyKey: string | null;
	executionResult: CommercialActionExecutionResult | null;
}

export type CommercialActionExecutionResult =
	| {
			kind: "checkout";
			sessionId: string;
			url: string;
			duplicate: boolean;
			promotionRedemption?: { id: string; status: "reserved" | "applied" } | null;
	  }
	| {
			kind: "subscription_change";
			changeId: string;
			status: "pending" | "processing" | "applied" | "failed" | "cancelled";
			effectiveMode: "immediate" | "period_end";
			effectiveAt: string;
			promotionRedemption?: { id: string; status: "reserved" | "applied" } | null;
	  }
	| {
			kind: "subscription_cancellation";
			action: CommercialCancellationAction;
			externalSubscriptionId: string;
			effectiveMode: "immediate" | "period_end" | null;
			/** When access ends, or null once a cancellation is cleared or nothing changed. */
			effectiveAt: string | null;
			cancelAtPeriodEnd: boolean;
			/** The queued change this cancellation marked `cancelled`. */
			supersededChangeId: string | null;
	  };

export interface CommercialPreviewDraft {
	billingAccountId: string;
	intent: CommercialActionIntent;
	intentHash: string;
	stateFingerprint: string;
	preview: Omit<CommercialActionPreview, "previewToken" | "expiresAt">;
	/** Server-side only: the validated code behind the preview, never stored or returned. */
	promotion?: CommercialPromotion | null;
	/** Server-side only: the provider-state fingerprint before promotion state is folded in. */
	providerStateFingerprint?: string;
}
