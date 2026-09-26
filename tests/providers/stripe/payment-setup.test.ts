import { describe, expect, it, spyOn } from "bun:test";
import type Stripe from "stripe";
import type { CommercialPreviewDraft } from "../../../src/billing/commercial";
import { BillingError, isBillingError } from "../../../src/billing/errors";
import type { StripeRecurringCheckoutPlan } from "../../../src/db/repository";
import {
	applyPaymentSetupEvent,
	createPaymentSetup,
	enqueuePaymentSetupEvent,
	nextPollAt,
	normalizePaymentSetupEvent,
	PAYMENT_SETUP_ATTENTION_ATTEMPTS,
	PAYMENT_SETUP_ATTENTION_POLL_MS,
	PAYMENT_SETUP_LIFETIME_MS,
	PAYMENT_SETUP_POLL_INTERVAL_MS,
	type PaymentSetupContext,
	type PaymentSetupRequestParameters,
	paymentSetupPreviewFacts,
	paymentSetupRequestHash,
	reconcilePaymentSetup,
	STRIPE_IDEMPOTENCY_RETENTION_MS,
} from "../../../src/providers/stripe/payment-setup";
import {
	paymentSetupPlanIdempotencyKey,
	startPlanOnSavedCard,
} from "../../../src/providers/stripe/saved-card-plan";
import {
	paymentSetupSubscriptionParams,
	StripeBillingService,
	type StripeBillingServiceDependencies,
} from "../../../src/providers/stripe/service";
import {
	FakePaymentSetupClient,
	type FakePaymentSetupClientOptions,
	FakePaymentSetupStore,
	sessionIdFor,
} from "./payment-setup-fixture";

const now = new Date("2026-09-22T10:00:00.000Z");
const previewToken = "11111111-1111-4111-8111-111111111111";
const otherPreviewToken = "22222222-2222-4222-8222-222222222222";

const parameters: PaymentSetupRequestParameters = {
	billingAccountId: "acct_1",
	currency: "usd",
	email: "payer@example.com",
	successUrl: "https://app.example.com/billing?session={CHECKOUT_SESSION_ID}",
	cancelUrl: "https://app.example.com/billing",
	providerAccountId: "acct_stripe_1",
	integrationIdentifier: "qfmxzjpa",
	plan: null,
};

function context(
	options: FakePaymentSetupClientOptions = {},
	overrides: { store?: FakePaymentSetupStore; now?: Date } = {},
): PaymentSetupContext & { store: FakePaymentSetupStore; client: FakePaymentSetupClient } {
	const store = overrides.store ?? new FakePaymentSetupStore();
	const client = new FakePaymentSetupClient(options);
	const clock = overrides.now ?? now;
	store.now = clock;
	return { client, repository: store, now: () => clock, store };
}

async function create(
	ctx: PaymentSetupContext,
	input: { previewToken?: string; parameters?: PaymentSetupRequestParameters } = {},
) {
	const creation = await createPaymentSetup(ctx, {
		previewToken: input.previewToken ?? previewToken,
		providerCustomerId: "cus_1",
		providerIdempotencyKey: "billing:payment-setup:project:abc",
		parameters: input.parameters ?? parameters,
	});
	if (creation.sessionId === null) throw new Error("Expected a persisted provider session");
	return { ...creation, sessionId: creation.sessionId };
}

describe("hosted payment setup creation", () => {
	// capability: payment_method.setup
	it("creates a card-only setup session with the requested currency and a 23-hour lifetime", async () => {
		const ctx = context();

		const creation = await create(ctx);

		const [call] = ctx.client.createdSessions;
		expect(call?.idempotencyKey).toBe("billing:payment-setup:project:abc");
		expect(call?.params).toMatchObject({
			mode: "setup",
			currency: "usd",
			allowed_payment_method_types: ["card"],
			customer: "cus_1",
			client_reference_id: "acct_1",
			success_url: parameters.successUrl,
			cancel_url: parameters.cancelUrl,
		});
		expect(call?.params.expires_at).toBe(
			Math.floor((now.getTime() + PAYMENT_SETUP_LIFETIME_MS) / 1000),
		);
		expect(creation.expiresAt).toBe(
			new Date(now.getTime() + PAYMENT_SETUP_LIFETIME_MS).toISOString(),
		);
		expect(creation.reused).toBe(false);
		expect(ctx.store.only().status).toBe("awaiting_customer");
	});

	it("carries the setup id in session and setup-intent metadata so events can find it", async () => {
		const ctx = context();

		await create(ctx);

		const setupId = ctx.store.only().id;
		const params = ctx.client.createdSessions[0]?.params as {
			metadata?: Record<string, string>;
			setup_intent_data?: { metadata?: Record<string, string> };
		};
		expect(params.metadata).toEqual({
			billingAccountId: "acct_1",
			quotumOperation: "payment_method_setup",
			quotumPaymentSetupId: setupId,
		});
		expect(params.setup_intent_data?.metadata).toEqual(params.metadata);
	});

	it("shows the account-default and future-charge purpose in the hosted copy", async () => {
		const ctx = context();

		await create(ctx);

		const params = ctx.client.createdSessions[0]?.params as {
			custom_text?: { submit?: { message?: string } };
		};
		expect(params.custom_text?.submit?.message).toContain("default payment method");
		expect(params.custom_text?.submit?.message).toContain("Nothing is charged now");
	});

	it("schedules exactly one reconciliation task for the setup", async () => {
		const ctx = context();

		await create(ctx);

		expect(ctx.store.reconciliations).toHaveLength(1);
		expect(ctx.store.reconciliations[0]?.setupId).toBe(ctx.store.only().id);
	});

	it("records no financial fact: only the setup row exists", async () => {
		const ctx = context();

		await create(ctx);

		const row = ctx.store.only();
		expect(row.default_payment_method_id).toBeNull();
		expect(row.completed_at).toBeNull();
		// Nothing in the created session asks Stripe for money.
		const params = ctx.client.createdSessions[0]?.params ?? {};
		expect(params).not.toHaveProperty("line_items");
		expect(params).not.toHaveProperty("payment_intent_data");
		expect(params).not.toHaveProperty("subscription_data");
	});
});

