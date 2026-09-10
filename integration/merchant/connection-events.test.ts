import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import Stripe from "stripe";
import { createConnectionEventApp } from "../../src/composition/connection-events";
import { createStripeAppEvents } from "../../src/composition/stripe-app-events";
import { closePool } from "../../src/db/client";
import { StripeAppEvents } from "../../src/platform/connections/stripe-events";
import {
	createGoogleOidcTestKeys,
	createTestGoogleOidcVerifier,
	signGoogleOidcToken,
} from "../../tests/helpers/google-oidc";
import { withOpenApiAssertions } from "../../tests/helpers/openapi";
import {
	authorizeStripeApp,
	isolatedStripeOAuthPort,
	MerchantBrowser,
	merchantFixture,
	merchantTestScope,
	onboard,
	stripeCheckoutSettings,
	stubConnectionValidation,
	stubEnvironmentBilling,
} from "./fixture";

const f = merchantFixture({
	connectionValidation: stubConnectionValidation(),
	environmentBilling: stubEnvironmentBilling(() => f.sql),
});
const scope = merchantTestScope;
const oidc = createGoogleOidcTestKeys();
const googleVerifier = createTestGoogleOidcVerifier(oidc.kid, oidc.pem);

beforeEach(() => f.reset());
afterAll(async () => {
	await f.sql.close();
	await closePool();
});

