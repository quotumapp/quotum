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
	  };

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

export interface CommercialActionPreview {
	schemaVersion: 1;
	previewToken: string;
	intentHash: string;
	stateFingerprint: string;
	expiresAt: string;
	billingAccountId: string;
	action: CommercialActionIntent["kind"];
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
