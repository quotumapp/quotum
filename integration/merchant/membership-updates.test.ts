import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type {
	InvitationView,
	MerchantRole,
	MerchantSessionView,
	OnboardingDraftView,
} from "../../src/platform/contracts";
import { MerchantBrowser, merchantFixture } from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

async function createOrganization(browser: MerchantBrowser, slug: string) {
	await browser.json<OnboardingDraftView>("/api/platform/onboarding/organization", {
		name: `${slug} Company`,
		slug,
	});
}
/** Invites `member` into `slug` and accepts; returns the membership id. */
async function join(
	owner: MerchantBrowser,
	member: MerchantBrowser,
	email: string,
	slug: string,
	role: Exclude<MerchantRole, "Owner">,
): Promise<string> {
	await owner.json("/api/platform/team/invitations", { organizationSlug: slug, email, role });
	await member.json("/api/platform/invitations/accept", {
		token: f.mailer.link("invitation", email),
	});
	const [row] = await f.sql<
		{ id: string }[]
	>`SELECT m.id FROM platform_memberships m JOIN platform_organizations o ON o.id=m.organization_id JOIN platform_principals p ON p.id=m.principal_id JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE o.slug=${slug} AND u.email=${email}`;
	if (!row) throw new Error("Membership missing");
	return row.id;
}
async function openSessions(email: string): Promise<number> {
	const [row] = await f.sql<
		{ open: number }[]
	>`SELECT count(*)::int AS open FROM platform_merchant_sessions s JOIN platform_principals p ON p.id=s.principal_id JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE u.email=${email} AND s.revoked_at IS NULL`;
	return row?.open ?? 0;
}
async function update(
	actor: MerchantBrowser,
	id: string,
	body: { organizationSlug: string; role?: string; status?: string },
) {
	const response = await actor.request(`/api/platform/team/members/${id}`, body);
	return [response.status, (await response.json()).error?.code ?? null];
}

