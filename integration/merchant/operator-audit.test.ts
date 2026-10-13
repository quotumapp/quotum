import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { runAuditCommand } from "../../src/composition/cli/audit";
import { merchantFixture } from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

/** A headless operator: the database is all `quotum audit` reads. */
const env = { POSTGRES_URI: process.env.POSTGRES_URI };

type Page = {
	events: {
		id: string;
		createdAt: string;
		organization: string | null;
		principalId: string | null;
		action: string;
		target: string | null;
		metadata: Record<string, unknown>;
	}[];
	nextBefore: string | null;
};

async function audit(argv: string[]): Promise<{ code: number; stderr: string; page: Page }> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runAuditCommand(["list", ...argv], env, {
		output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
	});
	return {
		code,
		stderr: err.join("\n"),
		page: code === 0 ? JSON.parse(out.join("\n")) : { events: [], nextBefore: null },
	};
}

async function organization(slug: string): Promise<string> {
	const [row] = await f.sql<{ id: string }[]>`
		INSERT INTO platform_organizations (slug, name) VALUES (${slug}, ${slug}) RETURNING id
	`;
	if (!row) throw new Error("organization was not created");
	return row.id;
}

async function event(
	organizationId: string | null,
	action: string,
	createdAt: string,
	metadata: Record<string, unknown> = {},
): Promise<void> {
	await f.sql`
		INSERT INTO platform_audit_events (organization_id, action, target, metadata, created_at)
		VALUES (${organizationId}, ${action}, ${`target-${action}`}, ${JSON.stringify(metadata)}::text::jsonb, ${createdAt}::timestamptz)
	`;
}

describe("quotum audit list", () => {
	it("lists the trail newest first with the organization's slug and exact UTC time", async () => {
		const acme = await organization("acme");
		await event(acme, "credential.rotated", "2026-10-01T10:00:00.000001Z", {
			operator: "ops-runbook",
			memberOverrideReason: "owner asked",
		});
		await event(null, "environment.activated", "2026-10-02T10:00:00.250000Z");

		const result = await audit([]);
		expect(result.code).toBe(0);
		expect(result.page.nextBefore).toBeNull();
		expect(result.page.events.map((e) => e.action)).toEqual([
			"environment.activated",
			"credential.rotated",
		]);
		expect(result.page.events[1]).toMatchObject({
			createdAt: "2026-10-01T10:00:00.000001Z",
			organization: "acme",
			principalId: null,
			target: "target-credential.rotated",
			metadata: { operator: "ops-runbook", memberOverrideReason: "owner asked" },
		});
		expect(result.page.events[0]).toMatchObject({ organization: null });
	});

	it("filters by organization, action and time", async () => {
		const acme = await organization("acme");
		const globex = await organization("globex");
		await event(acme, "credential.rotated", "2026-10-01T10:00:00Z");
		await event(acme, "environment.activated", "2026-10-02T10:00:00Z");
		await event(globex, "credential.rotated", "2026-10-03T10:00:00Z");

		const byOrganization = await audit(["--organization", "acme"]);
		expect(byOrganization.page.events.map((e) => e.organization)).toEqual(["acme", "acme"]);

		const byAction = await audit(["--action", "credential.rotated"]);
		expect(byAction.page.events.map((e) => e.organization)).toEqual(["globex", "acme"]);

		// Inclusive since, exclusive until.
		const window = await audit([
			"--since",
			"2026-10-02T10:00:00Z",
			"--until",
			"2026-10-03T10:00:00Z",
		]);
		expect(window.page.events.map((e) => e.action)).toEqual(["environment.activated"]);
	});

	it("pages exactly, including events that share a timestamp", async () => {
		const acme = await organization("acme");
		const tie = "2026-10-05T12:00:00Z";
		for (const action of ["a.one", "a.two", "a.three", "a.four", "a.five"])
			await event(acme, action, tie);

		const seen: string[] = [];
		let before: string | null = null;
		for (let pages = 0; pages < 5; pages += 1) {
			const result = await audit([
				"--limit",
				"2",
				...(before === null ? [] : ["--before", before]),
			]);
			expect(result.code).toBe(0);
			seen.push(...result.page.events.map((e) => e.id));
			before = result.page.nextBefore;
			if (before === null) break;
		}
		const all = await audit(["--limit", "500"]);
		expect(seen).toHaveLength(5);
		expect(new Set(seen).size).toBe(5);
		expect(seen).toEqual(all.page.events.map((e) => e.id));
	});

	it("refuses an organization or event it cannot find instead of returning an empty page", async () => {
		const unknownOrganization = await audit(["--organization", "nowhere"]);
		expect(unknownOrganization.code).toBe(1);
		expect(unknownOrganization.stderr).toContain("Organization nowhere was not found");

		const unknownEvent = await audit(["--before", "00000000-0000-4000-8000-000000000000"]);
		expect(unknownEvent.code).toBe(1);
		expect(unknownEvent.stderr).toContain("was not found");
	});
});
