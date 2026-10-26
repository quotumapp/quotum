import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { InvitationView, MerchantMembershipView } from "../../src/platform/contracts";
import { MerchantBrowser, merchantFixture, onboard } from "./fixture";

const f = merchantFixture();
beforeEach(async () => {
	f.store.config.organizationLimit = 5;
	await f.reset();
});
afterAll(() => f.sql.close());

async function outcome(response: Response | undefined) {
	if (!response) throw new Error("The request never started");
	return [response.status, (await response.json()).error?.code ?? null];
}
/** An onboarded owner, and a second person signed in with an address that can be invited. */
async function people(invitee = "invitee@example.com") {
	const owner = new MerchantBrowser(f);
	await onboard(owner);
	const person = new MerchantBrowser(f);
	await f.sql`DELETE FROM platform_rate_limits`;
	await person.signup(invitee);
	return { owner, person };
}
function invite(
	owner: MerchantBrowser,
	email = "invitee@example.com",
	organizationSlug = "acme",
	role = "Developer",
) {
	return owner.json<InvitationView>("/api/platform/team/invitations", {
		organizationSlug,
		email,
		role,
	});
}
const inbox = (person: MerchantBrowser) =>
	person.json<InvitationView[]>("/api/platform/invitations");
async function statusOf(id: string): Promise<string | undefined> {
	const [row] = await f.sql<
		{ status: string }[]
	>`SELECT status FROM platform_invitations WHERE id=${id}`;
	return row?.status;
}

describe("a person's invitation inbox", () => {
	it("lists the invitations addressed to the signed-in address, and only those", async () => {
		const { owner, person } = await people();
		const sent = await invite(owner);
		const other = new MerchantBrowser(f);
		await f.sql`DELETE FROM platform_rate_limits`;
		await other.signup("other@example.com");
		const stranger = new MerchantBrowser(f);
		await stranger.json("/api/platform/config");

		const listed = await inbox(person);
		expect(listed).toEqual([
			{
				id: sent.id,
				organizationName: "Acme Company",
				organizationSlug: "acme",
				email: "invitee@example.com",
				role: "Developer",
				expiresAt: sent.expiresAt,
				status: "valid",
			},
		]);
		// Another person's inbox is empty, not an error, and nobody without a session sees anything.
		expect(await inbox(other)).toEqual([]);
		expect((await stranger.request("/api/platform/invitations")).status).toBe(401);
	});

	it("leaves out invitations that are expired, revoked, replaced or from a suspended organization", async () => {
		const { owner, person } = await people();
		const expired = await invite(owner);
		await f.sql`UPDATE platform_invitations SET expires_at=now()-interval '1 minute' WHERE id=${expired.id}`;
		expect(await inbox(person)).toEqual([]);

		// A resend replaces the expired one; the replacement is listed, the replaced one is not.
		const resent = await owner.json<InvitationView>(
			`/api/platform/team/invitations/${expired.id}/resend`,
			{ organizationSlug: "acme" },
		);
		expect((await inbox(person)).map((invitation) => invitation.id)).toEqual([resent.id]);
		await owner.json(`/api/platform/team/invitations/${resent.id}/revoke`, {
			organizationSlug: "acme",
		});
		expect(await inbox(person)).toEqual([]);

		const fresh = await invite(owner);
		expect((await inbox(person)).map((invitation) => invitation.id)).toEqual([fresh.id]);
		await f.sql`UPDATE platform_organizations SET status='suspended' WHERE slug='acme'`;
		expect(await inbox(person)).toEqual([]);
	});

	it("shows an invitation that cannot be accepted with the reason, and refuses it", async () => {
		const { owner, person } = await people();
		const sent = await invite(owner);

		await f.sql`UPDATE platform_organizations SET member_limit=1 WHERE slug='acme'`;
		expect((await inbox(person))[0]?.status).toBe("seat_limit");
		expect(
			await outcome(await person.request(`/api/platform/invitations/${sent.id}/accept`, {})),
		).toEqual([409, "INVITATION_SEAT_LIMIT"]);
		await f.sql`UPDATE platform_organizations SET member_limit=3 WHERE slug='acme'`;

		await f.sql`UPDATE platform_memberships SET revision=revision+1 WHERE role='Owner'`;
		expect((await inbox(person))[0]?.status).toBe("inviter_authority_lost");
		expect(
			await outcome(await person.request(`/api/platform/invitations/${sent.id}/accept`, {})),
		).toEqual([409, "INVITATION_INVITER_AUTHORITY_LOST"]);
		expect(await statusOf(sent.id)).toBe("valid");
		expect(
			await f.sql`SELECT 1 FROM platform_memberships m JOIN platform_principals p ON p.id=m.principal_id JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE u.email='invitee@example.com'`,
		).toHaveLength(0);
	});

	it("shows only the newest ten", async () => {
		const owner = new MerchantBrowser(f);
		await onboard(owner);
		f.store.config.organizationLimit = 100;
		await f.sql`DELETE FROM platform_rate_limits`;
		const person = new MerchantBrowser(f);
		await person.signup("invitee@example.com");
		const sent: string[] = [];
		sent.push((await invite(owner)).id);
		for (let index = 0; index < 10; index += 1) {
			const created = await owner.json<MerchantMembershipView>("/api/platform/organizations", {
				name: `Company ${index}`,
				slug: `company-${index}`,
			});
			sent.push((await invite(owner, "invitee@example.com", created.organizationSlug)).id);
		}
		const listed = await inbox(person);
		expect(listed).toHaveLength(10);
		// Newest first: the oldest invitation, from the first organization, is the one left out.
		expect(listed.map((invitation) => invitation.id)).toEqual(sent.slice(1).reverse());
	});
});

