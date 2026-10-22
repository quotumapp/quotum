import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { runCredentialsCommand } from "../../src/composition/cli/credentials";
import { runEnvironmentsCommand } from "../../src/composition/cli/environments";
import { runOrganizationsCommand } from "../../src/composition/cli/organizations";
import { runProjectsCommand } from "../../src/composition/cli/projects";
import { PostgresProjectInstanceContextResolver } from "../../src/composition/project-instance-persistence";
import { isTenantTrafficEligible } from "../../src/projects/context";
import { MerchantBrowser, merchantFixture } from "./fixture";
import {
	operatorEnv as headless,
	lifecycleStatusOf,
	runOperator,
	seedOperatorOrganization,
} from "./operator-fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

/** A console deployment: members manage their organization and the production limit applies. */
const consoleEnv = { ...headless, QUOTUM_CONSOLE_ENABLED: "true" };

type Result = { code: number; stderr: string; json: Record<string, unknown> };

async function run(
	command: typeof runOrganizationsCommand | typeof runProjectsCommand,
	argv: string[],
	settings: Record<string, string | undefined> = headless,
): Promise<Result> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await command(argv, settings, {
		output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
	});
	return { code, stderr: err.join("\n"), json: code === 0 ? JSON.parse(out.join("\n")) : {} };
}

const environments = (argv: string[], settings = headless) =>
	runOperator(runEnvironmentsCommand, argv, {}, settings);

const auditOf = (action: string) => f.sql<
	{
		organization_id: string | null;
		target: string;
		principal_id: string | null;
		metadata: Record<string, unknown>;
	}[]
>`
	SELECT organization_id, target, principal_id, metadata FROM platform_audit_events
	WHERE action=${action} ORDER BY created_at
`;

async function eligible(instanceKey: string): Promise<boolean> {
	const lookup = await new PostgresProjectInstanceContextResolver(f.client).resolveInstanceKey(
		instanceKey,
	);
	if (lookup.kind !== "resolved") throw new Error(`${instanceKey} did not resolve`);
	return isTenantTrafficEligible(lookup.context);
}

describe("quotum organizations rename and projects rename", () => {
	it("changes display names only, on every environment, and audits each change once", async () => {
		await seedOperatorOrganization(f);

		const organization = await run(runOrganizationsCommand, [
			"rename",
			"ops",
			"--name",
			"Operations Inc",
		]);
		expect(organization.json).toMatchObject({
			organization: "ops",
			name: "Operations Inc",
			previousName: "Operations",
			changed: true,
		});
		const [row] = await f.sql<
			{ slug: string; name: string }[]
		>`SELECT slug,name FROM platform_organizations`;
		expect(row).toEqual({ slug: "ops", name: "Operations Inc" });

		const project = await run(runProjectsCommand, [
			"rename",
			"ops",
			"alpha",
			"--name",
			"Alpha App",
		]);
		expect(project.json).toMatchObject({ project: "alpha", name: "Alpha App", changed: true });
		expect(await f.sql`SELECT key,name FROM platform_projects`).toEqual([
			{ key: "alpha", name: "Alpha App" },
		]);
		const instances = await f.sql<
			{ key: string; name: string }[]
		>`SELECT key,name FROM projects ORDER BY key`;
		expect(instances).toEqual([
			{ key: "alpha", name: "Alpha App" },
			{ key: "alpha-sandbox", name: "Alpha App" },
		]);

		// The same name again changes nothing and writes no second event.
		const again = await run(runProjectsCommand, ["rename", "ops", "alpha", "--name", "Alpha App"]);
		expect(again.json).toMatchObject({ changed: false });
		expect(await auditOf("organization.renamed")).toHaveLength(1);
		const renamed = await auditOf("project.renamed");
		expect(renamed).toHaveLength(1);
		expect(renamed[0]?.principal_id).toBeNull();
		expect(renamed[0]?.metadata).toEqual({
			operator: "ops-runbook",
			project: "alpha",
			previousName: "Alpha",
			name: "Alpha App",
		});
	});

	it("needs a stated reason once the organization has members", async () => {
		await seedOperatorOrganization(f);
		const browser = new MerchantBrowser(f);
		await browser.signup("owner@ops.example");
		const owner = await run(
			runOrganizationsCommand,
			["add-owner", "ops", "--email", "owner@ops.example"],
			consoleEnv,
		);
		expect(owner.code).toBe(0);

		const refused = await run(
			runOrganizationsCommand,
			["rename", "ops", "--name", "Ops Renamed"],
			consoleEnv,
		);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("--member-override-reason");
		const projectRefused = await run(
			runProjectsCommand,
			["rename", "ops", "alpha", "--name", "Alpha Renamed"],
			consoleEnv,
		);
		expect(projectRefused.code).toBe(1);
		expect((await f.sql`SELECT name FROM platform_organizations`)[0]?.name).toBe("Operations");

		const reasoned = await run(
			runOrganizationsCommand,
			["rename", "ops", "--name", "Ops Renamed", "--member-override-reason", "owner asked"],
			consoleEnv,
		);
		expect(reasoned.json).toMatchObject({ changed: true });
		const [event] = await auditOf("organization.renamed");
		expect(event?.metadata).toMatchObject({
			operator: "ops-runbook",
			memberOverrideReason: "owner asked",
		});
	});

	it("reports an organization or project it cannot find", async () => {
		await seedOperatorOrganization(f);
		const organization = await run(runOrganizationsCommand, ["rename", "nowhere", "--name", "X"]);
		expect(organization.code).toBe(1);
		expect(organization.stderr).toContain("Organization nowhere was not found");
		const project = await run(runProjectsCommand, ["rename", "ops", "nope", "--name", "X"]);
		expect(project.code).toBe(1);
		expect(project.stderr).toContain("Project nope was not found in ops");
	});
});