describe("hosted payment setup reuse and conflicts", () => {
	it("returns the existing link unchanged for a matching request", async () => {
		const ctx = context();
		const first = await create(ctx);

		const second = await create(ctx, { previewToken: otherPreviewToken });

		expect(second.reused).toBe(true);
		expect(second.sessionId).toBe(first.sessionId);
		expect(second.url).toBe(first.url);
		expect(ctx.client.createdSessions).toHaveLength(1);
		expect(ctx.store.rows.size).toBe(1);
	});

	it("refuses a differing request and names the active setup", async () => {
		const ctx = context();
		await create(ctx);
		const setupId = ctx.store.only().id;

		const error = await create(ctx, {
			previewToken: otherPreviewToken,
			parameters: { ...parameters, currency: "eur" },
		}).catch((thrown: unknown) => thrown);

		if (!isBillingError(error)) throw new Error("Expected a billing error");
		expect(error.code).toBe("PAYMENT_SETUP_ALREADY_ACTIVE");
		expect(error.status).toBe(409);
		expect(error.details).toEqual({
			paymentSetup: {
				setupId,
				status: "awaiting_customer",
				expiresAt: new Date(now.getTime() + PAYMENT_SETUP_LIFETIME_MS).toISOString(),
			},
		});
	});

	it("hashes only the frozen request parameters", () => {
		expect(paymentSetupRequestHash(parameters)).toBe(paymentSetupRequestHash({ ...parameters }));
		expect(paymentSetupRequestHash({ ...parameters, currency: "eur" })).not.toBe(
			paymentSetupRequestHash(parameters),
		);
	});

	it("needs a new preview once the setup completed", async () => {
		const ctx = context();
		await create(ctx);
		const setup = ctx.store.only();
		setup.status = "completed";
		setup.default_payment_method_id = "pm_1";
		setup.completed_at = now.toISOString();

		const second = await create(ctx, { previewToken: otherPreviewToken });

		expect(second.reused).toBe(false);
		expect(second.setupId).not.toBe(setup.id);
	});

	it("reports the reuse a preview would make", async () => {
		const ctx = context();
		const before = await paymentSetupPreviewFacts(ctx, parameters);
		expect(before).toEqual({ reusesExistingSetup: false, setup: null });

		await create(ctx);

		const after = await paymentSetupPreviewFacts(ctx, parameters);
		expect(after.reusesExistingSetup).toBe(true);
		expect(after.setup?.id).toBe(ctx.store.only().id);
	});
});

