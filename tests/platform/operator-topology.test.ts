import { describe, expect, it } from "bun:test";
import type { PlatformProjectInstanceRecord } from "../../src/platform/application/ports";
import type { MerchantSql } from "../../src/platform/database";
import {
	renameOrganization,
	renameProject,
	setEnvironmentSuspension,
} from "../../src/platform/operator-topology";

interface Scenario {
	organization?: { id: string; name: string; status: string };
	hasMembers?: boolean;
	project?: { id: string; name: string };
	instances?: PlatformProjectInstanceRecord[];
	/** What the guarded UPDATE of an instance answers. */
	moved?: boolean;
}

const acme = { id: "organization-1", name: "Acme", status: "active" };
const alpha = { id: "project-1", name: "Alpha" };
const instance = (
	overrides: Partial<PlatformProjectInstanceRecord> = {},
): PlatformProjectInstanceRecord => ({
	id: "instance-1",
	platformProjectId: "project-1",
	key: "alpha-sandbox",
	name: "Alpha",
	environment: "sandbox",
	lifecycleStatus: "active",
	internalProject: false,
	...overrides,
});

/** Answers each statement the functions issue from `scenario` and records all of them. */
function fakeSql(scenario: Scenario) {
	const statements: { text: string; values: readonly unknown[] }[] = [];
	const calls: { name: string; args: unknown[] }[] = [];
	const answer = (raw: string, values: readonly unknown[]) => {
		const text = raw.replace(/\s+/g, " ").trim();
		statements.push({ text, values });
		if (text.includes("AS has_members"))
			return scenario.organization
				? [{ status: scenario.organization.status, has_members: scenario.hasMembers ?? false }]
				: [];
		if (text.startsWith("SELECT id,name,status FROM platform_organizations"))
			return scenario.organization ? [scenario.organization] : [];
		if (text.startsWith("SELECT id,status FROM platform_organizations"))
			return scenario.organization ? [scenario.organization] : [];
		if (text.startsWith("SELECT id FROM platform_organizations"))
			return scenario.organization?.status === "active" ? [{ id: scenario.organization.id }] : [];
		if (text.startsWith("SELECT id,name FROM platform_projects"))
			return scenario.project ? [scenario.project] : [];
		return [];
	};
	const sql: MerchantSql = Object.assign(
		async (strings: TemplateStringsArray, ...values: unknown[]) =>
			answer(strings.join("?"), values),
		{
			query: async (query: { text: string; values: readonly unknown[] }) =>
				answer(query.text, query.values),
			begin: (work: (tx: MerchantSql) => Promise<unknown>) => work(sql),
			instances: {
				forProject: async () => scenario.instances ?? [],
				suspend: async (...args: unknown[]) => {
					calls.push({ name: "suspend", args });
					return scenario.moved ?? true;
				},
				resume: async (...args: unknown[]) => {
					calls.push({ name: "resume", args });
					return scenario.moved ?? true;
				},
				renameForProject: async (...args: unknown[]) => {
					calls.push({ name: "renameForProject", args });
				},
			},
		},
	) as unknown as MerchantSql;
	return {
		sql,
		statements,
		calls,
		updates: (table: string) =>
			statements.filter((s) => s.text.startsWith(`UPDATE ${table} SET name=`)),
		audit: () =>
			statements
				.filter((s) => s.text.startsWith("INSERT INTO platform_audit_events"))
				.map((s) => s.values),
	};
}

const operator = "ops-runbook";

