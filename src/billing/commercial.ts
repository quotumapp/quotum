import type { PaymentSetupPlanStatus, PaymentSetupStatus } from "./payment-setup";
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
	  }
	/**
	 * Saves a payment method for later off-session charges. Without `plan` it needs no catalog item
	 * and no subscription, and `currency` only selects which setup methods the provider offers.
	 * With `plan`, `currency` must be that plan's currency and the saved card starts the plan.
	 */
	| {
			kind: "setup_payment";
			currency: string;
			email?: string | null;
			successUrl?: string | null;
			cancelUrl?: string | null;
			plan?: {
				planKey: string;
				quantities: Record<string, number>;
			};
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

/** The plan a setup preview will start once the customer saves a card. */
export interface CommercialPreviewPaymentSetupPlan {
	planKey: string;
	planVersionId: string;
	trialDays: number | null;
	startsAfterSetup: true;
}

/**
 * What a payment-method setup preview reports. Without a plan it charges nothing and grants
 * nothing. With a plan, the line items are that plan and the saved card starts it.
 */
export interface CommercialPreviewPaymentSetup {
	/** The currency whose eligible setup methods the hosted page will offer. */
	currency: string;
	/** The saved method becomes the billing account's default for later off-session charges. */
	appliesTo: "account_default";
	/** Payment methods pinned to individual subscriptions keep whatever they already point at. */
	preservesSubscriptionPaymentMethods: true;
	/** Whether an unresolved setup exists whose link the execution would hand back unchanged. */
	reusesExistingSetup: boolean;
	existingSetupId: string | null;
	existingSetupExpiresAt: string | null;
	/** The plan started after setup, or null when the setup only saves a card. */
	plan: CommercialPreviewPaymentSetupPlan | null;
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
	paymentSetup: CommercialPreviewPaymentSetup | null;
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
	/**
	 * A hosted setup link. Creating it does not mean the customer finished setup; the persisted
	 * record, read back through the payment-setup session route, is what says that.
	 */
	| {
			kind: "payment_setup";
			setupId: string;
			status: PaymentSetupStatus;
			sessionId: string | null;
			url: string | null;
			expiresAt: string;
			/**
			 * True when this call did not create the link: an unfinished setup's link was handed
			 * back, or the provider replayed the session an interrupted attempt had already made.
			 */
			reused: boolean;
			/**
			 * The plan this setup will start, still `pending` until the customer finishes. Null when
			 * the setup only saves a card. The session read carries the terminal outcome.
			 */
			plan: {
				planKey: string;
				planVersionId: string;
				status: PaymentSetupPlanStatus;
			} | null;
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
