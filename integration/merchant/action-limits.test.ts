import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { InvitationView, OnboardingDraftView, TeamView } from "../../src/platform/contracts";
import { MerchantBrowser, merchantFixture, merchantTestScope, onboard } from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

async function outcome(response: Response) {
	return [response.status, (await response.json()).error?.code ?? null];
}
/**
 * Moves the fixture clock forward in steps under the idle timeout, touching each session so
 * none of them expires on the way.
 */
async function wait(minutes: number, ...browsers: MerchantBrowser[]) {
	for (let left = minutes; left > 0; left -= 20) {
		f.advance(Math.min(left, 20) * 60_000);
		for (const browser of browsers) await browser.json("/api/platform/session");
	}
}
async function organization(owner: MerchantBrowser) {
	await owner.signup();
	await owner.json<OnboardingDraftView>("/api/platform/onboarding/organization", {
		name: "Acme Company",
		slug: "acme",
	});
}
const guest = (index: number) => `guest-${index}@example.com`;
const invite = (browser: MerchantBrowser, email: string, role = "Viewer", key?: string) =>
	browser.request(
		"/api/platform/team/invitations",
		{ organizationSlug: "acme", email, role },
		key === undefined ? {} : { key },
	);
const resend = (browser: MerchantBrowser, id: string) =>
	browser.request(`/api/platform/team/invitations/${id}/resend`, { organizationSlug: "acme" });

describe("merchant action limits", () => {
	it("limits one member to thirty invitations an hour and charges only a new invitation", async () => {
		const owner = new MerchantBrowser(f);
		await organization(owner);
		const first = await owner.json<InvitationView>(
			"/api/platform/team/invitations",
			{ organizationSlug: "acme", email: guest(0), role: "Viewer" },
			{ key: "invitation-first" },
		);
		// An address that has an invitation is refused before anything is mailed or counted.
		for (let attempt = 0; attempt < 5; attempt++)
			expect(await outcome(await invite(owner, guest(0)))).toEqual([409, "INVITATION_EXISTS"]);
		for (let index = 1; index < 30; index++)
			expect(await outcome(await invite(owner, guest(index)))).toEqual([200, null]);

		const limited = await invite(owner, guest(30));
		const retryAfter = Number(limited.headers.get("retry-after"));
		expect(retryAfter).toBeGreaterThanOrEqual(1);
		expect(retryAfter).toBeLessThanOrEqual(3600);
		expect(await outcome(limited)).toEqual([429, "RATE_LIMITED"]);
		expect(await f.sql`SELECT id FROM platform_invitations`).toHaveLength(30);
		const mailed = f.mailer.messages.length;

		// A repeat of a stored request replays it, and a resend that is refused leaves the
		// invitation it would have replaced valid.
		expect(
			(
				await owner.json<InvitationView>(
					"/api/platform/team/invitations",
					{
						organizationSlug: "acme",
						email: guest(0),
						role: "Viewer",
					},
					{ key: "invitation-first" },
				)
			).id,
		).toBe(first.id);
		expect(await outcome(await resend(owner, first.id))).toEqual([429, "RATE_LIMITED"]);
		expect(await f.sql`SELECT status FROM platform_invitations WHERE id=${first.id}`).toEqual([
			{ status: "valid" },
		]);
		expect(f.mailer.messages).toHaveLength(mailed);

		await wait(61, owner);
		expect(await outcome(await invite(owner, guest(30)))).toEqual([200, null]);
		expect(await outcome(await resend(owner, first.id))).toEqual([200, null]);
	});

	it("limits an organization to one hundred invitations a day across its members", async () => {
		const owner = new MerchantBrowser(f);
		await organization(owner);
		const admin = new MerchantBrowser(f);
		await admin.signup("admin@example.com");
		await invite(owner, "admin@example.com", "Admin");
		await admin.json("/api/platform/invitations/accept", {
			token: f.mailer.link("invitation", "admin@example.com"),
		});
		const team = await owner.json<TeamView>("/api/platform/team?organization=acme");
		expect(team.members.map((member) => member.role).sort()).toEqual(["Admin", "Owner"]);

		// Each of the three hours takes thirty, the first with the administrator's own invitation.
		let sent = 1;
		for (let hour = 0; hour < 3; hour++) {
			if (hour > 0) await wait(61, owner, admin);
			for (; sent < (hour + 1) * 30; sent++)
				expect(await outcome(await invite(owner, guest(sent)))).toEqual([200, null]);
		}
		// The administrator has sent nothing yet, but the organization has used ninety.
		await wait(61, owner, admin);
		for (; sent < 100; sent++)
			expect(await outcome(await invite(admin, guest(sent)))).toEqual([200, null]);

		for (const member of [admin, owner]) {
			const limited = await invite(member, guest(100));
			// The organization's day, not the member's hour, is what ran out.
			expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(3600);
			expect(await outcome(limited)).toEqual([429, "RATE_LIMITED"]);
		}
		expect(await f.sql`SELECT id FROM platform_invitations`).toHaveLength(100);
	});

	it("limits one member to thirty step-up challenges in fifteen minutes", async () => {
		const owner = new MerchantBrowser(f);
		await onboard(owner);
		const challenge = (body: Record<string, unknown> = {}, key?: string) =>
			owner.request(
				"/api/platform/step-up",
				{
					scope: merchantTestScope,
					action: "connections.manage",
					target: crypto.randomUUID(),
					returnTo: "/",
					...body,
				},
				key === undefined ? {} : { key },
			);
		// Requests refused before a challenge is stored spend nothing.
		expect(await outcome(await challenge({ target: "not-an-operation" }))).toEqual([
			400,
			"ACTION_REJECTED",
		]);
		expect(
			await outcome(await challenge({ scope: { ...merchantTestScope, projectKey: "missing" } })),
		).toEqual([404, "CONTEXT_UNAVAILABLE"]);
		const target = crypto.randomUUID();
		const first = await (await challenge({ target }, "challenge-first")).json();
		for (let index = 1; index < 30; index++)
			expect(await outcome(await challenge())).toEqual([200, null]);

		const limited = await challenge();
		expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(15 * 60);
		expect(await outcome(limited)).toEqual([429, "RATE_LIMITED"]);
		expect(await f.sql`SELECT id FROM platform_step_up_grants`).toHaveLength(30);
		expect((await (await challenge({ target }, "challenge-first")).json()).data.id).toBe(
			first.data.id,
		);

		await wait(16, owner);
		expect(await outcome(await challenge())).toEqual([200, null]);
	});
});