describe("renameOrganization", () => {
	it("changes the display name, leaves the slug and audits the operator", async () => {
		const db = fakeSql({ organization: acme });
		await expect(
			renameOrganization(db.sql, { organizationSlug: "acme", name: "Acme Corp", operator }),
		).resolves.toEqual({
			organization: "acme",
			name: "Acme Corp",
			previousName: "Acme",
			changed: true,
		});
		expect(db.updates("platform_organizations")).toHaveLength(1);
		expect(db.updates("platform_organizations")[0]?.values).toEqual([
			"Acme Corp",
			"organization-1",
		]);
		const [event] = db.audit();
		expect(event?.slice(0, 4)).toEqual([
			null,
			"organization-1",
			"organization.renamed",
			"organization-1",
		]);
		expect(JSON.parse(String(event?.[4]))).toEqual({
			operator,
			previousName: "Acme",
			name: "Acme Corp",
		});
	});

	it("changes nothing, and asks for no reason, when the name is already in place", async () => {
		const db = fakeSql({ organization: acme, hasMembers: true });
		const result = await renameOrganization(db.sql, {
			organizationSlug: "acme",
			name: "Acme",
			operator,
		});
		expect(result.changed).toBe(false);
		expect(db.updates("platform_organizations")).toHaveLength(0);
		expect(db.audit()).toHaveLength(0);
	});

	it("needs a stated reason once the organization has members, and records it", async () => {
		const refused = fakeSql({ organization: acme, hasMembers: true });
		await expect(
			renameOrganization(refused.sql, { organizationSlug: "acme", name: "Acme Corp", operator }),
		).rejects.toThrow("--member-override-reason");
		expect(refused.updates("platform_organizations")).toHaveLength(0);

		const reasoned = fakeSql({ organization: acme, hasMembers: true });
		await renameOrganization(reasoned.sql, {
			organizationSlug: "acme",
			name: "Acme Corp",
			operator,
			memberOverrideReason: "the owner asked",
		});
		expect(JSON.parse(String(reasoned.audit()[0]?.[4]))).toMatchObject({
			operator,
			memberOverrideReason: "the owner asked",
		});
	});

	it("refuses an organization that is missing or not active", async () => {
		await expect(
			renameOrganization(fakeSql({}).sql, { organizationSlug: "acme", name: "x", operator }),
		).rejects.toThrow("Organization acme was not found");
		await expect(
			renameOrganization(fakeSql({ organization: { ...acme, status: "suspended" } }).sql, {
				organizationSlug: "acme",
				name: "x",
				operator,
			}),
		).rejects.toThrow("is suspended");
	});
});

describe("renameProject", () => {
	it("renames the project and every environment, never a key", async () => {
		const db = fakeSql({ organization: acme, project: alpha });
		await expect(
			renameProject(db.sql, {
				organizationSlug: "acme",
				projectKey: "alpha",
				name: "Alpha App",
				operator,
			}),
		).resolves.toMatchObject({
			project: "alpha",
			name: "Alpha App",
			previousName: "Alpha",
			changed: true,
		});
		expect(db.updates("platform_projects")[0]?.values).toEqual(["Alpha App", "project-1"]);
		expect(db.calls).toEqual([
			{ name: "renameForProject", args: ["project-1", "organization-1", "Alpha App"] },
		]);
		const [event] = db.audit();
		expect(event?.slice(0, 4)).toEqual([null, "organization-1", "project.renamed", "project-1"]);
	});

	it("reports an unknown project, and needs a reason for a member-owned one", async () => {
		await expect(
			renameProject(fakeSql({ organization: acme }).sql, {
				organizationSlug: "acme",
				projectKey: "nope",
				name: "x",
				operator,
			}),
		).rejects.toThrow("Project nope was not found in acme");
		const members = fakeSql({ organization: acme, project: alpha, hasMembers: true });
		await expect(
			renameProject(members.sql, {
				organizationSlug: "acme",
				projectKey: "alpha",
				name: "Alpha App",
				operator,
			}),
		).rejects.toThrow("--member-override-reason");
		expect(members.calls).toEqual([]);
	});
});

