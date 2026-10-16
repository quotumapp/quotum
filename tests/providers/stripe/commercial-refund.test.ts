import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import type { CommercialPreviewRefund } from "../../../src/billing/commercial";
import { type RefundRequest, remainingTimeRefundMinor } from "../../../src/billing/refunds";
import type {
	ClaimRefundRequestInput,
	PurchaseRefundFacts,
	RecordRefundOutcomeInput,
	SubscriptionPaymentRefundFacts,
} from "../../../src/db/repository/refund-requests";
import {
	issueRefund,
	REFUND_METADATA_KEY,
	REFUND_RESEND_WINDOW_MS,
	type RefundClientDependency,
	type RefundIntent,
	type RefundRepositoryDependency,
	refundEventState,
	refundState,
	resolveRefundPreview,
	type StripeRefundAnswer,
} from "../../../src/providers/stripe/refunds";

const billingAccountId = "user_1";
const previewToken = "11111111-1111-4111-8111-111111111111";
const periodStart = new Date("2026-10-01T00:00:00.000Z");
const periodEnd = new Date("2026-10-31T00:00:00.000Z");
const midPeriod = new Date("2026-10-16T00:00:00.000Z");

const subscriptionIntent = (overrides: Partial<RefundIntent> = {}): RefundIntent => ({
	kind: "refund",
	target: { type: "subscription_payment", externalSubscriptionId: "sub_1" },
	mode: "full",
	reason: "Customer asked",
	...overrides,
});

const purchaseIntent = (overrides: Partial<RefundIntent> = {}): RefundIntent => ({
	kind: "refund",
	target: { type: "purchase", purchaseId: "22222222-2222-4222-8222-222222222222" },
	mode: "full",
	reason: "Customer asked",
	...overrides,
});

function invoiceFacts(
	overrides: Partial<SubscriptionPaymentRefundFacts> = {},
): SubscriptionPaymentRefundFacts {
	return {
		customerId: "customer-1",
		subscriptionId: "33333333-3333-4333-8333-333333333333",
		externalSubscriptionId: "sub_1",
		externalInvoiceId: "in_1",
		amountPaidMinor: 3000,
		refundedMinor: 0,
		currency: "usd",
		periodStart,
		periodEnd,
		openRequestId: null,
		...overrides,
	};
}

function purchaseFacts(overrides: Partial<PurchaseRefundFacts> = {}): PurchaseRefundFacts {
	return {
		customerId: "customer-1",
		purchaseId: "22222222-2222-4222-8222-222222222222",
		provider: "stripe",
		purchaseKind: "consumable",
		status: "completed",
		transactionId: "pi_topup",
		amountPaidMinor: 1000,
		refundedMinor: 0,
		currency: "usd",
		creditQuantity: "100",
		unconsumedQuantity: "40",
		unconsumedShareMinor: 400,
		openRequestId: null,
		...overrides,
	};
}

function previewDependencies(input: {
	invoice?: SubscriptionPaymentRefundFacts;
	purchase?: PurchaseRefundFacts;
	paymentIntent?: string | null;
}) {
	return {
		client: {
			findPaymentIntentForInvoice: async () =>
				input.paymentIntent === undefined ? "pi_sub" : input.paymentIntent,
		} satisfies RefundClientDependency,
		repository: {
			readSubscriptionPaymentForRefund: async () => input.invoice ?? invoiceFacts(),
			readPurchaseForRefund: async () => input.purchase ?? purchaseFacts(),
		} satisfies RefundRepositoryDependency,
	};
}

async function refusal(promise: Promise<unknown>): Promise<string | null> {
	try {
		await promise;
		return null;
	} catch (error) {
		return (error as { code?: string }).code ?? String(error);
	}
}

