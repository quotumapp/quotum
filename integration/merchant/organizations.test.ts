import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type {
	MerchantMembershipView,
	MerchantSessionView,
	OnboardingDraftView,
} from "../../src/platform/contracts";
import { MerchantBrowser, merchantFixture, onboard } from "./fixture";

const f = merchantFixture();
beforeEach(async () => {
	f.store.config.organizationLimit = 5;
	await f.reset();
});
afterAll(() => f.sql.close());

// The fixture pool is shared by the app and this file, so a blocked request, the transaction
// holding the lock and each poll each occupy one of its connections.
async function waitForLockWaiters(count: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const [row] = await f.sql<
			{ waiting: number }[]
		>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock'`;
		if (row && row.waiting >= count) return;
		await Bun.sleep(20);
	}
	throw new Error(`Fewer than ${count} requests waited on a lock`);
}
async function outcome(response: Response | undefined) {
	if (!response) throw new Error("The request never started");
	return [response.status, (await response.json()).error?.code ?? null];
}
async function principalId(email = "owner@example.com"): Promise<string> {
	const [row] = await f.sql<
		{ id: string }[]
	>`SELECT p.id FROM platform_principals p JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE u.email=${email}`;
	if (!row) throw new Error(`No principal for ${email}`);
	return row.id;
}