describe("connection-event webhook verification", () => {
	it("accepts a valid Stripe event and rejects tamper, mode, account, lookup, and stale cases", async () => {
		const browser = new MerchantBrowser(f);
		await onboard(browser);
		const { projectKey, versionId } = await draftStripe(browser);
		const fetches: string[] = [];
		const event = stripeConnectionEvent();
		const { app, httpCalls } = connectionEventApp(fetches, event);
		const payload = JSON.stringify(event);
		const header = await stripeTestHeader(payload, "whsec_synthetic");

		const valid = await app.request(webhookPath(projectKey, versionId, "stripe"), {
			method: "POST",
			headers: { "content-type": "application/json", "stripe-signature": header },
			body: payload,
		});
		expect(valid.status).toBe(200);
		expect(await valid.json()).toEqual({ success: true });
		expect(httpCalls()).toEqual(["account", `events:${event.id}`]);
		const [verified] = await f.sql<
			{ event_verified_at: string | null; external_identity: string | null }[]
		>`SELECT event_verified_at::text, external_identity FROM platform_connection_versions WHERE id=${versionId}`;
		expect(verified.event_verified_at).not.toBeNull();
		expect(verified.external_identity).toBeNull();

		await f.sql`UPDATE platform_connection_versions SET event_verified_at=NULL WHERE id=${versionId}`;
		fetches.length = 0;
		const tamperedHeader = header.replace(/v1=([0-9a-f]+)$/i, (_match, hex: string) => {
			const last = hex.at(-1) ?? "0";
			return `v1=${hex.slice(0, -1)}${last === "0" ? "1" : "0"}`;
		});
		expect(
			(
				await app.request(webhookPath(projectKey, versionId, "stripe"), {
					method: "POST",
					headers: { "content-type": "application/json", "stripe-signature": tamperedHeader },
					body: payload,
				})
			).status,
		).toBe(400);
		expect(fetches).toEqual([]);

		const liveEvent = stripeConnectionEvent({ livemode: true });
		expect(
			(
				await postStripe(
					app,
					projectKey,
					versionId,
					liveEvent,
					await stripeTestHeader(JSON.stringify(liveEvent), "whsec_synthetic"),
				)
			).status,
		).toBe(400);

		const otherAccount = stripeConnectionEvent({ account: "acct_other" });
		expect(
			(
				await postStripe(
					app,
					projectKey,
					versionId,
					otherAccount,
					await stripeTestHeader(JSON.stringify(otherAccount), "whsec_synthetic"),
				)
			).status,
		).toBe(400);

		const mismatchApp = connectionEventApp(fetches, { ...event, id: "evt_other" }).app;
		expect(
			(
				await postStripe(
					mismatchApp,
					projectKey,
					versionId,
					event,
					await stripeTestHeader(payload, "whsec_synthetic"),
				)
			).status,
		).toBe(400);

		const stale = stripeConnectionEvent({ created: Math.floor(Date.now() / 1000) - 600 }); // keep for later debug
		expect(
			(
				await postStripe(
					app,
					projectKey,
					versionId,
					stale,
					await stripeTestHeader(JSON.stringify(stale), "whsec_synthetic"),
				)
			).status,
		).toBe(400);
		const [after] = await f.sql<
			{ event_verified_at: string | null }[]
		>`SELECT event_verified_at::text FROM platform_connection_versions WHERE id=${versionId}`;
		expect(after.event_verified_at).toBeNull();
	});

	it("returns 404 for unknown, mismatched, expired, and retired connection versions", async () => {
		const browser = new MerchantBrowser(f);
		await onboard(browser);
		const { projectKey, versionId } = await draftStripe(browser);
		const { app } = connectionEventApp([], stripeConnectionEvent());
		const payload = JSON.stringify(stripeConnectionEvent());
		const header = await stripeTestHeader(payload, "whsec_synthetic");
		expect(
			(await postStripe(app, projectKey, crypto.randomUUID(), stripeConnectionEvent(), header))
				.status,
		).toBe(400);
		expect(
			(await postStripe(app, projectKey, versionId, stripeConnectionEvent(), header, "apple"))
				.status,
		).toBe(404);
		expect(
			(await postStripe(app, "missing-project", versionId, stripeConnectionEvent(), header)).status,
		).toBe(404);
		await f.sql`UPDATE platform_connection_versions SET expires_at=now()-interval '1 second' WHERE id=${versionId}`;
		expect(
			(await postStripe(app, projectKey, versionId, stripeConnectionEvent(), header)).status,
		).toBe(404);
		await f.sql`UPDATE platform_connection_versions SET expires_at=now()+interval '1 day', status='retired' WHERE id=${versionId}`;
		expect(
			(await postStripe(app, projectKey, versionId, stripeConnectionEvent(), header)).status,
		).toBe(404);
	});

	it("rejects oversized Stripe bodies and missing webhook secrets", async () => {
		const browser = new MerchantBrowser(f);
		await onboard(browser);
		const { projectKey, versionId } = await draftStripe(browser);
		const { app } = connectionEventApp([], stripeConnectionEvent());
		const oversized = await app.request(webhookPath(projectKey, versionId, "stripe"), {
			method: "POST",
			headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=ab" },
			body: "x".repeat(256 * 1024 + 1),
		});
		expect(oversized.status).toBe(413);
		await f.sql`DELETE FROM platform_connection_secrets WHERE purpose='webhookSecret'`;
		const payload = JSON.stringify(stripeConnectionEvent());
		expect(
			(
				await postStripe(
					app,
					projectKey,
					versionId,
					stripeConnectionEvent(),
					await stripeTestHeader(payload, "whsec_synthetic"),
				)
			).status,
		).toBe(400);
	});

	it("verifies Google RTDN in-process and rejects a wrong audience", async () => {
		const browser = new MerchantBrowser(f);
		await onboard(browser);
		const { projectKey, versionId, audience } = await draftGoogle(browser);
		const { app } = connectionEventApp([]);
		const body = googlePushBody();
		const token = signGoogleOidcToken(oidc.keys.privateKey, googleClaims(audience), oidc.kid);
		const valid = await app.request(webhookPath(projectKey, versionId, "google"), {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify(body),
		});
		expect(valid.status).toBe(200);
		const [verified] = await f.sql<
			{ event_verified_at: string | null }[]
		>`SELECT event_verified_at::text FROM platform_connection_versions WHERE id=${versionId}`;
		expect(verified.event_verified_at).not.toBeNull();

		const wrong = signGoogleOidcToken(
			oidc.keys.privateKey,
			googleClaims("https://example.test/wrong-aud"),
			oidc.kid,
		);
		expect(
			(
				await app.request(webhookPath(projectKey, versionId, "google"), {
					method: "POST",
					headers: { "content-type": "application/json", authorization: `Bearer ${wrong}` },
					body: JSON.stringify(googlePushBody()),
				})
			).status,
		).toBe(400);
	});

	it("rejects Apple garbage payloads", async () => {
		const browser = new MerchantBrowser(f);
		await onboard(browser);
		const { projectKey, versionId } = await draftApple(browser);
		const { app } = connectionEventApp([]);
		expect(
			(
				await app.request(webhookPath(projectKey, versionId, "apple"), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ signedPayload: "garbage" }),
				})
			).status,
		).toBe(400);
	});
});