describe("refund amounts", () => {
	// capability: refund.issue
	it("returns the share of the paid period still ahead, rounded down", () => {
		expect(
			remainingTimeRefundMinor({
				paidMinor: 3000,
				refundableMinor: 3000,
				periodStart,
				periodEnd,
				now: midPeriod,
			}),
		).toBe(1500);
		expect(
			remainingTimeRefundMinor({
				paidMinor: 1000,
				refundableMinor: 1000,
				periodStart,
				periodEnd,
				now: new Date(periodStart.getTime() + 1),
			}),
		).toBe(999);
	});

	// capability: refund.issue
	it("never refunds more than is refundable, before the period starts or after it ends", () => {
		const base = { paidMinor: 3000, periodStart, periodEnd };
		expect(
			remainingTimeRefundMinor({
				...base,
				refundableMinor: 400,
				now: new Date(periodStart.getTime() - 86_400_000),
			}),
		).toBe(400);
		expect(
			remainingTimeRefundMinor({
				...base,
				refundableMinor: 3000,
				now: new Date(periodEnd.getTime() + 1),
			}),
		).toBe(0);
		expect(remainingTimeRefundMinor({ ...base, refundableMinor: 3000, now: periodEnd })).toBe(0);
		expect(
			remainingTimeRefundMinor({
				paidMinor: 3000,
				refundableMinor: 3000,
				periodStart: periodEnd,
				periodEnd: periodStart,
				now: midPeriod,
			}),
		).toBe(0);
	});

	// capability: refund.issue
	it("stays within what was paid and never grows as time passes", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 100_000_000 }),
				fc.integer({ min: 0, max: 100_000_000 }),
				fc.integer({ min: 0, max: 40 * 86_400_000 }),
				fc.integer({ min: 0, max: 40 * 86_400_000 }),
				(paid, refundable, earlier, later) => {
					const [first, second] = earlier <= later ? [earlier, later] : [later, earlier];
					const amountAt = (offset: number) =>
						remainingTimeRefundMinor({
							paidMinor: paid,
							refundableMinor: Math.min(refundable, paid),
							periodStart,
							periodEnd,
							now: new Date(periodStart.getTime() + offset),
						});
					const sooner = amountAt(first);
					const later_ = amountAt(second);
					expect(sooner).toBeGreaterThanOrEqual(0);
					expect(sooner).toBeLessThanOrEqual(Math.min(refundable, paid));
					expect(later_).toBeLessThanOrEqual(sooner);
				},
			),
		);
	});
});

