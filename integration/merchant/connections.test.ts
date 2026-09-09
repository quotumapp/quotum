import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createConnectionValidation } from "../../src/composition/connection-validation";
import { PostgresProjectInstanceContextResolver } from "../../src/composition/project-instance-persistence";
import { BillingRepository } from "../../src/db/repository";
import { MerchantStripeOAuth } from "../../src/platform/connections/oauth";
import { resolveStripeOAuth } from "../../src/platform/connections/oauth-runtime";
import { StripeAppEvents } from "../../src/platform/connections/stripe-events";
import type {
	MerchantScope,
	OnboardingDraftView,
	ProvisioningOperationView,
} from "../../src/platform/contracts";
import { seedIntegrationProjectsAndCatalog } from "../../tests/integration/helpers/catalog-fixtures";
import { publishAiCreditsCatalog } from "../../tests/integration/helpers/metering-catalog";
import { MerchantBrowser, merchantFixture, password } from "./fixture";

const validator = createConnectionValidation();
const f = merchantFixture({
	connectionValidation: {
		normalize: validator.normalize,
		async validate(kind) {
			return {
				identity: kind === "stripe" ? "acct_isolated" : kind,
				eventVerified: true,
				checks: [{ code: "TEST_VERIFIED", passed: true }],
			};
		},
	},
	environmentBilling: {
		async catalogReadiness(id) {
			const [row] = await f.sql<
				{ revision: string | null }[]
			>`SELECT published_catalog_revision_id::text AS revision FROM projects WHERE id=${id}`;
			return {
				revisionId: row?.revision ?? null,
				providers: row?.revision ? ["stripe"] : [],
				ready: !!row?.revision,
			};
		},
		async promote() {
			throw new Error("Unused");
		},
	},
});
beforeEach(() => f.reset());
afterAll(() => f.sql.close());
const scope: MerchantScope = {
	kind: "merchant",
	organizationSlug: "acme",
	projectKey: "example",
	environment: "sandbox",
};
async function onboard(browser: MerchantBrowser) {
	await browser.signup();
	const org = await browser.json<OnboardingDraftView>("/api/platform/onboarding/organization", {
		name: "Acme Company",
		slug: "acme",
	});
	const draft = await browser.json<OnboardingDraftView>("/api/platform/onboarding/project", {
		name: "Example Project",
		key: "example",
		revision: org.revision,
	});
	await browser.json<ProvisioningOperationView>("/api/platform/onboarding/provision", {
		revision: draft.revision,
	});
}
const input = {
	scope,
	expectedRevision: 0,
	settings: { projectionUrl: "https://receiver.example.com" },
	secrets: {},
};
describe("encrypted merchant connections", () => {
	it("discloses generated secrets once, commits by revision and retains disabled recovery credentials", async () => {
		const browser = new MerchantBrowser(f);
		await onboard(browser);
		const draft = await browser.json<{ draftId: string; projectionSecret: string }>(
			"/api/platform/connections/projection/drafts",
			input,
			{ key: "draft-one" },
		);
		expect(draft.projectionSecret).toHaveLength(43);
		const replay = await browser.json<Record<string, unknown>>(
			"/api/platform/connections/projection/drafts",
			input,
			{ key: "draft-one" },
		);
		expect(replay).toEqual({ draftId: draft.draftId, secretDisclosed: false });
		const rows = await f.sql`SELECT * FROM platform_connection_secrets`;
		expect(rows).toHaveLength(1);
		expect(JSON.stringify(rows)).not.toContain(draft.projectionSecret);
		await browser.json("/api/platform/connections/projection/validate", {
			scope,
			draftId: draft.draftId,
		});
		const body = { scope, draftId: draft.draftId };
		const results = await Promise.all([
			browser.json("/api/platform/connections/projection/commit", body, { key: "commit-one" }),
			browser.json("/api/platform/connections/projection/commit", body, { key: "commit-one" }),
		]);
		expect(results[0]).toEqual(results[1]);
		const [version] = await f.sql<
			{ project_instance_id: string }[]
		>`SELECT project_instance_id FROM platform_connection_versions WHERE id=${draft.draftId}`;
		const instance = version?.project_instance_id ?? "";
		expect(
			(await f.connectionRepository.active(instance, "projection"))?.secrets.projectionSecret,
		).toBe(draft.projectionSecret);
		await browser.json("/api/platform/connections/projection/disable", {
			scope,
			expectedRevision: 1,
		});
		expect(await f.connectionRepository.active(instance, "projection")).toBeNull();
		expect(
			(await f.connectionRepository.active(instance, "projection", true))?.secrets.projectionSecret,
		).toBe(draft.projectionSecret);
		expect(JSON.stringify(await f.sql`SELECT * FROM platform_connection_operations`)).not.toContain(
			draft.projectionSecret,
		);
	});
	it("rejects foreign scopes, expired drafts and changed idempotency inputs", async () => {
		const browser = new MerchantBrowser(f);
		await onboard(browser);
		const draft = await browser.json<{ draftId: string }>(
			"/api/platform/connections/projection/drafts",
			input,
			{ key: "draft-one" },
		);
		expect(
			(
				await browser.request(
					"/api/platform/connections/projection/drafts",
					{ ...input, settings: { projectionUrl: "https://different.example.com" } },
					{ key: "draft-one" },
				)
			).status,
		).toBe(409);
		expect(
			(
				await browser.request("/api/platform/connections/projection/validate", {
					scope: { ...scope, organizationSlug: "foreign" },
					draftId: draft.draftId,
				})
			).status,
		).toBe(403);
		await f.sql`UPDATE platform_connection_versions SET expires_at=now()-interval '1 second' WHERE id=${draft.draftId}`;
		expect(
			(
				await browser.request("/api/platform/connections/projection/validate", {
					scope,
					draftId: draft.draftId,
				})
			).status,
		).toBe(409);
	});
	it("requires verification and production step-up even before activation", async () => {
		const browser = new MerchantBrowser(f);
		await onboard(browser);
		const prod = { ...scope, environment: "production" as const };
		const draft = await browser.json<{ draftId: string }>(
			"/api/platform/connections/projection/drafts",
			{ ...input, scope: prod },
		);
		const body = { scope: prod, draftId: draft.draftId };
		expect(
			(await browser.request("/api/platform/connections/projection/commit", body)).status,
		).toBe(409);
		await browser.json("/api/platform/connections/projection/validate", body);
		expect(
			(await browser.request("/api/platform/connections/projection/commit", body)).status,
		).toBe(403);
		const challenge = await browser.request("/api/platform/step-up", {
			scope: prod,
			action: "connections.manage",
			target: draft.draftId,
			returnTo: "/",
		});
		expect(challenge.status).toBe(200);
		const readiness = await browser.json<{ ready: boolean; blockers: string[] }>(
			"/api/platform/environments/readiness",
			{ scope: prod },
		);
		expect(readiness.ready).toBe(false);
		expect(readiness.blockers).toContain("PROVIDER_REQUIRED");
	});
});

