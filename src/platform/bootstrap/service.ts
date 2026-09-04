import type {
	PlatformProjectInstanceRecord,
	PlatformTransactionResources,
	PlatformUnitOfWork,
} from "../application/ports";
import {
	acquirePlatformBootstrapLock,
	type PlatformLogicalProjectRecord,
	PlatformLogicalProjectRepository,
	type PlatformOrganizationRecord,
	PlatformOrganizationRepository,
	PlatformProjectCredentialRepository,
} from "../persistence/repositories";
import type { PlatformBootstrapManifest } from "./manifest";

export interface PreparedPlatformCredential {
	credentialId: string;
	projectInstanceKey: string;
	secretVerifier: Uint8Array;
}

export interface PlatformBootstrapInspection {
	state: "empty" | "exact";
	organizationCount: number;
	logicalProjectCount: number;
	projectInstanceCount: number;
	credentialsToIssue: readonly string[];
}

export interface PlatformBootstrapResult extends PlatformBootstrapInspection {
	credentialsIssued: number;
}

interface PlatformSnapshot {
	organizations: readonly PlatformOrganizationRecord[];
	projects: readonly PlatformLogicalProjectRecord[];
	instances: readonly PlatformProjectInstanceRecord[];
	credentialInstanceIds: ReadonlySet<string>;
}

export class PlatformBootstrapService {
	constructor(private readonly unitOfWork: PlatformUnitOfWork) {}

	async inspect(manifest: PlatformBootstrapManifest): Promise<PlatformBootstrapInspection> {
		return await this.unitOfWork.transaction(async (resources) => {
			await acquirePlatformBootstrapLock(resources.executor);
			return await inspectManifest(resources, manifest);
		});
	}

	async apply(
		manifest: PlatformBootstrapManifest,
		preparedCredentials: readonly PreparedPlatformCredential[],
	): Promise<PlatformBootstrapResult> {
		return await this.unitOfWork.transaction(async (resources) => {
			await acquirePlatformBootstrapLock(resources.executor);
			let inspection = await inspectManifest(resources, manifest);
			let instancesByKey = new Map<string, PlatformProjectInstanceRecord>();

			if (inspection.state === "empty") {
				instancesByKey = await createTopology(resources, manifest);
				inspection = await inspectManifest(resources, manifest);
			} else {
				const instances = await resources.projectInstances.list();
				instancesByKey = new Map(instances.map((instance) => [instance.key, instance]));
			}

			const expectedCredentialKeys = [...inspection.credentialsToIssue].sort();
			const preparedCredentialKeys = preparedCredentials
				.map((credential) => credential.projectInstanceKey)
				.sort();
			if (JSON.stringify(expectedCredentialKeys) !== JSON.stringify(preparedCredentialKeys)) {
				throw new Error("Prepared credentials do not match the platform bootstrap plan");
			}

			const credentials = new PlatformProjectCredentialRepository(resources.executor);
			for (const prepared of preparedCredentials) {
				const instance = instancesByKey.get(prepared.projectInstanceKey);
				if (instance === undefined) {
					throw new Error(`Unknown bootstrap project instance: ${prepared.projectInstanceKey}`);
				}
				await credentials.create({
					id: prepared.credentialId,
					projectInstanceId: instance.id,
					secretVerifier: prepared.secretVerifier,
				});
			}

			const completed = await inspectManifest(resources, manifest);
			return { ...completed, credentialsIssued: preparedCredentials.length };
		});
	}
}

async function inspectManifest(
	resources: PlatformTransactionResources,
	manifest: PlatformBootstrapManifest,
): Promise<PlatformBootstrapInspection> {
	const organizations = new PlatformOrganizationRepository(resources.executor);
	const projects = new PlatformLogicalProjectRepository(resources.executor);
	const credentials = new PlatformProjectCredentialRepository(resources.executor);
	const snapshot: PlatformSnapshot = {
		organizations: await organizations.list(),
		projects: await projects.list(),
		instances: await resources.projectInstances.list(),
		credentialInstanceIds: new Set(
			(await credentials.list()).map((credential) => credential.projectInstanceId),
		),
	};
	const expected = flattenManifest(manifest);
	const empty =
		snapshot.organizations.length === 0 &&
		snapshot.projects.length === 0 &&
		snapshot.instances.length === 0 &&
		snapshot.credentialInstanceIds.size === 0;
	if (!empty) assertSnapshotMatches(expected, snapshot);

	const instanceIdsByKey = new Map(
		snapshot.instances.map((instance) => [instance.key, instance.id]),
	);
	const credentialsToIssue = expected.instances
		.filter((instance) => {
			if (!instance.issueCredential) return false;
			const instanceId = instanceIdsByKey.get(instance.key);
			return instanceId === undefined || !snapshot.credentialInstanceIds.has(instanceId);
		})
		.map((instance) => instance.key)
		.sort();

	return {
		state: empty ? "empty" : "exact",
		organizationCount: expected.organizations.length,
		logicalProjectCount: expected.projects.length,
		projectInstanceCount: expected.instances.length,
		credentialsToIssue,
	};
}

