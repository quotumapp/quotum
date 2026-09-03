import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { createLocalProjectionReceiver } from "../helpers/projection-receiver";
import { resetAndSeedIntegrationData } from "../integration/helpers/catalog-fixtures";
import {
	stripeCheckoutSessionObject,
	stripeEvent,
	stripeRefundObject,
} from "../integration/helpers/fake-provider-clients";
import { makeProjectionJobDue } from "../integration/helpers/job-time-travel";
import { e2eApiKey, e2eOperatorKey, e2eServiceEnv, signStripeWebhook } from "./helpers/e2e-env";
import { describeE2e } from "./helpers/gating";
import { type BillingServiceProcess, startBillingService } from "./helpers/service-process";

const e2eDescribe = describeE2e(describe, describe.skip);
let service: BillingServiceProcess | undefined;
let sql: SQL | undefined;
let receiver: ReturnType<typeof createLocalProjectionReceiver> | undefined;

e2eDescribe("E2E pipeline", () => {
	beforeEach(async () => {
		const postgresUri = process.env.POSTGRES_URI;
		if (postgresUri === undefined || postgresUri.trim() === "") {
			throw new Error("POSTGRES_URI is required for E2E tests");
		}

		sql = new SQL(postgresUri, { max: 2, idleTimeout: 1, maxLifetime: 0 });
		await resetAndSeedIntegrationData(sql);
		receiver = createLocalProjectionReceiver({ secret: "voysee-e2e-projection-secret" });
		service = await startBillingService(
			e2eServiceEnv({
				postgresUri,
				receiverUrl: receiver.url,
				overrides: { BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS: "3600000" },
			}),
		);
	});

	afterEach(async () => {
		await service?.stop();
		service = undefined;
		receiver?.stop();
		receiver = undefined;
		await sql?.close();
		sql = undefined;
	});

	it("processes a signed Stripe checkout webhook and delivers a credit projection", async () => {
		const projectionReceiver = requireReceiver();
		const response = await postSignedStripeWebhook(
			stripeEvent(
				"checkout.session.completed",
				checkoutSession({
					sessionId: "cs_e2e_checkout",
					paymentIntentId: "pi_e2e_checkout",
					chargeId: "ch_e2e_checkout",
				}),
				"evt_e2e_checkout",
			),
		);
		expect(response.status).toBe(200);

		await projectionReceiver.waitForRequests(1, 5000);
		expect(projectionReceiver.requests[0]).toMatchObject({
			bearerOk: true,
			signatureOk: true,
		});
		expect(projectionReceiver.requests[0].body).toMatchObject({
			projectKey: "voysee",
			idempotencyKey: "stripe:payment:pi_e2e_checkout:projection",
			purchase: expect.objectContaining({
				productKey: "echo_credits_10",
				creditAmount: 10,
			}),
		});

		const entitlements = await requireService().request(
			"/v1/billing-accounts/integration_user/entitlements",
			{
				headers: authHeaders(),
			},
		);
		expect(entitlements.status).toBe(200);
		expect((await entitlements.json()).data).toMatchObject({
			billingAccountId: "integration_user",
			entitlements: [],
		});
	});

	it("processes a signed Stripe refund webhook and delivers a reversal projection", async () => {
		const checkout = await postSignedStripeWebhook(
			stripeEvent(
				"checkout.session.completed",
				checkoutSession({
					sessionId: "cs_e2e_refund_checkout",
					paymentIntentId: "pi_e2e_refund_checkout",
					chargeId: "ch_e2e_refund_checkout",
				}),
				"evt_e2e_refund_checkout",
			),
		);
		expect(checkout.status).toBe(200);
		await waitForProjection("stripe:payment:pi_e2e_refund_checkout:projection");

		const response = await postSignedStripeWebhook(
			stripeEvent(
				"refund.created",
				refundObject({
					refundId: "re_e2e_refund",
					paymentIntentId: "pi_e2e_refund_checkout",
					chargeId: "ch_e2e_refund_checkout",
				}),
				"evt_e2e_refund",
			),
		);
		expect(response.status).toBe(200);

		await waitForProjection("stripe:refund:re_e2e_refund:reversal");
		expect(
			requireReceiver().requests.find(
				(request) => request.body.idempotencyKey === "stripe:refund:re_e2e_refund:reversal",
			)?.body,
		).toMatchObject({
			reversal: expect.objectContaining({
				reason: "refund",
				productKey: "echo_credits_10",
				creditAmount: 10,
			}),
		});
	});

	it("retries failed delivery with the same idempotency key", async () => {
		requireReceiver().queueResponses({ status: 503, body: { success: false } });
		const idempotencyKey = "stripe:payment:pi_e2e_retry:projection";
		const response = await postSignedStripeWebhook(
			stripeEvent(
				"checkout.session.completed",
				checkoutSession({
					sessionId: "cs_e2e_retry",
					paymentIntentId: "pi_e2e_retry",
					chargeId: "ch_e2e_retry",
				}),
				"evt_e2e_retry",
			),
		);
		expect(response.status).toBe(200);

		await waitForProjectionAttempt(idempotencyKey, 1);
		const job = await projectionJobByKey(idempotencyKey);
		expect(job.status).toBe("pending");
		expect(job.attempts).toBe(1);
		await makeProjectionJobDue(requireSql(), job.id);

		await waitForProjection(idempotencyKey, 2);
		const delivered = requireReceiver().requests.filter(
			(request) => request.body.idempotencyKey === idempotencyKey,
		);
		expect(delivered).toHaveLength(2);
		expect(new Set(delivered.map((request) => request.body.jobId))).toEqual(new Set([job.id]));
	});

	it("replays a skipped refund through the real admin route", async () => {
		const idempotencyKey = "stripe:refund:re_e2e_replay:reversal";
		const refund = await postSignedStripeWebhook(
			stripeEvent(
				"refund.created",
				refundObject({
					refundId: "re_e2e_replay",
					paymentIntentId: "pi_e2e_replay",
					chargeId: "ch_e2e_replay",
				}),
				"evt_e2e_replay_refund",
			),
		);
		expect(refund.status).toBe(200);

		const checkout = await postSignedStripeWebhook(
			stripeEvent(
				"checkout.session.completed",
				checkoutSession({
					sessionId: "cs_e2e_replay",
					paymentIntentId: "pi_e2e_replay",
					chargeId: "ch_e2e_replay",
				}),
				"evt_e2e_replay_checkout",
			),
		);
		expect(checkout.status).toBe(200);

		const skippedEventId = await skippedRefundEventId("evt_e2e_replay_refund");
		const list = await requireService().request(
			"/v1/admin/store-events?provider=stripe&processingStatus=skipped&eventType=refund.created&limit=10",
			{ headers: authHeaders() },
		);
		expect(list.status).toBe(200);
		expect((await list.json()).data.map((event: { id: string }) => event.id)).toContain(
			skippedEventId,
		);

		const replay = await requireService().request(
			`/v1/admin/store-events/${skippedEventId}/replay`,
			{
				method: "POST",
				headers: { ...authHeaders(), "x-billing-operator-key": e2eOperatorKey },
			},
		);
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({
			success: true,
			data: { eventId: skippedEventId, status: "processed" },
		});

		await waitForProjection(idempotencyKey);
		expect(
			requireReceiver().requests.find((request) => request.body.idempotencyKey === idempotencyKey)
				?.body,
		).toMatchObject({
			reversal: expect.objectContaining({ transactionId: "re_e2e_replay" }),
		});
	});
});

