import type { CapabilityFeasibility, ProviderOperation } from "../../shared/provider-capabilities";
import { assessedOn } from "../feasibility";

const assess = assessedOn("2026-10-22");
const prices = {
	title: "Paddle prices",
	url: "https://developer.paddle.com/api-reference/prices/create-price",
};
const checkout = {
	title: "Paddle transaction checkout",
	url: "https://developer.paddle.com/build/transactions/pass-transaction-checkout",
};
const updates = {
	title: "Update a subscription",
	url: "https://developer.paddle.com/api-reference/subscriptions/update-subscription",
};
const charges = {
	title: "Charge a subscription",
	url: "https://developer.paddle.com/api-reference/subscriptions/create-subscription-charge",
};
const usage = {
	title: "Paddle for AI companies",
	url: "https://developer.paddle.com/get-started/how-paddle-works/ai-companies/",
};
const adjustments = {
	title: "Paddle adjustments",
	url: "https://developer.paddle.com/api-reference/adjustments/create-adjustment",
};
const events = {
	title: "Paddle webhook delivery",
	url: "https://developer.paddle.com/webhooks/overview",
};
const discounts = {
	title: "Paddle discounts",
	url: "https://developer.paddle.com/api-reference/discounts/create-discount",
};
const eligibility = {
	title: "Paddle acceptable use policy",
	url: "https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle",
};