describe("refund previews", () => {
	// capability: refund.issue
	it("previews a full refund of the latest subscription payment", async () => {
		const { refund, fingerprintFacts } = await resolveRefundPreview(
			previewDependencies({ invoice: invoiceFacts({ refundedMinor: 500 }) }),
			billingAccountId,
			subscriptionIntent({ cancelImmediately: true }),
			midPeriod,
		);

		expect(refund).toEqual({
			targetKind: "subscription_payment",
			externalInvoiceId: "in_1",
			purchaseId: null,
			providerPaymentId: "pi_sub",
			currency: "usd",
			amountPaidMinor: 3000,
			refundedMinor: 500,
			refundableMinor: 2500,
			refundAmountMinor: 2500,
			basis: "full",
			cancelsSubscriptionId: "sub_1",
		} satisfies CommercialPreviewRefund);
		expect(fingerprintFacts).toMatchObject({ paid: 3000, refunded: 500, paymentIntent: "pi_sub" });
	});

	// capability: refund.issue
	it("prorates a subscription payment by the time left, capped at what remains", async () => {
		const prorated = await resolveRefundPreview(
			previewDependencies({}),
			billingAccountId,
			subscriptionIntent({ mode: "prorated" }),
			midPeriod,
		);
		expect(prorated.refund).toMatchObject({ basis: "remaining_time", refundAmountMinor: 1500 });

		const capped = await resolveRefundPreview(
			previewDependencies({ invoice: invoiceFacts({ refundedMinor: 2800 }) }),
			billingAccountId,
			subscriptionIntent({ mode: "prorated" }),
			midPeriod,
		);
		expect(capped.refund).toMatchObject({ refundableMinor: 200, refundAmountMinor: 200 });
	});

	// capability: refund.issue
	it("prorates a top-up by the credit not yet spent", async () => {
		const { refund } = await resolveRefundPreview(
			previewDependencies({}),
			billingAccountId,
			purchaseIntent({ mode: "prorated" }),
			midPeriod,
		);

		expect(refund).toMatchObject({
			targetKind: "purchase",
			providerPaymentId: "pi_topup",
			basis: "unconsumed_credit",
			refundAmountMinor: 400,
			cancelsSubscriptionId: null,
		});
	});

	// capability: refund.issue
	it("refuses what cannot or should not be refunded", async () => {
		const attempt = (input: Parameters<typeof previewDependencies>[0], intent: RefundIntent) =>
			refusal(
				resolveRefundPreview(previewDependencies(input), billingAccountId, intent, midPeriod),
			);

		expect(
			await attempt({ invoice: invoiceFacts({ openRequestId: "req_1" }) }, subscriptionIntent()),
		).toBe("REFUND_ALREADY_OPEN");
		expect(await attempt({ paymentIntent: null }, subscriptionIntent())).toBe(
			"PAYMENT_NOT_REFUNDABLE",
		);
		expect(
			await attempt({ invoice: invoiceFacts({ refundedMinor: 3000 }) }, subscriptionIntent()),
		).toBe("REFUND_NOTHING_REFUNDABLE");
		expect(
			await attempt(
				{ invoice: invoiceFacts({ periodStart: null, periodEnd: null }) },
				subscriptionIntent({ mode: "prorated" }),
			),
		).toBe("REFUND_NOT_PRORATABLE");
		expect(
			await attempt(
				{ invoice: invoiceFacts({ periodEnd: new Date(midPeriod.getTime() - 1) }) },
				subscriptionIntent({ mode: "prorated" }),
			),
		).toBe("REFUND_NOTHING_REFUNDABLE");

		expect(
			await attempt({ purchase: purchaseFacts({ provider: "apple" }) }, purchaseIntent()),
		).toBe("REFUND_PROVIDER_MANAGED");
		expect(
			await attempt({ purchase: purchaseFacts({ provider: "google" }) }, purchaseIntent()),
		).toBe("REFUND_PROVIDER_MANAGED");
		for (const unrefundable of [
			{ status: "refunded" as const },
			{ purchaseKind: "subscription" as const },
			{ transactionId: "cs_checkout_session" },
			{ amountPaidMinor: null },
			{ currency: null },
		]) {
			expect(await attempt({ purchase: purchaseFacts(unrefundable) }, purchaseIntent())).toBe(
				"PAYMENT_NOT_REFUNDABLE",
			);
		}
		expect(
			await attempt({ purchase: purchaseFacts({ openRequestId: "req_1" }) }, purchaseIntent()),
		).toBe("REFUND_ALREADY_OPEN");
		expect(
			await attempt(
				{ purchase: purchaseFacts({ unconsumedShareMinor: null }) },
				purchaseIntent({ mode: "prorated" }),
			),
		).toBe("REFUND_NOT_PRORATABLE");
		expect(
			await attempt(
				{ purchase: purchaseFacts({ unconsumedShareMinor: 0 }) },
				purchaseIntent({ mode: "prorated" }),
			),
		).toBe("REFUND_NOTHING_REFUNDABLE");
	});
});

const refund: CommercialPreviewRefund = {
	targetKind: "subscription_payment",
	externalInvoiceId: "in_1",
	purchaseId: null,
	providerPaymentId: "pi_sub",
	currency: "usd",
	amountPaidMinor: 3000,
	refundedMinor: 0,
	refundableMinor: 3000,
	refundAmountMinor: 1500,
	basis: "remaining_time",
	cancelsSubscriptionId: null,
};

