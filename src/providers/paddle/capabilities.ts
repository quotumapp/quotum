import type {
	CapabilityCondition,
	CapabilityVerification,
	OperationSupport,
	ProviderCapabilityDeclaration,
} from "../../shared/provider-capabilities";

type ImplementableLevel = "native" | "quotum_composed";

interface PlannedEntry {
	level?: ImplementableLevel;
	composedVia?: string;
	questions?: string[];
	conditions?: CapabilityCondition[];
	notes?: string;
}

function planned(
	blocker: Pick<Extract<CapabilityVerification, { status: "planned" }>, "trackedBy" | "blockedBy">,
	{ level = "native", composedVia, conditions = [], notes }: PlannedEntry,
): OperationSupport {
	return {
		level,
		...(composedVia === undefined ? {} : { composedVia }),
		verification: {
			status: "planned",
			...blocker,
			evidence: { tests: [], scenarios: [], questions: [] },
		},
		conditions,
		...(notes === undefined ? {} : { notes }),
	};
}

/** Tracked by the Paddle adapter increment. */
function inP4(entry: PlannedEntry = {}): OperationSupport {
	return planned({ trackedBy: "P4" }, entry);
}

/** Waits on an open DEC-14 row: commercial eligibility, usage settlement or off-session collection. */
function awaitingDecision(entry: PlannedEntry): OperationSupport {
	return planned({ blockedBy: { kind: "decision", ref: "DEC-14" } }, entry);
}

/** Waits on a provider semantic the assessment leaves unresolved. */
function awaitingAnswer(question: string, entry: PlannedEntry): OperationSupport {
	return planned({ blockedBy: { kind: "question", ref: question } }, entry);
}

function notEvaluated(notes: string, questions: string[] = []): OperationSupport {
	return {
		level: "not_evaluated",
		verification:
			questions.length === 0
				? { status: "not_applicable" }
				: { status: "not_applicable", evidence: { tests: [], scenarios: [], questions: [] } },
		conditions: [],
		notes,
	};
}

const renewalExclusionWindow: CapabilityCondition = {
	kind: "renewal_exclusion_window",
	minutes: 30,
};
const activeSubscription: CapabilityCondition = { kind: "subscription_state", allowed: ["active"] };
const oneBillingInterval: CapabilityCondition = { kind: "uniform_billing_interval" };

/**
 * Assessment semantics for deferred operations. The exported declaration below admits only
 * the fixed subscription sandbox scope backed by runtime and provider evidence.
 */
