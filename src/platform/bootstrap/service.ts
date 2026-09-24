import type { CredentialAccess } from "../../shared/credential-access";
import type {
	PlatformProjectInstanceRecord,
	PlatformTransactionResources,
	PlatformUnitOfWork,
} from "../application/ports";
import {
	acquirePlatformBootstrapLock,
	PlatformLogicalProjectRepository,
	PlatformOrganizationRepository,
	PlatformProjectCredentialRepository,
} from "../persistence/repositories";
import type { PlatformBootstrapManifest } from "./manifest";
import {
	indexPlatformSnapshot,
	type PlatformBootstrapInspection,
	type PlatformBootstrapSnapshot,
	planPlatformBootstrap,
} from "./plan";

export type { PlatformBootstrapInspection } from "./plan";

export interface PreparedPlatformCredential {
	credentialId: string;
	projectInstanceKey: string;
	environment: "sandbox" | "production";
	access: CredentialAccess;
	secretVerifier: Uint8Array;
}

export interface PlatformBootstrapResult extends PlatformBootstrapInspection {
	credentialsIssued: number;
	/** What this run created, named as in the inspection's `*ToCreate` lists. */
	organizationsCreated: readonly string[];
	logicalProjectsCreated: readonly string[];
	projectInstancesCreated: readonly string[];
}

export class PlatformBootstrapService {
	constructor(private readonly unitOfWork: PlatformUnitOfWork) {}

	async inspect(manifest: PlatformBootstrapManifest): Promise<PlatformBootstrapInspection> {
		return await this.unitOfWork.transaction(async (resources) => {
			await acquirePlatformBootstrapLock(resources.executor);
			return planPlatformBootstrap(manifest, await readSnapshot(resources));
		});
	}

	/**
	 * Plans again under the lock, creates the declared rows that are missing and stores the prepared
	 * credentials. A concurrent run that already issued a planned credential makes this one fail
	 * instead of issuing a second.
	 */
	async apply(
		manifest: PlatformBootstrapManifest,
		preparedCredentials: readonly PreparedPlatformCredential[],
	): Promise<PlatformBootstrapResult> {
		return await this.unitOfWork.transaction(async (resources) => {
			await acquirePlatformBootstrapLock(resources.executor);
			const snapshot = await readSnapshot(resources);
			const plan = planPlatformBootstrap(manifest, snapshot);

			const expectedCredentialKeys = [
				...plan.credentialsToIssue.map((key) => `${key}:full`),
				...plan.readOnlyCredentialsToIssue.map((key) => `${key}:read_only`),
			].sort();
			const preparedCredentialKeys = preparedCredentials
				.map((credential) => `${credential.projectInstanceKey}:${credential.access}`)
				.sort();
			if (JSON.stringify(expectedCredentialKeys) !== JSON.stringify(preparedCredentialKeys)) {
				throw new Error("Prepared credentials do not match the platform bootstrap plan");
			}

			const instancesByKey = await createMissingTopology(resources, manifest, snapshot, plan);
			const credentials = new PlatformProjectCredentialRepository(resources.executor);
			for (const prepared of preparedCredentials) {
				const instance = instancesByKey.get(prepared.projectInstanceKey);
				if (instance === undefined) {
					throw new Error(`Unknown bootstrap project instance: ${prepared.projectInstanceKey}`);
				}
				if (instance.environment !== prepared.environment) {
					throw new Error("Prepared credentials do not match the platform bootstrap plan");
				}
				await credentials.create({
					id: prepared.credentialId,
					projectInstanceId: instance.id,
					access: prepared.access,
					secretVerifier: prepared.secretVerifier,
				});
			}

			const completed = planPlatformBootstrap(manifest, await readSnapshot(resources));
			if (completed.state !== "exact")
				throw new Error("Platform bootstrap did not create every declared row");
			return {
				...completed,
				credentialsIssued: preparedCredentials.length,
				organizationsCreated: plan.organizationsToCreate,
				logicalProjectsCreated: plan.logicalProjectsToCreate,
				projectInstancesCreated: plan.projectInstancesToCreate,
			};
		});
	}
}

async function readSnapshot(
	resources: PlatformTransactionResources,
): Promise<PlatformBootstrapSnapshot> {
	const stored = await new PlatformProjectCredentialRepository(resources.executor).list();
	return {
		organizations: await new PlatformOrganizationRepository(resources.executor).list(),
		projects: await new PlatformLogicalProjectRepository(resources.executor).list(),
		instances: await resources.projectInstances.list(),
		credentialInstanceIds: new Set(stored.map((credential) => credential.projectInstanceId)),
		credentialKinds: new Set(
			stored.map((credential) => `${credential.projectInstanceId}:${credential.access}`),
		),
	};
}

/** Inserts the planned rows in manifest order, under the organizations and projects that exist. */
async function createMissingTopology(
	resources: PlatformTransactionResources,
	manifest: PlatformBootstrapManifest,
	snapshot: PlatformBootstrapSnapshot,
	plan: PlatformBootstrapInspection,
): Promise<Map<string, PlatformProjectInstanceRecord>> {
	const stored = indexPlatformSnapshot(snapshot);
	const organizations = new PlatformOrganizationRepository(resources.executor);
	const projects = new PlatformLogicalProjectRepository(resources.executor);
	const createOrganizations = new Set(plan.organizationsToCreate);
	const createProjects = new Set(plan.logicalProjectsToCreate);
	const createInstances = new Set(plan.projectInstancesToCreate);
	const instancesByKey = new Map(stored.instancesByKey);
	for (const organizationInput of manifest.organizations) {
		const organizationId = createOrganizations.has(organizationInput.slug)
			? (await organizations.create({ slug: organizationInput.slug, name: organizationInput.name }))
					.id
			: stored.organizationsBySlug.get(organizationInput.slug)?.id;
		if (organizationId === undefined)
			throw new Error(`Platform organization ${organizationInput.slug} is missing`);
		for (const projectInput of organizationInput.projects) {
			const path = `${organizationInput.slug}/${projectInput.key}`;
			const projectId = createProjects.has(path)
				? (
						await projects.create({
							organizationId,
							key: projectInput.key,
							name: projectInput.name,
						})
					).id
				: stored.projectsByPath.get(path)?.id;
			if (projectId === undefined) throw new Error(`Platform logical project ${path} is missing`);
			for (const instanceInput of projectInput.instances) {
				if (!createInstances.has(instanceInput.key)) continue;
				const instance = await resources.projectInstances.create({
					platformProjectId: projectId,
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
