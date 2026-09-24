import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { BunPlatformUnitOfWork } from "../../src/composition/project-instance-persistence";
import {
	type PlatformBootstrapManifest,
	parsePlatformBootstrapManifest,
	platformBootstrapCredentialEnvironment,
} from "../../src/platform/bootstrap/manifest";
import {
	type PlatformBootstrapInspection,
	PlatformBootstrapService,
	type PreparedPlatformCredential,
} from "../../src/platform/bootstrap/service";
import { generateProjectApiCredential } from "../../src/platform/credentials/project-api-token";
import type { CredentialAccess } from "../../src/shared/credential-access";
import { MerchantBrowser, merchantFixture } from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

const bootstrap = () => new PlatformBootstrapService(new BunPlatformUnitOfWork(f.client));

const sandbox = (key: string, issueCredential = true) => ({
	key,
	environment: "sandbox" as const,
	lifecycleStatus: "active" as const,
	issueCredential,
});

/** A first deployment: one organization with a sandbox environment. */
function firstManifest(): PlatformBootstrapManifest {
	return parsePlatformBootstrapManifest(
		JSON.stringify({
			version: 1,
			organizations: [
				{
					slug: "ops",
					name: "Operations",
					projects: [{ key: "alpha", name: "Alpha", instances: [sandbox("alpha-sandbox")] }],
				},
			],
		}),
	);
}

/** The same deployment later: production for alpha, a second project and a second organization. */
function laterManifest(): PlatformBootstrapManifest {
	return parsePlatformBootstrapManifest(
		JSON.stringify({
			version: 1,
			organizations: [
				{
					slug: "ops",
					name: "Operations",
					projects: [
						{
							key: "alpha",
							name: "Alpha",
							instances: [
								sandbox("alpha-sandbox"),
								{
									key: "alpha",
									environment: "production",
									lifecycleStatus: "active",
									issueCredential: true,
									issueReadOnlyCredential: true,
								},
							],
						},
						{ key: "beta", name: "Beta", instances: [sandbox("beta-sandbox")] },
					],
				},
				{
					slug: "labs",
					name: "Labs",
					projects: [{ key: "gamma", name: "Gamma", instances: [sandbox("gamma-sandbox", false)] }],
				},
			],
		}),
	);
}

/** What the CLI hands `apply`: one generated key per planned credential. */
function prepare(
	manifest: PlatformBootstrapManifest,
	inspection: PlatformBootstrapInspection,
): PreparedPlatformCredential[] {
	const generate = (keys: readonly string[], access: CredentialAccess) =>
		keys.map((projectInstanceKey) => {
			const generated = generateProjectApiCredential(
				platformBootstrapCredentialEnvironment(manifest, projectInstanceKey, access),
				access,
			);
			return {
				credentialId: generated.credentialId,
				projectInstanceKey,
				environment: generated.environment,
				access: generated.access,
				secretVerifier: generated.secretVerifier,
			};
		});
	return [
		...generate(inspection.credentialsToIssue, "full"),
		...generate(inspection.readOnlyCredentialsToIssue, "read_only"),
	];
}

async function run(manifest: PlatformBootstrapManifest, service = bootstrap()) {
	return await service.apply(manifest, prepare(manifest, await service.inspect(manifest)));
}

/** Every platform row with the columns bootstrap must never change. */
async function storedTopology() {
	return {
		organizations: await f.sql<{ id: string; slug: string; name: string; updated_at: Date }[]>`
			SELECT id, slug, name, updated_at FROM platform_organizations ORDER BY slug
		`,
		projects: await f.sql<
			{ id: string; organization_id: string; key: string; name: string; updated_at: Date }[]
		>`
			SELECT id, organization_id, key, name, updated_at FROM platform_projects ORDER BY key
		`,
		instances: await f.sql<
			{ id: string; platform_project_id: string; key: string; lifecycle_status: string }[]
		>`
			SELECT id, platform_project_id, key, lifecycle_status FROM projects ORDER BY key
		`,
		credentials: await f.sql<{ key: string; access: string; id: string }[]>`
			SELECT p.key, c.access, c.id
			FROM platform_project_api_credentials c
			JOIN projects p ON p.id = c.project_instance_id
			ORDER BY p.key, c.access
		`,
	};
}