const paddleAssessment: ProviderCapabilityDeclaration = {
	provider: "paddle",
	channel: "web",
	connectionKind: "paddle",
	availability: "available",
	writeSemantics: { clientIdempotencyKeys: false, uncertainWrite: "reconcile_required" },
	// Billing cycles recur every day, week, month or year times a frequency; Paddle documents no
	// maximum, so Quotum's three-year cap applies.
	billingCadences: [
		{ unit: "day", minCount: 1, maxCount: 1095 },
		{ unit: "week", minCount: 1, maxCount: 156 },
		{ unit: "month", minCount: 1, maxCount: 36 },
		{ unit: "year", minCount: 1, maxCount: 3 },
	],
	limits: {
		requestsPerMinute: 240,
		webhookRetries: { attempts: 60, windowHours: 72 },
		webhookOrdering: "unordered",
	},
	changeBillingPolicies: [
		{ billing: "prorated", collection: "immediate" },
		{ billing: "prorated", collection: "next_renewal" },
		{ billing: "full", collection: "immediate" },
		{ billing: "full", collection: "next_renewal" },
		{ billing: "none", collection: "next_renewal" },
	],
	operations: {
		"catalog.product.subscription": inP4({ questions: ["Q-CHK-01"] }),
		"catalog.product.consumable": awaitingDecision({
			questions: ["Q-ELIG-03"],
			notes: "Paddle must confirm that software-usage credit packs are acceptable products.",
		}),
		"catalog.product.non_consumable": inP4({ questions: ["Q-CHK-03"] }),
		"catalog.trial": inP4({
			questions: ["Q-SUB-06"],
			notes: "Trial access follows subscription lifecycle state, separately from paid fulfilment.",
		}),
		"catalog.addon": inP4({
			questions: ["Q-SUB-04"],
			conditions: [oneBillingInterval],
			notes: "All recurring items in one Paddle subscription must share a billing period.",
		}),
		"catalog.topup": awaitingDecision({
			questions: ["Q-ELIG-03"],
			notes: "Paddle must confirm that software-usage credit packs are acceptable products.",
		}),
		"catalog.price.flat": inP4(),
		"catalog.price.licensed": inP4({
			questions: ["Q-SUB-05"],
			conditions: [{ kind: "quantity_integer" }],
			notes: "Paddle quantities are whole numbers; Quotum keeps seat allocation authority.",
		}),
		"catalog.price.tiered": notEvaluated("The Paddle assessment does not cover tiered prices."),
		"catalog.price.hybrid": inP4({
			questions: ["Q-SUB-04"],
			conditions: [oneBillingInterval],
			notes:
				"Base and seat items share one subscription and one billing period; metered overage follows postpaid usage settlement.",
		}),
		"catalog.price.postpaid_usage": awaitingDecision({
			level: "quotum_composed",
			composedVia: "non-catalog transaction item",
			questions: ["Q-SET-01", "Q-SET-03", "Q-TAX-01"],
			notes:
				"Quotum keeps usage rating and bills the finalized amount as one non-catalog item with quantity one, so fractional usage is never rounded into Paddle quantities.",
		}),
		"checkout.hosted": inP4({
			questions: ["Q-ELIG-02", "Q-ELIG-05", "Q-CHK-02", "Q-CHK-03", "Q-RET-01"],
			notes:
				"A server-created transaction opens through Paddle.js on the merchant's approved payment page; fulfilment follows the completed transaction event, never a browser callback.",
		}),
		"checkout.plan": inP4({
			questions: ["Q-ELIG-02", "Q-CHK-01", "Q-CHK-02", "Q-RET-01"],
			notes:
				"Paddle creates subscriptions only from paid recurring transactions or issued recurring invoices; it has no direct create-subscription operation.",
		}),
		"purchase.verify": notEvaluated(
			"Paddle purchases are web checkouts fulfilled from webhooks; the assessment covers no client-submitted purchase verification.",
		),
		"portal.session": inP4({
			questions: ["Q-PORT-01"],
			notes: "Portal sessions are created on demand; their authenticated URLs are never stored.",
		}),
		"payment_method.setup": awaitingAnswer("Q-SET-02", {
			questions: ["Q-SET-02"],
			notes:
				"Paddle saves a payment method through its own hosted transaction; whether Quotum can start one without a charge and promote the result to the account default is unresolved.",
		}),
		"webhook.ingest": inP4({
			questions: ["Q-WH-01", "Q-WH-02", "Q-WH-03"],
			notes:
				"Paddle-Signature is verified over the raw body; deliveries need HTTP 200 within five seconds and may arrive out of order.",
		}),
		"event.replay": inP4({ questions: ["Q-WH-03"] }),
		"subscription.reconcile": inP4({ questions: ["Q-RET-02", "Q-RATE-01"] }),
		"trial.ending_notice": notEvaluated(
			"The Paddle assessment does not cover trial-ending notices.",
		),
		"subscription.change.preview": notEvaluated(
			"The Paddle assessment does not cover previewing subscription updates.",
			["Q-SUB-07"],
		),
		"subscription.change.apply": inP4({
			questions: ["Q-SUB-01", "Q-SUB-03", "Q-RET-01"],
			notes:
				"Updates carry the full retained item set rather than item patches, with one of Paddle's five proration modes.",
		}),
		"subscription.change.period_end": awaitingAnswer("Q-SUB-02", {
			questions: ["Q-SUB-01", "Q-SUB-02"],
			notes:
				"Collecting at the next renewal does not by itself prove that the entitlement change waits for it.",
		}),
		"subscription.cancel": inP4({
			questions: ["Q-SUB-01"],
			notes:
				"Paddle cancels immediately or at the next billing period; whether an immediate cancellation refunds the paid period is not assessed.",
		}),
		"subscription.uncancel": notEvaluated(
			"The Paddle assessment does not cover clearing a scheduled cancellation.",
			["Q-SUB-01"],
		),
		"subscription.create": inP4({
			notes:
				"Paddle creates subscriptions from paid transactions or issued invoices and has no direct create-subscription operation.",
		}),
		"settlement.collect_finalized_charge": awaitingDecision({
			level: "quotum_composed",
			composedVia: "one-time subscription charge",
			questions: ["Q-SET-02", "Q-SET-03", "Q-TAX-01", "Q-RET-01", "Q-RET-02", "Q-RATE-02"],
			conditions: [renewalExclusionWindow, activeSubscription],
			notes:
				"Charges are blocked within 30 minutes of renewal and while the subscription is past due, and the charge response returns the subscription rather than the created transaction.",
		}),
		"adjustment.issue": awaitingDecision({
			level: "quotum_composed",
			composedVia: "transaction adjustment",
			questions: ["Q-REF-01", "Q-REF-02", "Q-SET-03", "Q-RET-01"],
			notes:
				"Most live refund adjustments need Paddle approval, so pending, approved, rejected and reversed states are kept before allocations change; a negative correction is not a negative price.",
		}),
		"refund.sync": inP4({
			questions: ["Q-REF-01"],
			notes: "Refunds arrive as adjustments whose approval state can change after creation.",
		}),
		"topup.customer_initiated": awaitingDecision({
			questions: ["Q-ELIG-03", "Q-CHK-03"],
			notes: "Paddle must confirm that software-usage credit packs are acceptable products.",
		}),
		"topup.automatic": awaitingDecision({
			level: "quotum_composed",
			composedVia: "one-time subscription charge",
			questions: ["Q-SET-02", "Q-SET-04", "Q-ELIG-03", "Q-RET-01", "Q-RET-02", "Q-RATE-02"],
			conditions: [
				{ kind: "account_flag", flag: "spmConsent", expected: [true] },
				{ kind: "saved_payment_method", required: true, resolveWith: "topup.customer_initiated" },
				renewalExclusionWindow,
				activeSubscription,
			],
			notes:
				"Consent to save a payment method for future purchases differs from the method a subscription renews with; a customer without a collectable method needs a customer-initiated top-up.",
		}),
		"promotion.code_entry": awaitingAnswer("Q-PROMO-01", {
			questions: ["Q-PROMO-01"],
			notes:
				"Paddle has discount entities; stacking, product scope and duration parity with Quotum promotions is unvalidated.",
		}),
		"promotion.signed_offer": {
			level: "unsupported",
			verification: { status: "not_applicable" },
			conditions: [],
		},
		"promotion.store_offer_code": {
			level: "unsupported",
			verification: { status: "not_applicable" },
			conditions: [],
		},
		"promotion.hosted_code": awaitingAnswer("Q-PROMO-01", {
			questions: ["Q-PROMO-01", "Q-PROMO-02"],
		}),
	},
};

