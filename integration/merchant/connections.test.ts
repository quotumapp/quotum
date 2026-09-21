import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { capabilityErrorCodes } from "../../src/billing/errors";
import { createConnectionValidation } from "../../src/composition/connection-validation";
import { createEnvironmentBillingPort } from "../../src/composition/environment-billing";
import { PostgresProjectInstanceContextResolver } from "../../src/composition/project-instance-persistence";
import { BillingRepository } from "../../src/db/repository";
import { MerchantStripeOAuth } from "../../src/platform/connections/oauth";
import { resolveStripeOAuth } from "../../src/platform/connections/oauth-runtime";
import type { ReadinessCapabilityDetail } from "../../src/platform/connections/ports";
import { StripeAppEvents } from "../../src/platform/connections/stripe-events";
import type {
	MerchantScope,
	OnboardingDraftView,
	ProvisioningOperationView,
	ReadinessBlockerDetail,
} from "../../src/platform/contracts";
import { seedIntegrationProjectsAndCatalog } from "../../tests/integration/helpers/catalog-fixtures";
import { publishAiCreditsCatalog } from "../../tests/integration/helpers/metering-catalog";
import { MerchantBrowser, merchantFixture, password } from "./fixture";

const validator = createConnectionValidation();
/** Reported by the stubbed billing port for every readiness read; it never gates activation. */
const capabilityDetail: ReadinessCapabilityDetail = {
	code: capabilityErrorCodes.configuration.code,
	connectionKind: "apple",
	provider: "apple",
	operation: "catalog.topup",
	targets: [{ kind: "topup", key: "credits_100" }],
	reason: {
		code: "CONNECTION_DISABLED",
		layer: "configuration",
		condition: { kind: "connection_enabled" },
		observed: { connectionEnabled: false },
		resolution: { kind: "merchant_configuration", connectionKind: "apple" },
	},
};
/** The connection kinds each readiness read handed to the billing port. */
const readinessConnectionKinds: string[][] = [];
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
		async catalogReadiness(id, connections) {
			readinessConnectionKinds.push(connections.map((connection) => connection.kind));
			const [row] = await f.sql<
				{ revision: string | null }[]
			>`SELECT published_catalog_revision_id::text AS revision FROM projects WHERE id=${id}`;
			return {
				revisionId: row?.revision ?? null,
				providers: row?.revision ? ["stripe"] : [],
				ready: !!row?.revision,
				capabilityDetails: [capabilityDetail],
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
interface Readiness {
	ready: boolean;
	blockers: string[];
	catalogRevisionId: string | null;
	blockerDetails: ReadinessBlockerDetail[];
	connections: { kind: string; validated_at: string | null }[];
	fingerprint: string;
}
/** Gating details mirror `blockers` in order; capability details follow them without gating. */
function expectMirroredBlockers(readiness: Readiness) {
	expect(
		readiness.blockerDetails.filter((detail) => detail.gating).map((detail) => detail.code),
	).toEqual(readiness.blockers);
	expect(readiness.blockerDetails.slice(readiness.blockers.length)).toEqual([
		{ ...capabilityDetail, gating: false },
	]);
}
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
		const readiness = await browser.json<Readiness>("/api/platform/environments/readiness", {
			scope: prod,
		});
		expect(readiness.ready).toBe(false);
		expect(readiness.blockers).toContain("PROVIDER_REQUIRED");
		expectMirroredBlockers(readiness);
		expect(readiness.blockerDetails).toEqual([
			{ code: "PROVIDER_REQUIRED", gating: true },
			{
				code: "PROJECTION_VALIDATION_REQUIRED",
				gating: true,
				connectionKind: "projection",
				observed: { validatedAt: null, maxAgeSeconds: 900 },
			},
			{ code: "PUBLISHED_CATALOG_REQUIRED", gating: true },
			{ ...capabilityDetail, gating: false },
		]);
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
			(await resolveStripeOAuth(f.connectionRepository, version, "sandbox", provider, f.sql))
				.secretKey,
		).toBe("rotated-synthetic-access");
		expect(
			(await resolveStripeOAuth(f.connectionRepository, version, "sandbox", provider, f.sql))
				.secretKey,
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
	// A validated Stripe connection that has not received an event yet, before any catalog is
	// published: every Stripe blocker names its connection and provider.
	await f.sql`UPDATE platform_connection_versions v SET event_verified_at=NULL FROM platform_connections c WHERE c.active_version_id=v.id AND c.kind='stripe'`;
	const pending = await browser.json<Readiness>("/api/platform/environments/readiness", {
		scope: prod,
	});
	expect(pending.ready).toBe(false);
	expectMirroredBlockers(pending);
	const stripeSubject = { connectionKind: "stripe", provider: "stripe" } as const;
	expect(pending.blockerDetails.slice(0, pending.blockers.length)).toEqual([
		{ code: "STRIPE_EVENT_REQUIRED", gating: true, ...stripeSubject },
		{ code: "STRIPE_CATALOG_REQUIRED", gating: true, ...stripeSubject },
		{ code: "PUBLISHED_CATALOG_REQUIRED", gating: true },
	]);
	await f.sql`UPDATE platform_connection_versions v SET event_verified_at=now() FROM platform_connections c WHERE c.active_version_id=v.id AND c.kind='stripe'`;
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
	const ready = await browser.json<Readiness>("/api/platform/environments/readiness", {
		scope: prod,
	});
	expect(ready.ready).toBe(true);
	expectMirroredBlockers(ready);
	expect(readinessConnectionKinds.at(-1)).toEqual(["projection", "stripe"]);
	// The runtime port reads the same published revision for both views.
	const published = await createEnvironmentBillingPort().catalogReadiness(
		context.context.projectInstanceId,
		await f.connectionRepository.list(context.context.projectInstanceId),
	);
	expect(published.ready).toBe(true);
	expect(published.revisionId).toBe(ready.catalogRevisionId);
	// The plan and the top-up both bind Apple and Google, which have no connection.
	expect(
		published.capabilityDetails?.map(({ code, provider, operation, targets, reason }) => ({
			code,
			provider,
			operation,
			targets,
			reason: reason?.code,
		})),
	).toEqual(
		(
			[
				["catalog.product.subscription", { kind: "plan", key: "premium" }],
				["catalog.topup", { kind: "topup", key: "ai_credits_10" }],
			] as const
		).flatMap(([operation, target]) =>
			(["apple", "google"] as const).map((provider) => ({
				code: capabilityErrorCodes.configuration.code,
				provider,
				operation,
				targets: [target],
				reason: "CONNECTION_DISABLED" as const,
			})),
		),
	);
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
	expect(activated.credential).toMatch(/^pqpk_[A-Za-z0-9_-]{43}$/u);
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

	const rotateGrant = await grant(browser, "rotate-production", "credentials.rotate");
	const rotated = await browser.json<{ credential: string; credentialDisclosed: boolean }>(
		"/api/platform/environments/credentials/rotate",
		{ scope: prod },
		{ headers: { "x-quotum-step-up-grant": rotateGrant }, key: "rotate-production" },
	);
	expect(rotated.credentialDisclosed).toBe(true);
	expect(rotated.credential).toMatch(/^pqpk_[A-Za-z0-9_-]{43}$/u);
	expect(rotated.credential).not.toBe(activated.credential);
	const rotateReplay = await browser.json<Record<string, unknown>>(
		"/api/platform/environments/credentials/rotate",
		{ scope: prod },
		{ key: "rotate-production" },
	);
	expect(rotateReplay).toEqual({ access: "full", credentialDisclosed: false });
	const resolver = new PostgresProjectInstanceContextResolver(f.client);
	expect(await resolver.resolveCredential(activated.credential)).toEqual({ kind: "ineligible" });
	expect(await resolver.resolveCredential(rotated.credential)).toMatchObject({
		kind: "resolved",
		context: { environment: "production" },
		access: "full",
	});
	expect(JSON.stringify(await f.sql`SELECT * FROM platform_connection_operations`)).not.toContain(
		rotated.credential,
	);

	// A read-only key is issued beside the full key and bound to its own step-up action: a grant
	// confirmed for replacing the backend's key cannot mint an inspection key, or the reverse.
	const readOnlyBody = { scope: prod, access: "read_only" };
	const fullActionGrant = await grant(browser, "issue-read-only", "credentials.rotate");
	const refusedWithFullGrant = await browser.request(
		"/api/platform/environments/credentials/rotate",
		readOnlyBody,
		{ headers: { "x-quotum-step-up-grant": fullActionGrant }, key: "issue-read-only" },
	);
	expect(refusedWithFullGrant.status).toBe(409);
	expect(await refusedWithFullGrant.json()).toMatchObject({ error: { code: "STEP_UP_EXPIRED" } });
	const readOnlyGrant = await grant(browser, "issue-read-only", "credentials.rotate_read_only");
	const refusedWithReadOnlyGrant = await browser.request(
		"/api/platform/environments/credentials/rotate",
		{ scope: prod },
		{ headers: { "x-quotum-step-up-grant": readOnlyGrant }, key: "issue-read-only" },
	);
	expect(refusedWithReadOnlyGrant.status).toBe(409);
	expect(await refusedWithReadOnlyGrant.json()).toMatchObject({
		error: { code: "STEP_UP_EXPIRED" },
	});
	const issued = await browser.json<{
		access: string;
		credential: string;
		credentialDisclosed: boolean;
	}>("/api/platform/environments/credentials/rotate", readOnlyBody, {
		headers: { "x-quotum-step-up-grant": readOnlyGrant },
		key: "issue-read-only",
	});
	expect(issued).toMatchObject({ access: "read_only", credentialDisclosed: true });
	expect(issued.credential).toMatch(/^pqrk_[A-Za-z0-9_-]{43}$/u);
	const readOnlyReplay = await browser.json<Record<string, unknown>>(
		"/api/platform/environments/credentials/rotate",
		readOnlyBody,
		{ key: "issue-read-only" },
	);
	expect(readOnlyReplay).toEqual({ access: "read_only", credentialDisclosed: false });
	// The same idempotency key for the other kind is a conflict, never the stored receipt.
	const otherKindReplay = await browser.request(
		"/api/platform/environments/credentials/rotate",
		{ scope: prod },
		{ key: "issue-read-only" },
	);
	expect(otherKindReplay.status).toBe(409);
	expect(await otherKindReplay.json()).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
	expect(await resolver.resolveCredential(issued.credential)).toMatchObject({
		kind: "resolved",
		context: { environment: "production" },
		access: "read_only",
	});
	expect(await resolver.resolveCredential(rotated.credential)).toMatchObject({ kind: "resolved" });

	// Each kind rotates on its own.
	const rotateReadOnlyGrant = await grant(
		browser,
		"rotate-read-only",
		"credentials.rotate_read_only",
	);
	const reissued = await browser.json<{ credential: string }>(
		"/api/platform/environments/credentials/rotate",
		readOnlyBody,
		{ headers: { "x-quotum-step-up-grant": rotateReadOnlyGrant }, key: "rotate-read-only" },
	);
	expect(await resolver.resolveCredential(issued.credential)).toEqual({ kind: "ineligible" });
	expect(await resolver.resolveCredential(reissued.credential)).toMatchObject({
		access: "read_only",
	});
	expect(await resolver.resolveCredential(rotated.credential)).toMatchObject({ access: "full" });
	const secondFullGrant = await grant(browser, "rotate-production-2", "credentials.rotate");
	const rotatedAgain = await browser.json<{ credential: string }>(
		"/api/platform/environments/credentials/rotate",
		{ scope: prod },
		{ headers: { "x-quotum-step-up-grant": secondFullGrant }, key: "rotate-production-2" },
	);
	expect(await resolver.resolveCredential(rotated.credential)).toEqual({ kind: "ineligible" });
	expect(await resolver.resolveCredential(rotatedAgain.credential)).toMatchObject({
		access: "full",
	});
	expect(await resolver.resolveCredential(reissued.credential)).toMatchObject({
		kind: "resolved",
		access: "read_only",
	});
	const audited = await f.sql<
		{ action: string; access: string | null }[]
	>`SELECT action, metadata->>'access' AS access FROM platform_audit_events WHERE action LIKE 'credential.%' ORDER BY created_at`;
	expect(audited.map((event) => `${event.action}:${event.access}`)).toEqual([
		"credential.rotated:full",
		"credential.issued:read_only",
		"credential.rotated:read_only",
		"credential.rotated:full",
	]);
	const stored = JSON.stringify(await f.sql`SELECT * FROM platform_connection_operations`);
	for (const secret of [issued.credential, reissued.credential, rotatedAgain.credential]) {
		expect(stored).not.toContain(secret);
	}

	// Status reports each kind without any key material, and the read-only key can be withdrawn.
	type CredentialStatus = Record<"full" | "readOnly", { live: boolean; issuedAt: string | null }>;
	const status = () =>
		browser.json<CredentialStatus>("/api/platform/environments/credentials/status", {
			scope: prod,
		});
	const before = await status();
	// No asymmetric matcher here: Bun writes the matcher into the received value, and
	// `before.full.issuedAt` is compared again below.
	for (const kind of [before.full, before.readOnly]) {
		expect(kind.live).toBe(true);
		expect(Number.isNaN(Date.parse(kind.issuedAt ?? ""))).toBe(false);
		expect(Object.keys(kind).sort()).toEqual(["issuedAt", "live"]);
	}

	const revokeFull = await browser.request(
		"/api/platform/environments/credentials/revoke",
		{ scope: prod, access: "full" },
		{ key: "revoke-full-key" },
	);
	expect(revokeFull.status).toBe(400);
	const rotateActionGrant = await grant(
		browser,
		"revoke-read-only",
		"credentials.rotate_read_only",
	);
	const refusedRevoke = await browser.request(
		"/api/platform/environments/credentials/revoke",
		readOnlyBody,
		{ headers: { "x-quotum-step-up-grant": rotateActionGrant }, key: "revoke-read-only" },
	);
	expect(refusedRevoke.status).toBe(409);
	expect(await refusedRevoke.json()).toMatchObject({ error: { code: "STEP_UP_EXPIRED" } });
	expect(await resolver.resolveCredential(reissued.credential)).toMatchObject({
		kind: "resolved",
	});

	const revokeGrant = await grant(browser, "revoke-read-only", "credentials.revoke_read_only");
	// A grant confirmed for withdrawing the key cannot mint a new one either.
	const refusedRotate = await browser.request(
		"/api/platform/environments/credentials/rotate",
		readOnlyBody,
		{ headers: { "x-quotum-step-up-grant": revokeGrant }, key: "revoke-read-only" },
	);
	expect(refusedRotate.status).toBe(409);
	const revoked = await browser.json<Record<string, unknown>>(
		"/api/platform/environments/credentials/revoke",
		readOnlyBody,
		{ headers: { "x-quotum-step-up-grant": revokeGrant }, key: "revoke-read-only" },
	);
	expect(revoked).toEqual({ access: "read_only", revoked: true });
	const revokeReplay = await browser.json<Record<string, unknown>>(
		"/api/platform/environments/credentials/revoke",
		readOnlyBody,
		{ key: "revoke-read-only" },
	);
	expect(revokeReplay).toEqual({ access: "read_only", revoked: true });
	expect(await resolver.resolveCredential(reissued.credential)).toEqual({ kind: "ineligible" });
	expect(await resolver.resolveCredential(rotatedAgain.credential)).toMatchObject({
		kind: "resolved",
		access: "full",
	});
	expect(await status()).toEqual({
		full: { live: true, issuedAt: before.full.issuedAt },
		readOnly: { live: false, issuedAt: null },
	});

	// Nothing left to withdraw is still a success, and leaves no audit event.
	const secondRevokeGrant = await grant(
		browser,
		"revoke-read-only-2",
		"credentials.revoke_read_only",
	);
	const nothingLive = await browser.json<Record<string, unknown>>(
		"/api/platform/environments/credentials/revoke",
		readOnlyBody,
		{ headers: { "x-quotum-step-up-grant": secondRevokeGrant }, key: "revoke-read-only-2" },
	);
	expect(nothingLive).toEqual({ access: "read_only", revoked: false });
	const revocations = await f.sql<
		{ access: string | null }[]
	>`SELECT metadata->>'access' AS access FROM platform_audit_events WHERE action='credential.revoked'`;
	expect(revocations.map((event) => event.access)).toEqual(["read_only"]);

	await f.sql`UPDATE platform_connection_versions SET validated_at=validated_at-interval '16 minutes' WHERE status='active'`;
	const stale = await browser.json<Readiness>("/api/platform/environments/readiness", {
		scope: prod,
	});
	const validatedAt = (kind: string) =>
		stale.connections.find((connection) => connection.kind === kind)?.validated_at ?? null;
	expect(stale.ready).toBe(false);
	expectMirroredBlockers(stale);
	expect(stale.blockerDetails.slice(0, stale.blockers.length)).toEqual([
		{
			code: "PROJECTION_VALIDATION_REQUIRED",
			gating: true,
			connectionKind: "projection",
			observed: { validatedAt: validatedAt("projection"), maxAgeSeconds: 900 },
		},
		{
			code: "STRIPE_VALIDATION_REQUIRED",
			gating: true,
			connectionKind: "stripe",
			provider: "stripe",
			observed: { validatedAt: validatedAt("stripe"), maxAgeSeconds: 900 },
		},
	]);
	expect(typeof validatedAt("stripe")).toBe("string");

	// A secret that can no longer be read blocks its connection after the validation blockers.
	await f.sql`DELETE FROM platform_connection_secrets WHERE purpose='webhookSecret'`;
	const broken = await browser.json<Readiness>("/api/platform/environments/readiness", {
		scope: prod,
	});
	expectMirroredBlockers(broken);
	expect(broken.blockerDetails.slice(0, broken.blockers.length)).toEqual([
		...stale.blockerDetails.slice(0, stale.blockers.length),
		{ code: "STRIPE_SECRET_UNAVAILABLE", gating: true, ...stripeSubject },
	]);
});

function connectionService() {
	if (!f.connections) throw new Error("Connection test service unavailable");
	return f.connections;
}