describe("creating further organizations", () => {
	it("adds an organization to a person who already belongs to one, leaving their onboarding alone", async () => {
		const owner = new MerchantBrowser(f);
		await onboard(owner);
		const before = await owner.json<OnboardingDraftView>("/api/platform/onboarding");

		const created = await owner.json<MerchantMembershipView>("/api/platform/organizations", {
			name: "Globex Labs",
			slug: "globex-labs",
		});
		expect(created).toMatchObject({
			organizationName: "Globex Labs",
			organizationSlug: "globex-labs",
			role: "Owner",
		});
		expect(created.capabilities).toContain("team.manage");

		const session = await owner.json<MerchantSessionView>("/api/platform/session");
		expect(session.memberships.map((m) => m.organizationSlug).sort()).toEqual([
			"acme",
			"globex-labs",
		]);
		// The draft is the first organization's walk-through; a second organization does not touch it.
		expect(session.onboarding).toEqual(before);
		const team = await owner.json<{ canManage: boolean; members: { role: string }[] }>(
			"/api/platform/team?organization=globex-labs",
		);
		expect(team.canManage).toBe(true);
		expect(team.members.map((m) => m.role)).toEqual(["Owner"]);
		expect(
			await f.sql`SELECT target FROM platform_audit_events WHERE action='organization.created' AND target=${created.organizationId}`,
		).toHaveLength(1);

		// A project is added the way it is to any existing organization.
		const project = await owner.json<{ organizationSlug: string }>("/api/platform/projects", {
			organizationSlug: "globex-labs",
			name: "Globex App",
			key: "globex-app",
		});
		expect(project.organizationSlug).toBe("globex-labs");
	});

	it("creates an organization for a person who never started onboarding", async () => {
		const owner = new MerchantBrowser(f);
		await owner.signup();
		const created = await owner.json<MerchantMembershipView>("/api/platform/organizations", {
			name: "First Company",
			slug: "first",
		});
		expect(created.role).toBe("Owner");
		expect((await (await owner.request("/api/platform/onboarding")).json()).data).toBeNull();
	});

	it("answers an address that is taken with 409 and spends nothing", async () => {
		const owner = new MerchantBrowser(f);
		await onboard(owner);
		const refused = await owner.request("/api/platform/organizations", {
			name: "Another Acme",
			slug: "acme",
		});
		expect(await outcome(refused)).toEqual([409, "SLUG_UNAVAILABLE"]);
		expect(await f.sql`SELECT slug FROM platform_organizations`).toEqual([{ slug: "acme" }]);
		expect(
			await f.sql`SELECT 1 FROM platform_rate_limits WHERE key_hash=${f.store.hash(`organization:principal:${await principalId()}`)}`,
		).toHaveLength(0);
	});

	it("repeats an answer for the same key and refuses the key for a different request", async () => {
		const owner = new MerchantBrowser(f);
		await onboard(owner);
		const body = { name: "Globex Labs", slug: "globex-labs" };
		const first = await owner.json<MerchantMembershipView>("/api/platform/organizations", body, {
			key: "create-globex-1",
		});
		const again = await owner.json<MerchantMembershipView>("/api/platform/organizations", body, {
			key: "create-globex-1",
		});
		expect(again).toEqual(first);
		expect(
			await f.sql`SELECT id FROM platform_organizations WHERE slug='globex-labs'`,
		).toHaveLength(1);
		const reused = await owner.request(
			"/api/platform/organizations",
			{ name: "Initech", slug: "initech" },
			{ key: "create-globex-1" },
		);
		expect(await outcome(reused)).toEqual([409, "IDEMPOTENCY_CONFLICT"]);
	});

	it("stops at the owned-organization cap and counts only active organizations the person owns", async () => {
		const owner = new MerchantBrowser(f);
		await onboard(owner);
		f.store.config.organizationLimit = 2;
		await owner.json("/api/platform/organizations", { name: "Second", slug: "second" });
		const refused = await owner.request("/api/platform/organizations", {
			name: "Third",
			slug: "third",
		});
		expect(await outcome(refused)).toEqual([409, "ORGANIZATION_LIMIT_REACHED"]);
		expect(await f.sql`SELECT slug FROM platform_organizations ORDER BY slug`).toEqual([
			{ slug: "acme" },
			{ slug: "second" },
		]);

		// A suspended organization no longer counts, and neither does one the person only belongs to.
		await f.sql`UPDATE platform_organizations SET status='suspended' WHERE slug='second'`;
		await owner.json("/api/platform/organizations", { name: "Third", slug: "third" });
		await f.sql`UPDATE platform_memberships SET role='Admin' WHERE organization_id=(SELECT id FROM platform_organizations WHERE slug='third')`;
		await owner.json("/api/platform/organizations", { name: "Fourth", slug: "fourth" });
		// Lowering the setting keeps what exists and blocks only another.
		f.store.config.organizationLimit = 1;
		const session = await owner.json<MerchantSessionView>("/api/platform/session");
		expect(session.memberships.map((m) => m.organizationSlug).sort()).toEqual([
			"acme",
			"fourth",
			"third",
		]);
		expect(
			await outcome(
				await owner.request("/api/platform/organizations", { name: "Fifth", slug: "fifth" }),
			),
		).toEqual([409, "ORGANIZATION_LIMIT_REACHED"]);
	});

	it("lets two sessions of one person take only the last slot under the cap", async () => {
		const first = new MerchantBrowser(f);
		await onboard(first);
		const second = new MerchantBrowser(f);
		await f.sql`DELETE FROM platform_rate_limits`;
		await second.login("owner@example.com");
		f.store.config.organizationLimit = 2;
		const owner = await principalId();

		let pending: Promise<Response>[] = [];
		// Each session holds a different session row, so only the per-person lock keeps them apart:
		// both requests wait on it here, and whichever takes it first leaves the other the full cap.
		await f.client.begin(async (tx) => {
			await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`platform_organizations.owner:${owner}`}, 0))`;
			pending = [
				first.request(
					"/api/platform/organizations",
					{ name: "Second One", slug: "second-one" },
					{ key: "first-session-org" },
				),
				second.request(
					"/api/platform/organizations",
					{ name: "Second Two", slug: "second-two" },
					{ key: "second-session-org" },
				),
			];
			await waitForLockWaiters(2);
		});
		const outcomes = await Promise.all(pending.map(async (reply) => outcome(await reply)));
		expect(outcomes.sort()).toEqual([
			[200, null],
			[409, "ORGANIZATION_LIMIT_REACHED"],
		]);
		expect(await f.sql`SELECT id FROM platform_organizations`).toHaveLength(2);
	});

	it("applies the same cap to the onboarding route but lets a saved draft keep its organization", async () => {
		const owner = new MerchantBrowser(f);
		await owner.signup();
		f.store.config.organizationLimit = 1;
		const draft = await owner.json<OnboardingDraftView>("/api/platform/onboarding/organization", {
			name: "Acme Company",
			slug: "acme",
		});
		// At the cap, the draft's own organization can still be renamed.
		const renamed = await owner.json<OnboardingDraftView>("/api/platform/onboarding/organization", {
			name: "Acme Inc",
			slug: "acme-inc",
			revision: draft.revision,
		});
		expect(renamed.organization?.slug).toBe("acme-inc");

		const other = new MerchantBrowser(f);
		await other.signup("other@example.com");
		await other.json("/api/platform/organizations", { name: "Other Co", slug: "other" });
		// A person at the cap with no draft cannot start one either.
		expect(
			await outcome(
				await other.request("/api/platform/onboarding/organization", {
					name: "Other Two",
					slug: "other-two",
				}),
			),
		).toEqual([409, "ORGANIZATION_LIMIT_REACHED"]);
		expect(await f.sql`SELECT slug FROM platform_organizations ORDER BY slug`).toEqual([
			{ slug: "acme-inc" },
			{ slug: "other" },
		]);
	});

	it("limits how often one person creates organizations", async () => {
		const owner = new MerchantBrowser(f);
		await owner.signup();
		f.store.config.organizationLimit = 100;
		for (let index = 0; index < 10; index += 1)
			await owner.json("/api/platform/organizations", {
				name: `Company ${index}`,
				slug: `company-${index}`,
			});
		const limited = await owner.request("/api/platform/organizations", {
			name: "Company 10",
			slug: "company-10",
		});
		expect(await outcome(limited)).toEqual([429, "RATE_LIMITED"]);
		expect(await f.sql`SELECT id FROM platform_organizations`).toHaveLength(10);
	});

	it("needs a signed-in session", async () => {
		const anonymous = new MerchantBrowser(f);
		await anonymous.json("/api/platform/config");
		const refused = await anonymous.request("/api/platform/organizations", {
			name: "Globex Labs",
			slug: "globex-labs",
		});
		expect(refused.status).toBe(401);
		expect(await f.sql`SELECT id FROM platform_organizations`).toHaveLength(0);
	});
});