describe("hosted payment setup completion", () => {
	function completionEvent(setupId: string, sessionId: string, action = "completed") {
		return {
			type: action === "completed" ? "checkout.session.completed" : "checkout.session.expired",
			object: {
				id: sessionId,
				mode: "setup",
				customer: "cus_1",
				setup_intent: `seti_${sessionId}`,
				metadata: { quotumPaymentSetupId: setupId },
			},
		};
	}

	it("updates only the customer's invoice default payment method", async () => {
		const ctx = context();
		const creation = await create(ctx);
		const event = normalizePaymentSetupEvent(completionEvent(creation.setupId, creation.sessionId));
		if (event === null) throw new Error("Expected a setup event");

		const result = await applyPaymentSetupEvent(ctx, { event, workerId: "worker-a" });

		expect(result).toEqual({ status: "processed" });
		expect(ctx.client.defaultWrites).toEqual([
			{
				customerId: "cus_1",
				paymentMethodId: `pm_seti_${creation.sessionId}`,
				idempotencyKey: `billing:payment-setup-default:${creation.setupId}:pm_seti_${creation.sessionId}`,
			},
		]);
		const row = ctx.store.only();
		expect(row.status).toBe("completed");
		expect(row.card_brand).toBe("visa");
		expect(row.card_last4).toBe("4242");
		expect(row.claimed_by).toBeNull();
	});

	it("persists the intended method before asking the provider to make it default", async () => {
		const ctx = context();
		const creation = await create(ctx);
		ctx.client.failNext("updateCustomerDefaultPaymentMethod", new Error("stripe is down"));
		const event = normalizePaymentSetupEvent(completionEvent(creation.setupId, creation.sessionId));
		if (event === null) throw new Error("Expected a setup event");

		await expect(applyPaymentSetupEvent(ctx, { event, workerId: "worker-a" })).rejects.toThrow(
			"stripe is down",
		);

		const row = ctx.store.only();
		expect(row.status).toBe("applying_default");
		expect(row.intended_payment_method_id).toBe(`pm_seti_${creation.sessionId}`);
		expect(row.default_payment_method_id).toBeNull();
	});

	it("ignores a duplicate completion", async () => {
		const ctx = context();
		const creation = await create(ctx);
		const event = normalizePaymentSetupEvent(completionEvent(creation.setupId, creation.sessionId));
		if (event === null) throw new Error("Expected a setup event");
		await applyPaymentSetupEvent(ctx, { event, workerId: "worker-a" });

		const replay = await applyPaymentSetupEvent(ctx, { event, workerId: "worker-b" });

		expect(replay).toEqual({ status: "ignored", reason: "payment_setup_already_completed" });
		expect(ctx.client.defaultWrites).toHaveLength(1);
	});

	it("never expires a setup a later completion already finished", async () => {
		const ctx = context();
		const creation = await create(ctx);
		const completed = normalizePaymentSetupEvent(
			completionEvent(creation.setupId, creation.sessionId),
		);
		const expired = normalizePaymentSetupEvent(
			completionEvent(creation.setupId, creation.sessionId, "expired"),
		);
		if (completed === null || expired === null) throw new Error("Expected setup events");
		await applyPaymentSetupEvent(ctx, { event: completed, workerId: "worker-a" });

		const outOfOrder = await applyPaymentSetupEvent(ctx, { event: expired, workerId: "worker-b" });

		expect(outOfOrder).toEqual({ status: "ignored", reason: "payment_setup_already_completed" });
		expect(ctx.store.only().status).toBe("completed");
	});

	it("completes a setup whose completion overtook the creation response", async () => {
		const ctx = context();
		const reservation = await ctx.store.reservePaymentSetup({
			billingAccountId: "acct_1",
			previewToken,
			providerAccountId: "acct_stripe_1",
			providerCustomerId: "cus_1",
			providerIdempotencyKey: "billing:payment-setup:project:abc",
			requestHash: paymentSetupRequestHash(parameters),
			currency: "usd",
			email: null,
			successUrl: parameters.successUrl,
			cancelUrl: parameters.cancelUrl,
			expiresAt: new Date(now.getTime() + PAYMENT_SETUP_LIFETIME_MS),
		});
		expect(reservation.setup.external_session_id).toBeNull();
		const event = normalizePaymentSetupEvent(
			completionEvent(reservation.setup.id, "cs_overtaking"),
		);
		if (event === null) throw new Error("Expected a setup event");

		const result = await applyPaymentSetupEvent(ctx, { event, workerId: "worker-a" });

		expect(result).toEqual({ status: "processed" });
		const row = ctx.store.only();
		expect(row.status).toBe("completed");
		// The event supplied the session identity the creation response had not yet recorded.
		expect(row.external_session_id).toBe("cs_overtaking");
	});

	it("returns completed state without reissuing a provider call after a lost execution response", async () => {
		const ctx = context();
		const reservation = await ctx.store.reservePaymentSetup({
			billingAccountId: "acct_1",
			previewToken,
			providerAccountId: "acct_stripe_1",
			providerCustomerId: "cus_1",
			providerIdempotencyKey: "billing:payment-setup:project:abc",
			requestHash: paymentSetupRequestHash(parameters),
			currency: "usd",
			email: null,
			successUrl: parameters.successUrl,
			cancelUrl: parameters.cancelUrl,
			expiresAt: new Date(now.getTime() + PAYMENT_SETUP_LIFETIME_MS),
		});
		const sessionId = sessionIdFor("billing:payment-setup:project:abc");
		const event = normalizePaymentSetupEvent(completionEvent(reservation.setup.id, sessionId));
		if (event === null) throw new Error("Expected a setup event");
		await applyPaymentSetupEvent(ctx, { event, workerId: "worker-a" });

		const creation = await create(ctx);

		// Completion is durable; a repeated execution must not create another Stripe session.
		expect(creation).toMatchObject({ setupId: reservation.setup.id, sessionId, reused: true });
		expect(creation.url).toBeNull();
		expect(creation.status).toBe("completed");
		expect(ctx.client.createdSessions).toHaveLength(0);
		expect(ctx.store.only().status).toBe("completed");
	});

	it("ignores a completion for a setup absent from this project", async () => {
		const ctx = context();
		const event = normalizePaymentSetupEvent(
			completionEvent("00000000-0000-4000-8000-000000000999", "cs_unknown"),
		);
		if (event === null) throw new Error("Expected a setup event");

		const result = await applyPaymentSetupEvent(ctx, { event, workerId: "worker-a" });

		expect(result).toEqual({ status: "ignored", reason: "payment_setup_missing" });
		expect(ctx.client.defaultWrites).toEqual([]);
	});

	it("waits when another worker already holds the setup", async () => {
		const ctx = context();
		const creation = await create(ctx);
		await ctx.store.claimPaymentSetup({ setupId: creation.setupId, workerId: "worker-a" });
		const event = normalizePaymentSetupEvent(completionEvent(creation.setupId, creation.sessionId));
		if (event === null) throw new Error("Expected a setup event");

		const result = await applyPaymentSetupEvent(ctx, { event, workerId: "worker-b" });

		expect(result).toMatchObject({ status: "deferred", reason: "payment_setup_claimed_elsewhere" });
	});

	it("refuses a setup intent that belongs to another customer", async () => {
		const ctx = context({ setupIntentCustomerId: "cus_other" });
		const creation = await create(ctx);
		const event = normalizePaymentSetupEvent(completionEvent(creation.setupId, creation.sessionId));
		if (event === null) throw new Error("Expected a setup event");

		const error = await applyPaymentSetupEvent(ctx, { event, workerId: "worker-a" }).catch(
			(thrown: unknown) => thrown,
		);

		if (!isBillingError(error)) throw new Error("Expected a billing error");
		expect(error.code).toBe("STRIPE_PAYMENT_SETUP_MISMATCH");
		expect(ctx.client.defaultWrites).toEqual([]);
	});

	it("refuses a setup intent that has not succeeded", async () => {
		const ctx = context({ setupIntentStatus: "requires_payment_method" });
		const creation = await create(ctx);
		const event = normalizePaymentSetupEvent(completionEvent(creation.setupId, creation.sessionId));
		if (event === null) throw new Error("Expected a setup event");

		const error = await applyPaymentSetupEvent(ctx, { event, workerId: "worker-a" }).catch(
			(thrown: unknown) => thrown,
		);

		if (!isBillingError(error)) throw new Error("Expected a billing error");
		expect(error.code).toBe("STRIPE_PAYMENT_SETUP_INCOMPLETE");
	});

	it("refuses a saved method that is not a card", async () => {
		const ctx = context({ paymentMethodType: "sepa_debit" });
		const creation = await create(ctx);
		const event = normalizePaymentSetupEvent(completionEvent(creation.setupId, creation.sessionId));
		if (event === null) throw new Error("Expected a setup event");

		const error = await applyPaymentSetupEvent(ctx, { event, workerId: "worker-a" }).catch(
			(thrown: unknown) => thrown,
		);

		if (!isBillingError(error)) throw new Error("Expected a billing error");
		expect(error.code).toBe("STRIPE_PAYMENT_SETUP_UNSUPPORTED_METHOD");
	});

	it("records a confirmed expiry and frees the slot", async () => {
		const ctx = context();
		const creation = await create(ctx);
		const event = normalizePaymentSetupEvent(
			completionEvent(creation.setupId, creation.sessionId, "expired"),
		);
		if (event === null) throw new Error("Expected a setup event");

		const result = await applyPaymentSetupEvent(ctx, { event, workerId: "worker-a" });

		expect(result).toEqual({ status: "processed" });
		const row = ctx.store.only();
		expect(row.status).toBe("expired");
		expect(row.session_url).toBeNull();
		expect(
			await ctx.store.findActivePaymentSetup({
				billingAccountId: "acct_1",
				providerAccountId: "acct_stripe_1",
			}),
		).toBeNull();
	});
});

