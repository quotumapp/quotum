import type { CapabilityFeasibility, ProviderOperation } from "../../shared/provider-capabilities";
import { assessedOn } from "../feasibility";

const assess = assessedOn("2026-10-22");
const pricing = {
	title: "Stripe pricing models",
	url: "https://docs.stripe.com/products-prices/pricing-models",
};
const subscriptions = {
	title: "Stripe subscriptions",
	url: "https://docs.stripe.com/billing/subscriptions/overview",
};
const checkout = {
	title: "Stripe Checkout",
	url: "https://docs.stripe.com/payments/checkout/how-checkout-works",
};
const portal = {
	title: "Stripe customer portal",
	url: "https://docs.stripe.com/customer-management",
};
const setup = {
	title: "Set up future payments",
	url: "https://docs.stripe.com/payments/checkout/save-and-reuse",
};
const events = { title: "Stripe webhooks", url: "https://docs.stripe.com/webhooks" };
const changes = {
	title: "Change subscription prices",
	url: "https://docs.stripe.com/billing/subscriptions/change-price",
};
const cancel = {
	title: "Cancel subscriptions",
	url: "https://docs.stripe.com/billing/subscriptions/cancel",
};
const invoices = {
	title: "Create and collect invoices",
	url: "https://docs.stripe.com/invoicing/integration",
};
const refunds = { title: "Create a refund", url: "https://docs.stripe.com/api/refunds/create" };
const discounts = {
	title: "Coupons and promotion codes",
	url: "https://docs.stripe.com/billing/subscriptions/coupons",
};

