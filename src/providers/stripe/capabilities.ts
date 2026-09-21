import type {
	CapabilityCondition,
	OperationSupport,
	ProviderCapabilityDeclaration,
} from "../../shared/provider-capabilities";

const verifiedOn = "2026-09-17";

const catalogControlPlaneTest = "tests/integration/catalog-control-plane.test.ts";
const phase3JourneysTest = "tests/integration/phase3-release-journeys.test.ts";
const promotionsTest = "tests/integration/promotions.test.ts";
const stripeFlowsTest = "tests/integration/stripe-flows.test.ts";
const commercialPricingTest = "tests/billing/commercial-pricing.test.ts";
const pricingTest = "tests/billing/pricing.test.ts";
const normalizerTest = "tests/providers/stripe/normalizer.test.ts";
const promotionProvisioningTest = "tests/providers/stripe/promotions.test.ts";
const serviceTest = "tests/providers/stripe/service.test.ts";
const cancellationTest = "tests/providers/stripe/commercial-cancellation.test.ts";
const autoTopupWorkerTest = "tests/workers/auto-topup.test.ts";
const recurringBillingWorkerTest = "tests/workers/recurring-billing.test.ts";

/** Changes resolve only Stripe subscriptions in these states, cancelled ones until period end. */
const changeableSubscription: CapabilityCondition = {
	kind: "subscription_state",
	allowed: ["active", "grace_period", "billing_retry", "cancelled"],
};

/** Uncancelling needs something to clear: a period-end cancellation that has not run yet. */
const cancellationPending: CapabilityCondition = { kind: "cancellation_pending", required: true };

const changeTargets =
	"The target plan must be the same kind as the current plan and publish Stripe base or licensed prices.";

function native(
	tests: string[],
	options: { conditions?: CapabilityCondition[]; notes?: string } = {},
): OperationSupport {
	const conditions = options.conditions ?? [];
	return {
		level: "native",
		verification: verification(tests, conditions),
		conditions,
		...(options.notes === undefined ? {} : { notes: options.notes }),
	};
}

function composed(
	composedVia: string,
	tests: string[],
	notes: string,
	conditions: CapabilityCondition[] = [],
): OperationSupport {
	return {
		level: "quotum_composed",
		composedVia,
		verification: verification(tests, conditions),
		conditions,
		notes,
	};
}

/** Condition-bearing support stays conditional until a conformance scenario verifies it. */
function verification(
	tests: string[],
	conditions: CapabilityCondition[],
): OperationSupport["verification"] {
	return {
		status: conditions.length === 0 ? "verified" : "conditional",
		verifiedOn,
		evidence: { tests, scenarios: [], questions: [] },
	};
}