describe("hosted payment setup event ingress", () => {
	it("only claims setup sessions Quotum created", () => {
		expect(
			normalizePaymentSetupEvent({
				type: "checkout.session.completed",
				object: { id: "cs_1", mode: "payment", metadata: {} },
			}),
		).toBeNull();
		expect(
			normalizePaymentSetupEvent({
				type: "checkout.session.completed",
				object: { id: "cs_1", mode: "setup", metadata: {} },
			}),
		).toBeNull();
		expect(
			normalizePaymentSetupEvent({
				type: "invoice.paid",
				object: { id: "in_1", mode: "setup", metadata: { quotumPaymentSetupId: "s_1" } },
			}),
		).toBeNull();
	});

	it("queues an event once, however many times it is delivered", async () => {
		const ctx = context();
		const setup = {
			action: "completed" as const,
			setupId: "s_1",
			checkoutSessionId: "cs_1",
			stripeCustomerId: "cus_1",
			setupIntentId: "seti_1",
		};
		const rawEvent = { id: "evt_1", type: "checkout.session.completed" };

		await enqueuePaymentSetupEvent(ctx, {
			externalEventId: "evt_1",
			eventType: "checkout.session.completed",
			setup,
			rawEvent,
		});
		await enqueuePaymentSetupEvent(ctx, {
			externalEventId: "evt_1",
			eventType: "checkout.session.completed",
			setup,
			rawEvent,
		});

		expect(ctx.store.enqueuedEvents).toHaveLength(2);
		expect(ctx.client.defaultWrites).toEqual([]);
	});
});

describe("hosted payment setup reconciliation", () => {
	it("keeps polling an open session without consuming a retry attempt", async () => {
		const ctx = context();
		const creation = await create(ctx);

		const result = await reconcilePaymentSetup(ctx, {
			setupId: creation.setupId,
			workerId: "worker-a",
			attempts: 0,
		});

		expect(result).toMatchObject({ status: "deferred", reason: "payment_setup_awaiting_customer" });
		if (result.status !== "deferred") throw new Error("Expected a deferral");
		expect(result.nextAttemptAt.getTime()).toBe(now.getTime() + PAYMENT_SETUP_POLL_INTERVAL_MS);
	});

	it("applies a completion whose webhook never arrived", async () => {
		const ctx = context({ sessionStatus: "complete" });
		const creation = await create(ctx);

		const result = await reconcilePaymentSetup(ctx, {
			setupId: creation.setupId,
			workerId: "worker-a",
			attempts: 0,
		});

		expect(result).toEqual({ status: "processed" });
		expect(ctx.store.only().status).toBe("completed");
		expect(ctx.client.defaultWrites).toHaveLength(1);
	});

	it("confirms expiry with the provider before releasing the slot", async () => {
		const ctx = context({ sessionStatus: "expired" });
		const creation = await create(ctx);

		const result = await reconcilePaymentSetup(ctx, {
			setupId: creation.setupId,
			workerId: "worker-a",
			attempts: 0,
		});

		expect(result).toEqual({ status: "processed" });
		expect(ctx.store.only().status).toBe("expired");
	});

	it("finishes an interrupted default-method write", async () => {
		const ctx = context();
		const creation = await create(ctx);
		const setup = ctx.store.only();
		setup.status = "applying_default";
		setup.intended_payment_method_id = `pm_seti_${creation.sessionId}`;
		setup.external_setup_intent_id = `seti_${creation.sessionId}`;

		const result = await reconcilePaymentSetup(ctx, {
			setupId: creation.setupId,
			workerId: "worker-a",
			attempts: 0,
		});

		expect(result).toEqual({ status: "processed" });
		expect(ctx.store.only().status).toBe("completed");
	});

	it("resumes a creation whose response was lost, reusing the frozen idempotency key", async () => {
		const ctx = context();
		const reservation = await ctx.store.reservePaymentSetup({
			billingAccountId: "acct_1",
			previewToken,
			providerAccountId: "acct_stripe_1",
			providerCustomerId: "cus_1",
			providerIdempotencyKey: "billing:payment-setup:project:abc",
			requestHash: paymentSetupRequestHash(parameters),
			currency: "usd",
			email: null,
			successUrl: parameters.successUrl,
			cancelUrl: parameters.cancelUrl,
			expiresAt: new Date(now.getTime() + PAYMENT_SETUP_LIFETIME_MS),
		});

		const result = await reconcilePaymentSetup(ctx, {
			setupId: reservation.setup.id,
			workerId: "worker-a",
			attempts: 0,
		});

		expect(result).toMatchObject({ status: "deferred", reason: "payment_setup_link_recovered" });
		expect(ctx.client.createdSessions[0]?.idempotencyKey).toBe("billing:payment-setup:project:abc");
		expect(ctx.store.only().status).toBe("awaiting_customer");
	});

	it("never recreates a stalled creation past Stripe's idempotency retention window", async () => {
		const ctx = context();
		const reservation = await ctx.store.reservePaymentSetup({
			billingAccountId: "acct_1",
			previewToken,
			providerAccountId: "acct_stripe_1",
			providerCustomerId: "cus_1",
			providerIdempotencyKey: "billing:payment-setup:project:abc",
			requestHash: paymentSetupRequestHash(parameters),
			currency: "usd",
			email: null,
			successUrl: parameters.successUrl,
			cancelUrl: parameters.cancelUrl,
			expiresAt: new Date(now.getTime() + PAYMENT_SETUP_LIFETIME_MS),
		});
		reservation.setup.created_at = new Date(
			now.getTime() - STRIPE_IDEMPOTENCY_RETENTION_MS - 1000,
		).toISOString();

		const result = await reconcilePaymentSetup(ctx, {
			setupId: reservation.setup.id,
			workerId: "worker-a",
			attempts: 0,
		});

		expect(result).toMatchObject({ status: "deferred" });
		expect(ctx.client.createdSessions).toHaveLength(0);
		const row = ctx.store.only();
		expect(row.status).toBe("needs_attention");
		expect(row.attention_reason).toContain("idempotency window has expired");
	});

	it("retries a provider failure while the attempt budget lasts", async () => {
		const ctx = context({ sessionStatus: "complete" });
		const creation = await create(ctx);
		ctx.client.failNext("retrieveSetupCheckoutSession", new Error("stripe timeout"));

		const result = await reconcilePaymentSetup(ctx, {
			setupId: creation.setupId,
			workerId: "worker-a",
			attempts: 0,
		});

		expect(result).toEqual({ status: "retryable", reason: "stripe timeout" });
		expect(ctx.store.only().status).toBe("awaiting_customer");
	});

	it("keeps an exhausted setup visible and holding the slot instead of failing it", async () => {
		const ctx = context({ sessionStatus: "complete" });
		const creation = await create(ctx);
		ctx.client.failNext("retrieveSetupCheckoutSession", new Error("stripe timeout"));

		const result = await reconcilePaymentSetup(ctx, {
			setupId: creation.setupId,
			workerId: "worker-a",
			attempts: PAYMENT_SETUP_ATTENTION_ATTEMPTS,
		});

		expect(result).toMatchObject({ status: "deferred", reason: "stripe timeout" });
		const row = ctx.store.only();
		expect(row.status).toBe("needs_attention");
		expect(row.attention_reason).toBe("stripe timeout");
		expect(
			await ctx.store.findActivePaymentSetup({
				billingAccountId: "acct_1",
				providerAccountId: "acct_stripe_1",
			}),
		).not.toBeNull();
	});

	it("stops watching a setup that no longer exists", async () => {
		const ctx = context();

		const result = await reconcilePaymentSetup(ctx, {
			setupId: "00000000-0000-4000-8000-000000000404",
			workerId: "worker-a",
			attempts: 0,
		});

		expect(result).toEqual({ status: "ignored", reason: "payment_setup_missing" });
	});
});