describe("additive platform bootstrap", () => {
	it("creates only the declared rows that are missing and issues their credentials", async () => {
		await expect(run(firstManifest())).resolves.toMatchObject({
			state: "exact",
			organizationsCreated: ["ops"],
			logicalProjectsCreated: ["ops/alpha"],
			projectInstancesCreated: ["alpha-sandbox"],
			credentialsIssued: 1,
		});
		const before = await storedTopology();

		await expect(bootstrap().inspect(laterManifest())).resolves.toEqual({
			state: "incomplete",
			organizationCount: 2,
			logicalProjectCount: 3,
			projectInstanceCount: 4,
			organizationsToCreate: ["labs"],
			logicalProjectsToCreate: ["labs/gamma", "ops/beta"],
			projectInstancesToCreate: ["alpha", "beta-sandbox", "gamma-sandbox"],
			credentialsToIssue: ["alpha", "beta-sandbox"],
			readOnlyCredentialsToIssue: ["alpha"],
		});
		await expect(run(laterManifest())).resolves.toMatchObject({
			state: "exact",
			organizationsCreated: ["labs"],
			logicalProjectsCreated: ["labs/gamma", "ops/beta"],
			projectInstancesCreated: ["alpha", "beta-sandbox", "gamma-sandbox"],
			credentialsToIssue: [],
			readOnlyCredentialsToIssue: [],
			credentialsIssued: 3,
		});

		const after = await storedTopology();
		// Existing rows keep their ids and timestamps; new ones sit under them.
		expect(after.organizations).toContainEqual(only(before.organizations));
		expect(after.projects).toContainEqual(only(before.projects));
		expect(after.instances).toContainEqual(only(before.instances));
		expect(after.credentials).toContainEqual(only(before.credentials));
		const alpha = only(before.projects);
		const ops = only(before.organizations);
		expect(after.instances.find((row) => row.key === "alpha")?.platform_project_id).toBe(alpha.id);
		expect(after.projects.find((row) => row.key === "beta")?.organization_id).toBe(ops.id);
		expect(after.credentials.map((row) => `${row.key}:${row.access}`)).toEqual([
			"alpha:full",
			"alpha:read_only",
			"alpha-sandbox:full",
			"beta-sandbox:full",
		]);
		const [metering] = await f.sql<{ count: number }[]>`
			SELECT count(*)::int AS count FROM metering_settings
		`;
		expect(metering?.count).toBe(4);

		// A repeated run has nothing left to do.
		await expect(bootstrap().apply(laterManifest(), [])).resolves.toMatchObject({
			state: "exact",
			organizationsCreated: [],
			logicalProjectsCreated: [],
			projectInstancesCreated: [],
			credentialsIssued: 0,
		});
		expect(await storedTopology()).toEqual(after);
	});

	it("refuses drift on either side and writes nothing", async () => {
		await run(firstManifest());
		const before = await storedTopology();

		const renamed = laterManifest();
		const [organization] = renamed.organizations;
		if (organization === undefined) throw new Error("Missing organization");
		organization.name = "Renamed Operations";
		const renamedDrift =
			"BILLING_PLATFORM_BOOTSTRAP_JSON does not match database state: organization ops has a different name in the database";
		await expect(bootstrap().inspect(renamed)).rejects.toThrow(renamedDrift);
		const prepared = prepare(laterManifest(), await bootstrap().inspect(laterManifest()));
		await expect(bootstrap().apply(renamed, prepared)).rejects.toThrow(renamedDrift);

		await f.sql`UPDATE projects SET lifecycle_status='suspended' WHERE key='alpha-sandbox'`;
		await expect(bootstrap().inspect(laterManifest())).rejects.toThrow(
			"instance alpha-sandbox has lifecycleStatus suspended in the database but active in the manifest",
		);
		await f.sql`UPDATE projects SET lifecycle_status='active' WHERE key='alpha-sandbox'`;
		expect(await storedTopology()).toEqual(before);
	});

	it("never adds to an organization that has members or is not active", async () => {
		await run(firstManifest());
		await new MerchantBrowser(f).signup();
		await f.sql`
			INSERT INTO platform_memberships(organization_id, principal_id, role)
			SELECT o.id, p.id, 'Owner' FROM platform_organizations o, platform_principals p
			WHERE o.slug='ops'
		`;
		const before = await storedTopology();
		await expect(bootstrap().inspect(laterManifest())).rejects.toThrow(
			"Bootstrap cannot add to organization ops: it has members, so the merchant platform manages it",
		);
		// Nor may it mint a new kind of key there, even when every row already exists.
		const readOnly = firstManifest();
		const sandboxInstance = readOnly.organizations[0]?.projects[0]?.instances[0];
		if (sandboxInstance === undefined) throw new Error("Missing sandbox instance");
		sandboxInstance.issueReadOnlyCredential = true;
		await expect(bootstrap().inspect(readOnly)).rejects.toThrow(
			"Bootstrap cannot add to organization ops: it has members",
		);
		// The organization still matches when nothing is added to it.
		await expect(bootstrap().inspect(firstManifest())).resolves.toMatchObject({ state: "exact" });

		await f.sql`DELETE FROM platform_memberships`;
		await f.sql`UPDATE platform_organizations SET status='suspended' WHERE slug='ops'`;
		await expect(run(laterManifest())).rejects.toThrow(
			"Bootstrap cannot add to organization ops: it is suspended",
		);
		expect((await storedTopology()).projects).toEqual(before.projects);
	});

	it("creates each row once when two runs apply the same plan", async () => {
		await run(firstManifest());
		const [first, second] = [bootstrap(), bootstrap()];
		const plans = await Promise.all([
			first.inspect(laterManifest()),
			second.inspect(laterManifest()),
		]);
		const results = await Promise.allSettled([
			first.apply(laterManifest(), prepare(laterManifest(), plans[0])),
			second.apply(laterManifest(), prepare(laterManifest(), plans[1])),
		]);
		expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
		const rejected = results.find((result) => result.status === "rejected");
		expect(String(rejected?.status === "rejected" ? rejected.reason : "")).toContain(
			"Prepared credentials do not match the platform bootstrap plan",
		);
		const after = await storedTopology();
		expect(after.projects.map((row) => row.key)).toEqual(["alpha", "beta", "gamma"]);
		expect(after.credentials.map((row) => `${row.key}:${row.access}`)).toEqual([
			"alpha:full",
			"alpha:read_only",
			"alpha-sandbox:full",
			"beta-sandbox:full",
		]);
	});
});

function only<T>(rows: readonly T[]): T {
	const [row] = rows;
	if (row === undefined || rows.length !== 1) throw new Error("Expected exactly one row");
	return row;
}