describe("quotum environments suspend and resume", () => {
	it("stops /v1 traffic for one environment and brings it back, without touching the other", async () => {
		await seedOperatorOrganization(f);
		expect(await eligible("alpha-sandbox")).toBe(true);

		const suspended = await environments([
			"suspend",
			"alpha-sandbox",
			"--reason",
			"abuse report under review",
		]);
		expect(suspended.json).toMatchObject({
			instance: "alpha-sandbox",
			environment: "sandbox",
			lifecycleStatus: "suspended",
			changed: true,
		});
		expect(await lifecycleStatusOf(f, "alpha-sandbox")).toBe("suspended");
		expect(await eligible("alpha-sandbox")).toBe(false);
		expect(await eligible("alpha")).toBe(true);

		// Credentials and connections are managed on active and inactive environments only, so a
		// suspended one is resumed before it is rotated.
		const status = await runOperator(runCredentialsCommand, ["status", "alpha-sandbox"]);
		expect(status.code).toBe(1);
		expect(status.stderr).toContain("CONTEXT_UNAVAILABLE");

		// Suspending again is a no-op.
		const again = await environments([
			"suspend",
			"alpha-sandbox",
			"--reason",
			"still under review",
		]);
		expect(again.json).toMatchObject({ changed: false });

		const resumed = await environments(["resume", "alpha-sandbox"]);
		expect(resumed.json).toMatchObject({ lifecycleStatus: "active", changed: true });
		expect(await eligible("alpha-sandbox")).toBe(true);

		const [suspendEvent] = await auditOf("environment.suspended");
		expect(suspendEvent?.principal_id).toBeNull();
		expect(suspendEvent?.metadata).toEqual({
			operator: "ops-runbook",
			instance: "alpha-sandbox",
			environment: "sandbox",
			reason: "abuse report under review",
		});
		expect(await auditOf("environment.suspended")).toHaveLength(1);
		expect(await auditOf("environment.resumed")).toHaveLength(1);
	});

	it("moves only active environments to suspended and only suspended ones back", async () => {
		await seedOperatorOrganization(f, "inactive");
		const notActive = await environments(["suspend", "alpha", "--reason", "nothing to stop"]);
		expect(notActive.code).toBe(1);
		expect(notActive.stderr).toContain("is inactive; only active environments can be suspended");
		expect(await lifecycleStatusOf(f, "alpha")).toBe("inactive");

		const notSuspended = await environments(["resume", "alpha"]);
		expect(notSuspended.code).toBe(1);
		expect(notSuspended.stderr).toContain("only suspended environments can be resumed");

		await f.sql`UPDATE projects SET lifecycle_status='deactivated' WHERE key='alpha-sandbox'`;
		const deactivated = await environments(["resume", "alpha-sandbox"]);
		expect(deactivated.code).toBe(1);
		expect(deactivated.stderr).toContain("is deactivated");
	});

	it("resumes production without applying the deprecated production quota", async () => {
		await seedOperatorOrganization(f);
		// A second project in the same organization already holds the one production slot.
		await f.sql`
			WITH project AS (
				INSERT INTO platform_projects (organization_id, key, name)
				SELECT id, 'beta', 'Beta' FROM platform_organizations WHERE slug='ops'
				RETURNING id
			)
			INSERT INTO projects (platform_project_id, key, name, environment, lifecycle_status, internal_project)
			SELECT id, 'beta', 'Beta', 'production', 'active', false FROM project
		`;
		// Suspend the first production environment, then fill its slot by activating the second.
		await f.sql`UPDATE projects SET lifecycle_status='suspended' WHERE key='alpha'`;

		await f.sql`UPDATE platform_organizations SET production_limit=0 WHERE slug='ops'`;
		const resumed = await environments(["resume", "alpha"], consoleEnv);
		expect(resumed.code).toBe(0);
		expect(resumed.json).toMatchObject({ lifecycleStatus: "active", changed: true });
		expect(await lifecycleStatusOf(f, "alpha")).toBe("active");
	});

	it("needs a stated reason once the organization has members", async () => {
		await seedOperatorOrganization(f);
		const browser = new MerchantBrowser(f);
		await browser.signup("owner@ops.example");
		await run(
			runOrganizationsCommand,
			["add-owner", "ops", "--email", "owner@ops.example"],
			consoleEnv,
		);

		const refused = await environments(
			["suspend", "alpha-sandbox", "--reason", "incident"],
			consoleEnv,
		);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("--member-override-reason");
		expect(await lifecycleStatusOf(f, "alpha-sandbox")).toBe("active");

		const reasoned = await environments(
			[
				"suspend",
				"alpha-sandbox",
				"--reason",
				"incident",
				"--member-override-reason",
				"owner unreachable",
			],
			consoleEnv,
		);
		expect(reasoned.json).toMatchObject({ lifecycleStatus: "suspended" });
		const [event] = await auditOf("environment.suspended");
		expect(event?.metadata).toMatchObject({ memberOverrideReason: "owner unreachable" });
	});
});