describe("Stripe App webhook verification", () => {
	it("deauthorizes, defers invoice.paid, and rejects bad signatures and unknown paths", async () => {
		const browser = new MerchantBrowser(f);
		await onboard(browser);
		const provider = isolatedStripeOAuthPort();
		await authorizeStripeApp(f, browser, provider, stubConnectionValidation());
		const events = createStripeAppEvents(f.connectionRepository, provider);
		const app = withOpenApiAssertions(events.app);

		const deauth = stripeAppEvent("account.application.deauthorized", "evt_deauth");
		expect((await postStripeApp(app, deauth, "test")).status).toBe(200);
		await events.runOnce();
		const [disabled] = await f.sql<
			{ enabled: boolean; revision: number }[]
		>`SELECT enabled, revision FROM platform_connections WHERE stripe_account_id='acct_isolated'`;
		expect(disabled).toEqual({ enabled: false, revision: 2 });
		const [processed] = await f.sql<
			{ processed_at: string | null }[]
		>`SELECT processed_at::text FROM platform_stripe_app_events WHERE event_id='evt_deauth'`;
		expect(processed.processed_at).not.toBeNull();

		const invoice = stripeAppEvent("invoice.paid", "evt_invoice");
		expect((await postStripeApp(app, invoice, "test")).status).toBe(200);
		await events.runOnce();
		const [deferred] = await f.sql<
			{ processed_at: string | null; next_attempt_at: string; event_verified_at: string | null }[]
		>`
			SELECT e.processed_at::text, e.next_attempt_at::text, v.event_verified_at::text
			FROM platform_stripe_app_events e
			JOIN platform_connections c ON c.stripe_account_id=e.account_id
			JOIN platform_connection_versions v ON v.id=c.active_version_id
			WHERE e.event_id='evt_invoice'
		`;
		expect(deferred.processed_at).toBeNull();
		expect(new Date(deferred.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
		expect(deferred.event_verified_at).not.toBeNull();

		const liveMismatch = stripeAppEvent("invoice.paid", "evt_live", { livemode: false });
		expect((await postStripeApp(app, liveMismatch, "live")).status).toBe(400);
		const missingAccount = { ...stripeAppEvent("invoice.paid", "evt_no_acct"), account: undefined };
		expect((await postStripeApp(app, missingAccount, "test")).status).toBe(400);
		const tampered = stripeAppEvent("invoice.paid", "evt_tamper");
		const tamperedHeader = (
			await stripeTestHeader(JSON.stringify(tampered), "whsec_app_synthetic")
		).replace(
			/v1=([0-9a-f]+)$/i,
			(_match, hex: string) => `v1=${hex.slice(0, -1)}${hex.at(-1) === "0" ? "1" : "0"}`,
		);
		expect(
			(
				await app.request("/v1/stripe-app/webhooks/test", {
					method: "POST",
					headers: { "content-type": "application/json", "stripe-signature": tamperedHeader },
					body: JSON.stringify(tampered),
				})
			).status,
		).toBe(400);

		const unknown = stripeAppEvent("invoice.paid", "evt_unknown", { account: "acct_unknown" });
		expect((await postStripeApp(app, unknown, "test")).status).toBe(200);
		expect(await new StripeAppEvents(f.sql).pending()).toEqual([]);

		expect((await postStripeApp(app, invoice, "test")).status).toBe(200);
		expect(
			await f.sql`SELECT event_id FROM platform_stripe_app_events WHERE event_id='evt_invoice'`,
		).toHaveLength(1);

		const oversized = await app.request("/v1/stripe-app/webhooks/test", {
			method: "POST",
			headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=ab" },
			body: "x".repeat(256 * 1024 + 1),
		});
		expect(oversized.status).toBe(413);
		expect(
			(await app.request("/v1/stripe-app/webhooks/bogus", { method: "POST", body: "{}" })).status,
		).toBe(400);
	});
});

function connectionEventApp(fetches: string[], canonicalEvent: Record<string, unknown> = {}) {
	const httpCalls: string[] = [];
	const fakeFetch = Object.assign(
		async (input: URL | RequestInfo) => {
			const url = String(input);
			fetches.push(url);
			if (url.includes("/v1/account")) {
				httpCalls.push("account");
				return Response.json({ id: "acct_synthetic", object: "account" });
			}
			if (url.includes("/v1/events")) {
				const id = url.split("/v1/events/")[1]?.split(/[?#]/)[0] ?? canonicalEvent.id;
				httpCalls.push(`events:${id}`);
				return Response.json(canonicalEvent);
			}
			return Response.json({ error: { message: `unexpected ${url}` } }, { status: 500 });
		},
		{ preconnect: fetch.preconnect },
	);
	return {
		app: withOpenApiAssertions(
			createConnectionEventApp(f.connectionRepository, {
				stripeHttpClient: Stripe.createFetchHttpClient(fakeFetch),
				googleOidcVerifier: googleVerifier,
			}),
		),
		httpCalls: () => [...httpCalls],
	};
}

async function draftStripe(browser: MerchantBrowser) {
	const draft = await browser.json<{ draftId: string }>("/api/platform/connections/stripe/drafts", {
		scope,
		expectedRevision: 0,
		settings: stripeCheckoutSettings,
		secrets: { secretKey: "rk_test_synthetic", webhookSecret: "whsec_synthetic" },
	});
	const [project] = await f.sql<
		{ key: string }[]
	>`SELECT key FROM projects WHERE environment='sandbox'`;
	return { projectKey: project.key, versionId: draft.draftId };
}

async function draftGoogle(browser: MerchantBrowser) {
	const audience = "https://merchant.example.test/google-rtdn";
	const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
	const draft = await browser.json<{ draftId: string }>("/api/platform/connections/google/drafts", {
		scope,
		expectedRevision: 0,
		settings: {
			packageName: "com.example.app",
			rtdnAudience: audience,
			rtdnServiceAccountEmail: "pubsub-push@example.iam.gserviceaccount.com",
			rtdnAuthorizedParty: "pubsub-push-client-id",
			enablePublisherMutations: false,
			serviceAccountKeyFile: null,
		},
		secrets: {
			serviceAccountJson: JSON.stringify({
				type: "service_account",
				private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
				client_email: "play-publisher@example.iam.gserviceaccount.com",
				token_uri: "https://oauth2.googleapis.com/token",
				universe_domain: "googleapis.com",
			}),
			obfuscatedAccountIdSecret: "account-link-secret",
		},
	});
	const [project] = await f.sql<
		{ key: string }[]
	>`SELECT key FROM projects WHERE environment='sandbox'`;
	return { projectKey: project.key, versionId: draft.draftId, audience };
}

async function draftApple(browser: MerchantBrowser) {
	const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const draft = await browser.json<{ draftId: string }>("/api/platform/connections/apple/drafts", {
		scope,
		expectedRevision: 0,
		settings: {
			bundleId: "com.example.app",
			appAppleId: null,
			issuerId: "issuer-id",
			keyId: "key-id",
			environment: "sandbox",
			enableOnlineChecks: true,
			rootCertificatesDir: null,
		},
		secrets: {
			privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		},
	});
	const [project] = await f.sql<
		{ key: string }[]
	>`SELECT key FROM projects WHERE environment='sandbox'`;
	return { projectKey: project.key, versionId: draft.draftId };
}

function webhookPath(projectKey: string, versionId: string, provider: string) {
	return `/v1/projects/${projectKey}/connections/${versionId}/webhooks/${provider}`;
}

function stripeConnectionEvent(overrides: Record<string, unknown> = {}) {
	return {
		id: "evt_conn_1",
		object: "event",
		api_version: "2026-01-28.clover",
		created: Math.floor(Date.now() / 1000) + 30,
		type: "customer.subscription.updated",
		livemode: false,
		pending_webhooks: 1,
		request: { id: null, idempotency_key: null },
		data: { object: {} },
		...overrides,
	};
}

function stripeAppEvent(type: string, id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		object: "event",
		api_version: "2026-01-28.clover",
		created: Math.floor(Date.now() / 1000) + 30,
		type,
		livemode: false,
		account: "acct_isolated",
		pending_webhooks: 1,
		request: { id: null, idempotency_key: null },
		data: { object: {} },
		...overrides,
	};
}

type TestApp = {
	request: (path: string, init?: RequestInit) => Response | Promise<Response>;
};

async function postStripe(
	app: TestApp,
	projectKey: string,
	versionId: string,
	event: Record<string, unknown>,
	header: string,
	provider = "stripe",
) {
	return await app.request(webhookPath(projectKey, versionId, provider), {
		method: "POST",
		headers: { "content-type": "application/json", "stripe-signature": header },
		body: JSON.stringify(event),
	});
}

async function postStripeApp(app: TestApp, event: Record<string, unknown>, mode: "test" | "live") {
	const payload = JSON.stringify(event);
	return await app.request(`/v1/stripe-app/webhooks/${mode}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"stripe-signature": await stripeTestHeader(payload, "whsec_app_synthetic"),
		},
		body: payload,
	});
}

function googlePushBody() {
	return {
		message: {
			data: Buffer.from(
				JSON.stringify({
					version: "1.0",
					packageName: "com.example.app",
					eventTimeMillis: String(Date.now()),
					testNotification: { version: "1.0" },
				}),
			).toString("base64"),
			messageId: "message_1",
		},
		subscription: "projects/test/subscriptions/google-rtdn",
	};
}

function googleClaims(aud: string) {
	const now = Math.floor(Date.now() / 1000);
	return {
		aud,
		email: "pubsub-push@example.iam.gserviceaccount.com",
		email_verified: true,
		iss: "https://accounts.google.com",
		azp: "pubsub-push-client-id",
		iat: now,
		exp: now + 3600,
	};
}

async function stripeTestHeader(payload: string, secret: string): Promise<string> {
	try {
		return Stripe.webhooks.generateTestHeaderString({ payload, secret });
	} catch {
		return await Stripe.webhooks.generateTestHeaderStringAsync({ payload, secret });
	}
}
