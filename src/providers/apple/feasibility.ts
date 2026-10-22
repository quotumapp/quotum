import type { CapabilityFeasibility, ProviderOperation } from "../../shared/provider-capabilities";
import { assessedOn } from "../feasibility";

const assess = assessedOn("2026-10-22");
const products = {
	title: "Apple In-App Purchase",
	url: "https://developer.apple.com/in-app-purchase/",
};
const subscriptions = {
	title: "Auto-renewable subscriptions",
	url: "https://developer.apple.com/app-store/subscriptions/",
};
const storekit = { title: "StoreKit", url: "https://developer.apple.com/documentation/storekit" };
const server = {
	title: "App Store Server API",
	url: "https://developer.apple.com/documentation/appstoreserverapi",
};
const events = {
	title: "App Store Server Notifications",
	url: "https://developer.apple.com/documentation/appstoreservernotifications",
};
const advanced = {
	title: "Advanced Commerce eligibility",
	url: "https://developer.apple.com/in-app-purchase/advanced-commerce-api/",
};
const advancedApi = {
	title: "Advanced Commerce API",
	url: "https://developer.apple.com/documentation/advancedcommerceapi",
};
const offers = {
	title: "Subscription offers",
	url: "https://developer.apple.com/app-store/subscriptions/#subscription-offers",
};

