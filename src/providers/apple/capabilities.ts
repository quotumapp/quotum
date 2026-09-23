import type {
	OperationSupport,
	ProviderCapabilityDeclaration,
} from "../../shared/provider-capabilities";

const verifiedOn = "2026-09-17";
const appleFlows = "tests/integration/apple-flows.test.ts";
const appleNormalizer = "tests/providers/apple/normalizer.test.ts";
const appleService = "tests/providers/apple/service.test.ts";
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

function composed(composedVia: string, tests: string[], notes: string): OperationSupport {
	return {
		level: "quotum_composed",
		composedVia,
		verification: {
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
	"Purchases start in the app through StoreKit and reach Quotum through purchase verification.";
const noUsageInvoices = "App Store purchases cannot carry postpaid usage invoices.";

/** Current Apple StoreKit behaviour; every verified entry cites a test tagged with its operation. */
export const appleCapabilities: ProviderCapabilityDeclaration = {
	provider: "apple",
	channel: "ios",
	connectionKind: "apple",
	availability: "available",
	writeSemantics: { clientIdempotencyKeys: false, uncertainWrite: "reconcile_required" },
	operations: {
		"catalog.product.subscription": verified([appleFlows]),
		"catalog.product.consumable": verified([appleFlows, appleNormalizer]),
		"catalog.product.non_consumable": notEvaluated(
			"StoreKit normalizes non-consumable transactions, but no test exercises one.",
		),
		"catalog.trial": providerManaged(
			"Free-trial offers (introductory, promotional, offer code or win-back) run in the App Store; Quotum records the trial bounds from the signed transaction. The catalog rejects plan trial days on Apple bindings.",
			[appleNormalizer, appleService, appleFlows],
		),
		"catalog.addon": notEvaluated(
			"The catalog accepts add-on plans only when every binding is Stripe.",
		),
		"catalog.topup": verified([appleFlows]),
		"catalog.price.flat": notEvaluated(explicitPriceComponents),
		"catalog.price.licensed": unsupported(
			`Seat pricing is not an App Store capability. ${explicitPriceComponents}`,
		),
		"catalog.price.tiered": notEvaluated(explicitPriceComponents),
		"catalog.price.hybrid": unsupported(
			`Hybrid pricing is not an App Store capability. ${explicitPriceComponents}`,
		),
		"catalog.price.postpaid_usage": unsupported(noUsageInvoices),
		"checkout.hosted": unsupported(nativePurchaseFlow),
		"checkout.plan": unsupported(nativePurchaseFlow),
		"purchase.verify": verified(
			[appleService, appleFlows],
			"The transaction's app account token must match the token Quotum issued for the billing account.",
		),
		"portal.session": notEvaluated(),
		"payment_method.setup": providerManaged(
			"The App Store owns the Apple ID payment method; there is no Quotum-hosted setup and nothing for Quotum to make default.",
		),
		"webhook.ingest": verified([appleFlows, appleService]),
		"event.replay": verified([appleService]),
		"subscription.reconcile": verified([appleService]),
		"trial.ending_notice": composed(
			"App Store free-trial transactions",
			[workerFlows],
			"App Store sends no trial-ending notification; the subscription reconciliation worker sends the notice three days before the recorded trial end.",
		),
		"subscription.change.preview": unsupported(
			"Upgrades, downgrades and crossgrades are priced in the App Store purchase sheet; Quotum has no preview for them and records no preview outcome.",
		),
		"subscription.change.apply": providerManaged(
			"Upgrades and crossgrades happen in the App Store; Quotum records the resulting subscription notifications.",
		),
		"subscription.change.period_end": providerManaged(
			"Downgrades are scheduled in the App Store; Quotum records the renewal preference notification.",
		),
		"subscription.cancel": providerManaged(
			"Cancellation happens in the store's subscription settings; Quotum records the resulting notification.",
		),
		"subscription.uncancel": providerManaged(
			"Resubscribing before the period ends happens in the store's subscription settings; Quotum records the resulting notification.",
		),
		"settlement.collect_finalized_charge": unsupported(noUsageInvoices),
		"adjustment.issue": unsupported(
			"Adjustments apply to postpaid usage invoices, which App Store purchases cannot carry.",
		),
		"refund.sync": providerManaged(
			"Apple decides refunds; Quotum mirrors refund, revocation and refund reversal notifications.",
			[appleFlows, appleNormalizer],
		),
		"topup.customer_initiated": verified(
			[appleFlows],
			"The customer buys a consumable top-up through StoreKit.",
		),
		"topup.automatic": unsupported(
			"Silent automatic purchases are unavailable; Apple automatic top-up jobs end as provider_action_required.",
		),
		"promotion.code_entry": notEvaluated(
			"Quotum rejects iOS promotion-code redemption because App Store rules forbid unlocking digital content with a developer's own codes.",
		),
		"promotion.hosted_code": notEvaluated(),
	},
};
