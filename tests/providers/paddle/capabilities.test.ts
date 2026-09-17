import { describe, expect, it } from "bun:test";
import { paddleCapabilities } from "../../../src/providers/paddle/capabilities";
import {
	type CapabilityConfigurationFacts,
	type CapabilityFacts,
	type CapabilityOperationFacts,
	capabilityStatusLabel,
	changeBillingPolicies,
	evaluateCapability,
	type OperationSupport,
	type ProviderCapabilityDeclaration,
	type ProviderOperation,
	providerOperations,
	renderCapabilityStatus,
	validateDeclaration,
} from "../../../src/shared/provider-capabilities";

const questionIdPattern = /^Q-(ELIG|CHK|SUB|SET|REF|TAX|ONB|RET|WH|MIG|RATE|PORT|PROMO)-\d{2}$/;

const configured: CapabilityConfigurationFacts = {
	connectionEnabled: true,
	connectionValidated: true,
	accountFlags: { spmConsent: true },
};

const clearOfRenewal: CapabilityOperationFacts = {
	subscriptionState: "active",
	nextRenewalAt: "2026-09-17T12:00:00.000Z",
	now: "2026-09-17T11:00:00.000Z",
};

const insideRenewalWindowWhilePastDue: CapabilityOperationFacts = {
	subscriptionState: "billing_retry",
	nextRenewalAt: "2026-09-17T12:00:00.000Z",
	now: "2026-09-17T11:45:00.000Z",
};

function support(operation: ProviderOperation): OperationSupport {
	return paddleCapabilities.operations[operation];
}

function isImplementable(entry: OperationSupport): boolean {
	return entry.level === "native" || entry.level === "quotum_composed";
}

/**
 * A copy that pretends the adapter shipped, so operation-layer conditions can be evaluated. The
 * exported declaration itself stays planned.
 */
function asIfImplemented(
	declaration: ProviderCapabilityDeclaration,
): ProviderCapabilityDeclaration {
	const operations = Object.fromEntries(
		providerOperations.map((operation) => {
			const entry = declaration.operations[operation];
			return [
				operation,
				isImplementable(entry)
					? {
							...entry,
							verification: {
								status: "conditional",
								verifiedOn: "2026-09-17",
								note: "Hypothetical implementation for condition evaluation.",
								evidence: { tests: [], scenarios: [], questions: [] },
							},
						}
					: entry,
			];
		}),
	) as Record<ProviderOperation, OperationSupport>;
	return { ...declaration, availability: "available", operations };
}

const implemented = asIfImplemented(paddleCapabilities);

function evaluateImplemented(operation: ProviderOperation, facts: CapabilityFacts) {
	return evaluateCapability(implemented, operation, facts);
}

