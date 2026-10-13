import { describe, expect, it } from "bun:test";
import { listPlatformAuditEvents } from "../../src/platform/audit";
import type { PlatformQuery } from "../../src/platform/persistence/query-executor";

const row = (id: string) => ({
	id,
	created_at: "2026-10-13T09:00:00.000001Z",
	organization: "acme",
	principal_id: null,
	action: "credential.rotated",
	target: "alpha",
	metadata: { operator: "ops-runbook" },
});

function fakeExecutor(scenario: {
	organization?: string;
	knownEvent?: boolean;
	events?: string[];
}) {
	const queries: PlatformQuery[] = [];
	return {
		queries,
		executor: {
			async query<Row>(query: PlatformQuery): Promise<readonly Row[]> {
				queries.push(query);
				const text = query.text.replace(/\s+/g, " ").trim();
				if (text.startsWith("SELECT id FROM platform_organizations"))
					return (scenario.organization ? [{ id: scenario.organization }] : []) as Row[];
				if (text.startsWith("SELECT id FROM platform_audit_events"))
					return (scenario.knownEvent === false ? [] : [{ id: "known" }]) as Row[];
				return (scenario.events ?? []).map(row) as Row[];
			},
		},
	};
}

describe("listPlatformAuditEvents", () => {
	it("binds every filter and asks for one more row than the page", async () => {
		const db = fakeExecutor({ organization: "org-1", events: [] });
		await listPlatformAuditEvents(db.executor, {
			organizationSlug: "acme",
			action: "credential.rotated",
			since: "2026-10-01T00:00:00Z",
			until: "2026-10-02T00:00:00Z",
			before: "00000000-0000-4000-8000-000000000001",
			limit: 50,
		});
		const main = db.queries.at(-1);
		expect(main?.values).toEqual([
			"org-1",
			"credential.rotated",
			"2026-10-01T00:00:00Z",
			"2026-10-02T00:00:00Z",
			"00000000-0000-4000-8000-000000000001",
			51,
		]);
		expect(main?.text).toContain("ORDER BY e.created_at DESC, e.id DESC");
	});

	it("reports the next page only when more events remain", async () => {
		const more = fakeExecutor({ events: ["e3", "e2", "e1"] });
		const full = await listPlatformAuditEvents(more.executor, { limit: 2 });
		expect(full.events.map((e) => e.id)).toEqual(["e3", "e2"]);
		expect(full.nextBefore).toBe("e2");

		const last = fakeExecutor({ events: ["e2", "e1"] });
		const done = await listPlatformAuditEvents(last.executor, { limit: 2 });
		expect(done.events).toHaveLength(2);
		expect(done.nextBefore).toBeNull();
	});

	it("maps a row to the record the command prints", async () => {
		const db = fakeExecutor({ events: ["e1"] });
		const page = await listPlatformAuditEvents(db.executor, { limit: 10 });
		expect(page.events).toEqual([
			{
				id: "e1",
				createdAt: "2026-10-13T09:00:00.000001Z",
				organization: "acme",
				principalId: null,
				action: "credential.rotated",
				target: "alpha",
				metadata: { operator: "ops-runbook" },
			},
		]);
	});

	it("refuses an unknown organization or cursor instead of returning nothing", async () => {
		await expect(
			listPlatformAuditEvents(fakeExecutor({}).executor, { organizationSlug: "nowhere", limit: 5 }),
		).rejects.toThrow("Organization nowhere was not found");
		await expect(
			listPlatformAuditEvents(fakeExecutor({ knownEvent: false }).executor, {
				before: "00000000-0000-4000-8000-000000000002",
				limit: 5,
			}),
		).rejects.toThrow("was not found");
	});
});
