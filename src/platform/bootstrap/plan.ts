import type { CredentialAccess } from "../../shared/credential-access";
import type { PlatformProjectInstanceRecord } from "../application/ports";
import type {
	PlatformLogicalProjectRecord,
	PlatformOrganizationListing,
} from "../persistence/repositories";
import type { PlatformBootstrapInstance, PlatformBootstrapManifest } from "./manifest";

/** The stored platform rows that bootstrap compares with its manifest. */
export interface PlatformBootstrapSnapshot {
	organizations: readonly PlatformOrganizationListing[];
	projects: readonly PlatformLogicalProjectRecord[];
	instances: readonly PlatformProjectInstanceRecord[];
	credentialInstanceIds: ReadonlySet<string>;
	/** `${instanceId}:${access}` for every credential ever stored, revoked ones included. */
	credentialKinds: ReadonlySet<string>;
}

export interface PlatformBootstrapInspection {
	/**
	 * `empty`: no platform rows exist yet. `incomplete`: every stored row matches the manifest and
	 * some declared rows are missing. `exact`: every declared row exists.
	 */
	state: "empty" | "incomplete" | "exact";
	organizationCount: number;
	logicalProjectCount: number;
	projectInstanceCount: number;
	/** Declared organizations that do not exist yet, by slug. */
	organizationsToCreate: readonly string[];
	/** Declared logical projects that do not exist yet, as `organization/project`. */
	logicalProjectsToCreate: readonly string[];
	/** Declared project instances that do not exist yet, by key. */
	projectInstancesToCreate: readonly string[];
	/** Instance keys that declare a full credential and have never had one. */
	credentialsToIssue: readonly string[];
	/** The same for read-only credentials, planned independently of the full ones. */
	readOnlyCredentialsToIssue: readonly string[];
}

interface DeclaredInstance {
	organizationSlug: string;
	/** `organization/project` */
	path: string;
	projectName: string;
	instance: PlatformBootstrapInstance;
}

/** Stored rows keyed the way the manifest names them. */
export function indexPlatformSnapshot(snapshot: PlatformBootstrapSnapshot) {
	const organizationsById = new Map(snapshot.organizations.map((row) => [row.id, row]));
	const pathsByProjectId = new Map<string, string>();
	for (const project of snapshot.projects) {
		const organization = organizationsById.get(project.organizationId);
		if (organization !== undefined)
			pathsByProjectId.set(project.id, `${organization.slug}/${project.key}`);
	}
	return {
		organizationsBySlug: new Map(snapshot.organizations.map((row) => [row.slug, row])),
		projectsByPath: new Map(
			snapshot.projects.flatMap((row) => {
				const path = pathsByProjectId.get(row.id);
				return path === undefined ? [] : [[path, row] as const];
			}),
		),
		pathsByProjectId,
		instancesByKey: new Map(snapshot.instances.map((row) => [row.key, row])),
	};
}

/**
 * Compares the database with the manifest. Every stored row must be declared and match exactly;
 * declared rows that are missing are planned for creation, but never inside an organization that
 * has members or is not active. Bootstrap never updates or deletes, so any other difference throws.
 */