describe("setEnvironmentSuspension", () => {
	const target = {
		instanceKey: "alpha-sandbox",
		organizationId: "organization-1",
		platformProjectId: "project-1",
		instanceId: "instance-1",
	};
	const base = { target, operator, enforceProductionLimit: true };

	it("suspends an active environment and audits the reason", async () => {
		const db = fakeSql({ organization: acme, instances: [instance()] });
		await expect(
			setEnvironmentSuspension(db.sql, { ...base, suspended: true, reason: "chargeback review" }),
		).resolves.toEqual({
			instance: "alpha-sandbox",
			environment: "sandbox",
			lifecycleStatus: "suspended",
			changed: true,
		});
		expect(db.calls).toEqual([{ name: "suspend", args: ["instance-1", "organization-1"] }]);
		const [event] = db.audit();
		expect(event?.slice(0, 4)).toEqual([
			null,
			"organization-1",
			"environment.suspended",
			"instance-1",
		]);
		expect(JSON.parse(String(event?.[4]))).toEqual({
			operator,
			instance: "alpha-sandbox",
			environment: "sandbox",
			reason: "chargeback review",
		});
	});

	it("resumes a suspended environment under the production limit unless the caller waives it", async () => {
		const suspended = instance({ lifecycleStatus: "suspended", environment: "production" });
		const enforced = fakeSql({ organization: acme, instances: [suspended] });
		await setEnvironmentSuspension(enforced.sql, { ...base, suspended: false });
		expect(enforced.calls).toEqual([
			{
				name: "resume",
				args: ["instance-1", "organization-1", { enforceProductionLimit: true }],
			},
		]);
		expect(enforced.audit()[0]?.[2]).toBe("environment.resumed");

		const waived = fakeSql({ organization: acme, instances: [suspended] });
		await setEnvironmentSuspension(waived.sql, {
			...base,
			suspended: false,
			enforceProductionLimit: false,
		});
		expect(waived.calls[0]?.args[2]).toEqual({ enforceProductionLimit: false });
	});

	it("says so when the production limit blocks a resume", async () => {
		const db = fakeSql({
			organization: acme,
			instances: [instance({ lifecycleStatus: "suspended", environment: "production" })],
			moved: false,
		});
		await expect(setEnvironmentSuspension(db.sql, { ...base, suspended: false })).rejects.toThrow(
			"production limit is reached",
		);
		expect(db.audit()).toHaveLength(0);
	});

	it("changes nothing for an environment already in the requested state", async () => {
		const db = fakeSql({ organization: acme, instances: [instance()], hasMembers: true });
		const result = await setEnvironmentSuspension(db.sql, { ...base, suspended: false });
		expect(result).toMatchObject({ lifecycleStatus: "active", changed: false });
		expect(db.calls).toEqual([]);
		expect(db.audit()).toHaveLength(0);
	});

	it("refuses every state it is not meant to move, and an internal instance", async () => {
		for (const [status, suspended] of [
			["inactive", true],
			["deactivating", true],
			["deactivated", true],
			["inactive", false],
			["deactivating", false],
			["deactivated", false],
		] as const) {
			const db = fakeSql({
				organization: acme,
				instances: [instance({ lifecycleStatus: status })],
			});
			await expect(setEnvironmentSuspension(db.sql, { ...base, suspended })).rejects.toThrow(
				`is ${status}`,
			);
			expect(db.calls).toEqual([]);
		}
		const internal = fakeSql({
			organization: acme,
			instances: [instance({ internalProject: true, environment: "internal" })],
		});
		await expect(
			setEnvironmentSuspension(internal.sql, { ...base, suspended: true }),
		).rejects.toThrow("is unavailable");
	});

	it("needs a stated reason once the organization has members", async () => {
		const db = fakeSql({ organization: acme, instances: [instance()], hasMembers: true });
		await expect(setEnvironmentSuspension(db.sql, { ...base, suspended: true })).rejects.toThrow(
			"--member-override-reason",
		);
		expect(db.calls).toEqual([]);
		const reasoned = fakeSql({ organization: acme, instances: [instance()], hasMembers: true });
		await setEnvironmentSuspension(reasoned.sql, {
			...base,
			suspended: true,
			memberOverrideReason: "owner unreachable",
		});
		expect(reasoned.calls).toHaveLength(1);
	});
});