/** Current Stripe web behaviour; verified and conditional entries cite tagged tests. */
export const stripeCapabilities: ProviderCapabilityDeclaration = {
	provider: "stripe",
	channel: "web",
	connectionKind: "stripe",
	availability: "available",
	writeSemantics: { clientIdempotencyKeys: true, uncertainWrite: "provider_idempotency" },
	changeBillingPolicies: [
		{ billing: "prorated", collection: "immediate" },
		{ billing: "prorated", collection: "next_renewal" },
		{ billing: "none", collection: "next_renewal" },
	],
	operations: {
		"catalog.product.subscription": native([stripeFlowsTest, catalogControlPlaneTest]),
		"catalog.product.consumable": native([stripeFlowsTest, serviceTest]),
		"catalog.product.non_consumable": native([stripeFlowsTest, serviceTest], {
			notes:
				"Non-consumable products are provisioned Stripe web store products sold through product Checkout.",
		}),
		"catalog.trial": native([catalogControlPlaneTest, serviceTest]),
		"catalog.addon": native([catalogControlPlaneTest], {
			notes: "An add-on is a separate Stripe subscription and requires an active base plan.",
		}),
		"catalog.topup": native([stripeFlowsTest]),
		"catalog.price.flat": native([catalogControlPlaneTest, serviceTest]),
		"catalog.price.licensed": native([catalogControlPlaneTest, serviceTest]),
		"catalog.price.tiered": native([phase3JourneysTest, commercialPricingTest], {
			notes:
				"Stripe prices tiered in-advance lines during Checkout; Quotum rates tiered postpaid overage itself.",
		}),
		"catalog.price.hybrid": native([catalogControlPlaneTest, serviceTest]),
		"catalog.price.postpaid_usage": native([catalogControlPlaneTest]),
		"checkout.hosted": native([stripeFlowsTest, serviceTest]),
		"checkout.plan": native([catalogControlPlaneTest, serviceTest]),
		"purchase.verify": {
			level: "unsupported",
			verification: { status: "not_applicable" },
			conditions: [],
			notes:
				"Stripe purchases complete in hosted Checkout and are recorded from signed webhook events; the Checkout Session status route never grants access.",
		},
		"portal.session": native([stripeFlowsTest, serviceTest]),
		"webhook.ingest": native([stripeFlowsTest, serviceTest]),
		"event.replay": native([serviceTest]),
		"subscription.reconcile": native([serviceTest]),
		"subscription.change.preview": native([stripeFlowsTest], {
			conditions: [changeableSubscription],
			notes: `${changeTargets} Stripe calculates the final proration amount during execution.`,
		}),
		"subscription.change.apply": native(
			[catalogControlPlaneTest, promotionsTest, recurringBillingWorkerTest],
			{
				conditions: [changeableSubscription],
				notes: `${changeTargets} The recurring billing worker applies the change with its Stripe proration behavior.`,
			},
		),
		"subscription.change.period_end": native([stripeFlowsTest, pricingTest], {
			conditions: [changeableSubscription],
			notes: `${changeTargets} Downgrades default to the end of the current period, when the recurring billing worker applies them.`,
		}),
		"subscription.cancel": native([stripeFlowsTest, cancellationTest], {
			conditions: [changeableSubscription],
			notes:
				"An immediate cancellation ends the Stripe subscription with no proration credit and no closing invoice; a period-end cancellation sets `cancel_at_period_end`. A queued change for the subscription is superseded, and a base plan cannot be cancelled while add-on subscriptions are active.",
		}),
		"subscription.uncancel": native([stripeFlowsTest, cancellationTest], {
			conditions: [changeableSubscription, cancellationPending],
			notes:
				"Clearing `cancel_at_period_end` only restores renewal; it does not restore a subscription change the cancellation superseded, and a subscription Stripe already ended cannot be cleared.",
		}),
		"settlement.collect_finalized_charge": composed(
			"Stripe invoices with a one-off usage line",
			[serviceTest, recurringBillingWorkerTest, catalogControlPlaneTest, phase3JourneysTest],
			"Quotum rates the overage after the usage period closes, then finalizes and pays the invoice against the subscription.",
		),
		"adjustment.issue": composed(
			"Stripe invoices with a signed correction line",
			[serviceTest, phase3JourneysTest],
			"Late usage corrections invoice the rated difference for the closed period; negative corrections finalize without payment.",
		),
		"refund.sync": native([stripeFlowsTest, serviceTest, normalizerTest], {
			notes:
				"Refunds and disputes reverse the purchase they paid for in proportion to the cumulative amount reversed, deduplicated by refund id.",
		}),
		"topup.customer_initiated": native([stripeFlowsTest]),
		"topup.automatic": composed(
			"Stripe invoices with a top-up price line",
			[serviceTest, autoTopupWorkerTest, phase3JourneysTest],
			"Quotum pays a Stripe invoice with the customer's default payment method; a missing method or an authentication request ends the job as action required.",
			[{ kind: "saved_payment_method", required: true, resolveWith: "topup.customer_initiated" }],
		),
		"promotion.code_entry": composed(
			"Stripe coupons applied as Checkout and subscription discounts",
			[promotionsTest, promotionProvisioningTest, normalizerTest],
			"Quotum validates and reserves the code, then applies the promotion's Stripe coupon to the Checkout Session or subscription change.",
		),
		"promotion.hosted_code": native([promotionsTest, promotionProvisioningTest, normalizerTest], {
			notes: "The connection needs write access to Stripe Coupons and Promotion codes.",
		}),
	},
};
