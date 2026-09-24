import { describe, expect, it } from "bun:test";
import type { PlatformProjectInstanceRecord } from "../../../src/platform/application/ports";
import {
	type PlatformBootstrapManifest,
	parsePlatformBootstrapManifest,
} from "../../../src/platform/bootstrap/manifest";
import {
	type PlatformBootstrapSnapshot,
	planPlatformBootstrap,
} from "../../../src/platform/bootstrap/plan";
import type {
	PlatformLogicalProjectRecord,
	PlatformOrganizationListing,
} from "../../../src/platform/persistence/repositories";

const drift = "BILLING_PLATFORM_BOOTSTRAP_JSON does not match database state: ";

/** One organization with a sandbox instance: what a first bootstrap run created. */
function baseManifest(): PlatformBootstrapManifest {
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
								{
									key: "alpha-sandbox",
									environment: "sandbox",
									lifecycleStatus: "active",
									issueCredential: true,
								},
							],
						},
					],
				},
			],
		}),
	);
}

/** The base plus an instance, a project in the same organization and a new organization. */
function extendedManifest(): PlatformBootstrapManifest {
	const manifest = baseManifest();
	const [organization] = manifest.organizations;
	const [alpha] = organization?.projects ?? [];
	if (organization === undefined || alpha === undefined) throw new Error("Missing base topology");
	alpha.instances.push({
		key: "alpha",
		environment: "production",
		lifecycleStatus: "active",
		issueCredential: true,
		issueReadOnlyCredential: true,
	});
	organization.projects.push({
		key: "beta",
		name: "Beta",
		instances: [
			{
				key: "beta-sandbox",
				environment: "sandbox",
				lifecycleStatus: "active",
				issueCredential: true,
			},
		],
	});
	manifest.organizations.push({
		slug: "labs",
		name: "Labs",
		projects: [
			{
				key: "gamma",
				name: "Gamma",
				instances: [
					{
						key: "gamma-internal",
						environment: "internal",
						lifecycleStatus: "active",
						issueCredential: false,
					},
				],
			},
		],
	});
	return parsePlatformBootstrapManifest(JSON.stringify(manifest));
}

interface MutableSnapshot extends PlatformBootstrapSnapshot {
	organizations: PlatformOrganizationListing[];
	projects: PlatformLogicalProjectRecord[];
	instances: PlatformProjectInstanceRecord[];
	credentialInstanceIds: Set<string>;
	credentialKinds: Set<string>;
}

/** The rows a bootstrap run of `manifest` stores, with every declared credential issued. */
function storedFor(manifest: PlatformBootstrapManifest): MutableSnapshot {
	const snapshot: MutableSnapshot = {
		organizations: [],
		projects: [],
		instances: [],
		credentialInstanceIds: new Set(),
		credentialKinds: new Set(),
	};
	for (const organization of manifest.organizations) {
		const organizationId = `organization:${organization.slug}`;
		snapshot.organizations.push({
			id: organizationId,
			slug: organization.slug,
			name: organization.name,
			status: "active",
			hasMembers: false,
		});
		for (const project of organization.projects) {
			const projectId = `project:${organization.slug}/${project.key}`;
			snapshot.projects.push({
				id: projectId,
				organizationId,
				key: project.key,
				name: project.name,
			});
			for (const instance of project.instances) {
				const instanceId = `instance:${instance.key}`;
				snapshot.instances.push({
					id: instanceId,
					platformProjectId: projectId,
					key: instance.key,
					name: project.name,
					environment: instance.environment,
					lifecycleStatus: instance.lifecycleStatus,
					internalProject: instance.environment === "internal",
				});
				for (const [declared, access] of [
					[instance.issueCredential, "full"],
					[instance.issueReadOnlyCredential, "read_only"],
				] as const) {
					if (!declared) continue;
					snapshot.credentialInstanceIds.add(instanceId);
					snapshot.credentialKinds.add(`${instanceId}:${access}`);
				}
			}
		}
	}
	return snapshot;
}