describe("answering an invitation from the inbox", () => {
	it("accepts by id, joining with the invited role, and repeats safely", async () => {
		const { owner, person } = await people();
		const sent = await invite(owner);
		const accepted = await person.json<{ organizationSlug: string }>(
			`/api/platform/invitations/${sent.id}/accept`,
			{},
			{ key: "accept-from-inbox" },
		);
		expect(accepted).toEqual({ organizationSlug: "acme" });
		expect(await statusOf(sent.id)).toBe("used");
		const [member] = await f.sql<
			{ role: string; status: string }[]
		>`SELECT m.role,m.status FROM platform_memberships m JOIN platform_principals p ON p.id=m.principal_id JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE u.email='invitee@example.com'`;
		expect(member).toEqual({ role: "Developer", status: "active" });
		expect(
			await f.sql`SELECT target FROM platform_audit_events WHERE action='invitation.accepted' AND target=${sent.id}`,
		).toHaveLength(1);
		expect(await inbox(person)).toEqual([]);

		// The same key repeats the answer; a new key meets an invitation already accepted by this person.
		expect(
			await person.json<{ organizationSlug: string }>(
				`/api/platform/invitations/${sent.id}/accept`,
				{},
				{ key: "accept-from-inbox" },
			),
		).toEqual(accepted);
		expect(
			await person.json<{ organizationSlug: string }>(
				`/api/platform/invitations/${sent.id}/accept`,
				{},
			),
		).toEqual(accepted);
		expect(
			await f.sql`SELECT 1 FROM platform_audit_events WHERE action='invitation.accepted'`,
		).toHaveLength(1);
		const session = await person.json<{ memberships: { organizationSlug: string }[] }>(
			"/api/platform/session",
		);
		expect(session.memberships.map((m) => m.organizationSlug)).toEqual(["acme"]);
	});

	it("revives a removed member through the inbox", async () => {
		const { owner, person } = await people();
		const first = await invite(owner);
		await person.json<{ organizationSlug: string }>(
			`/api/platform/invitations/${first.id}/accept`,
			{},
		);
		const team = await owner.json<{ members: { id: string; email: string }[] }>(
			"/api/platform/team?organization=acme",
		);
		const memberId = team.members.find((m) => m.email === "invitee@example.com")?.id ?? "";
		await owner.json(`/api/platform/team/members/${memberId}`, {
			organizationSlug: "acme",
			status: "removed",
		});
		const again = await invite(owner, "invitee@example.com", "acme", "Viewer");
		expect((await inbox(person)).map((invitation) => invitation.id)).toEqual([again.id]);
		await person.json<{ organizationSlug: string }>(
			`/api/platform/invitations/${again.id}/accept`,
			{},
		);
		const [member] = await f.sql<
			{ role: string; status: string }[]
		>`SELECT role,status FROM platform_memberships WHERE id=${memberId}`;
		expect(member).toEqual({ role: "Viewer", status: "active" });
	});

	it("joins once when the same invitation is accepted by id and by link together", async () => {
		const { owner, person } = await people();
		const sent = await invite(owner);
		const token = f.mailer.link("invitation", "invitee@example.com");
		// Two sessions of the one person, so the requests meet at the organization lock and not at
		// a shared session row.
		const second = new MerchantBrowser(f);
		await f.sql`DELETE FROM platform_rate_limits`;
		await second.login("invitee@example.com");
		const replies = await Promise.all([
			person.request(`/api/platform/invitations/${sent.id}/accept`, {}, { key: "accept-by-id-1" }),
			second.request(`/api/platform/invitations/${sent.id}/accept`, {}, { key: "accept-by-id-2" }),
			second.request("/api/platform/invitations/accept", { token }, { key: "accept-by-token" }),
		]);
		expect(replies.map((reply) => reply.status)).toEqual([200, 200, 200]);
		expect(
			await f.sql`SELECT m.id FROM platform_memberships m JOIN platform_principals p ON p.id=m.principal_id JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE u.email='invitee@example.com'`,
		).toHaveLength(1);
		expect(
			await f.sql`SELECT 1 FROM platform_audit_events WHERE action='invitation.accepted'`,
		).toHaveLength(1);
	});

	it("answers another person's invitation, and an unknown one, as not found", async () => {
		const { owner, person } = await people();
		const sent = await invite(owner);
		const other = new MerchantBrowser(f);
		await f.sql`DELETE FROM platform_rate_limits`;
		await other.signup("other@example.com");

		const unknown = "3f0c2f6e-0000-4000-8000-000000000000";
		const answers = [];
		for (const id of [sent.id, unknown])
			for (const action of ["accept", "decline"])
				answers.push(
					await other
						.request(`/api/platform/invitations/${id}/${action}`, {})
						.then(async (reply) => ({ status: reply.status, body: await reply.json() })),
				);
		// The same status and the same body for both, so an id reveals nothing about who it was for.
		expect(answers.map((a) => [a.status, a.body.error.code])).toEqual(
			Array(4).fill([404, "INVITATION_NOT_FOUND"]),
		);
		expect(new Set(answers.map((a) => a.body.error.message)).size).toBe(1);
		expect(await statusOf(sent.id)).toBe("valid");
		expect((await person.request("/api/platform/invitations/not-an-id/accept", {})).status).toBe(
			400,
		);
	});

	it("declines, hides it from the inbox and from the emailed link, and lets the organization invite again", async () => {
		const { owner, person } = await people();
		const sent = await invite(owner);
		const token = f.mailer.link("invitation", "invitee@example.com");

		expect(
			await person.json<{ status: string }>(
				`/api/platform/invitations/${sent.id}/decline`,
				{},
				{ key: "decline-1" },
			),
		).toEqual({ status: "declined" });
		expect(await statusOf(sent.id)).toBe("declined");
		expect(await inbox(person)).toEqual([]);
		const audit =
			await f.sql`SELECT metadata FROM platform_audit_events WHERE action='invitation.declined' AND target=${sent.id}`;
		expect(audit).toHaveLength(1);
		// The link no longer joins, and says why.
		expect(
			(await person.json<InvitationView>("/api/platform/invitations/preview", { token })).status,
		).toBe("declined");
		expect(
			await outcome(await person.request("/api/platform/invitations/accept", { token })),
		).toEqual([409, "INVITATION_DECLINED"]);
		expect(
			await outcome(await person.request(`/api/platform/invitations/${sent.id}/accept`, {})),
		).toEqual([409, "INVITATION_DECLINED"]);

		// Declining again, with the same key or a new one, changes and records nothing.
		expect(
			await person.json<{ status: string }>(
				`/api/platform/invitations/${sent.id}/decline`,
				{},
				{ key: "decline-1" },
			),
		).toEqual({ status: "declined" });
		expect(
			await person.json<{ status: string }>(`/api/platform/invitations/${sent.id}/decline`, {}),
		).toEqual({
			status: "declined",
		});
		expect(
			await f.sql`SELECT 1 FROM platform_audit_events WHERE action='invitation.declined'`,
		).toHaveLength(1);

		// The organization sees the outcome, revoking it leaves it declined, and inviting again works.
		const team = await owner.json<{ invitations: InvitationView[] }>(
			"/api/platform/team?organization=acme",
		);
		expect(team.invitations.find((invitation) => invitation.id === sent.id)?.status).toBe(
			"declined",
		);
		await owner.json(`/api/platform/team/invitations/${sent.id}/revoke`, {
			organizationSlug: "acme",
		});
		expect(await statusOf(sent.id)).toBe("declined");
		const again = await invite(owner);
		expect((await inbox(person)).map((invitation) => invitation.id)).toEqual([again.id]);
	});

	it("will not decline an invitation that was already accepted", async () => {
		const { owner, person } = await people();
		const sent = await invite(owner);
		await person.json<{ organizationSlug: string }>(
			`/api/platform/invitations/${sent.id}/accept`,
			{},
		);
		expect(
			await outcome(await person.request(`/api/platform/invitations/${sent.id}/decline`, {})),
		).toEqual([409, "INVITATION_USED"]);
		expect(await statusOf(sent.id)).toBe("used");
	});

	it("treats declining a revoked or replaced invitation as already done", async () => {
		const { owner, person } = await people();
		const first = await invite(owner);
		const second = await owner.json<InvitationView>(
			`/api/platform/team/invitations/${first.id}/resend`,
			{ organizationSlug: "acme" },
		);
		expect(await statusOf(first.id)).toBe("replaced");
		expect(
			await person.json<{ status: string }>(`/api/platform/invitations/${first.id}/decline`, {}),
		).toEqual({
			status: "declined",
		});
		expect(await statusOf(first.id)).toBe("replaced");
		await owner.json(`/api/platform/team/invitations/${second.id}/revoke`, {
			organizationSlug: "acme",
		});
		expect(
			await person.json<{ status: string }>(`/api/platform/invitations/${second.id}/decline`, {}),
		).toEqual({
			status: "declined",
		});
		expect(await statusOf(second.id)).toBe("revoked");
		expect(
			await f.sql`SELECT 1 FROM platform_audit_events WHERE action='invitation.declined'`,
		).toHaveLength(0);
	});
});
