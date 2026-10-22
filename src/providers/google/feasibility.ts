import type { CapabilityFeasibility, ProviderOperation } from "../../shared/provider-capabilities";
import { assessedOn } from "../feasibility";

const assess = assessedOn("2026-10-22");
const purchases = {
	title: "Play Billing integration",
	url: "https://developer.android.com/google/play/billing/integrate",
};
const subscriptions = {
	title: "Play subscriptions",
	url: "https://developer.android.com/google/play/billing/subscriptions",
};
const lifecycle = {
	title: "Subscription lifecycle",
	url: "https://developer.android.com/google/play/billing/lifecycle/subscriptions",
};
const server = {
	title: "Play Developer API",
	url: "https://developers.google.com/android-publisher/api-ref/rest",
};
const events = {
	title: "Real-time developer notifications",
	url: "https://developer.android.com/google/play/billing/rtdn-reference",
};
const refunds = {
	title: "Refund an order",
	url: "https://developers.google.com/android-publisher/api-ref/rest/v3/orders/refund",
};
const offers = {
	title: "Subscription products and offers",
	url: "https://developer.android.com/google/play/billing/subscriptions#base-plans-offers",
};

/** Native Play flows and Publisher API possibilities, independent of current Quotum gates. */
export const googleFeasibility = {
	"catalog.product.subscription": assess(
		"possible",
		"Auto-renewing base plans can fund subscription entitlements mirrored by Quotum.",
		subscriptions,
	),
	"catalog.product.consumable": assess(
		"possible",
		"A verified one-time purchase can grant a consumable balance before the purchase is consumed.",
		purchases,
	),
	"catalog.product.non_consumable": assess(
		"possible",
		"Unconsumed one-time purchases can fund lasting access; Quotum still needs a qualified fulfillment path.",
		purchases,
	),
	"catalog.trial": assess(
		"provider_managed",
		"Play offers determine trial phases and eligibility; arbitrary Quotum trial-end behavior is not a publisher command.",
		offers,
	),
	"catalog.addon": assess(
		"conditional",
		"Play supports native subscription add-ons with cadence and country restrictions; separate Quotum add-on subscriptions and base-plan gating need qualification.",
		{
			title: "Subscriptions with add-ons",
			url: "https://developer.android.com/google/play/billing/subscription-with-addons",
		},
	),
	"catalog.topup": assess(
		"possible",
		"Consumable one-time products can replenish balances managed by Quotum.",
		purchases,
	),
	"catalog.price.flat": assess(
		"conditional",
		"Base-plan prices can represent a flat fee; exact Quotum price bindings need storefront/currency validation.",
		offers,
	),
	"catalog.price.licensed": assess(
		"unavailable",
		"Auto-renewing subscriptions do not expose a licensed-seat quantity; one-time multi-quantity purchases do not supply that recurring contract.",
		purchases,
		subscriptions,
	),
	"catalog.price.tiered": assess(
		"unavailable",
		"Play base plans expose fixed offer phases, not provider-side volume or graduated recurring prices.",
		offers,
	),
	"catalog.price.hybrid": assess(
		"unknown",
		"Multiple subscription items exist, but the required licensed or metered-overage components have no established equivalent.",
		{
			title: "Subscriptions with add-ons",
			url: "https://developer.android.com/google/play/billing/subscription-with-addons",
		},
	),
	"catalog.price.postpaid_usage": assess(
		"unavailable",
		"Native base plans do not accept an arbitrary usage invoice after a Quotum metering period.",
		subscriptions,
	),
	"checkout.hosted": assess(
		"unavailable",
		"Play Billing launches a native purchase sheet, without a server-created hosted checkout session.",
		purchases,
	),
	"checkout.plan": assess(
		"unavailable",
		"A base plan is purchased through the native Play Billing flow.",
		purchases,
	),
	"purchase.verify": assess(
		"possible",
		"Publisher purchase reads plus acknowledgement or consumption can verify and fulfill purchases.",
		purchases,
		server,
	),
	"portal.session": assess(
		"provider_managed",
		"Play supplies subscription-management screens and deep links, not a Quotum-created billing portal session.",
		subscriptions,
	),
	"payment_method.setup": assess(
		"provider_managed",
		"Google manages the customer's payment methods; Quotum cannot choose the account's default collection method.",
		subscriptions,
	),
	"webhook.ingest": assess(
		"possible",
		"RTDN and authenticated purchase reads expose lifecycle changes.",
		events,
	),
	"event.replay": assess(
		"possible",
		"Quotum can retain authenticated notifications and replay them locally with fresh provider state.",
		events,
	),
	"subscription.reconcile": assess(
		"possible",
		"Subscription purchase reads expose authoritative state and line items.",
		{
			title: "Get a subscription purchase",
			url: "https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get",
		},
	),
	"trial.ending_notice": assess(
		"possible",
		"Offer phases and recorded expiry let Quotum derive a trial-ending notice.",
		offers,
		lifecycle,
	),
	"subscription.change.preview": assess(
		"provider_managed",
		"Play displays replacement pricing in the purchase flow; a matching server-side proration preview is not exposed.",
		subscriptions,
	),
	"subscription.change.apply": assess(
		"provider_managed",
		"Replacement modes act through a customer-facing native purchase and a linked purchase token.",
		subscriptions,
	),
	"subscription.change.period_end": assess(
		"provider_managed",
		"Deferred replacements are chosen in the native purchase flow; Quotum mirrors the resulting state.",
		subscriptions,
	),
	"subscription.cancel": assess(
		"conditional",
		"Publisher cancellation can stop renewals; immediate no-refund termination and cancellation-mode parity need validation.",
		{
			title: "Cancel a subscription purchase",
			url: "https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/cancel",
		},
	),
	"subscription.uncancel": assess(
		"provider_managed",
		"Customer resubscription through Play can restore renewal; it is not a generic backend clear-cancellation command.",
		lifecycle,
	),
	"subscription.create": assess(
		"unavailable",
		"A new subscription requires a native customer purchase, not an off-session charge initiated by Quotum.",
		purchases,
	),
	"settlement.collect_finalized_charge": assess(
		"unavailable",
		"Play Billing has no arbitrary postpaid subscription-usage invoice endpoint.",
		subscriptions,
		server,
	),
	"adjustment.issue": assess(
		"unavailable",
		"Play has no usage invoice to adjust; order refunds and revocations are separate operations.",
		server,
		refunds,
	),
	"refund.sync": assess(
		"possible",
		"Voided purchase notifications and reads can reverse refunded or revoked purchase grants.",
		events,
		{
			title: "Voided purchases",
			url: "https://developers.google.com/android-publisher/voided-purchases",
		},
	),
	"refund.issue": assess(
		"conditional",
		"Publisher order refunds and subscription revocation exist; arbitrary-amount, proration and durable recovery parity need validation.",
		refunds,
		{
			title: "Revoke a subscription purchase",
			url: "https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/revoke",
		},
	),
	"topup.customer_initiated": assess(
		"possible",
		"A customer can buy a consumable in Play Billing to replenish a Quotum balance.",
		purchases,
	),
	"topup.automatic": assess(
		"unavailable",
		"A new consumable purchase requires the native customer flow; subscription renewal is not a silent top-up purchase.",
		purchases,
	),
	"promotion.code_entry": assess(
		"conditional",
		"Quotum codes could select developer-determined Play offers; client offer-token handling, eligibility and discount parity need validation.",
		offers,
	),
	"promotion.hosted_code": assess(
		"unavailable",
		"Play's native promotion redemption is not a provider-hosted web checkout.",
		purchases,
	),
	"promotion.signed_offer": assess(
		"unavailable",
		"Play offer tokens do not implement Apple's signed subscription-offer protocol.",
		offers,
	),
	"promotion.store_offer_code": assess(
		"conditional",
		"Play promotion redemption exists; mapping a redeemed code from authoritative purchase data needs validation.",
		{ title: "Play promotions", url: "https://developer.android.com/google/play/billing/promo" },
	),
} satisfies Record<ProviderOperation, CapabilityFeasibility>;