describe("Paddle capability declaration", () => {
	it("declares a valid planned web provider behind a paddle connection", () => {
		expect(validateDeclaration(paddleCapabilities)).toEqual([]);
		expect(paddleCapabilities).toMatchObject({
			provider: "paddle",
			channel: "web",
			connectionKind: "paddle",
			availability: "planned",
		});
		expect(Object.keys(paddleCapabilities.operations).sort()).toEqual(
			[...providerOperations].sort(),
		);
	});

	it("has no client idempotency keys, so an uncertain write needs reconciliation", () => {
		expect(paddleCapabilities.writeSemantics).toEqual({
			clientIdempotencyKeys: false,
			uncertainWrite: "reconcile_required",
		});
	});

	it("declares unordered webhooks retried 60 times over three days and 240 requests a minute", () => {
		expect(paddleCapabilities.limits).toEqual({
			webhookOrdering: "unordered",
			webhookRetries: { attempts: 60, windowHours: 72 },
			requestsPerMinute: 240,
		});
	});

	it("lists the five change billing policies of Paddle's proration modes", () => {
		const policies = paddleCapabilities.changeBillingPolicies ?? [];
		expect(policies).toHaveLength(5);
		expect(policies).toEqual([
			{ billing: "prorated", collection: "immediate" },
			{ billing: "prorated", collection: "next_renewal" },
			{ billing: "full", collection: "immediate" },
			{ billing: "full", collection: "next_renewal" },
			{ billing: "none", collection: "next_renewal" },
		]);
		expect(
			changeBillingPolicies.filter(
				(policy) =>
					!policies.some(
						(listed) =>
							listed.billing === policy.billing && listed.collection === policy.collection,
					),
			),
		).toEqual([{ billing: "none", collection: "immediate" }]);
	});

	it.each([...providerOperations])(
		"blocks %s at the provider or implementation layer while Paddle is planned",
		(operation) => {
			const facts: CapabilityFacts = { configuration: configured, operation: clearOfRenewal };
			const verdict = evaluateCapability(paddleCapabilities, operation, facts);
			const entry = support(operation);

			expect(verdict.outcome).toBe("blocked");
			if (isImplementable(entry)) {
				expect(verdict.blockingLayer).toBe("implementation");
				expect(verdict.reasons).toEqual([
					{
						code: "IMPLEMENTATION_PLANNED",
						layer: "implementation",
						observed: { availability: "planned", verificationStatus: "planned" },
						resolution: { kind: "none" },
					},
				]);
			} else {
				expect(entry.level).toBe("not_evaluated");
				expect(verdict.blockingLayer).toBe("provider");
				expect(verdict.reasons.map((reason) => reason.code)).toEqual(["CAPABILITY_NOT_EVALUATED"]);
			}
		},
	);

	it("tracks every implementable entry by P4, DEC-14 or an assessment question", () => {
		for (const operation of providerOperations) {
			const entry = support(operation);
			const verification = entry.verification;
			expect(verification.evidence?.tests ?? []).toEqual([]);
			for (const question of verification.evidence?.questions ?? []) {
				expect(question).toMatch(questionIdPattern);
			}
			if (!isImplementable(entry)) {
				expect(verification.status).toBe("not_applicable");
				continue;
			}
			if (verification.status !== "planned") {
				throw new Error(`${operation} must stay planned`);
			}
			const blocker = verification.blockedBy;
			if (blocker === undefined) {
				expect(verification.trackedBy).toBe("P4");
				continue;
			}
			expect(verification.trackedBy).toBeUndefined();
			if (blocker.kind === "decision") {
				expect(blocker.ref).toBe("DEC-14");
			} else {
				expect(blocker.kind).toBe("question");
				expect(blocker.ref).toMatch(questionIdPattern);
				expect(verification.evidence?.questions).toContain(blocker.ref);
			}
		}
	});

	it("blocks add-ons whose recurring prices mix billing intervals", () => {
		expect(support("catalog.addon").conditions).toEqual([{ kind: "uniform_billing_interval" }]);
		expect(capabilityStatusLabel(support("catalog.addon"))).toBe("conditional_not_implemented");

		expect(
			evaluateImplemented("catalog.addon", { operation: { billingIntervals: ["month", "year"] } }),
		).toEqual({
			provider: "paddle",
			operation: "catalog.addon",
			outcome: "blocked",
			level: "native",
			blockingLayer: "operation",
			reasons: [
				{
					code: "BILLING_INTERVAL",
					layer: "operation",
					condition: { kind: "uniform_billing_interval" },
					observed: { billingIntervals: "month,year" },
					resolution: { kind: "none" },
				},
			],
		});
		expect(
			evaluateImplemented("catalog.addon", { operation: { billingIntervals: ["year", "year"] } })
				.outcome,
		).toBe("available");
	});

	it("blocks finalized usage charges inside the 30-minute renewal window and while past due", () => {
		const entry = support("settlement.collect_finalized_charge");
		expect(entry.level).toBe("quotum_composed");
		expect(entry.composedVia).toBeTruthy();
		expect(entry.conditions).toEqual([
			{ kind: "renewal_exclusion_window", minutes: 30 },
			{ kind: "subscription_state", allowed: ["active"] },
		]);
		expect(renderCapabilityStatus(entry)).toBe("Requires policy decision (DEC-14)");

		const blocked = evaluateImplemented("settlement.collect_finalized_charge", {
			operation: insideRenewalWindowWhilePastDue,
		});
		expect(blocked.outcome).toBe("blocked");
		expect(blocked.blockingLayer).toBe("operation");
		expect(blocked.reasons).toEqual([
			{
				code: "RENEWAL_EXCLUSION_WINDOW",
				layer: "operation",
				condition: { kind: "renewal_exclusion_window", minutes: 30 },
				observed: {
					nextRenewalAt: "2026-09-17T12:00:00.000Z",
					now: "2026-09-17T11:45:00.000Z",
					minutes: 30,
				},
				resolution: { kind: "wait_until", at: "2026-09-17T12:00:00.000Z" },
			},
			{
				code: "SUBSCRIPTION_STATE",
				layer: "operation",
				condition: { kind: "subscription_state", allowed: ["active"] },
				observed: { subscriptionState: "billing_retry" },
				resolution: { kind: "none" },
			},
		]);
		expect(
			evaluateImplemented("settlement.collect_finalized_charge", { operation: clearOfRenewal })
				.outcome,
		).toBe("available");
	});

	it("requires saved-method consent and a saved payment method for automatic top-ups", () => {
		const entry = support("topup.automatic");
		expect(entry.level).toBe("quotum_composed");
		expect(entry.conditions).toEqual([
			{ kind: "account_flag", flag: "spmConsent", expected: [true] },
			{ kind: "saved_payment_method", required: true, resolveWith: "topup.customer_initiated" },
			{ kind: "renewal_exclusion_window", minutes: 30 },
			{ kind: "subscription_state", allowed: ["active"] },
		]);
		expect(entry.verification).toMatchObject({
			status: "planned",
			blockedBy: { kind: "decision", ref: "DEC-14" },
		});

		const withoutConsent = evaluateImplemented("topup.automatic", {
			configuration: { ...configured, accountFlags: { spmConsent: false } },
			operation: { ...clearOfRenewal, savedPaymentMethod: true },
		});
		expect(withoutConsent.blockingLayer).toBe("configuration");
		expect(withoutConsent.reasons).toEqual([
			{
				code: "ACCOUNT_FLAG_REQUIRED",
				layer: "configuration",
				condition: { kind: "account_flag", flag: "spmConsent", expected: [true] },
				observed: { flag: "spmConsent", value: false },
				resolution: {
					kind: "merchant_configuration",
					connectionKind: "paddle",
					flag: "spmConsent",
				},
			},
		]);

		const withoutSavedMethod = evaluateImplemented("topup.automatic", {
			configuration: configured,
			operation: { ...clearOfRenewal, savedPaymentMethod: false },
		});
		expect(withoutSavedMethod.blockingLayer).toBe("operation");
		expect(withoutSavedMethod.reasons).toEqual([
			{
				code: "SAVED_PAYMENT_METHOD_REQUIRED",
				layer: "operation",
				condition: {
					kind: "saved_payment_method",
					required: true,
					resolveWith: "topup.customer_initiated",
				},
				observed: { savedPaymentMethod: false },
				resolution: { kind: "customer_action", operation: "topup.customer_initiated" },
			},
		]);

		const unknownSavedMethod = evaluateImplemented("topup.automatic", {
			configuration: configured,
			operation: { ...clearOfRenewal, savedPaymentMethod: "unknown" },
		});
		expect(unknownSavedMethod.outcome).toBe("undetermined");
		expect(unknownSavedMethod.reasons).toEqual([
			expect.objectContaining({
				code: "FACT_UNAVAILABLE",
				layer: "operation",
				resolution: { kind: "checked_at_execution" },
			}),
		]);

		const nearRenewal = evaluateImplemented("topup.automatic", {
			configuration: configured,
			operation: { ...insideRenewalWindowWhilePastDue, savedPaymentMethod: true },
		});
		expect(nearRenewal.reasons.map((reason) => reason.code)).toEqual([
			"RENEWAL_EXCLUSION_WINDOW",
			"SUBSCRIPTION_STATE",
		]);

		expect(
			evaluateImplemented("topup.automatic", {
				configuration: configured,
				operation: { ...clearOfRenewal, savedPaymentMethod: true },
			}).outcome,
		).toBe("available");
	});

	it("composes usage adjustments from Paddle adjustments with their approval states", () => {
		const adjustment = support("adjustment.issue");
		expect(adjustment.level).toBe("quotum_composed");
		expect(adjustment.composedVia).toBe("transaction adjustment");
		expect(adjustment.notes).toMatch(/approval/);
		expect(adjustment.notes).toMatch(/pending, approved, rejected and reversed/);
		expect(evaluateCapability(paddleCapabilities, "adjustment.issue", {})).toMatchObject({
			level: "quotum_composed",
			composedVia: "transaction adjustment",
			blockingLayer: "implementation",
		});

		expect(support("refund.sync")).toMatchObject({
			level: "native",
			verification: { status: "planned", trackedBy: "P4" },
		});
	});

	it("notes that subscriptions come only from paid transactions and updates carry every item", () => {
		expect(support("checkout.plan").notes).toMatch(/only from paid recurring transactions/);
		expect(capabilityStatusLabel(support("checkout.plan"))).toBe("planned");
		expect(support("subscription.change.apply").notes).toMatch(/full retained item set/);
	});
});