/** Only checkout dispatch has durable recovery in this increment. Worker write groups remain absent. */
export const paddleCapabilities: ProviderCapabilityDeclaration = {
	...paddleAssessment,
	operations: {
		...paddleAssessment.operations,
		"checkout.plan": {
			level: "quotum_composed",
			composedVia: "checkout.hosted",
			conditions: [],
			verification: {
				status: "conditional",
				verifiedOn: "2026-10-03",
				note: "Sandbox common preview/execute only; one fixed base-plan component at quantity one without trial or promotion.",
				evidence: {
					tests: ["tests/integration/paddle-flows.test.ts"],
					scenarios: [],
					questions: [],
				},
			},
			notes:
				"Sandbox fixed subscription scope. The stored commercial preview pins the provider connection and plan version; fulfillment awaits signed provider events.",
		},
		...Object.fromEntries(
			[
				"subscription.change.apply",
				"subscription.change.period_end",
				"settlement.collect_finalized_charge",
				"adjustment.issue",
				"topup.automatic",
			].map((operation) => [
				operation,
				{
					level: "unsupported",
					verification: { status: "not_applicable" },
					conditions: [],
					notes:
						"Planned for a later increment; this adapter has no durable dispatcher for this operation.",
				},
			]),
		),
		...Object.fromEntries(
			[
				"catalog.product.subscription",
				"catalog.price.flat",
				"checkout.hosted",
				"webhook.ingest",
				"event.replay",
			].map((operation) => [
				operation,
				{
					level: "native",
					conditions: [],
					verification: {
						status: "conditional",
						verifiedOn: "2026-10-03",
						note: "Sandbox only; one fixed recurring item with quantity one and no trial. Real Paddle checkout and signed projection delivery observed.",
						evidence: {
							tests: ["tests/integration/paddle-flows.test.ts"],
							scenarios: [],
							questions: [],
						},
					},
					notes:
						"Sandbox fixed subscription scope. Other product types and lifecycle actions remain unavailable until separately qualified.",
				},
			]),
		),
	},
};