describe("hosted setup review regressions", () => {
	it("queues recovery before a provider creation fails", async () => {
		const ctx = context();
		ctx.client.failNext("createCheckoutSession", new Error("response lost"));
		await expect(create(ctx)).rejects.toThrow("response lost");
		expect(ctx.store.only().status).toBe("creating");
		expect(ctx.store.reconciliations).toHaveLength(1);
		const target = ctx.store.reconciliations[0];
		if (!target) throw new Error("Missing recovery task");
		await reconcilePaymentSetup(ctx, {
			setupId: target.setupId,
			workerId: "worker-a",
			attempts: 0,
		});
		expect(ctx.store.only().status).toBe("awaiting_customer");
	});

	it("reports conflicting request parameters during preview", async () => {
		const ctx = context();
		await create(ctx);
		for (const change of [
			{ currency: "eur" },
			{ email: "other@example.test" },
			{ successUrl: "https://app.example.com/other" },
			{ cancelUrl: "https://app.example.com/cancel" },
		]) {
			await expect(
				paymentSetupPreviewFacts(ctx, { ...parameters, ...change }),
			).rejects.toMatchObject({ code: "PAYMENT_SETUP_ALREADY_ACTIVE", status: 409 });
		}
	});

	it("refuses an unexpanded method before promoting it to default", async () => {
		const ctx = context();
		const creation = await create(ctx);
		ctx.client.retrieveSetupIntent = async () => ({
			id: "seti_1",
			status: "succeeded",
			customer: "cus_1",
			payment_method: "pm_unknown",
		});
		await expect(
			applyPaymentSetupEvent(ctx, {
				workerId: "worker-a",
				event: {
					action: "completed",
					setupId: creation.setupId,
					checkoutSessionId: creation.sessionId,
					stripeCustomerId: "cus_1",
					setupIntentId: "seti_1",
				},
			}),
		).rejects.toMatchObject({ code: "STRIPE_PAYMENT_SETUP_INCOMPLETE" });
		expect(ctx.client.defaultWrites).toHaveLength(0);
		expect(ctx.store.only().status).toBe("awaiting_customer");
	});

	it("uses the worker's last attempt to retain recovery and expose attention", async () => {
		for (const maxAttempts of [1, 3, 5]) {
			const ctx = context();
			const creation = await create(ctx);
			ctx.client.failNext("retrieveSetupCheckoutSession", new Error("provider down"));
			const result = await reconcilePaymentSetup(ctx, {
				setupId: creation.setupId,
				workerId: "worker-a",
				attempts: maxAttempts - 1,
				maxAttempts,
			});
			expect(result).toMatchObject({ status: "deferred" });
			expect(ctx.store.only().status).toBe("needs_attention");
			expect(nextPollAt(ctx.store.only(), now).getTime()).toBe(
				now.getTime() + PAYMENT_SETUP_ATTENTION_POLL_MS,
			);
		}
	});

	it("polls past-expiry unresolved sessions on the normal interval", async () => {
		const ctx = context();
		await create(ctx);
		const row = ctx.store.only();
		row.expires_at = new Date(now.getTime() - 60_000).toISOString();
		expect(nextPollAt(row, now).getTime()).toBe(now.getTime() + PAYMENT_SETUP_POLL_INTERVAL_MS);
	});

	it("does not create a session when its frozen expiry is too close", async () => {
		const ctx = context();
		const lost = new Error("response lost");
		ctx.client.failNext("createCheckoutSession", lost);
		await expect(create(ctx)).rejects.toBe(lost);
		const row = ctx.store.only();
		row.expires_at = new Date(now.getTime() + 20 * 60_000).toISOString();
		await expect(create(ctx)).rejects.toMatchObject({ code: "STRIPE_PAYMENT_SETUP_INCOMPLETE" });
		const result = await reconcilePaymentSetup(ctx, {
			setupId: row.id,
			workerId: "worker-a",
			attempts: 0,
		});
		expect(result).toMatchObject({ status: "deferred" });
		expect(row.status).toBe("needs_attention");
		expect(ctx.client.createdSessions).toHaveLength(0);
	});

	for (const status of ["completed", "expired", "applying_default", "needs_attention"] as const) {
		it(`returns stored ${status} state after the original idempotency window`, async () => {
			const ctx = context();
			const first = await create(ctx);
			ctx.store.only().status = status;
			ctx.now = () => new Date(now.getTime() + 48 * 60 * 60_000);
			const retry = await create(ctx);
			expect(retry).toMatchObject({ setupId: first.setupId, status, url: null, reused: true });
			expect(ctx.client.createdSessions).toHaveLength(1);
		});
	}
});

