import type { StripeCheckoutPromotionFacts } from "../../billing/promotions";
import type { ProjectionSyncReason, SubscriptionStatus } from "../../billing/types";

export interface StripeCatalog {
	schemaVersion: 1;
	plans: Array<{
		key: string;
		name: string;
		version: number;
		kind: "base" | "addon";
		tierRank: number;
		trialDays: number | null;
		trialRequiresPaymentMethod: boolean;
		trialEndBehavior: "cancel" | "pause";
		upgradeProrationBehavior: "always_invoice" | "create_prorations" | "none";
		downgradeProrationBehavior: "always_invoice" | "create_prorations" | "none";
		components: Array<{
			key: string;
			kind: "base" | "licensed" | "metered_overage";
			featureKey: string | null;
			featureUnit: string | null;
			includedQuantity: string | null;
			currency: string;
			unitAmountMinor: number;
			pricingModel: "flat" | "graduated" | "volume";
			tiers: Array<{
				upToQuantity: string | null;
				unitAmountMinor: number;
				flatAmountMinor: number;
			}>;
			billingUnits: string;
			interval: "month" | "year";
			minimumQuantity: number;
			maximumQuantity: number | null;
			taxBehavior: "inclusive" | "exclusive" | "unspecified";
		}>;
	}>;
	oneTimePurchases: Array<{
		key: string;
		name: string;
		kind: "topup" | "one_time";
		currency: string;
		amountMinor: number;
		credits: number;
	}>;
}

export type NormalizedStripeCommand =
	| NormalizedStripeIdentityOnlyCommand
	| NormalizedStripeCheckoutPromotionReleaseCommand
	| NormalizedStripeCreditPurchaseCommand
	| NormalizedStripeSubscriptionCommand
	| NormalizedStripeCreditReversalCommand
	| NormalizedStripeIgnoredCommand;

export interface NormalizedStripeIdentityOnlyCommand {
	kind: "identity_only";
	billingAccountId: string;
	stripeCustomerId: string;
	eventType: string;
	externalEventId: string;
	rawPayload: Record<string, unknown>;
	promotion?: NormalizedStripeCheckoutPromotion | null;
}

export type NormalizedStripeCheckoutPromotion = StripeCheckoutPromotionFacts;

export interface NormalizedStripeCheckoutPromotionReleaseCommand {
	kind: "checkout_promotion_release";
	checkoutSessionId: string;
	redemptionId: string | null;
	eventType: string;
	externalEventId: string;
	rawPayload: Record<string, unknown>;
}

export interface NormalizedStripeCreditPurchaseCommand {
	kind: "credit_purchase";
	purchaseKind: "consumable" | "non_consumable";
	billingAccountId: string | null;
	stripeCustomerId: string | null;
	externalProductId: string;
	externalPriceId: string;
	/** Purchase identity: the PaymentIntent id, or the Checkout Session id when nothing was charged. */
	transactionId: string;
	paymentIntentId: string | null;
	chargeId: string | null;
	checkoutSessionId: string;
	promotion?: NormalizedStripeCheckoutPromotion | null;
	amountPaidCents: number | null;
	currency: string | null;
	purchasedAt: Date;
	rawPayload: Record<string, unknown>;
	eventType: string;
	externalEventId: string;
	projectionIdempotencyKey: string;
}

export interface NormalizedStripeSubscriptionCommand {
	kind: "subscription";
	billingAccountId: string | null;
	stripeCustomerId: string;
	stripeSubscriptionId: string;
	invoiceId: string | null;
	providerObjectIds: string[];
	externalProductId: string;
	externalPriceId: string;
	items: NormalizedStripeSubscriptionItem[];
	subscriptionStatus: SubscriptionStatus;
	providerStatus: string;
	purchasedAt: Date;
	currentPeriodStart: Date | null;
	trialStart: Date | null;
	trialEnd: Date | null;
	expiresAt: Date | null;
	cancelAtPeriodEnd: boolean;
	providerEventCreated: number;
	invoiceStatus: string | null;
	invoiceAmountPaid: number | null;
	invoiceCurrency: string | null;
	invoicePaidAt: Date | null;
	autoRenew: boolean;
	rawPayload: Record<string, unknown>;
	eventType: string;
	externalEventId: string;
	projectionReason: Extract<ProjectionSyncReason, "provider_webhook" | "provider_reconciliation">;
	projectionIdempotencyKey: string;
	/** `ending` for `customer.subscription.trial_will_end`, which asks for a trial-ending fact. */
	trialNotice: "ending" | null;
}

export interface NormalizedStripeSubscriptionItem {
	providerSubscriptionItemId: string;
	externalProductId: string;
	externalPriceId: string;
	quantity: number;
}

export interface NormalizedStripeCreditReversalCommand {
	kind: "credit_reversal";
	reversalReason: "refund" | "dispute";
	reversalId: string;
	billingAccountId: string | null;
	stripeCustomerId: string | null;
	paymentIntentId: string;
	chargeId: string | null;
	reversalAmount: number;
	reversalCurrency: string;
	reversedAt: Date;
	rawPayload: Record<string, unknown>;
	eventType: string;
	externalEventId: string;
	projectionIdempotencyKey: string;
}

export interface NormalizedStripeIgnoredCommand {
	kind: "ignored";
	reason: string;
	eventType: string;
	externalEventId: string;
	rawPayload: Record<string, unknown>;
}