/** Standard StoreKit today; eligible Advanced Commerce APIs are conditional future candidates. */
export const appleFeasibility = {
	"catalog.product.subscription": assess(
		"possible",
		"Auto-renewable products can fund plans whose entitlements Quotum mirrors.",
		products,
	),
	"catalog.product.consumable": assess(
		"possible",
		"Consumable purchases can fund app-owned balances after server verification.",
		products,
	),
	"catalog.product.non_consumable": assess(
		"possible",
		"Non-consumable purchases support lasting access; Quotum would need to qualify that fulfillment path.",
		products,
	),
	"catalog.trial": assess(
		"provider_managed",
		"Store introductory offers own trial eligibility and duration; they cannot honor arbitrary Quotum trial-end policies.",
		offers,
	),
	"catalog.addon": assess(
		"conditional",
		"Separate subscription groups or eligible Advanced Commerce items could supply add-ons; Quotum's base-plan and lifecycle parity need qualification.",
		subscriptions,
		advanced,
	),
	"catalog.topup": assess(
		"possible",
		"Consumable products can grant a fixed quantity to a balance maintained by Quotum.",
		products,
	),
	"catalog.price.flat": assess(
		"conditional",
		"Storefront-specific product prices can represent a flat fee; explicit Quotum amount and currency bindings need validation.",
		subscriptions,
	),
	"catalog.price.licensed": assess(
		"unknown",
		"StoreKit has fixed products; licensed-quantity parity through Advanced Commerce has not been established.",
		products,
		advancedApi,
	),
	"catalog.price.tiered": assess(
		"unknown",
		"Fixed store prices do not establish provider-side volume or graduated pricing; Advanced Commerce parity is unassessed.",
		products,
		advancedApi,
	),
	"catalog.price.hybrid": assess(
		"unknown",
		"Advanced Commerce supports multiple subscription items, but licensed or metered-overage parity is unassessed.",
		advancedApi,
	),
	"catalog.price.postpaid_usage": assess(
		"unavailable",
		"StoreKit and Advanced Commerce start purchases in the app; they expose no arbitrary off-session usage invoice for Quotum.",
		storekit,
		advancedApi,
	),
	"checkout.hosted": assess(
		"unavailable",
		"Apple starts these purchases through StoreKit, without a server-created hosted checkout session.",
		storekit,
	),
	"checkout.plan": assess(
		"unavailable",
		"Recurring purchases require the native StoreKit purchase flow, including Advanced Commerce creation.",
		storekit,
		advancedApi,
	),
	"purchase.verify": assess(
		"possible",
		"Signed transactions and authenticated server reads can verify purchases and their ownership.",
		server,
	),
	"portal.session": assess(
		"provider_managed",
		"Apple supplies subscription-management UI; no Quotum-created billing portal session exposes the defined self-service surface.",
		subscriptions,
	),
	"payment_method.setup": assess(
		"provider_managed",
		"Apple owns the customer's payment account; Quotum cannot save or choose its default payment method.",
		{ title: "Apple Account payment methods", url: "https://support.apple.com/118293" },
	),
	"webhook.ingest": assess(
		"possible",
		"Signed server notifications expose subscription and transaction changes.",
		events,
	),
	"event.replay": assess(
		"possible",
		"Quotum can retain authenticated notifications and reprocess them locally.",
		events,
	),
	"subscription.reconcile": assess(
		"possible",
		"The server API exposes transaction history and subscription status for reconciliation.",
		server,
	),
	"trial.ending_notice": assess(
		"possible",
		"Quotum can derive a notice from the verified trial period, without a dedicated Apple ending event.",
		server,
		offers,
	),
	"subscription.change.preview": assess(
		"provider_managed",
		"StoreKit presents purchase terms to the customer; server-side proration previews matching Quotum are not exposed.",
		storekit,
		subscriptions,
	),
	"subscription.change.apply": assess(
		"provider_managed",
		"Plan replacements use native purchase flows; Advanced Commerce subscription modification also runs in the app.",
		subscriptions,
		advancedApi,
	),
	"subscription.change.period_end": assess(
		"provider_managed",
		"Apple determines when native subscription replacements take effect; Quotum cannot dispatch an arbitrary deferred plan change.",
		subscriptions,
		advancedApi,
	),
	"subscription.cancel": assess(
		"conditional",
		"Eligible apps can stop renewal through Advanced Commerce after signing its addendum; immediate no-refund cancellation parity is unassessed.",
		{
			title: "Cancel through Advanced Commerce",
			url: "https://developer.apple.com/documentation/advancedcommerceapi/cancel-a-subscription",
		},
		advanced,
	),
	"subscription.uncancel": assess(
		"provider_managed",
		"Reactivation requires a customer-facing StoreKit or Advanced Commerce in-app flow, rather than a generic backend command.",
		subscriptions,
		advancedApi,
	),
	"subscription.create": assess(
		"unavailable",
		"Subscription creation requires an in-app purchase, including Advanced Commerce; no silent saved-card start is exposed.",
		storekit,
		advancedApi,
	),
	"settlement.collect_finalized_charge": assess(
		"unavailable",
		"Native purchases do not offer an off-session invoice for an arbitrary finalized usage amount.",
		storekit,
		advancedApi,
	),
	"adjustment.issue": assess(
		"unavailable",
		"There is no postpaid usage invoice to correct; refund requests are a separate capability.",
		server,
		advancedApi,
	),
	"refund.sync": assess(
		"possible",
		"Refund and revocation notifications plus refund-history reads can drive balance reversals.",
		events,
		server,
	),
	"refund.issue": assess(
		"conditional",
		"Advanced Commerce permits server refund requests for eligible apps with the signed addendum; approval and Quotum amount/recovery parity need qualification. Standard StoreKit keeps the customer-request flow.",
		{
			title: "Request a transaction refund",
			url: "https://developer.apple.com/documentation/advancedcommerceapi/request-transaction-refund",
		},
		advanced,
	),
	"topup.customer_initiated": assess(
		"possible",
		"A customer can buy a consumable through StoreKit to replenish a Quotum balance.",
		products,
	),
	"topup.automatic": assess(
		"unavailable",
		"Creating a new consumable charge requires a native customer purchase; existing subscription renewal is a different operation.",
		storekit,
		advancedApi,
	),
	"promotion.code_entry": assess(
		"conditional",
		"Quotum codes can map to eligible signed StoreKit promotional offers; redemption still requires a verified native purchase.",
		offers,
	),
	"promotion.hosted_code": assess(
		"unavailable",
		"Apple's native offer-code sheet is not a provider-hosted web checkout with Quotum promotion entry.",
		storekit,
		offers,
	),
	"promotion.signed_offer": assess(
		"conditional",
		"StoreKit promotional offers accept server signatures, subject to customer and subscription eligibility.",
		offers,
	),
	"promotion.store_offer_code": assess(
		"provider_managed",
		"Apple controls offer-code distribution and redemption; Quotum can mirror the resulting verified purchase.",
		{
			title: "Offer codes",
			url: "https://developer.apple.com/help/app-store-connect/manage-in-app-purchases/offer-codes-for-in-app-purchases",
		},
	),
} satisfies Record<ProviderOperation, CapabilityFeasibility>;