function authHeaders(): HeadersInit {
	return { authorization: `Bearer ${e2eApiKey}` };
}

async function postSignedStripeWebhook(event: Record<string, unknown>): Promise<Response> {
	const payload = JSON.stringify(event);
	return await requireService().request("/v1/projects/voysee/webhooks/stripe", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"stripe-signature": signStripeWebhook(payload),
		},
		body: payload,
	});
}

function checkoutSession(input: {
	sessionId: string;
	paymentIntentId: string;
	chargeId: string;
}): Record<string, unknown> {
	return stripeCheckoutSessionObject({
		id: input.sessionId,
		charge: input.chargeId,
		latest_charge: input.chargeId,
		payment_intent: {
			id: input.paymentIntentId,
			latest_charge: input.chargeId,
			metadata: { billingAccountId: "integration_user" },
		},
	});
}

function refundObject(input: {
	refundId: string;
	paymentIntentId: string;
	chargeId: string;
}): Record<string, unknown> {
	return stripeRefundObject({
		id: input.refundId,
		charge: input.chargeId,
		payment_intent: input.paymentIntentId,
	});
}

async function waitForProjection(idempotencyKey: string, count = 1): Promise<void> {
	await waitFor(async () => {
		const seen = requireReceiver().requests.filter(
			(request) => request.body.idempotencyKey === idempotencyKey,
		).length;
		return seen >= count;
	}, `projection ${idempotencyKey}`);
}

async function waitForProjectionAttempt(idempotencyKey: string, attempts: number): Promise<void> {
	await waitFor(async () => {
		const rows = await requireSql()<{ attempts: number }[]>`
			SELECT attempts
			FROM projection_sync_jobs
			WHERE idempotency_key = ${idempotencyKey}
		`;
		return rows[0]?.attempts === attempts;
	}, `projection attempt ${idempotencyKey}:${attempts}`);
}

async function projectionJobByKey(
	idempotencyKey: string,
): Promise<{ id: string; status: string; attempts: number }> {
	const rows = await requireSql()<{ id: string; status: string; attempts: number }[]>`
		SELECT id, status, attempts
		FROM projection_sync_jobs
		WHERE idempotency_key = ${idempotencyKey}
	`;
	expect(rows).toHaveLength(1);
	return rows[0];
}

async function skippedRefundEventId(externalEventId: string): Promise<string> {
	const rows = await requireSql()<{ id: string }[]>`
		SELECT id
		FROM store_events
		WHERE provider = 'stripe'
			AND event_type = 'refund.created'
			AND external_event_id = ${externalEventId}
			AND processing_status = 'skipped'
	`;
	expect(rows).toHaveLength(1);
	return rows[0].id;
}

function requireService(): BillingServiceProcess {
	if (service === undefined) {
		throw new Error("Billing service is not running");
	}
	return service;
}

function requireReceiver(): ReturnType<typeof createLocalProjectionReceiver> {
	if (receiver === undefined) {
		throw new Error("Projection receiver is not running");
	}
	return receiver;
}

function requireSql(): SQL {
	if (sql === undefined) {
		throw new Error("Postgres connection is not available");
	}
	return sql;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await predicate()) {
			return;
		}
		await Bun.sleep(100);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
