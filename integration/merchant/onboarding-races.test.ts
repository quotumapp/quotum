import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import type { OnboardingDraftView } from "../../src/platform/contracts";
import type { PlatformQuery } from "../../src/platform/persistence/query-executor";
import { PlatformOrganizationRepository } from "../../src/platform/persistence/repositories";
import { MerchantBrowser, merchantFixture } from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
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

describe("merchant onboarding races", () => {
	it("creates one organization when two sessions of one person start onboarding together", async () => {
		const first = new MerchantBrowser(f);
		await first.signup();
		const second = new MerchantBrowser(f);
		await f.sql`DELETE FROM platform_rate_limits`;
		await second.login("owner@example.com");
		const [principal] = await f.sql<
			{ id: string }[]
		>`SELECT p.id FROM platform_principals p JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE u.email='owner@example.com'`;

		let pending: Promise<Response>[] = [];
		// A draft held uncommitted keeps both requests past their draft read until it rolls back,
		// which is the interleaving that let the second request replace the first's draft.
		await f.client
			.begin(async (tx) => {
				await tx`INSERT INTO platform_onboarding_drafts(principal_id) VALUES(${principal?.id})`;
				pending = [
					first.request(
						"/api/platform/onboarding/organization",
						{ name: "First Company", slug: "first" },
						{ key: "first-session-create" },
					),
					second.request(
						"/api/platform/onboarding/organization",
						{ name: "Second Company", slug: "second" },
						{ key: "second-session-create" },
					),
				];
				await waitForLockWaiters(2);
				throw new Error("rollback");
			})
			.catch((error: Error) => {
				if (error.message !== "rollback") throw error;
			});
		const outcomes = await Promise.all(pending.map(async (reply) => outcome(await reply)));
		expect(outcomes.sort()).toEqual([
			[200, null],
			[409, "DRAFT_CHANGED"],
		]);
		const owned = await f.sql<
			{ slug: string }[]
		>`SELECT o.slug FROM platform_organizations o JOIN platform_memberships m ON m.organization_id=o.id WHERE m.principal_id=${principal?.id}`;
		expect(owned).toHaveLength(1);
		const draft = await first.json<OnboardingDraftView>("/api/platform/onboarding");
		expect(draft.organization?.slug).toBe(owned[0]?.slug);
		expect(await f.sql`SELECT slug FROM platform_organizations ORDER BY slug`).toEqual(owned);
	});

	it("answers a slug claimed by a concurrent sign-up with 409 SLUG_UNAVAILABLE", async () => {
		const browser = new MerchantBrowser(f);
		await browser.signup();
		let pending: Promise<Response> | undefined;
		await f.client.begin(async (tx) => {
			// Another person's organization with the same address, not yet committed.
			await tx`INSERT INTO platform_organizations(name,slug) VALUES('Other Acme','acme')`;
			pending = browser.request("/api/platform/onboarding/organization", {
				name: "Acme Company",
				slug: "acme",
			});
			await waitForLockWaiters(1);
		});
		expect(await outcome(await pending)).toEqual([409, "SLUG_UNAVAILABLE"]);
		expect(await f.sql`SELECT name FROM platform_organizations`).toEqual([{ name: "Other Acme" }]);
		expect((await (await browser.request("/api/platform/onboarding")).json()).data).toBeNull();
	});

	it("answers a rename to a slug another onboarding is claiming with 409 SLUG_UNAVAILABLE", async () => {
		const browser = new MerchantBrowser(f);
		await browser.signup();
		const org = await browser.json<OnboardingDraftView>("/api/platform/onboarding/organization", {
			name: "Acme Company",
			slug: "acme",
		});
		let pending: Promise<Response> | undefined;
		await f.client.begin(async (tx) => {
			// What another person's onboarding does while it creates `acme-labs`.
			await new PlatformOrganizationRepository({
				query: async <Row>({ text, values }: PlatformQuery) =>
					(await tx.unsafe(text, [...values])) as Row[],
			}).lockSlug("acme-labs");
			await tx`INSERT INTO platform_organizations(name,slug) VALUES('Acme Labs Elsewhere','acme-labs')`;
			pending = browser.request("/api/platform/onboarding/organization", {
				name: "Acme Labs",
				slug: "acme-labs",
				revision: org.revision,
			});
			await waitForLockWaiters(1);
		});
		expect(await outcome(await pending)).toEqual([409, "SLUG_UNAVAILABLE"]);
		const draft = await browser.json<OnboardingDraftView>("/api/platform/onboarding");
		expect(draft.organization).toMatchObject({ slug: "acme", name: "Acme Company" });
		expect(draft.revision).toBe(org.revision);
	});
});
