import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createApp } from "../../src/app";
import {
	checkProjectRuntimeConfiguration,
	PostgresProjectInstanceContextResolver,
} from "../../src/composition/project-instance-persistence";
import type {
	InvitationView,
	MerchantSessionView,
	OnboardingDraftView,
	ProvisioningOperationView,
	StepUpChallengeView,
} from "../../src/platform/contracts";
import { SESSION_COOKIE } from "../../src/platform/security";
import { mutationTarget } from "../../src/platform/step-up";
import { createIntegrationBillingEnv } from "../../tests/integration/helpers/local-postgres";
import { MerchantBrowser, merchantFixture, password } from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());
async function onboard(browser: MerchantBrowser, orgSlug = "acme") {
	const org = await browser.json<OnboardingDraftView>("/api/platform/onboarding/organization", {
		name: "Acme Company",
		slug: orgSlug,
	});
	const draft = await browser.json<OnboardingDraftView>("/api/platform/onboarding/project", {
		name: "Example Project",
		key: "example",
		revision: org.revision,
	});
	const operation = await browser.json<ProvisioningOperationView>(
		"/api/platform/onboarding/provision",
		{ revision: draft.revision },
		{ key: "provision-one" },
	);
	return { org, draft, operation };
}
describe("merchant platform transactions", () => {
	it("uses canonical sandbox credentials and retains strict runtime readiness", async () => {
		const browser = new MerchantBrowser(f);
		await browser.signup();
		const { operation } = await onboard(browser);
		const issued = await browser.json<{ credential: string }>(
			`/api/platform/provisioning/${operation.id}/credential`,
			{},
		);
		const resolver = new PostgresProjectInstanceContextResolver(f.client);
		const resolved = await resolver.resolveCredential(issued.credential);
		expect(resolved.kind).toBe("resolved");
		if (resolved.kind !== "resolved") throw new Error("Expected canonical credential");
		expect(resolved.context).toMatchObject({
			organizationSlug: "acme",
			logicalProjectKey: "example",
			environment: "sandbox",
			runtimeUnconfigured: true,
		});
		const env = createIntegrationBillingEnv(process.env.POSTGRES_URI ?? "");
		const billing = createApp({ env, projectContextResolver: resolver });
		expect(
			(
				await billing.request("/v1/admin/stats/summary", {
					headers: { authorization: `Bearer ${issued.credential}` },
				})
			).status,
		).toBe(200);
		expect(await checkProjectRuntimeConfiguration([], f.client)).toBe(true);
		await f.sql`DELETE FROM platform_project_runtime_modes WHERE project_instance_id=${resolved.context.projectInstanceId}`;
		expect(await checkProjectRuntimeConfiguration([], f.client)).toBe(false);
		await f.sql`UPDATE platform_organizations SET status='suspended' WHERE slug='acme'`;
		expect(
			(
				await billing.request("/v1/admin/stats/summary", {
					headers: { authorization: `Bearer ${issued.credential}` },
				})
			).status,
		).toBe(401);
	});
	it("resumes partial provisioning without duplicating environments or exposing credentials", async () => {
		const browser = new MerchantBrowser(f);
		await browser.signup();
		f.failProvisioning("production");
		const { operation, draft } = await onboard(browser);
		expect(operation.status).toBe("partially_provisioned");
		expect(operation.steps.find((s) => s.environment === "sandbox")?.status).toBe("succeeded");
		expect(await f.sql`SELECT id FROM projects`).toHaveLength(1);
		f.failProvisioning(null);
		const complete = await browser.json<ProvisioningOperationView>(
			`/api/platform/provisioning/${operation.id}/retry`,
			{},
		);
		expect(complete.status).toBe("succeeded");
		await browser.json(
			"/api/platform/onboarding/provision",
			{ revision: draft.revision },
			{ key: "provision-one" },
		);
		expect(await f.sql`SELECT id FROM platform_projects`).toHaveLength(1);
		expect(await f.sql`SELECT id FROM projects`).toHaveLength(2);
		expect(
			(
				await f.sql`SELECT lifecycle_status='active' AS active FROM projects WHERE environment='production'`
			)[0].active,
		).toBe(false);
		const credential = await browser.json<{ credential: string }>(
			`/api/platform/provisioning/${operation.id}/credential`,
			{},
			{ key: "deliver-once" },
		);
		expect(credential.credential.startsWith("qpk_v1.")).toBe(true);
		expect(
			(
				await browser.json<{ credential: string | null }>(
					`/api/platform/provisioning/${operation.id}/credential`,
					{},
					{ key: "deliver-once" },
				)
			).credential,
		).toBeNull();
		const stored = JSON.stringify(await f.sql`SELECT result FROM platform_idempotency`);
		expect(stored.includes(credential.credential)).toBe(false);
		const rotated = await browser.json<{ credential: string }>(
			`/api/platform/provisioning/${operation.id}/rotate`,
			{},
			{ key: "rotate-once" },
		);
		expect(rotated.credential !== credential.credential).toBe(true);
		await browser.json(
			`/api/platform/provisioning/${operation.id}/rotate`,
			{},
			{ key: "rotate-once" },
		);
		expect(await f.sql`SELECT id FROM platform_project_api_credentials`).toHaveLength(2);
		expect(
			await f.sql`SELECT id FROM platform_project_api_credentials WHERE revoked_at IS NULL`,
		).toHaveLength(1);
	});
	it("rejects stale drafts, changed idempotency requests, and cross-organization reads", async () => {
		const browser = new MerchantBrowser(f);
		await browser.signup();
		const { org } = await onboard(browser);
		expect(
			(
				await browser.request("/api/platform/onboarding/project", {
					name: "Changed",
					key: "changed",
					revision: org.revision,
				})
			).status,
		).toBe(409);
		expect(
			(
				await browser.request(
					"/api/platform/onboarding/provision",
					{ revision: 999 },
					{ key: "provision-one" },
				)
			).status,
		).toBe(409);
		const headers = {
			"x-quotum-organization": "acme",
			"x-quotum-project": "example",
			"x-quotum-environment": "sandbox",
		};
		expect(
			(await browser.request("/api/billing/admin/stats/summary", undefined, { headers })).status,
		).toBe(200);
		expect(
			(
				await browser.request("/api/billing/admin/stats/summary", undefined, {
					headers: { ...headers, "x-quotum-organization": "another" },
				})
			).status,
		).toBe(403);
		expect(
			(
				await browser.request("/api/billing/admin/stats/summary", undefined, {
					headers: { ...headers, "x-quotum-environment": "production" },
				})
			).status,
		).toBe(404);
	});
	it("accepts an invitation once under concurrent requests and immediately revokes a removed member's session", async () => {
		const owner = new MerchantBrowser(f);
		await owner.signup();
		await onboard(owner);
		const invitee = new MerchantBrowser(f);
		await invitee.signup("invitee@example.com");
		const invite = await owner.json<InvitationView>("/api/platform/team/invitations", {
			organizationSlug: "acme",
			email: "invitee@example.com",
			role: "Viewer",
		});
		const token = f.mailer.link("invitation", "invitee@example.com");
		const preview = await invitee.json<InvitationView>("/api/platform/invitations/preview", {
			token,
		});
		expect(preview.status).toBe("valid");
		expect(
			(await invitee.json<MerchantSessionView>("/api/platform/session")).pendingInvitation,
		).toBe(true);
		const replies = await Promise.all([
			invitee.request("/api/platform/invitations/accept", { token }),
			invitee.request("/api/platform/invitations/accept", { token }),
		]);
		expect(replies.map((r) => r.status)).toEqual([200, 200]);
		const members =
			await f.sql`SELECT m.id,m.role FROM platform_memberships m JOIN platform_principals p ON p.id=m.principal_id JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE u.email='invitee@example.com'`;
		expect(members).toHaveLength(1);
		expect(members[0].role).toBe("Viewer");
		expect(
			(await f.sql`SELECT status FROM platform_invitations WHERE id=${invite.id}`)[0].status,
		).toBe("used");
		expect(
			(
				await invitee.request("/api/platform/team/invitations", {
					organizationSlug: "acme",
					email: "third@example.com",
					role: "Admin",
				})
			).status,
		).toBe(403);
		await owner.json(`/api/platform/team/members/${members[0].id}`, {
			organizationSlug: "acme",
			status: "removed",
		});
		expect((await invitee.request("/api/platform/session")).status).toBe(401);
	});
	it("rejects replaced, expired, wrong-email, and revoked invitation tokens", async () => {
		const owner = new MerchantBrowser(f);
		await owner.signup();
		await onboard(owner);
		const invite = await owner.json<InvitationView>("/api/platform/team/invitations", {
			organizationSlug: "acme",
			email: "invitee@example.com",
			role: "Viewer",
		});
		const old = f.mailer.link("invitation", "invitee@example.com");
		expect(
			(await owner.json<InvitationView>("/api/platform/invitations/preview", { token: old }))
				.status,
		).toBe("wrong_email");
		const newInvite = await owner.json<InvitationView>(
			`/api/platform/team/invitations/${invite.id}/resend`,
			{ organizationSlug: "acme", role: "Developer" },
		);
		expect(
			(await owner.json<InvitationView>("/api/platform/invitations/preview", { token: old }))
				.status,
		).toBe("replaced");
		const current = f.mailer.link("invitation", "invitee@example.com");
		await f.sql`UPDATE platform_invitations SET expires_at=now()-interval '1 minute' WHERE id=${newInvite.id}`;
		expect(
			(await owner.json<InvitationView>("/api/platform/invitations/preview", { token: current }))
				.status,
		).toBe("expired");
		await owner.json(`/api/platform/team/invitations/${newInvite.id}/revoke`, {
			organizationSlug: "acme",
		});
		expect(
			(await owner.json<InvitationView>("/api/platform/invitations/preview", { token: current }))
				.status,
		).toBe("revoked");
	});
	it("checks current inviter authority and seat capacity transactionally", async () => {
		const owner = new MerchantBrowser(f);
		await owner.signup();
		await onboard(owner);
		await owner.json("/api/platform/team/invitations", {
			organizationSlug: "acme",
			email: "invitee@example.com",
			role: "Viewer",
		});
		const token = f.mailer.link("invitation", "invitee@example.com");
		await f.sql`UPDATE platform_organizations SET member_limit=1 WHERE slug='acme'`;
		const anon = new MerchantBrowser(f);
		await anon.json("/api/platform/config");
		expect(
			(await anon.json<InvitationView>("/api/platform/invitations/preview", { token })).status,
		).toBe("seat_limit");
		await f.sql`UPDATE platform_memberships SET revision=revision+1 WHERE role='Owner'`;
		expect(
			(await anon.json<InvitationView>("/api/platform/invitations/preview", { token })).status,
		).toBe("inviter_authority_lost");
	});
	it("binds a fresh password+OTP step-up to one session, scope, action, and payload", async () => {
		const browser = new MerchantBrowser(f);
		await browser.signup();
		await onboard(browser);
		await f.sql`UPDATE projects SET lifecycle_status='active' WHERE environment='production'`;

		const scope = {
			kind: "merchant" as const,
			organizationSlug: "acme",
			projectKey: "example",
			environment: "production" as const,
		};
		const path = "/api/billing/admin/catalog/publish";
		const body = { previewToken: "synthetic-preview" };
		const headers = {
			"x-quotum-organization": "acme",
			"x-quotum-project": "example",
			"x-quotum-environment": "production",
		};
		expect((await browser.request(path, body, { headers })).status).toBe(403);
		const challenge = await browser.json<StepUpChallengeView>("/api/platform/step-up", {
			scope,
			action: "catalog.publish",
			target: mutationTarget("POST", path, body),
			returnTo: "/orgs/acme/projects/example/production/catalog",
			request: { method: "POST", path, body, idempotencyKey: "publish-once" },
		});
		expect(
			(await browser.json<StepUpChallengeView>(`/api/platform/step-up/${challenge.id}`)).request
				?.idempotencyKey,
		).toBe("publish-once");
		expect(
			(await browser.request(`/api/platform/step-up/${challenge.id}/complete`, {})).status,
		).toBe(401);
		await f.sql`DELETE FROM platform_rate_limits`;
		await browser.json("/api/auth/sign-in/email", { email: "owner@example.com", password });
		await browser.json("/api/auth/two-factor/send-otp", {});
		await browser.json("/api/auth/two-factor/verify-otp", {
			code: f.mailer.otp("owner@example.com"),
			trustDevice: false,
		});
		const previous = browser.cookies.get(SESSION_COOKIE);
		const complete = await browser.json<{ grant: string }>(
			`/api/platform/step-up/${challenge.id}/complete`,
			{},
		);
		expect(browser.cookies.get(SESSION_COOKIE) !== previous).toBe(true);
		const changed = await browser.request(
			path,
			{ previewToken: "changed" },
			{ headers: { ...headers, "x-quotum-step-up-grant": complete.grant } },
		);
		expect(changed.status).toBe(409);
		const submitted = await browser.request(path, body, {
			key: "publish-once",
			headers: { ...headers, "x-quotum-step-up-grant": complete.grant },
		});
		// The fake preview is rejected by billing validation, after successful capability and step-up checks.
		expect(submitted.status).toBe(400);
		expect(
			(
				await browser.request(path, body, {
					key: "other-publish",
					headers: { ...headers, "x-quotum-step-up-grant": complete.grant },
				})
			).status,
		).toBe(409);
		expect(
			(await f.sql`SELECT consumed_at FROM platform_step_up_grants WHERE id=${challenge.id}`)[0]
				.consumed_at,
		).not.toBeNull();
	});
});
