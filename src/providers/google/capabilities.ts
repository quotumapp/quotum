import type {
	OperationSupport,
	ProviderCapabilityDeclaration,
} from "../../shared/provider-capabilities";

const verifiedOn = "2026-09-17";
const googleFlows = "tests/integration/google-flows.test.ts";
const googleService = "tests/providers/google/service.test.ts";
const workerFlows = "tests/integration/worker-flows.test.ts";

function verified(tests: string[], notes?: string): OperationSupport {
	return {
		level: "native",
		verification: {
			status: "verified",
			verifiedOn,
			evidence: { tests, scenarios: [], questions: [] },
		},
		conditions: [],
		...(notes === undefined ? {} : { notes }),
	};
}

function providerManaged(notes: string, tests: string[] = []): OperationSupport {
	return {
		level: "provider_managed",
		verification:
			tests.length === 0
				? { status: "not_applicable" }
				: {
						status: "verified",
						verifiedOn,
						evidence: { tests, scenarios: [], questions: [] },
					},
		conditions: [],
		notes,
	};
}

function unsupported(notes: string): OperationSupport {
	return {
		level: "unsupported",
		verification: { status: "not_applicable" },
		conditions: [],
		notes,
	};
}

function notEvaluated(notes?: string): OperationSupport {
	return {
		level: "not_evaluated",
		verification: { status: "not_applicable" },
		conditions: [],
		...(notes === undefined ? {} : { notes }),
	};
}

const explicitPriceComponents =
	"The catalog accepts explicit price components only on Stripe bindings.";
const nativePurchaseFlow =
	"Purchases start in the app through Google Play Billing and reach Quotum through purchase verification.";
const noUsageInvoices = "Google Play purchases cannot carry postpaid usage invoices.";

/** Current Google Play Billing behaviour; every verified entry cites a test tagged with its operation. */
export const googleCapabilities: ProviderCapabilityDeclaration = {
	provider: "google",
	channel: "android",
	connectionKind: "google",
	availability: "available",
	writeSemantics: { clientIdempotencyKeys: false, uncertainWrite: "reconcile_required" },
	operations: {
		"catalog.product.subscription": verified([googleFlows]),
		"catalog.product.consumable": verified([googleFlows]),
		"catalog.product.non_consumable": notEvaluated(
			"Play normalization accepts non-consumable products, but no test exercises a completed one.",
		),
		"catalog.trial": providerManaged(
			"Free trials are offers on Play base plans and Quotum mirrors the subscription; the catalog rejects plan trial days on Google bindings.",
		),
		"catalog.addon": notEvaluated(
			"The catalog accepts add-on plans only when every binding is Stripe.",
		),
		"catalog.topup": verified([googleFlows]),
		"catalog.price.flat": notEvaluated(explicitPriceComponents),
		"catalog.price.licensed": unsupported(
			`Seat pricing is not a Google Play capability. ${explicitPriceComponents}`,
		),
		"catalog.price.tiered": notEvaluated(explicitPriceComponents),
		"catalog.price.hybrid": unsupported(
			`Hybrid pricing is not a Google Play capability. ${explicitPriceComponents}`,
		),
		"catalog.price.postpaid_usage": unsupported(noUsageInvoices),
		"checkout.hosted": unsupported(nativePurchaseFlow),
		"checkout.plan": unsupported(nativePurchaseFlow),
		"purchase.verify": verified(
			[googleService, googleFlows],
			"Quotum acknowledges or consumes the purchase after recording it only when publisher mutations are enabled on the connection.",
		),
		"portal.session": notEvaluated(),
		"webhook.ingest": verified([googleFlows, googleService]),
		"event.replay": verified([googleService]),
		"subscription.reconcile": verified([googleService, workerFlows]),
		"subscription.change.preview": unsupported(
			"Plan changes are priced in the Google Play purchase sheet; Quotum has no preview for them and records no preview outcome.",
		),
		"subscription.change.apply": providerManaged(
			"Plan changes happen in Google Play and arrive as a new purchase token linked to the replaced one.",
		),
		"subscription.change.period_end": providerManaged(
			"Deferred plan changes are scheduled in Google Play; Quotum records the resulting purchase state.",
		),
		"settlement.collect_finalized_charge": unsupported(noUsageInvoices),
		"adjustment.issue": unsupported(
			"Adjustments apply to postpaid usage invoices, which Google Play purchases cannot carry.",
		),
		"refund.sync": providerManaged(
			"Refunds and revocations happen in Google Play; Quotum mirrors voided purchase notifications, including partial consumable refunds.",
			[googleFlows, googleService],
		),
		"topup.customer_initiated": verified(
			[googleFlows],
			"The customer buys a consumable top-up through Google Play Billing.",
		),
		"topup.automatic": unsupported(
			"Silent automatic purchases are unavailable; Google automatic top-up jobs end as provider_action_required.",
		),
		"promotion.code_entry": notEvaluated(
			"Quotum passes no discount to Google Play; Android code redemption executes feature grants in Quotum only.",
		),
		"promotion.hosted_code": notEvaluated(),
	},
};