function emptySnapshot(): MutableSnapshot {
	return {
		organizations: [],
		projects: [],
		instances: [],
		credentialInstanceIds: new Set(),
		credentialKinds: new Set(),
	};
}

function only<T>(items: readonly T[]): T {
	const [item] = items;
	if (item === undefined || items.length !== 1) throw new Error("Expected exactly one row");
	return item;
}

describe("planPlatformBootstrap", () => {
	it("plans every declared row and credential for an empty database", () => {
		expect(planPlatformBootstrap(extendedManifest(), emptySnapshot())).toEqual({
			state: "empty",
			organizationCount: 2,
			logicalProjectCount: 3,
			projectInstanceCount: 4,
			organizationsToCreate: ["labs", "ops"],
			logicalProjectsToCreate: ["labs/gamma", "ops/alpha", "ops/beta"],
			projectInstancesToCreate: ["alpha", "alpha-sandbox", "beta-sandbox", "gamma-internal"],
			credentialsToIssue: ["alpha", "alpha-sandbox", "beta-sandbox"],
			readOnlyCredentialsToIssue: ["alpha"],
		});
	});

	it("reports nothing to do once every declared row and credential exists", () => {
		const manifest = extendedManifest();
		expect(planPlatformBootstrap(manifest, storedFor(manifest))).toEqual({
			state: "exact",
			organizationCount: 2,
			logicalProjectCount: 3,
			projectInstanceCount: 4,
			organizationsToCreate: [],
			logicalProjectsToCreate: [],
			projectInstancesToCreate: [],
			credentialsToIssue: [],
			readOnlyCredentialsToIssue: [],
		});
	});

	it("plans only the declared rows that are missing, with their credentials", () => {
		expect(planPlatformBootstrap(extendedManifest(), storedFor(baseManifest()))).toEqual({
			state: "incomplete",
			organizationCount: 2,
			logicalProjectCount: 3,
			projectInstanceCount: 4,
			organizationsToCreate: ["labs"],
			logicalProjectsToCreate: ["labs/gamma", "ops/beta"],
			projectInstancesToCreate: ["alpha", "beta-sandbox", "gamma-internal"],
			credentialsToIssue: ["alpha", "beta-sandbox"],
			readOnlyCredentialsToIssue: ["alpha"],
		});
	});

	it("never reissues a credential kind that was ever stored", () => {
		const manifest = baseManifest();
		const stored = storedFor(manifest);
		// Revoked keys stay in the snapshot; only a kind that never existed is issued.
		expect(planPlatformBootstrap(manifest, stored).credentialsToIssue).toEqual([]);
		stored.credentialKinds.clear();
		stored.credentialInstanceIds.clear();
		expect(planPlatformBootstrap(manifest, stored).credentialsToIssue).toEqual(["alpha-sandbox"]);
	});

	const refusals: Array<[string, (stored: MutableSnapshot) => void, string]> = [
		[
			"an undeclared organization",
			(stored) =>
				stored.organizations.push({
					id: "organization:stray",
					slug: "stray",
					name: "Stray",
					status: "active",
					hasMembers: false,
				}),
			`${drift}organization stray is not declared`,
		],
		[
			"a renamed organization",
			(stored) => {
				only(stored.organizations).name = "Renamed";
			},
			`${drift}organization ops has a different name in the database`,
		],
		[
			"an undeclared project",
			(stored) =>
				stored.projects.push({
					id: "project:ops/stray",
					organizationId: "organization:ops",
					key: "stray",
					name: "Stray",
				}),
			`${drift}project ops/stray is not declared`,
		],
		[
			"a renamed project",
			(stored) => {
				only(stored.projects).name = "Renamed";
			},
			`${drift}project ops/alpha has a different name in the database`,
		],
		[
			"an undeclared instance",
			(stored) =>
				stored.instances.push({
					...only(stored.instances),
					id: "instance:stray",
					key: "stray",
					environment: "production",
				}),
			`${drift}instance stray is not declared`,
		],
		[
			"a lifecycle change",
			(stored) => {
				only(stored.instances).lifecycleStatus = "suspended";
			},
			`${drift}instance alpha-sandbox has lifecycleStatus suspended in the database but active in the manifest`,
		],
		[
			"an environment change",
			(stored) => {
				only(stored.instances).environment = "production";
			},
			`${drift}instance alpha-sandbox has environment production in the database but sandbox in the manifest`,
		],
		[
			"a renamed instance",
			(stored) => {
				only(stored.instances).name = "Renamed";
			},
			`${drift}instance alpha-sandbox has a different name in the database`,
		],
	];
	for (const [label, mutate, message] of refusals) {
		it(`refuses ${label} and plans nothing`, () => {
			const stored = storedFor(baseManifest());
			mutate(stored);
			expect(() => planPlatformBootstrap(extendedManifest(), stored)).toThrow(message);
			expect(() => planPlatformBootstrap(baseManifest(), stored)).toThrow(message);
		});
	}

	it("refuses an instance that moved to another project", () => {
		const manifest = extendedManifest();
		const stored = storedFor(manifest);
		const beta = stored.instances.find((instance) => instance.key === "beta-sandbox");
		if (beta === undefined) throw new Error("Missing beta instance");
		beta.platformProjectId = "project:labs/gamma";
		expect(() => planPlatformBootstrap(manifest, stored)).toThrow(
			`${drift}instance beta-sandbox belongs to labs/gamma in the database but ops/beta in the manifest`,
		);
	});

	it("refuses a stored credential on an instance that declares none", () => {
		const stored = storedFor(baseManifest());
		const manifest = baseManifest();
		const instance = manifest.organizations[0]?.projects[0]?.instances[0];
		if (instance === undefined) throw new Error("Missing base instance");
		instance.issueCredential = false;
		expect(() => planPlatformBootstrap(manifest, stored)).toThrow(
			"Database contains a project credential not declared by bootstrap manifest",
		);
	});

	it("never adds to an organization that has members", () => {
		const stored = storedFor(baseManifest());
		only(stored.organizations).hasMembers = true;
		expect(() => planPlatformBootstrap(extendedManifest(), stored)).toThrow(
			"Bootstrap cannot add to organization ops: it has members, so the merchant platform manages it",
		);
		// The same database still matches, and a new organization beside it is still created.
		expect(planPlatformBootstrap(baseManifest(), stored).state).toBe("exact");
		const newOrganizationOnly = extendedManifest();
		newOrganizationOnly.organizations[0] = only(baseManifest().organizations);
		expect(planPlatformBootstrap(newOrganizationOnly, stored)).toMatchObject({
			state: "incomplete",
			organizationsToCreate: ["labs"],
			logicalProjectsToCreate: ["labs/gamma"],
			projectInstancesToCreate: ["gamma-internal"],
		});
	});

	it("never issues a new credential inside an organization that has members or is not active", () => {
		// Only a credential kind is added: every row exists, so no row creation triggers the guard.
		const withReadOnly = baseManifest();
		const instance = withReadOnly.organizations[0]?.projects[0]?.instances[0];
		if (instance === undefined) throw new Error("Missing base instance");
		instance.issueReadOnlyCredential = true;
		const stored = storedFor(baseManifest());
		expect(planPlatformBootstrap(withReadOnly, stored)).toMatchObject({
			state: "exact",
			readOnlyCredentialsToIssue: ["alpha-sandbox"],
		});
		only(stored.organizations).hasMembers = true;
		expect(() => planPlatformBootstrap(withReadOnly, stored)).toThrow(
			"Bootstrap cannot add to organization ops: it has members, so the merchant platform manages it",
		);
		only(stored.organizations).hasMembers = false;
		only(stored.organizations).status = "suspended";
		expect(() => planPlatformBootstrap(withReadOnly, stored)).toThrow(
			"Bootstrap cannot add to organization ops: it is suspended",
		);
	});

	it("never adds to an organization that is not active", () => {
		for (const status of ["suspended", "removed"] as const) {
			const stored = storedFor(baseManifest());
			only(stored.organizations).status = status;
			expect(() => planPlatformBootstrap(extendedManifest(), stored)).toThrow(
				`Bootstrap cannot add to organization ops: it is ${status}`,
			);
		}
	});
});