/** Technical primitives do not resolve DEC-14 or qualify new runtime operations. */
export const paddleFeasibility = {
	"catalog.product.subscription": assess(
		"possible",
		"Recurring Paddle prices support subscription products; Quotum's present qualification remains sandbox-only.",
		prices,
	),
	"catalog.product.consumable": assess(
		"conditional",
		"One-time products can fund app-owned credits; merchant eligibility, credit terms and DEC-14 still need review.",
		usage,
		eligibility,
	),
	"catalog.product.non_consumable": assess(
		"possible",
		"A one-time transaction can fund lasting access maintained by Quotum.",
		prices,
		checkout,
	),
	"catalog.trial": assess(
		"conditional",
		"Recurring prices support trials; payment-method requirements and trial-end parity need validation.",
		prices,
	),
	"catalog.addon": assess(
		"possible",
		"Recurring add-ons can be separate subscriptions with a Quotum-enforced base-plan prerequisite.",
		{
			title: "Recurring add-ons",
			url: "https://developer.paddle.com/build/subscriptions/add-remove-products-prices-addons",
		},
	),
	"catalog.topup": assess(
		"conditional",
		"One-time software-usage credits are technically composable; merchant eligibility and DEC-14 remain open.",
		usage,
		eligibility,
	),
	"catalog.price.flat": assess(
		"possible",
		"Fixed recurring prices support explicit flat subscription components.",
		prices,
	),
	"catalog.price.licensed": assess(
		"possible",
		"Subscription line-item quantities can represent licensed seats within price quantity bounds.",
		prices,
		updates,
	),
	"catalog.price.tiered": assess(
		"unknown",
		"Externally rated tiered usage is documented, but binding an exact provider-side volume or graduated price is unassessed.",
		usage,
		prices,
	),
	"catalog.price.hybrid": assess(
		"conditional",
		"Recurring items and custom usage charges can compose a hybrid bill; timing and recovery parity need qualification.",
		usage,
		charges,
	),
	"catalog.price.postpaid_usage": assess(
		"conditional",
		"Quotum-rated overage can become a custom charge; Paddle's beta usage balances alone do not bill overage. DEC-14 remains open.",
		usage,
		charges,
	),
	"checkout.hosted": assess(
		"conditional",
		"A server-created transaction opens in Paddle Checkout on an approved payment page.",
		checkout,
	),
	"checkout.plan": assess(
		"conditional",
		"Recurring transaction items can start a plan; full trials, quantities and multi-item parity need qualification.",
		checkout,
		prices,
	),
	"purchase.verify": assess(
		"unknown",
		"Authenticated transaction reads exist, but a distinct native purchase submission and account-correlation contract is unassessed.",
		{
			title: "Get a transaction",
			url: "https://developer.paddle.com/api-reference/transactions/get-transaction",
		},
	),
	"portal.session": assess("possible", "The API creates authenticated customer portal sessions.", {
		title: "Create a portal session",
		url: "https://developer.paddle.com/api-reference/customer-portals/create-customer-portal-session",
	}),
	"payment_method.setup": assess(
		"unknown",
		"Updating a subscription's payment method is documented; no-charge setup and an account-wide collection default need semantic validation (Q-SET-02).",
		{
			title: "Update payment details",
			url: "https://developer.paddle.com/build/subscriptions/update-payment-details",
		},
	),
	"webhook.ingest": assess(
		"possible",
		"Signed notifications expose transaction and subscription lifecycle changes.",
		events,
	),
	"event.replay": assess(
		"possible",
		"Quotum can persist and reprocess authenticated Paddle event payloads locally.",
		events,
	),
	"subscription.reconcile": assess(
		"possible",
		"Authenticated subscription reads expose current provider state.",
		{
			title: "Get a subscription",
			url: "https://developer.paddle.com/api-reference/subscriptions/get-subscription",
		},
	),
	"trial.ending_notice": assess(
		"possible",
		"Recorded trial bounds can drive a Quotum notice without a dedicated provider event.",
		prices,
	),
	"subscription.change.preview": assess(
		"possible",
		"The subscription preview API calculates update charges before a write.",
		{
			title: "Preview a subscription update",
			url: "https://developer.paddle.com/api-reference/subscriptions/preview-subscription-update",
		},
	),
	"subscription.change.apply": assess(
		"conditional",
		"Updates support item replacement and billing modes; renewal exclusion, collection and uncertain-write recovery require qualification.",
		updates,
	),
	"subscription.change.period_end": assess(
		"conditional",
		"A Quotum worker could apply an update at renewal; exact boundary timing and billing semantics remain unvalidated.",
		updates,
	),
	"subscription.cancel": assess(
		"possible",
		"Cancellation can take effect immediately or at the next billing period.",
		{
			title: "Cancel a subscription",
			url: "https://developer.paddle.com/build/subscriptions/cancel-subscriptions",
		},
	),
	"subscription.uncancel": assess(
		"conditional",
		"An update can remove a scheduled cancellation while the subscription remains active.",
		updates,
	),
	"subscription.create": assess(
		"unknown",
		"Subscriptions normally follow paid recurring transactions; starting one off-session on a saved method needs separate proof.",
		checkout,
		{
			title: "Saved payment methods",
			url: "https://developer.paddle.com/build/checkout/saved-payment-methods",
		},
	),
	"settlement.collect_finalized_charge": assess(
		"conditional",
		"One-time subscription charges can collect a Quotum-rated amount; DEC-14, correlation and uncertain-write recovery still block parity.",
		charges,
		usage,
	),
	"adjustment.issue": assess(
		"conditional",
		"Refund/credit adjustments and extra charges offer correction primitives; signed-difference semantics and DEC-14 need validation.",
		adjustments,
		charges,
	),
	"refund.sync": assess(
		"possible",
		"Adjustment notifications and reads can mirror refunds and disputes into Quotum.",
		adjustments,
		events,
	),
	"refund.issue": assess(
		"conditional",
		"Refund adjustments support full or partial amounts, usually subject to Paddle approval; durable recovery is still required.",
		adjustments,
	),
	"topup.customer_initiated": assess(
		"conditional",
		"One-time checkout can fund app-owned credits; merchant eligibility and DEC-14 remain unresolved.",
		usage,
		eligibility,
	),
	"topup.automatic": assess(
		"conditional",
		"An automatically collected subscription charge is a candidate; saved-method consent, eligibility, DEC-14 and write recovery need validation.",
		charges,
		eligibility,
	),
	"promotion.code_entry": assess(
		"conditional",
		"Discount entities exist; scope, stacking and duration parity remain unvalidated (Q-PROMO-01).",
		discounts,
	),
	"promotion.hosted_code": assess(
		"conditional",
		"Checkout accepts discount codes; Quotum redemption limits and reporting parity need validation (Q-PROMO-01).",
		discounts,
	),
	"promotion.signed_offer": assess(
		"unavailable",
		"Paddle discounts do not implement Apple's signed subscription-offer protocol.",
		discounts,
	),
	"promotion.store_offer_code": assess(
		"unavailable",
		"Paddle checkout discount codes are not native app-store offer codes.",
		discounts,
	),
} satisfies Record<ProviderOperation, CapabilityFeasibility>;