export function planPlatformBootstrap(
	manifest: PlatformBootstrapManifest,
	snapshot: PlatformBootstrapSnapshot,
): PlatformBootstrapInspection {
	const organizations = new Map(manifest.organizations.map((row) => [row.slug, row]));
	const projects = new Map<string, { organizationSlug: string; name: string }>();
	const instances = new Map<string, DeclaredInstance>();
	for (const organization of manifest.organizations) {
		for (const project of organization.projects) {
			const path = `${organization.slug}/${project.key}`;
			projects.set(path, { organizationSlug: organization.slug, name: project.name });
			for (const instance of project.instances)
				instances.set(instance.key, {
					organizationSlug: organization.slug,
					path,
					projectName: project.name,
					instance,
				});
		}
	}
	const stored = indexPlatformSnapshot(snapshot);

	for (const organization of snapshot.organizations) {
		const declared = organizations.get(organization.slug);
		if (declared === undefined) throw drift(`organization ${organization.slug} is not declared`);
		if (declared.name !== organization.name)
			throw drift(`organization ${organization.slug} has a different name in the database`);
	}
	for (const project of snapshot.projects) {
		const path = stored.pathsByProjectId.get(project.id);
		const declared = path === undefined ? undefined : projects.get(path);
		if (path === undefined || declared === undefined)
			throw drift(`project ${path ?? project.key} is not declared`);
		if (declared.name !== project.name)
			throw drift(`project ${path} has a different name in the database`);
	}
	for (const instance of snapshot.instances) {
		const declared = instances.get(instance.key);
		if (declared === undefined) throw drift(`instance ${instance.key} is not declared`);
		const path = stored.pathsByProjectId.get(instance.platformProjectId) ?? "an undeclared project";
		if (path !== declared.path)
			throw drift(
				`instance ${instance.key} belongs to ${path} in the database but ${declared.path} in the manifest`,
			);
		for (const field of ["environment", "lifecycleStatus"] as const) {
			if (instance[field] !== declared.instance[field])
				throw drift(
					`instance ${instance.key} has ${field} ${instance[field]} in the database but ${declared.instance[field]} in the manifest`,
				);
		}
		if (
			instance.name !== declared.projectName ||
			instance.internalProject !== (declared.instance.environment === "internal")
		)
			throw drift(`instance ${instance.key} has a different name in the database`);
	}

	// By instance, not by kind: a read-only key minted later through merchant management on an
	// instance that holds a declared credential does not make the database drift from the manifest.
	const keysByInstanceId = new Map(snapshot.instances.map((row) => [row.id, row.key]));
	for (const instanceId of snapshot.credentialInstanceIds) {
		const declared = instances.get(keysByInstanceId.get(instanceId) ?? "")?.instance;
		if (!declared?.issueCredential && !declared?.issueReadOnlyCredential)
			throw new Error("Database contains a project credential not declared by bootstrap manifest");
	}

	const organizationsToCreate = [...organizations.keys()]
		.filter((slug) => !stored.organizationsBySlug.has(slug))
		.sort();
	const logicalProjectsToCreate = [...projects.keys()]
		.filter((path) => !stored.projectsByPath.has(path))
		.sort();
	const projectInstancesToCreate = [...instances.keys()]
		.filter((key) => !stored.instancesByKey.has(key))
		.sort();

	// Bootstrap issues each declared kind once and never rotates: a revoked row still counts.
	const toIssue = (access: CredentialAccess) =>
		[...instances.values()]
			.filter(({ instance }) => {
				if (!(access === "full" ? instance.issueCredential : instance.issueReadOnlyCredential))
					return false;
				const instanceId = stored.instancesByKey.get(instance.key)?.id;
				return instanceId === undefined || !snapshot.credentialKinds.has(`${instanceId}:${access}`);
			})
			.map(({ instance }) => instance.key)
			.sort();
	const credentialsToIssue = toIssue("full");
	const readOnlyCredentialsToIssue = toIssue("read_only");

	// An organization with members belongs to a merchant, who manages its projects and keys through
	// the merchant platform; bootstrap only adds rows or credentials to organizations nobody joined.
	const extended = new Set([
		...logicalProjectsToCreate.map((path) => projects.get(path)?.organizationSlug),
		...[...projectInstancesToCreate, ...credentialsToIssue, ...readOnlyCredentialsToIssue].map(
			(key) => instances.get(key)?.organizationSlug,
		),
	]);
	for (const organization of snapshot.organizations) {
		if (!extended.has(organization.slug)) continue;
		if (organization.hasMembers)
			throw new Error(
				`Bootstrap cannot add to organization ${organization.slug}: it has members, so the merchant platform manages it`,
			);
		if (organization.status !== "active")
			throw new Error(
				`Bootstrap cannot add to organization ${organization.slug}: it is ${organization.status}`,
			);
	}

	const empty =
		snapshot.organizations.length === 0 &&
		snapshot.projects.length === 0 &&
		snapshot.instances.length === 0 &&
		snapshot.credentialInstanceIds.size === 0;
	const complete =
		organizationsToCreate.length +
			logicalProjectsToCreate.length +
			projectInstancesToCreate.length ===
		0;
	return {
		state: empty ? "empty" : complete ? "exact" : "incomplete",
		organizationCount: organizations.size,
		logicalProjectCount: projects.size,
		projectInstanceCount: instances.size,
		organizationsToCreate,
		logicalProjectsToCreate,
		projectInstancesToCreate,
		credentialsToIssue,
		readOnlyCredentialsToIssue,
	};
}

/** Slugs and keys are lowercase identifiers, so naming them never echoes free text. */
function drift(detail: string): Error {
	return new Error(`BILLING_PLATFORM_BOOTSTRAP_JSON does not match database state: ${detail}`);
}
