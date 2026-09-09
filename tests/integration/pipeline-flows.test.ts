import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { EntitlementSnapshot } from "../../src/billing/types";
import { BillingAdminOperations } from "../../src/operations/admin";
import { StripeBillingService } from "../../src/providers/stripe/service";
import { StoreEventReplayWorker } from "../../src/workers/store-event-replay";
import { createLocalProjectionReceiver } from "../helpers/projection-receiver";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { expectProjectionJob, expectStoreEvent } from "./helpers/db-assertions";
import {
	stripeCheckoutSessionObject,
	stripeEvent,
	stripeRefundObject,
} from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { runProjectionWorkerOnce } from "./helpers/worker-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("Pipeline flows integration", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("delivers an Apple verification projection through a real receiver", async () => {
		const receiver = createLocalProjectionReceiver({ secret: "voysee-projection-secret" });
		const env = withProjectionUrls(context.env, { voysee: receiver.url });

		try {
			const fixture = createIntegrationApp({ env, repository: context.repository });
			await createAppleAccountToken(fixture);
			const verifyResponse = await verifyAppleSubscription(fixture);
			expect(verifyResponse.status).toBe(200);
			await expectProjectionJob(context.sql, {
				billingAccountId: "integration_user",
				reason: "purchase_verified",
				status: "pending",
			});

			const result = await runProjectionWorkerOnce({ env, repository: context.repository });
			await receiver.waitForRequests(1, 1000);

			expect(result).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
			expect(receiver.requests).toHaveLength(1);
			expect(receiver.requests[0]).toMatchObject({ bearerOk: true, signatureOk: true });
			expect(receiver.requests[0].body).toMatchObject({
				projectKey: "voysee",
				billingAccountId: "integration_user",
				reason: "purchase_verified",
				entitlements: {
					entitlements: [
						expect.objectContaining({
							key: "premium",
							active: true,
						}),
					],
				},
			});
			const succeededJob = await expectProjectionJob(context.sql, {
				billingAccountId: "integration_user",
				reason: "purchase_verified",
				status: "succeeded",
			});
			expect(succeededJob.locked_at).toBeNull();
			expect(succeededJob.locked_by).toBeNull();

			const entitlements = await fixture.app.request(
				"/v1/billing-accounts/integration_user/entitlements",
				{ headers: fixture.authHeaders("voysee") },
			);
			expect(entitlements.status).toBe(200);
			expectActivePremiumSnapshot((await entitlements.json()).data, "integration_user", {
				provider: "apple",
				channel: "ios",
			});
		} finally {
			receiver.stop();
		}
	});

	it("delivers Stripe checkout and refund projections with distinct idempotency keys", async () => {
		const receiver = createLocalProjectionReceiver({ secret: "voysee-projection-secret" });
		const env = withProjectionUrls(context.env, { voysee: receiver.url });

		try {
			const checkout = createIntegrationApp({
				env,
				repository: context.repository,
				stripeEvent: stripeEvent(
					"checkout.session.completed",
					stripeCheckoutSessionObject(),
					"evt_checkout",
				),
			});
			const checkoutResponse = await postStripeWebhook(checkout, { id: "evt_checkout" });
			expect(checkoutResponse.status).toBe(200);

			const checkoutRun = await runProjectionWorkerOnce({ env, repository: context.repository });
			await receiver.waitForRequests(1, 1000);
			expect(checkoutRun).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
			expect(receiver.requests[0].body).toMatchObject({
				idempotencyKey: "stripe:payment:pi_integration:projection",
				purchase: expect.objectContaining({
					productKey: "echo_credits_10",
					creditAmount: 10,
				}),
			});

			const refund = createIntegrationApp({
				env,
				repository: context.repository,
				stripeEvent: stripeEvent("refund.created", stripeRefundObject(), "evt_refund"),
			});
			const refundResponse = await postStripeWebhook(refund, { id: "evt_refund" });
			expect(refundResponse.status).toBe(200);

			const refundRun = await runProjectionWorkerOnce({ env, repository: context.repository });
			await receiver.waitForRequests(2, 1000);
			expect(refundRun).toEqual({ claimed: 1, succeeded: 1, failed: 0 });
			expect(receiver.requests[1].body).toMatchObject({
				idempotencyKey: "stripe:refund:re_integration:reversal",
				reversal: expect.objectContaining({
					reason: "refund",
					productKey: "echo_credits_10",
					creditAmount: 10,
				}),
			});
			expect(new Set(receiver.requests.map((request) => request.body.idempotencyKey))).toEqual(
				new Set([
					"stripe:payment:pi_integration:projection",
					"stripe:refund:re_integration:reversal",
				]),
			);
		} finally {
			receiver.stop();
		}
	});

	it("replays a skipped Stripe refund event and delivers its projection", async () => {
		const receiver = createLocalProjectionReceiver({ secret: "voysee-projection-secret" });
		const env = withProjectionUrls(context.env, { voysee: receiver.url });

		try {
			const skippedRefund = createIntegrationApp({
				env,
				repository: context.repository,
				stripeEvent: stripeEvent("refund.created", stripeRefundObject(), "evt_refund"),
			});
			const skippedRefundResponse = await postStripeWebhook(skippedRefund, { id: "evt_refund" });
			expect(skippedRefundResponse.status).toBe(200);
			const skipped = await expectStoreEvent(context.sql, {
				provider: "stripe",
				eventType: "refund.created",
				status: "skipped",
			});

			const checkout = createIntegrationApp({
				env,
				repository: context.repository,
				stripeEvent: stripeEvent(
					"checkout.session.completed",
					stripeCheckoutSessionObject(),
					"evt_checkout",
				),
			});
			const checkoutResponse = await postStripeWebhook(checkout, { id: "evt_checkout" });
			expect(checkoutResponse.status).toBe(200);

			const replayApp = createIntegrationApp({
				env,
				repository: context.repository,
				adminOperations: createStripeReplayAdminOperations(env),
			});
			const replay = await replayApp.app.request(`/v1/admin/store-events/${skipped.id}/replay`, {
				method: "POST",
				headers: operatorHeaders(replayApp),
			});
			expect(replay.status).toBe(200);
			expect(await replay.json()).toEqual({
				success: true,
				data: { eventId: skipped.id, status: "processed" },
			});

			const run = await runProjectionWorkerOnce({ env, repository: context.repository });
			await receiver.waitForRequests(2, 1000);

			expect(run).toEqual({ claimed: 2, succeeded: 2, failed: 0 });
			expect(receiver.requests.map((request) => request.body.idempotencyKey)).toContain(
				"stripe:refund:re_integration:reversal",
			);
		} finally {
			receiver.stop();
		}
	});

	it("routes projections to each project receiver with project-specific signatures", async () => {
		const voyseeReceiver = createLocalProjectionReceiver({ secret: "voysee-projection-secret" });
		const wiseleyReceiver = createLocalProjectionReceiver({ secret: "wiseley-projection-secret" });
		const env = withProjectionUrls(context.env, {
			voysee: voyseeReceiver.url,
			wiseley: wiseleyReceiver.url,
		});

		try {
			const fixture = createIntegrationApp({
				env,
				repository: context.repository,
			});
			await createGoogleConsumable(fixture, "voysee", "integration_user", "voysee_purchase_token");
			await createGoogleConsumable(
				fixture,
				"wiseley",
				"integration_user",
				"wiseley_purchase_token",
			);

			const result = await runProjectionWorkerOnce({ env, repository: context.repository });
			await voyseeReceiver.waitForRequests(1, 1000);
			await wiseleyReceiver.waitForRequests(1, 1000);

			expect(result).toEqual({ claimed: 2, succeeded: 2, failed: 0 });
			expect(voyseeReceiver.requests).toHaveLength(1);
			expect(wiseleyReceiver.requests).toHaveLength(1);
			expect(voyseeReceiver.requests[0]).toMatchObject({
				bearerOk: true,
				signatureOk: true,
			});
			expect(wiseleyReceiver.requests[0]).toMatchObject({
				bearerOk: true,
				signatureOk: true,
			});
			expect(voyseeReceiver.requests[0].body.projectKey).toBe("voysee");
			expect(voyseeReceiver.requests[0].body.billingAccountId).toBe("integration_user");
			expect(wiseleyReceiver.requests[0].body.projectKey).toBe("wiseley");
			expect(wiseleyReceiver.requests[0].body.billingAccountId).toBe("integration_user");
		} finally {
			voyseeReceiver.stop();
			wiseleyReceiver.stop();
		}
	});
});