async function createTopology(
	resources: PlatformTransactionResources,
	manifest: PlatformBootstrapManifest,
): Promise<Map<string, PlatformProjectInstanceRecord>> {
	const organizations = new PlatformOrganizationRepository(resources.executor);
	const projects = new PlatformLogicalProjectRepository(resources.executor);
	const instancesByKey = new Map<string, PlatformProjectInstanceRecord>();
	for (const organizationInput of manifest.organizations) {
		const organization = await organizations.create({
			slug: organizationInput.slug,
			name: organizationInput.name,
		});
		for (const projectInput of organizationInput.projects) {
			const project = await projects.create({
				organizationId: organization.id,
				key: projectInput.key,
				name: projectInput.name,
			});
			for (const instanceInput of projectInput.instances) {
				const instance = await resources.projectInstances.create({
					platformProjectId: project.id,
					key: instanceInput.key,
					name: projectInput.name,
					environment: instanceInput.environment,
					lifecycleStatus: instanceInput.lifecycleStatus,
					internalProject: instanceInput.environment === "internal",
				});
				instancesByKey.set(instance.key, instance);
			}
		}
	}
	return instancesByKey;
}

function flattenManifest(manifest: PlatformBootstrapManifest) {
	return {
		organizations: manifest.organizations.map(({ slug, name }) => ({ slug, name })),
		projects: manifest.organizations.flatMap((organization) =>
			organization.projects.map((project) => ({
				organizationSlug: organization.slug,
				key: project.key,
				name: project.name,
			})),
		),
		instances: manifest.organizations.flatMap((organization) =>
			organization.projects.flatMap((project) =>
				project.instances.map((instance) => ({
					organizationSlug: organization.slug,
					logicalProjectKey: project.key,
					name: project.name,
					key: instance.key,
					environment: instance.environment,
					lifecycleStatus: instance.lifecycleStatus,
					internalProject: instance.environment === "internal",
					issueCredential: instance.issueCredential,
				})),
			),
		),
	};
}

function assertSnapshotMatches(
	expected: ReturnType<typeof flattenManifest>,
	snapshot: PlatformSnapshot,
): void {
	const organizationsById = new Map(snapshot.organizations.map((item) => [item.id, item]));
	const projectsById = new Map(snapshot.projects.map((item) => [item.id, item]));
	const actualOrganizations = snapshot.organizations
		.map(({ slug, name }) => ({ slug, name }))
		.sort(compareJson);
	const actualProjects = snapshot.projects
		.map((project) => ({
			organizationSlug: organizationsById.get(project.organizationId)?.slug,
			key: project.key,
			name: project.name,
		}))
		.sort(compareJson);
	const actualInstances = snapshot.instances
		.map((instance) => {
			const project = projectsById.get(instance.platformProjectId);
			return {
				organizationSlug:
					project === undefined ? undefined : organizationsById.get(project.organizationId)?.slug,
				logicalProjectKey: project?.key,
				name: instance.name,
				key: instance.key,
				environment: instance.environment,
				lifecycleStatus: instance.lifecycleStatus,
				internalProject: instance.internalProject,
			};
		})
		.sort(compareJson);
	const expectedInstances = expected.instances
		.map(({ issueCredential: _issueCredential, ...instance }) => instance)
		.sort(compareJson);

	if (
		JSON.stringify(actualOrganizations) !==
			JSON.stringify([...expected.organizations].sort(compareJson)) ||
		JSON.stringify(actualProjects) !== JSON.stringify([...expected.projects].sort(compareJson)) ||
		JSON.stringify(actualInstances) !== JSON.stringify(expectedInstances)
	) {
		throw new Error("BILLING_PLATFORM_BOOTSTRAP_JSON does not match database state");
	}

	const expectedCredentialInstanceIds = new Set(
		expected.instances
			.filter((instance) => instance.issueCredential)
			.map((instance) => snapshot.instances.find((row) => row.key === instance.key)?.id),
	);
	for (const credentialInstanceId of snapshot.credentialInstanceIds) {
		if (!expectedCredentialInstanceIds.has(credentialInstanceId)) {
			throw new Error("Database contains a project credential not declared by bootstrap manifest");
		}
	}
}

function compareJson(left: unknown, right: unknown): number {
	return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