describe("merchant membership updates", () => {
	it("leaves sessions, invitations and step-up grants alone when nothing is reduced", async () => {
		const owner = new MerchantBrowser(f);
		await owner.signup();
		await createOrganization(owner, "acme");
		await f.sql`UPDATE platform_organizations SET member_limit=10 WHERE slug='acme'`;
		const admin = new MerchantBrowser(f);
		await admin.signup("admin@example.com");
		const adminId = await join(owner, admin, "admin@example.com", "acme", "Admin");
		const viewer = new MerchantBrowser(f);
		await viewer.signup("viewer@example.com");
		const viewerId = await join(owner, viewer, "viewer@example.com", "acme", "Viewer");
		const pending = await admin.json<InvitationView>("/api/platform/team/invitations", {
			organizationSlug: "acme",
			email: "third@example.com",
			role: "Viewer",
		});
		const [before] = await f.sql<
			{ revision: number }[]
		>`SELECT revision FROM platform_memberships WHERE id=${adminId}`;
		const [stepUp] = await f.sql<
			{ id: string }[]
		>`INSERT INTO platform_step_up_grants(session_id,organization_id,scope,action,target,return_to,expires_at) SELECT s.id,m.organization_id,'{}'::jsonb,'catalog.publish','target','/',now()+interval '10 minutes' FROM platform_memberships m JOIN platform_merchant_sessions s ON s.principal_id=m.principal_id WHERE m.id=${adminId} RETURNING id`;

		// A no-op (same role, same status) changes nothing at all.
		expect(await update(owner, adminId, { organizationSlug: "acme", role: "Admin" })).toEqual([
			200,
			null,
		]);
		expect(await update(owner, adminId, { organizationSlug: "acme", status: "active" })).toEqual([
			200,
			null,
		]);
		// Widening a role keeps the member signed in.
		expect(await update(owner, viewerId, { organizationSlug: "acme", role: "Developer" })).toEqual([
			200,
			null,
		]);

		expect(await openSessions("admin@example.com")).toBe(1);
		expect(await openSessions("viewer@example.com")).toBe(1);
		expect((await admin.request("/api/platform/session")).status).toBe(200);
		expect((await viewer.request("/api/platform/session")).status).toBe(200);
		expect(await f.sql`SELECT revision FROM platform_memberships WHERE id=${adminId}`).toEqual([
			{ revision: before?.revision },
		]);
		expect(await f.sql`SELECT status FROM platform_invitations WHERE id=${pending.id}`).toEqual([
			{ status: "valid" },
		]);
		expect(await f.sql`SELECT id FROM platform_step_up_grants WHERE expires_at>now()`).toEqual([
			{ id: stepUp?.id },
		]);
		const anonymous = new MerchantBrowser(f);
		await anonymous.json("/api/platform/config");
		expect(
			(
				await anonymous.json<InvitationView>("/api/platform/invitations/preview", {
					token: f.mailer.link("invitation", "third@example.com"),
				})
			).status,
		).toBe("valid");
		expect(
			await f.sql`SELECT metadata FROM platform_audit_events WHERE action='membership.updated' ORDER BY created_at`,
		).toEqual([{ metadata: { role: "Developer", status: "active" } }]);
	});

	it("keeps a member signed in to their other organizations when one organization removes them", async () => {
		const owner = new MerchantBrowser(f);
		await owner.signup();
		await createOrganization(owner, "acme");
		const other = new MerchantBrowser(f);
		await other.signup("globex-owner@example.com");
		await createOrganization(other, "globex");
		const memberId = await join(owner, other, "globex-owner@example.com", "acme", "Viewer");

		expect(
			await update(owner, memberId, { organizationSlug: "acme", status: "suspended" }),
		).toEqual([200, null]);
		const session = await other.json<MerchantSessionView>("/api/platform/session");
		expect(session.memberships.map((m) => m.organizationSlug)).toEqual(["globex"]);
		expect((await other.request("/api/platform/team?organization=globex")).status).toBe(200);
		expect((await other.request("/api/platform/team?organization=acme")).status).toBe(403);

		expect(await update(owner, memberId, { organizationSlug: "acme", status: "removed" })).toEqual([
			200,
			null,
		]);
		expect(await openSessions("globex-owner@example.com")).toBe(1);
		expect((await other.request("/api/platform/team?organization=globex")).status).toBe(200);
		expect((await other.request("/api/platform/team?organization=acme")).status).toBe(403);
	});

	it("ends a demoted admin's authority in that organization at once", async () => {
		const owner = new MerchantBrowser(f);
		await owner.signup();
		await createOrganization(owner, "acme");
		const admin = new MerchantBrowser(f);
		await admin.signup("admin@example.com");
		const adminId = await join(owner, admin, "admin@example.com", "acme", "Admin");
		const pending = await admin.json<InvitationView>("/api/platform/team/invitations", {
			organizationSlug: "acme",
			email: "third@example.com",
			role: "Viewer",
		});
		// A step-up the admin started in this organization, and one another organization holds.
		const [sessionRow] = await f.sql<
			{ id: string }[]
		>`SELECT s.id FROM platform_merchant_sessions s JOIN platform_principals p ON p.id=s.principal_id JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE u.email='admin@example.com' AND s.revoked_at IS NULL`;
		await f.sql`INSERT INTO platform_organizations(name,slug) VALUES('Globex','globex')`;
		const grants = await f.sql<
			{ id: string; slug: string }[]
		>`INSERT INTO platform_step_up_grants(session_id,organization_id,scope,action,target,return_to,expires_at) SELECT ${sessionRow?.id},o.id,'{}'::jsonb,'catalog.publish','target','/',now()+interval '10 minutes' FROM platform_organizations o WHERE o.slug IN ('acme','globex') RETURNING id,(SELECT slug FROM platform_organizations WHERE id=organization_id) AS slug`;

		expect(await update(owner, adminId, { organizationSlug: "acme", role: "Developer" })).toEqual([
			200,
			null,
		]);
		expect(await openSessions("admin@example.com")).toBe(1);
		expect(await f.sql`SELECT status FROM platform_invitations WHERE id=${pending.id}`).toEqual([
			{ status: "revoked" },
		]);
		const live = await f.sql<
			{ id: string }[]
		>`SELECT id FROM platform_step_up_grants WHERE expires_at>now()`;
		expect(live.map((row) => row.id)).toEqual(
			grants.filter((g) => g.slug === "globex").map((g) => g.id),
		);
		expect(
			(
				await admin.request("/api/platform/team/invitations", {
					organizationSlug: "acme",
					email: "fourth@example.com",
					role: "Viewer",
				})
			).status,
		).toBe(403);
		expect(
			await f.sql`SELECT metadata FROM platform_audit_events WHERE action='membership.updated'`,
		).toEqual([{ metadata: { role: "Developer", status: "active" } }]);
	});
});