function withProjectionUrls(
	env: LocalPostgresContext["env"],
	urls: Partial<Record<"voysee" | "wiseley", string>>,
): LocalPostgresContext["env"] {
	return {
		...env,
		connectionFixtures: env.connectionFixtures.map((project) => {
			const projectionUrl = urls[project.projectInstanceKey as "voysee" | "wiseley"];
			return projectionUrl === undefined ? project : { ...project, projectionUrl };
		}),
	};
}

async function createAppleAccountToken(
	fixture: ReturnType<typeof createIntegrationApp>,
): Promise<void> {
	const response = await fixture.app.request(
		"/v1/billing-accounts/integration_user/providers/apple/account-token",
		{ headers: fixture.authHeaders("voysee") },
	);
	const body = await response.json();
	expect(response.status).toBe(200);
	fixture.apple.setAppAccountToken(body.data.appAccountToken);
}

async function verifyAppleSubscription(
	fixture: ReturnType<typeof createIntegrationApp>,
): Promise<Response> {
	return await fixture.app.request("/v1/purchases/verify", {
		method: "POST",
		headers: {
			...fixture.authHeaders("voysee"),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			provider: "apple",
			billingAccountId: "integration_user",
			transactionId: "200000000000001",
		}),
	});
}

async function postStripeWebhook(
	fixture: ReturnType<typeof createIntegrationApp>,
	body: Record<string, unknown>,
	projectKey = "voysee",
): Promise<Response> {
	return await fixture.app.request(`/v1/projects/${projectKey}/webhooks/stripe`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"stripe-signature": "sig_test",
		},
		body: JSON.stringify(body),
	});
}

