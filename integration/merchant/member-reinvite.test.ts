import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { InvitationView, OnboardingDraftView, TeamView } from "../../src/platform/contracts";
import { MerchantBrowser, merchantFixture } from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

async function setup() {
	const owner = new MerchantBrowser(f);
	await owner.signup();
	await owner.json<OnboardingDraftView>("/api/platform/onboarding/organization", {
		name: "Acme Company",
		slug: "acme",
	});
	const member = new MerchantBrowser(f);
	await member.signup("member@example.com");
	await owner.json("/api/platform/team/invitations", {
		organizationSlug: "acme",
		email: "member@example.com",
		role: "Viewer",
	});
	await member.json("/api/platform/invitations/accept", {
		token: f.mailer.link("invitation", "member@example.com"),
	});
	const team = await owner.json<TeamView>("/api/platform/team?organization=acme");
	const membership = team.members.find((m) => m.email === "member@example.com");
	if (!membership) throw new Error("Membership missing");
	return { owner, member, membershipId: membership.id };
}
/** Removal may end the member's sessions; sign them in again before they act. */
async function signInAgain(member: MerchantBrowser) {
	await f.sql`DELETE FROM platform_rate_limits`;
	await member.login("member@example.com");
}
async function outcome(response: Response) {
	return [response.status, (await response.json()).error?.code ?? null];
}
const invite = (owner: MerchantBrowser, role = "Developer") =>
	owner.request("/api/platform/team/invitations", {
		organizationSlug: "acme",
		email: "member@example.com",
		role,
	});

describe("re-inviting former members", () => {
	it("lets a removed member rejoin through a new invitation with the invited role", async () => {
		const { owner, member, membershipId } = await setup();
		await owner.json(`/api/platform/team/members/${membershipId}`, {
			organizationSlug: "acme",
			status: "removed",
		});
		const [before] = await f.sql<
			{ revision: number }[]
		>`SELECT revision FROM platform_memberships WHERE id=${membershipId}`;

		expect(await outcome(await invite(owner))).toEqual([200, null]);
		const token = f.mailer.link("invitation", "member@example.com");
		await signInAgain(member);
		expect(
			(await member.json<InvitationView>("/api/platform/invitations/preview", { token })).status,
		).toBe("valid");
		await member.json("/api/platform/invitations/accept", { token });

		const rows = await f.sql<
			{ id: string; role: string; status: string; revision: number }[]
		>`SELECT m.id,m.role,m.status,m.revision FROM platform_memberships m JOIN platform_organizations o ON o.id=m.organization_id WHERE o.slug='acme' AND m.role<>'Owner'`;
		expect(rows).toEqual([
			{
				id: membershipId,
				role: "Developer",
				status: "active",
				revision: (before?.revision ?? 0) + 1,
			},
		]);
		expect((await member.request("/api/platform/team?organization=acme")).status).toBe(200);
	});

	it("refuses to invite a suspended member and points to reactivation", async () => {
		const { owner, membershipId } = await setup();
		await owner.json(`/api/platform/team/members/${membershipId}`, {
			organizationSlug: "acme",
			status: "suspended",
		});
		expect(await outcome(await invite(owner))).toEqual([409, "MEMBER_SUSPENDED"]);
		expect(await f.sql`SELECT id FROM platform_invitations WHERE status='valid'`).toEqual([]);
		// Reactivation is the way back for a suspended member.
		expect(
			await outcome(
				await owner.request(`/api/platform/team/members/${membershipId}`, {
					organizationSlug: "acme",
					status: "active",
				}),
			),
		).toEqual([200, null]);
	});

	it("does not reactivate or otherwise change a removed member", async () => {
		const { owner, member, membershipId } = await setup();
		await owner.json(`/api/platform/team/members/${membershipId}`, {
			organizationSlug: "acme",
			status: "removed",
		});
		for (const body of [{ status: "active" }, { status: "suspended" }, { role: "Admin" }])
			expect(
				await outcome(
					await owner.request(`/api/platform/team/members/${membershipId}`, {
						organizationSlug: "acme",
						...body,
					}),
				),
			).toEqual([409, "MEMBER_REMOVED"]);
		expect(
			await f.sql`SELECT role,status FROM platform_memberships WHERE id=${membershipId}`,
		).toEqual([{ role: "Viewer", status: "removed" }]);
		await signInAgain(member);
		expect((await member.request("/api/platform/team?organization=acme")).status).toBe(403);
	});
});