/** An in-memory request ledger and a scripted Stripe, enough to drive `issueRefund`. */
function issuing(
	options: { createdAt?: Date; stripe?: (call: number) => Promise<StripeRefundAnswer> } = {},
) {
	const stripeCalls: Array<{ metadata: Record<string, string>; amountMinor: number; key: string }> =
		[];
	const requests = new Map<string, RefundRequest>();
	let counter = 0;
	const record = (input: RecordRefundOutcomeInput): RefundRequest => {
		const current = requests.get(input.requestId);
		if (current === undefined) throw new Error("unknown request");
		const final = current.status === "succeeded" || current.status === "failed";
		if (final) return current;
		const next: RefundRequest = {
			...current,
			status: input.status,
			providerRefundId: input.providerRefundId ?? current.providerRefundId,
			failureCode: input.failureCode ?? null,
		};
		requests.set(current.id, next);
		return next;
	};
	const repository: RefundRepositoryDependency = {
		async claimRefundRequest(input: ClaimRefundRequestInput) {
			const existing = [...requests.values()].find(
				(request) => request.providerPaymentId === input.providerPaymentId,
			);
			if (existing !== undefined) return { request: existing, created: false };
			counter += 1;
			const request: RefundRequest = {
				id: `request-${counter}`,
				billingAccountId: input.billingAccountId,
				provider: "stripe",
				targetKind: input.targetKind,
				externalInvoiceId: input.externalInvoiceId,
				purchaseId: input.purchaseId,
				providerPaymentId: input.providerPaymentId,
				amountMinor: input.amountMinor,
				currency: input.currency,
				mode: input.mode,
				basis: input.basis,
				cancelImmediately: input.cancelImmediately,
				reason: input.reason,
				status: "requested",
				providerRefundId: null,
				failureCode: null,
				providerIdempotencyKey: input.providerIdempotencyKey,
				createdAt: (options.createdAt ?? new Date()).toISOString(),
				updatedAt: new Date().toISOString(),
				completedAt: null,
			};
			requests.set(request.id, request);
			return { request, created: true };
		},
		async recordRefundOutcome(input) {
			return record(input);
		},
	};
	const listed: StripeRefundAnswer[] = [];
	const client: RefundClientDependency = {
		async createRefund(params, key) {
			stripeCalls.push({ metadata: params.metadata, amountMinor: params.amountMinor, key });
			return await (options.stripe?.(stripeCalls.length) ??
				Promise.resolve({ id: "re_1", status: "succeeded" }));
		},
		async listPaymentIntentRefunds() {
			return listed;
		},
	};
	const issue = (now?: Date) =>
		issueRefund(
			{ client, repository },
			{
				billingAccountId,
				previewToken,
				idempotencyKey: "caller-key",
				providerIdempotencyKey: "billing:refund:commercial:abc",
				intent: subscriptionIntent({ mode: "prorated" }),
				refund,
				...(now === undefined ? {} : { now }),
			},
		);
	return { stripeCalls, requests, listed, issue };
}