async function createGoogleConsumable(
	fixture: ReturnType<typeof createIntegrationApp>,
	projectKey: "voysee" | "wiseley",
	billingAccountId: string,
	purchaseToken: string,
): Promise<void> {
	const link = await fixture.app.request(
		`/v1/billing-accounts/${billingAccountId}/providers/google/account-link`,
		{
			headers: fixture.authHeaders(projectKey),
		},
	);
	expect(link.status).toBe(200);

	const response = await fixture.app.request("/v1/purchases/verify", {
		method: "POST",
		headers: {
			...fixture.authHeaders(projectKey),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			provider: "google",
			billingAccountId,
			purchaseKind: "consumable",
			purchaseToken,
			productId: "echo_credits_10",
		}),
	});
	expect(response.status).toBe(200);
}

function operatorHeaders(fixture: ReturnType<typeof createIntegrationApp>): HeadersInit {
	return {
		...fixture.authHeaders("voysee"),
		"x-billing-operator-key": context.env.operatorApiKey ?? "",
	};
}

function createStripeReplayAdminOperations(
	env: LocalPostgresContext["env"],
): BillingAdminOperations {
	return new BillingAdminOperations({
		replayWorker: new StoreEventReplayWorker({
			workerId: "integration-admin-operator",
			maxAttempts: env.storeEventReplayMaxAttempts,
			batchSize: 25,
			repository: context.repository,
			projectContextResolver: context.projectContextResolver,
			providers: (project) => ({
				apple: null,
				google: null,
				stripe: new StripeBillingService({
					config: stripeConfig(),
					client: replayOnlyStripeClient(),
					repository: context.repository.forProject(project),
				}),
			}),
			now: () => new Date(),
			jitterMs: () => 0,
		}),
		reconciliationWorker: {
			runOnce() {
				throw new Error("Unexpected reconciliation run");
			},
		},
	});
}

function stripeConfig() {
	return {
		checkoutSuccessUrl:
			"https://app.integration.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
		checkoutCancelUrl: "https://app.integration.test/billing",
		portalReturnUrl: "https://app.integration.test/account/billing",
	};
}

function replayOnlyStripeClient() {
	return {
		async createCustomer() {
			throw new Error("Unexpected Stripe customer creation");
		},
		async createCheckoutSession() {
			throw new Error("Unexpected Stripe checkout creation");
		},
		async createPortalSession() {
			throw new Error("Unexpected Stripe portal creation");
		},
		async retrieveCheckoutSession() {
			throw new Error("Unexpected Stripe checkout retrieval");
		},
		constructWebhookEvent() {
			throw new Error("Unexpected Stripe signature verification");
		},
		async retrieveSubscription() {
			throw new Error("Unexpected Stripe subscription retrieval");
		},
	};
}

function expectActivePremiumSnapshot(
	snapshot: EntitlementSnapshot,
	billingAccountId: string,
	expected: { provider: string; channel: string },
): void {
	expect(snapshot.billingAccountId).toBe(billingAccountId);
	expect(snapshot.generatedAt).toEqual(expect.any(String));
	expect(snapshot.entitlements).toHaveLength(1);
	expect(snapshot.entitlements[0]).toEqual({
		key: "premium",
		active: true,
		expiresAt: "2099-06-30T00:00:00.000Z",
		metadata: expect.objectContaining({
			channel: expected.channel,
			provider: expected.provider,
			source: "subscription",
			status: "active",
		}),
	});
}