const proPlan: StripeRecurringCheckoutPlan = {
	planVersionId: "42",
	planKey: "pro",
	name: "Pro",
	kind: "base",
	trialDays: 14,
	trialRequiresPaymentMethod: true,
	trialEndBehavior: "cancel",
	trialUsed: false,
	components: [
		{
			priceComponentId: "1",
			priceKey: "base",
			componentKind: "base",
			featureKey: null,
			externalProductId: "prod_pro",
			externalPriceId: "price_pro",
			defaultQuantity: 1,
			minimumQuantity: 1,
			maximumQuantity: 1,
			unitAmountMinor: 999,
			pricingModel: "flat",
			currency: "usd",
			billingInterval: "month",
		},
		{
			priceComponentId: "2",
			priceKey: "seats",
			componentKind: "licensed",
			featureKey: "seats",
			externalProductId: "prod_seats",
			externalPriceId: "price_seats",
			defaultQuantity: 1,
			minimumQuantity: 1,
			maximumQuantity: 100,
			unitAmountMinor: 200,
			pricingModel: "flat",
			currency: "usd",
			billingInterval: "month",
		},
	],
};

const planRequest: PaymentSetupRequestParameters = {
	...parameters,
	plan: { planKey: "pro", planVersionId: "42", quantities: { seats: 5 } },
};