describe("issuing a refund", () => {
	// capability: refund.issue
	it("records the request, asks Stripe once under the execution key and returns it accepted", async () => {
		const { stripeCalls, requests, issue } = issuing();

		const request = await issue();

		expect(request).toMatchObject({
			status: "succeeded",
			providerRefundId: "re_1",
			amountMinor: 1500,
			currency: "usd",
			mode: "prorated",
			basis: "remaining_time",
		});
		expect(stripeCalls).toEqual([
			{
				amountMinor: 1500,
				key: "billing:refund:commercial:abc",
				metadata: { [REFUND_METADATA_KEY]: request.id },
			},
		]);
		expect(requests.size).toBe(1);
	});

	// capability: refund.issue
	it("does not ask Stripe again for a request it already sent", async () => {
		const { stripeCalls, issue } = issuing({
			stripe: async () => ({ id: "re_1", status: "pending" }),
		});

		const first = await issue();
		const second = await issue();

		expect(first.status).toBe("pending");
		expect(second).toEqual(first);
		expect(stripeCalls).toHaveLength(1);
	});

	// capability: refund.issue
	it("sends the same request again under the same key after an answer that never arrived", async () => {
		const { stripeCalls, requests, issue } = issuing({
			stripe: async (call) => {
				if (call === 1) throw Object.assign(new Error("socket hang up"), { statusCode: 503 });
				return { id: "re_1", status: "succeeded" };
			},
		});

		await expect(issue()).rejects.toThrow("socket hang up");
		expect([...requests.values()][0]?.status).toBe("requested");
		const request = await issue();

		expect(request.status).toBe("succeeded");
		expect(stripeCalls.map((call) => call.key)).toEqual([
			"billing:refund:commercial:abc",
			"billing:refund:commercial:abc",
		]);
	});

	// capability: refund.issue
	it("records a refusal Stripe proves and raises it, again on every repeat", async () => {
		const { stripeCalls, issue } = issuing({
			stripe: async () => {
				throw Object.assign(new Error("Charge ch_1 has already been refunded."), {
					statusCode: 400,
					type: "invalid_request_error",
					code: "charge_already_refunded",
				});
			},
		});

		for (let attempt = 0; attempt < 2; attempt += 1) {
			const error = await issue().catch((raised: unknown) => raised);
			expect(error).toMatchObject({
				code: "REFUND_REJECTED_BY_PROVIDER",
				status: 409,
				details: { providerCode: "charge_already_refunded" },
			});
			expect(JSON.stringify(error)).not.toContain("ch_1");
		}
		expect(stripeCalls).toHaveLength(1);
	});

	// capability: refund.issue
	it("treats a rate limit, a server error and a reused key as unproven, not as a refusal", async () => {
		for (const failure of [
			{ statusCode: 429 },
			{ statusCode: 500 },
			{ statusCode: 400, type: "StripeIdempotencyError", rawType: "idempotency_error" },
		]) {
			const { requests, issue } = issuing({
				stripe: async () => {
					throw Object.assign(new Error("unproven"), failure);
				},
			});
			await expect(issue()).rejects.toThrow("unproven");
			expect([...requests.values()][0]?.status).toBe("requested");
		}
	});

	// capability: refund.issue
	it("looks a request up instead of sending it past the resend window", async () => {
		const old = new Date(Date.now() - REFUND_RESEND_WINDOW_MS - 60_000);

		const unseen = issuing({ createdAt: old });
		const error = await unseen.issue().catch((raised: unknown) => raised);
		expect(error).toMatchObject({ code: "REFUND_RECONCILIATION_REQUIRED", status: 409 });
		expect(unseen.stripeCalls).toHaveLength(0);
		expect([...unseen.requests.values()][0]?.status).toBe("requires_review");

		// A refund Stripe did create carries the request id, so the request adopts it.
		const adoptable = issuing({ createdAt: old });
		adoptable.listed.push({
			id: "re_found",
			status: "succeeded",
			metadata: { [REFUND_METADATA_KEY]: "request-1" },
		});
		const adopted = await adoptable.issue();
		expect(adopted).toMatchObject({ status: "succeeded", providerRefundId: "re_found" });
		expect(adoptable.stripeCalls).toHaveLength(0);
	});
});

describe("refund states", () => {
	// capability: refund.issue
	it("maps Stripe's refund status to the request's state", () => {
		expect(refundState("succeeded", null)).toEqual({ status: "succeeded" });
		expect(refundState("pending", null)).toEqual({ status: "pending" });
		expect(refundState("requires_action", null)).toEqual({ status: "pending" });
		expect(refundState(null, null)).toEqual({ status: "pending" });
		expect(refundState("failed", "expired_or_canceled_card")).toEqual({
			status: "failed",
			failureCode: "expired_or_canceled_card",
		});
		expect(refundState("canceled", null)).toEqual({ status: "failed", failureCode: "canceled" });
	});

	// capability: refund.issue
	it("reads the request id and state from a refund event", () => {
		expect(
			refundEventState({
				id: "re_1",
				status: "failed",
				failure_reason: "lost_or_stolen_card",
				metadata: { [REFUND_METADATA_KEY]: "019ac3c1-0000-7000-8000-000000000007" },
			}),
		).toEqual({
			requestId: "019ac3c1-0000-7000-8000-000000000007",
			providerRefundId: "re_1",
			outcome: "failed",
			failureCode: "lost_or_stolen_card",
		});
		expect(refundEventState({ id: "re_2", status: "succeeded" })).toEqual({
			requestId: null,
			providerRefundId: "re_2",
			outcome: "succeeded",
			failureCode: null,
		});
		expect(refundEventState({ status: "succeeded" })).toBeNull();
		// Free text in Stripe's metadata never reaches a query as an id.
		expect(
			refundEventState({
				id: "re_3",
				status: "succeeded",
				metadata: { [REFUND_METADATA_KEY]: "not-a-uuid'; DROP TABLE refund_requests;--" },
			}),
		).toMatchObject({ requestId: null });
	});
});