describe("Stripe OAuth custody and account isolation", () => {
	it("binds authorization to one session and atomically rotates expired encrypted tokens", async () => {
		const browser = new MerchantBrowser(f);
		await onboard(browser);
		const identity = await f.store.authenticate(
			new Request("https://quotum.example/api/platform/session", {
				headers: { cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
			}),
		);
		let exchangeCalls = 0,
			refreshCalls = 0;
		const provider = {
			authorize: (_environment: string, state: string) =>
				`https://marketplace.stripe.com/oauth/v2/authorize?state=${state}`,
			exchange: async () => {
				exchangeCalls++;
				return {
					accessToken: "initial-synthetic-access",
					refreshToken: "initial-synthetic-refresh",
					expiresAt: Date.now() - 1000,
					accountId: "acct_isolated",
					livemode: false,
				};
			},
			refresh: async (_environment: string, token: string) => {
				refreshCalls++;
				expect(token).toBe("initial-synthetic-refresh");
				return {
					accessToken: "rotated-synthetic-access",
					refreshToken: "rotated-synthetic-refresh",
					expiresAt: Date.now() + 3600000,
					accountId: "acct_isolated",
					livemode: false,
				};
			},
			webhookSecret: () => "whsec_synthetic",
		};
		const oauth = new MerchantStripeOAuth(
			f.store,
			connectionService(),
			f.connectionRepository,
			provider,
			validator,
		);
		const settings = {
			checkoutSuccessUrl: "https://shop.example/success?session_id={CHECKOUT_SESSION_ID}",
			checkoutCancelUrl: "https://shop.example/cancel",
			portalReturnUrl: "https://shop.example/billing",
		};
		const start = await oauth.start(identity, scope, settings, 0);
		const state = new URL(start.authorizeUrl).searchParams.get("state");
		if (!state) throw new Error("Missing OAuth state");
		await expect(
			oauth.complete({ ...identity, sessionId: crypto.randomUUID() }, state, "code"),
		).rejects.toMatchObject({ code: "OAUTH_STATE_EXPIRED" });
		expect(exchangeCalls).toBe(0);
		const draft = await oauth.complete(identity, state, "code");
		await expect(oauth.complete(identity, state, "code")).rejects.toMatchObject({
			code: "OAUTH_STATE_EXPIRED",
		});
		expect(exchangeCalls).toBe(1);
		const instance = await connectionService().scope(identity, scope);
		const version = await f.connectionRepository.version(instance.id, draft.draftId);
		expect(
			(await resolveStripeOAuth(f.connectionRepository, version, "sandbox", provider)).secretKey,
		).toBe("rotated-synthetic-access");
		expect(
			(await resolveStripeOAuth(f.connectionRepository, version, "sandbox", provider)).secretKey,
		).toBe("rotated-synthetic-access");
		expect(refreshCalls).toBe(1);
		expect((await f.connectionRepository.secrets(version)).refreshToken).toBe(
			"rotated-synthetic-refresh",
		);
		expect(
			JSON.stringify(await f.sql`SELECT envelope FROM platform_connection_secrets`),
		).not.toContain("synthetic");
		const events = new StripeAppEvents(f.sql);
		await events.accept({
			event_id: "evt_unknown",
			account_id: "acct_unknown",
			livemode: false,
			payload: { type: "invoice.paid" },
		});
		expect(await events.pending()).toEqual([]);
		expect(await events.mapping("acct_unknown", false)).toBeNull();
		await connectionService().validate(identity, scope, "stripe", draft.draftId);
		await connectionService().commit(
			identity,
			scope,
			"stripe",
			draft.draftId,
			"oauth-commit",
			null,
		);
		expect(await events.mapping("acct_isolated", true)).toBeNull();
		expect(await events.mapping("acct_isolated", false)).not.toBeNull();
		const mapping = await events.mapping("acct_isolated", false);
		if (!mapping) throw new Error("Missing OAuth mapping");
		await f.sql`UPDATE platform_connection_versions SET event_verified_at=NULL WHERE id=${mapping.active_version_id}`;
		await events.verified(mapping.id, mapping.active_version_id, new Date(0));
		expect(
			(await f.connectionRepository.version(instance.id, draft.draftId)).event_verified_at,
		).toBeNull();
		await events.verified(mapping.id, mapping.active_version_id, new Date(Date.now() + 1000));
		expect(
			(await f.connectionRepository.version(instance.id, draft.draftId)).event_verified_at,
		).not.toBeNull();
		await f.sql`UPDATE platform_connection_versions SET settings=settings-'authMethod' WHERE id=${mapping.active_version_id}`;
		expect(await events.mapping("acct_isolated", false)).toBeNull();
	});
});

async function grant(browser: MerchantBrowser, target: string, action: string) {
	const prod = { ...scope, environment: "production" as const };
	const challenge = await browser.json<{ id: string }>("/api/platform/step-up", {
		scope: prod,
		action,
		target,
		returnTo: "/",
	});
	await f.sql`DELETE FROM platform_rate_limits`;
	await browser.json("/api/auth/sign-in/email", { email: "owner@example.com", password });
	await browser.json("/api/auth/two-factor/send-otp", {});
	await browser.json("/api/auth/two-factor/verify-otp", {
		code: f.mailer.otp("owner@example.com"),
		trustDevice: false,
	});
	return (
		await browser.json<{ grant: string }>(`/api/platform/step-up/${challenge.id}/complete`, {})
	).grant;
}
it("activates only reviewed production readiness and discloses its credential once", async () => {
	const browser = new MerchantBrowser(f);
	await onboard(browser);
	const prod = { ...scope, environment: "production" as const };
	for (const kind of ["projection", "stripe"] as const) {
		const draft = await browser.json<{ draftId: string }>(
			`/api/platform/connections/${kind}/drafts`,
			{
				scope: prod,
				expectedRevision: 0,
				settings:
					kind === "projection"
						? input.settings
						: {
								checkoutSuccessUrl: "https://shop.example/success?session_id={CHECKOUT_SESSION_ID}",
								checkoutCancelUrl: "https://shop.example/cancel",
								portalReturnUrl: "https://shop.example/billing",
							},
				secrets:
					kind === "projection"
						? {}
						: { secretKey: "rk_live_synthetic", webhookSecret: "whsec_synthetic" },
			},
		);
		await browser.json(`/api/platform/connections/${kind}/validate`, {
			scope: prod,
			draftId: draft.draftId,
		});
		const token = await grant(browser, draft.draftId, "connections.manage");
		await browser.json(
			`/api/platform/connections/${kind}/commit`,
			{ scope: prod, draftId: draft.draftId },
			{ headers: { "x-quotum-step-up-grant": token } },
		);
	}
	const [instance] = await f.sql<
		{ id: string }[]
	>`SELECT id FROM projects WHERE environment='production'`;
	const context = await new PostgresProjectInstanceContextResolver(f.client).resolveInstanceId(
		instance?.id ?? "missing",
	);
	if (context.kind !== "resolved") throw new Error("Missing production fixture");
	await seedIntegrationProjectsAndCatalog(f.client, [
		{
			name: "Activation fixture",
			projectInstanceKey: context.context.projectInstanceKey,
			projectionContract: "billing_state_v1",
			projectionUrl: "https://receiver.example.com",
			projectionSecret: "synthetic-test-only",
			apple: null,
			googlePlay: null,
			stripe: null,
		},
	]);
	await publishAiCreditsCatalog(new BillingRepository(), context.context);
	const ready = await browser.json<{ ready: boolean; fingerprint: string }>(
		"/api/platform/environments/readiness",
		{ scope: prod },
	);
	expect(ready.ready).toBe(true);
	expect(
		(
			await browser.request("/api/platform/environments/activate", {
				scope: prod,
				fingerprint: "stale",
			})
		).status,
	).toBe(409);
	const token = await grant(browser, ready.fingerprint, "environment.activate");
	await f.sql`UPDATE platform_organizations SET production_limit=0 WHERE slug='acme'`;
	expect(
		(
			await browser.request(
				"/api/platform/environments/activate",
				{ scope: prod, fingerprint: ready.fingerprint },
				{ headers: { "x-quotum-step-up-grant": token }, key: "activate-once" },
			)
		).status,
	).toBe(409);
	await f.sql`UPDATE platform_organizations SET production_limit=1 WHERE slug='acme'`;
	const activated = await browser.json<{ credential: string; credentialDisclosed: boolean }>(
		"/api/platform/environments/activate",
		{ scope: prod, fingerprint: ready.fingerprint },
		{ headers: { "x-quotum-step-up-grant": token }, key: "activate-once" },
	);
	expect(activated.credentialDisclosed).toBe(true);
	expect(activated.credential.length).toBeGreaterThan(30);
	const replay = await browser.json<Record<string, unknown>>(
		"/api/platform/environments/activate",
		{ scope: prod, fingerprint: ready.fingerprint },
		{ key: "activate-once" },
	);
	expect(replay.credentialDisclosed).toBe(false);
	expect(replay.credential).toBeUndefined();
	expect(
		(
			await new PostgresProjectInstanceContextResolver(f.client).resolveCredential(
				activated.credential,
			)
		).kind,
	).toBe("resolved");
	expect(JSON.stringify(await f.sql`SELECT * FROM platform_connection_operations`)).not.toContain(
		activated.credential,
	);
});

function connectionService() {
	if (!f.connections) throw new Error("Connection test service unavailable");
	return f.connections;
}