/** Provider potential, including operations outside the current Quotum adapter. */
export const stripeFeasibility = {
	"catalog.product.subscription": assess(
		"possible",
		"Recurring prices fund subscription entitlements tracked by Quotum.",
		subscriptions,
	),
	"catalog.product.consumable": assess(
		"possible",
		"One-time payments can fund consumable grants; Quotum owns the balance.",
		checkout,
	),
	"catalog.product.non_consumable": assess(
		"possible",
		"One-time payments can fund lasting access tracked by Quotum.",
		checkout,
	),
	"catalog.trial": assess(
		"conditional",
		"Subscription trials support payment-method and trial-end policies that must match the plan.",
		{ title: "Subscription trials", url: "https://docs.stripe.com/billing/subscriptions/trials" },
	),
	"catalog.addon": assess(
		"possible",
		"An additional subscription can sell an add-on; Quotum enforces the base-plan prerequisite.",
		subscriptions,
	),
	"catalog.topup": assess(
		"possible",
		"A one-time price can fund a metered balance maintained by Quotum.",
		checkout,
	),
	"catalog.price.flat": assess(
		"possible",
		"Fixed recurring prices map to explicit flat components.",
		pricing,
	),
	"catalog.price.licensed": assess(
		"possible",
		"Per-seat recurring prices accept an explicit quantity.",
		pricing,
	),
	"catalog.price.tiered": assess(
		"possible",
		"Volume and graduated prices support quantity-based tiers.",
		pricing,
	),
	"catalog.price.hybrid": assess(
		"possible",
		"Multiple subscription items can combine fixed, quantity and usage charges.",
		pricing,
		subscriptions,
	),
	"catalog.price.postpaid_usage": assess(
		"possible",
		"Quotum can rate usage and invoice the finalized amount through Stripe.",
		invoices,
	),
	"checkout.hosted": assess(
		"possible",
		"Checkout supports hosted one-time and subscription payments.",
		checkout,
	),
	"checkout.plan": assess(
		"possible",
		"Checkout can start a subscription with the plan's recurring line items.",
		checkout,
	),
	"purchase.verify": assess(
		"conditional",
		"A native payment could be verified by retrieving its PaymentIntent; trusted account correlation and fulfillment would need a new Quotum flow.",
		{
			title: "Retrieve a PaymentIntent",
			url: "https://docs.stripe.com/api/payment_intents/retrieve",
		},
	),
	"portal.session": assess(
		"possible",
		"Authenticated portal sessions expose customer billing self-service.",
		portal,
	),
	"payment_method.setup": assess(
		"possible",
		"Checkout setup mode saves a payment method without a charge; Quotum can set the invoice default.",
		setup,
	),
	"webhook.ingest": assess(
		"possible",
		"Signed payment and subscription events can drive local state.",
		events,
	),
	"event.replay": assess(
		"possible",
		"Quotum can persist and reprocess authenticated webhook payloads locally.",
		events,
	),
	"subscription.reconcile": assess(
		"possible",
		"The subscription API exposes authoritative state for local reconciliation.",
		subscriptions,
	),
	"trial.ending_notice": assess(
		"possible",
		"Trial-ending webhook events can trigger a Quotum notice.",
		{
			title: "Subscription webhook events",
			url: "https://docs.stripe.com/billing/subscriptions/webhooks",
		},
	),
	"subscription.change.preview": assess(
		"possible",
		"Invoice previews expose the financial effect of subscription updates.",
		{ title: "Preview an invoice", url: "https://docs.stripe.com/api/invoices/create_preview" },
	),
	"subscription.change.apply": assess(
		"conditional",
		"Subscription updates support price and quantity changes with explicit billing and proration policies.",
		changes,
	),
	"subscription.change.period_end": assess(
		"possible",
		"Subscription schedules or Quotum's worker can apply a change at a period boundary.",
		{
			title: "Subscription schedules",
			url: "https://docs.stripe.com/billing/subscriptions/subscription-schedules",
		},
	),
	"subscription.cancel": assess(
		"possible",
		"Cancellation supports immediate termination or stopping renewal at period end.",
		cancel,
	),
	"subscription.uncancel": assess(
		"conditional",
		"A pending period-end cancellation can be cleared before the subscription ends.",
		cancel,
	),
	"subscription.create": assess(
		"conditional",
		"The subscription API can bill a saved method; collection may still require customer authentication.",
		subscriptions,
		setup,
	),
	"settlement.collect_finalized_charge": assess(
		"possible",
		"Quotum can place its finalized usage amount on an invoice and collect it.",
		invoices,
	),
	"adjustment.issue": assess(
		"possible",
		"Invoice items and credit notes provide primitives for signed usage corrections.",
		invoices,
		{ title: "Credit notes", url: "https://docs.stripe.com/invoicing/dashboard/credit-notes" },
	),
	"refund.sync": assess(
		"possible",
		"Refund and dispute events can be reconciled to their original payment and grants.",
		events,
		refunds,
	),
	"refund.issue": assess(
		"possible",
		"The refund API returns all or part of a payment, up to its unrefunded amount.",
		refunds,
	),
	"topup.customer_initiated": assess(
		"possible",
		"Checkout can sell a one-time credit pack; Quotum credits it after payment.",
		checkout,
	),
	"topup.automatic": assess(
		"conditional",
		"An off-session invoice can charge a saved method; authentication or payment failure requires customer action.",
		invoices,
		setup,
	),
	"promotion.code_entry": assess(
		"possible",
		"Quotum can map validated codes to coupons applied to Checkout or subscriptions.",
		discounts,
	),
	"promotion.hosted_code": assess(
		"possible",
		"Checkout can accept Stripe promotion codes and report the applied discount.",
		discounts,
		checkout,
	),
	"promotion.signed_offer": assess(
		"unavailable",
		"Apple's signed subscription-offer protocol has no Stripe equivalent; coupons are a different operation.",
		discounts,
	),
	"promotion.store_offer_code": assess(
		"unavailable",
		"Stripe has hosted promotion codes, not native app-store offer-code redemption.",
		discounts,
	),
} satisfies Record<ProviderOperation, CapabilityFeasibility>;