describe("setup that starts a plan", () => {
	// capability: subscription.create
	function subscriptionClient() {
		const subscriptions = new Map<string, Record<string, unknown>>();
		const byKey = new Map<string, Record<string, unknown>>();
		const creates: Array<{ params: Stripe.SubscriptionCreateParams; idempotencyKey: string }> = [];
		let failure: unknown;
		let loseNext = false;
		return {
			creates,
			failNext(error: unknown) {
				failure = error;
			},
			loseNextResponse() {
				loseNext = true;
			},
			async createSubscription(params: Stripe.SubscriptionCreateParams, idempotencyKey: string) {
				const replay = byKey.get(idempotencyKey);
				if (replay !== undefined) return replay;
				if (failure !== undefined) {
					const error = failure;
					failure = undefined;
					throw error;
				}
				creates.push({ params, idempotencyKey });
				const subscription = {
					id: `sub_${creates.length}`,
					customer: params.customer,
					status: "active",
					metadata: params.metadata ?? {},
				};
				subscriptions.set(subscription.id, subscription);
				byKey.set(idempotencyKey, subscription);
				if (loseNext) {
					loseNext = false;
					throw new Error("response lost");
				}
				return subscription;
			},
			async listCustomerSubscriptions(customerId: string) {
				return [...subscriptions.values()].filter(
					(subscription) => subscription.customer === customerId,
				);
			},
			async retrieveSubscription(subscriptionId: string) {
				const subscription = subscriptions.get(subscriptionId);
				if (subscription === undefined) throw new Error(`Unknown subscription ${subscriptionId}`);
				return subscription;
			},
		};
	}

	function planSetup(
		options: { plan?: StripeRecurringCheckoutPlan; hasActiveBasePlan?: boolean } = {},
	) {
		const ctx = context({ sessionStatus: "complete" });
		const subscriptions = subscriptionClient();
		const recorded: Record<string, unknown>[] = [];
		let resolved = options.plan ?? proPlan;
		ctx.startPlanOnSavedCard = (setup, workerId) =>
			startPlanOnSavedCard(
				{
					client: subscriptions,
					repository: {
						getStripeRecurringCheckoutPlanByKey: async () => resolved,
						hasActiveBasePlan: async () => options.hasActiveBasePlan ?? false,
						recordPaymentSetupSubscriptionId: (input) =>
							ctx.store.recordPaymentSetupSubscriptionId(input),
						recordPaymentSetupPlanOutcome: (input) =>
							ctx.store.recordPaymentSetupPlanOutcome(input),
					},
					subscriptionCreateParams: (plan, quantities, setup) =>
						paymentSetupSubscriptionParams(plan, quantities, setup, "disabled"),
					recordSubscription: async (subscription) => {
						recorded.push(subscription);
					},
				},
				setup,
				workerId,
			);
		return {
			ctx,
			subscriptions,
			recorded,
			resolveAs(plan: StripeRecurringCheckoutPlan) {
				resolved = plan;
			},
		};
	}

	it("includes the plan version and quantities in the request hash", () => {
		expect(paymentSetupRequestHash(planRequest)).not.toBe(paymentSetupRequestHash(parameters));
		expect(paymentSetupRequestHash(planRequest)).not.toBe(
			paymentSetupRequestHash({
				...planRequest,
				plan: { planKey: "pro", planVersionId: "43", quantities: { seats: 5 } },
			}),
		);
	});

	it("keeps the plan on the normalized intent, prices it, and goes stale when the version changes", async () => {
		const drafts: CommercialPreviewDraft[] = [];
		let version = "42";
		let trialUsed = false;
		const service = new StripeBillingService({
			config: {
				checkoutSuccessUrl: "https://app.example.com/billing/success",
				checkoutCancelUrl: "https://app.example.com/billing",
				portalReturnUrl: "https://app.example.com/account/billing",
			},
			client: {} as StripeBillingServiceDependencies["client"],
			repository: {
				getStripeRecurringCheckoutPlanByKey: async () => ({
					...proPlan,
					planVersionId: version,
					trialUsed,
				}),
				hasActiveBasePlan: async () => false,
				createCommercialActionPreview: async (draft: CommercialPreviewDraft) => {
					drafts.push(draft);
					return {
						...draft.preview,
						previewToken: previewToken,
						expiresAt: "2026-09-22T10:15:00.000Z",
					};
				},
				getCommercialActionPreview: async () => {
					throw new Error("unread");
				},
				beginCommercialActionExecution: async () => {
					throw new Error("unexecuted");
				},
				completeCommercialActionExecution: async () => {
					throw new Error("unexecuted");
				},
			} as unknown as StripeBillingServiceDependencies["repository"],
		});
		const intent = {
			kind: "setup_payment" as const,
			currency: "usd",
			plan: { planKey: "pro", quantities: { seats: 5 } },
		};
		const preview = await service.previewCommercialAction({ billingAccountId: "acct_1", intent });
		expect(drafts[0]?.intent).toMatchObject({
			kind: "setup_payment",
			plan: { planKey: "pro", quantities: { seats: 5 } },
		});
		expect(preview).toMatchObject({
			estimatedTotalMinor: 1999,
			toPlanVersionId: "42",
			paymentSetup: {
				plan: { planKey: "pro", planVersionId: "42", trialDays: 14, startsAfterSetup: true },
			},
		});
		expect(preview.lineItems).toHaveLength(2);
		const firstFingerprint = preview.stateFingerprint;
		version = "43";
		const changed = await service.previewCommercialAction({ billingAccountId: "acct_1", intent });
		expect(changed.stateFingerprint).not.toBe(firstFingerprint);
		trialUsed = true;
		const skipped = await service.previewCommercialAction({ billingAccountId: "acct_1", intent });
		expect(skipped.stateFingerprint).not.toBe(changed.stateFingerprint);
		expect(skipped.paymentSetup?.plan).toMatchObject({ trialDays: null });
		expect(skipped.warnings).toContain(
			"This account already had a trial of the plan; the subscription starts without one.",
		);
		await expect(
			service.previewCommercialAction({
				billingAccountId: "acct_1",
				intent: {
					kind: "setup_payment",
					currency: "eur",
					plan: { planKey: "pro", quantities: {} },
				},
			}),
		).rejects.toMatchObject({
			code: "INVALID_REQUEST",
			status: 400,
			details: { currency: "eur", planCurrency: "usd" },
		});
	});

	it("creates the subscription with the saved card, trial and setup idempotency key", async () => {
		const { ctx, subscriptions, recorded } = planSetup();
		const creation = await create(ctx, { parameters: planRequest });
		expect(
			await reconcilePaymentSetup(ctx, {
				setupId: creation.setupId,
				workerId: "worker-a",
				attempts: 0,
			}),
		).toEqual({ status: "processed" });
		const setup = ctx.store.only();
		expect(setup.status).toBe("completed");
		expect(setup.plan_status).toBe("started");
		expect(subscriptions.creates[0]?.idempotencyKey).toBe(paymentSetupPlanIdempotencyKey(setup.id));
		expect(subscriptions.creates[0]?.params).toMatchObject({
			customer: "cus_1",
			payment_behavior: "error_if_incomplete",
			off_session: true,
			proration_behavior: "none",
			trial_period_days: 14,
			items: [
				{ price: "price_pro", quantity: 1 },
				{ price: "price_seats", quantity: 5 },
			],
			metadata: { quotumPaymentSetupId: setup.id, planKey: "pro", planVersionId: "42" },
		});
		expect(recorded).toHaveLength(1);
		expect(setup.external_subscription_id).toBe("sub_1");
		expect(
			paymentSetupSubscriptionParams(
				{ ...proPlan, trialUsed: true },
				{ seats: 5 },
				{ id: setup.id, billing_account_id: "acct_1", provider_customer_id: "cus_1" },
				"disabled",
			).trial_period_days,
		).toBeUndefined();
	});

	it("records plan_changed when the active version moved", async () => {
		const { ctx, subscriptions, resolveAs } = planSetup();
		const creation = await create(ctx, { parameters: planRequest });
		resolveAs({ ...proPlan, planVersionId: "99" });
		await reconcilePaymentSetup(ctx, {
			setupId: creation.setupId,
			workerId: "worker-a",
			attempts: 0,
		});
		expect(ctx.store.only()).toMatchObject({
			status: "completed",
			plan_status: "plan_changed",
			external_subscription_id: null,
		});
		expect(subscriptions.creates).toHaveLength(0);
	});

	it("records not_eligible for an add-on without a base plan and for a second base plan", async () => {
		const addon = planSetup({ plan: { ...proPlan, kind: "addon" } });
		const addonCreation = await create(addon.ctx, { parameters: planRequest });
		await reconcilePaymentSetup(addon.ctx, {
			setupId: addonCreation.setupId,
			workerId: "worker-a",
			attempts: 0,
		});
		expect(addon.ctx.store.only()).toMatchObject({
			status: "completed",
			plan_status: "not_eligible",
			plan_failure_code: "ADDON_REQUIRES_BASE_PLAN",
		});

		const secondBase = planSetup({ hasActiveBasePlan: true });
		const secondCreation = await create(secondBase.ctx, {
			parameters: planRequest,
			previewToken: otherPreviewToken,
		});
		await reconcilePaymentSetup(secondBase.ctx, {
			setupId: secondCreation.setupId,
			workerId: "worker-a",
			attempts: 0,
		});
		expect(secondBase.ctx.store.only()).toMatchObject({
			plan_status: "not_eligible",
			plan_failure_code: "BASE_PLAN_ALREADY_ACTIVE",
		});
	});

	it.each(["card_declined", "authentication_required"] as const)(
		"completes the setup and releases the slot on a 402 %s",
		async (code) => {
			const { ctx, subscriptions } = planSetup();
			const creation = await create(ctx, { parameters: planRequest });
			subscriptions.failNext(Object.assign(new Error("card failed"), { statusCode: 402, code }));
			expect(
				await reconcilePaymentSetup(ctx, {
					setupId: creation.setupId,
					workerId: "worker-a",
					attempts: 0,
				}),
			).toEqual({ status: "processed" });
			expect(ctx.store.only()).toMatchObject({
				status: "completed",
				plan_status: "payment_failed",
				plan_failure_code: code,
			});
			expect(await ctx.store.findActivePaymentSetup(planRequest)).toBeNull();
			expect(subscriptions.creates).toHaveLength(0);
		},
	);

	it("adopts the subscription a lost create response already made", async () => {
		const { ctx, subscriptions, recorded } = planSetup();
		const creation = await create(ctx, { parameters: planRequest });
		subscriptions.loseNextResponse();
		expect(
			(
				await reconcilePaymentSetup(ctx, {
					setupId: creation.setupId,
					workerId: "worker-a",
					attempts: 0,
				})
			).status,
		).toBe("retryable");
		expect(ctx.store.only().status).toBe("applying_default");
		expect(
			await reconcilePaymentSetup(ctx, {
				setupId: creation.setupId,
				workerId: "worker-a",
				attempts: 1,
			}),
		).toEqual({ status: "processed" });
		expect(subscriptions.creates).toHaveLength(1);
		expect(recorded).toHaveLength(1);
		expect(ctx.store.only()).toMatchObject({ status: "completed", plan_status: "started" });
	});

	it.each(["active_base", "version", "currency"] as const)(
		"recovers a lost create response after %s changes",
		async (change) => {
			const options = { hasActiveBasePlan: false };
			const { ctx, subscriptions, recorded, resolveAs } = planSetup(options);
			const creation = await create(ctx, { parameters: planRequest });
			const input = { setupId: creation.setupId, workerId: "worker-a", attempts: 0 };
			subscriptions.loseNextResponse();
			expect(await reconcilePaymentSetup(ctx, input)).toEqual({
				status: "retryable",
				reason: "response lost",
			});
			if (change === "active_base") options.hasActiveBasePlan = true;
			if (change === "version") resolveAs({ ...proPlan, planVersionId: "99" });
			if (change === "currency")
				resolveAs({
					...proPlan,
					components: proPlan.components.map((component) => ({ ...component, currency: "eur" })),
				});
			expect(await reconcilePaymentSetup(ctx, { ...input, attempts: 1 })).toEqual({
				status: "processed",
			});
			expect(subscriptions.creates).toHaveLength(1);
			expect(recorded).toHaveLength(1);
			expect(ctx.store.only()).toMatchObject({
				status: "completed",
				plan_status: "started",
				external_subscription_id: "sub_1",
			});
		},
	);

	it.each(["subscription_id", "outcome"] as const)(
		"retries a post-create INVALID_REQUEST while recording %s",
		async (stage) => {
			const options = { hasActiveBasePlan: false };
			const { ctx, subscriptions, recorded, resolveAs } = planSetup(options);
			const creation = await create(ctx, { parameters: planRequest });
			const input = { setupId: creation.setupId, workerId: "worker-a", attempts: 0 };
			const method =
				stage === "subscription_id"
					? "recordPaymentSetupSubscriptionId"
					: "recordPaymentSetupPlanOutcome";
			const failure = spyOn(ctx.store, method).mockImplementationOnce(async () => {
				throw new BillingError("local persistence failed", "INVALID_REQUEST", 400);
			});
			try {
				expect(await reconcilePaymentSetup(ctx, input)).toEqual({
					status: "retryable",
					reason: "local persistence failed",
				});
				expect(ctx.store.only()).toMatchObject({
					status: "applying_default",
					plan_status: "pending",
				});
				expect(subscriptions.creates).toHaveLength(1);
				// A webhook or the first attempt has now stored the subscription locally.
				options.hasActiveBasePlan = true;
				resolveAs({ ...proPlan, planVersionId: "99" });
				expect(await reconcilePaymentSetup(ctx, { ...input, attempts: 1 })).toEqual({
					status: "processed",
				});
				expect(ctx.store.only()).toMatchObject({
					status: "completed",
					plan_status: "started",
					external_subscription_id: "sub_1",
				});
				expect(subscriptions.creates).toHaveLength(1);
				expect(recorded.length).toBe(stage === "outcome" ? 2 : 1);
			} finally {
				failure.mockRestore();
			}
		},
	);

	it("retries subscription recording errors on both creation and recovery", async () => {
		const { ctx, subscriptions, recorded } = planSetup();
		const creation = await create(ctx, { parameters: planRequest });
		const input = { setupId: creation.setupId, workerId: "worker-a", attempts: 0 };
		const failure = spyOn(recorded, "push").mockImplementation(() => {
			throw new BillingError("subscription normalization failed", "INVALID_REQUEST", 400);
		});
		try {
			for (const attempts of [0, 1]) {
				expect(await reconcilePaymentSetup(ctx, { ...input, attempts })).toEqual({
					status: "retryable",
					reason: "subscription normalization failed",
				});
				expect(ctx.store.only()).toMatchObject({
					status: "applying_default",
					plan_status: "pending",
					external_subscription_id: "sub_1",
				});
			}
		} finally {
			failure.mockRestore();
		}
		expect(await reconcilePaymentSetup(ctx, { ...input, attempts: 2 })).toEqual({
			status: "processed",
		});
		expect(ctx.store.only()).toMatchObject({ status: "completed", plan_status: "started" });
		expect(subscriptions.creates).toHaveLength(1);
		expect(recorded).toHaveLength(1);
	});

	it("leaves a setup without a plan unchanged", async () => {
		const ctx = context({ sessionStatus: "complete" });
		ctx.startPlanOnSavedCard = () => {
			throw new Error("a card-only setup must not start a plan");
		};
		const creation = await create(ctx);
		expect(
			await reconcilePaymentSetup(ctx, {
				setupId: creation.setupId,
				workerId: "worker-a",
				attempts: 0,
			}),
		).toEqual({ status: "processed" });
		expect(ctx.store.only()).toMatchObject({ status: "completed", plan_status: null });
	});
});
