import type { StripeProrationBehavior } from "./pricing";

export type CommercialActionIntent =
	| {
			kind: "checkout_plan";
			planKey: string;
			quantities: Record<string, number>;
			email?: string | null;
			successUrl?: string | null;
			cancelUrl?: string | null;
	  }
	| {
			kind: "checkout_product";
			productKey: string;
			email?: string | null;
			successUrl?: string | null;
			cancelUrl?: string | null;
	  }
	| {
			kind: "subscription_change";
			externalSubscriptionId: string;
			targetPlanKey: string;
			quantities: Record<string, number>;
			effectiveMode?: "immediate" | "period_end";
			prorationBehavior?: StripeProrationBehavior;
	  };

export interface CommercialLineItem {
	key: string;
	label: string;
	quantity: number;
	unitAmountMinor: number;
	currency: string;
	interval: "month" | "year" | null;
	pricingModel: "flat" | "graduated" | "volume";
}

export interface CommercialActionPreview {
	schemaVersion: 1;
	previewToken: string;
	intentHash: string;
	stateFingerprint: string;
	expiresAt: string;
	billingAccountId: string;
	action: CommercialActionIntent["kind"];
	provider: "stripe";
	lineItems: CommercialLineItem[];
	estimatedTotalMinor: number | null;
	currency: string | null;
	amountStatus: "exact" | "provider_calculated";
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
	  }
	| {
			kind: "subscription_change";
			changeId: string;
			status: "pending" | "processing" | "applied" | "failed" | "cancelled";
			effectiveMode: "immediate" | "period_end";
			effectiveAt: string;
	  };

export interface CommercialPreviewDraft {
	billingAccountId: string;
	intent: CommercialActionIntent;
	intentHash: string;
	stateFingerprint: string;
	preview: Omit<CommercialActionPreview, "previewToken" | "expiresAt">;
}
