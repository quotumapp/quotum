import { timingSafeEqual } from "node:crypto";
import type { SQL } from "bun";
import { sql as defaultSql } from "../db/client";
import type {
	CreatePlatformProjectInstanceInput,
	PlatformProjectInstanceRecord,
	PlatformProjectInstanceStore,
	PlatformTransactionResources,
	PlatformUnitOfWork,
} from "../platform/application/ports";
import { parseProjectApiCredential } from "../platform/credentials/project-api-token";
import type {
	PlatformQuery,
	PlatformQueryExecutor,
	PlatformQueryValue,
} from "../platform/persistence/query-executor";
import type {
	ProjectEnvironment,
	ProjectInstanceContext,
	ProjectInstanceContextResolver,
	ProjectInstanceLookupResult,
	ProjectLifecycleStatus,
} from "../projects/context";

interface SqlClient {
	unsafe<Row extends object>(query: string, values?: readonly PlatformQueryValue[]): Promise<Row[]>;
}

interface ProjectContextRow {
	organization_id: string;
	organization_slug: string;
	organization_status?: "active" | "suspended" | "removed";
	logical_project_id: string;
	logical_project_key: string;
	project_instance_id: string;
	project_instance_key: string;
	environment: string;
	lifecycle_status: string;
	internal_project: boolean;
}

interface CredentialContextRow extends ProjectContextRow {
	secret_verifier: Uint8Array;
	expires_at: Date | null;
	revoked_at: Date | null;
}

const environmentValues = new Set<ProjectEnvironment>(["sandbox", "production", "internal"]);
const lifecycleValues = new Set<ProjectLifecycleStatus>([
	"inactive",
	"active",
	"suspended",
	"deactivating",
	"deactivated",
]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instanceKeyPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/u;

export class BunPlatformQueryExecutor implements PlatformQueryExecutor {
	constructor(private readonly client: SqlClient) {}

	async query<Row>(query: PlatformQuery): Promise<readonly Row[]> {
		return (await this.client.unsafe<object>(
			query.text,
			query.values,
		)) as unknown as readonly Row[];
	}
}

export class BunPlatformUnitOfWork implements PlatformUnitOfWork {
	constructor(private readonly client: SQL = defaultSql) {}

	async transaction<Result>(
		work: (resources: PlatformTransactionResources) => Promise<Result>,
	): Promise<Result> {
		return (await this.client.begin(async (transaction) => {
			const executor = new BunPlatformQueryExecutor(transaction as unknown as SqlClient);
			return await work({
				executor,
				projectInstances: new BunProjectInstanceStore(executor),
			});
		})) as Result;
	}
}

export class BunProjectInstanceStore implements PlatformProjectInstanceStore {
	constructor(private readonly executor: PlatformQueryExecutor) {}

	async forProject(platformProjectId: string): Promise<readonly PlatformProjectInstanceRecord[]> {
		const rows = await this.executor.query<Parameters<typeof mapProjectInstanceRow>[0]>({
			text: "SELECT id,platform_project_id,key,name,environment,lifecycle_status,internal_project FROM projects WHERE platform_project_id=$1 ORDER BY environment",
			values: [platformProjectId],
		});
		return rows.map(mapProjectInstanceRow);
	}

	async list(): Promise<readonly PlatformProjectInstanceRecord[]> {
		const rows = await this.executor.query<{
			id: string;
			platform_project_id: string;
			key: string;
			name: string;
			environment: ProjectEnvironment;
			lifecycle_status: ProjectLifecycleStatus;
			internal_project: boolean;
		}>({
			text: `
				SELECT
					id,
					platform_project_id,
					key,
					name,
					environment,
					lifecycle_status,
					internal_project
				FROM projects
				ORDER BY key
			`,
			values: [],
		});
		return rows.map(mapProjectInstanceRow);
	}

	async create(input: CreatePlatformProjectInstanceInput): Promise<PlatformProjectInstanceRecord> {
		const rows = await this.executor.query<{
			id: string;
			platform_project_id: string;
			key: string;
			name: string;
			environment: ProjectEnvironment;
			lifecycle_status: ProjectLifecycleStatus;
			internal_project: boolean;
		}>({
			text: `
				INSERT INTO projects (
					platform_project_id,
					key,
					name,
					environment,
					lifecycle_status,
					internal_project
				)
				VALUES ($1, $2, $3, $4, $5, $6)
				RETURNING
					id,
					platform_project_id,
					key,
					name,
					environment,
					lifecycle_status,
					internal_project
			`,
			values: [
				input.platformProjectId,
				input.key,
				input.name,
				input.environment,
				input.lifecycleStatus,
				input.internalProject,
			],
		});
		const row = rows[0];
		if (row === undefined) throw new Error("Billing project instance could not be created");
		await this.executor.query({
			text: "INSERT INTO metering_settings (project_id) VALUES ($1)",
			values: [row.id],
		});
		return mapProjectInstanceRow(row);
	}
}

export class PostgresProjectInstanceContextResolver implements ProjectInstanceContextResolver {
	private readonly executor: PlatformQueryExecutor;

	constructor(client: SQL = defaultSql) {
		this.executor = new BunPlatformQueryExecutor(client as unknown as SqlClient);
	}

	async resolveCredential(credential: string): Promise<ProjectInstanceLookupResult> {
		const parsed = parseProjectApiCredential(credential);
		if (parsed === null) return { kind: "not_found" };
		try {
			const rows = await this.executor.query<CredentialContextRow>({
				text: `
					SELECT
						credentials.secret_verifier,
						credentials.expires_at,
						credentials.revoked_at,
						organizations.id AS organization_id,
						organizations.slug AS organization_slug,
                            organizations.status AS organization_status,
						logical_projects.id AS logical_project_id,
						logical_projects.key AS logical_project_key,
						instances.id AS project_instance_id,
						instances.key AS project_instance_key,
						instances.environment,
						instances.lifecycle_status,
						instances.internal_project
					FROM platform_project_api_credentials credentials
					JOIN projects instances ON instances.id = credentials.project_instance_id
					JOIN platform_projects logical_projects
						ON logical_projects.id = instances.platform_project_id
					JOIN platform_organizations organizations
						ON organizations.id = logical_projects.organization_id
					WHERE credentials.id = $1
						AND credentials.audience = 'billing_api'
				`,
				values: [parsed.credentialId],
			});
			const row = rows[0];
			if (row === undefined || !verifierMatches(parsed.secretVerifier, row.secret_verifier)) {
				return { kind: "not_found" };
			}
			if (
				row.revoked_at !== null ||
				(row.expires_at !== null && row.expires_at.getTime() <= Date.now())
			) {
				return { kind: "ineligible" };
			}
			return { kind: "resolved", context: mapProjectContextRow(row) };
		} catch {
			return { kind: "unavailable" };
		}
	}

	async resolveInstanceKey(projectInstanceKey: string): Promise<ProjectInstanceLookupResult> {
		if (!instanceKeyPattern.test(projectInstanceKey)) return { kind: "not_found" };
		return await this.resolveContext("instances.key = $1", projectInstanceKey);
	}

	async resolveInstanceId(projectInstanceId: string): Promise<ProjectInstanceLookupResult> {
		if (!uuidPattern.test(projectInstanceId)) return { kind: "not_found" };
		return await this.resolveContext("instances.id = $1", projectInstanceId);
	}

	private async resolveContext(
		predicate: "instances.key = $1" | "instances.id = $1",
		value: string,
	): Promise<ProjectInstanceLookupResult> {
		try {
			const byKey = predicate === "instances.key = $1";
			const rows = await this.executor.query<ProjectContextRow>({
				text: byKey
					? `
						SELECT
							organizations.id AS organization_id,
							organizations.slug AS organization_slug,
                            organizations.status AS organization_status,
							logical_projects.id AS logical_project_id,
							logical_projects.key AS logical_project_key,
							instances.id AS project_instance_id,
							instances.key AS project_instance_key,
							instances.environment,
							instances.lifecycle_status,
							instances.internal_project
						FROM projects instances
						JOIN platform_projects logical_projects
							ON logical_projects.id = instances.platform_project_id
						JOIN platform_organizations organizations
							ON organizations.id = logical_projects.organization_id
						WHERE instances.key = $1
					`
					: `
						SELECT
							organizations.id AS organization_id,
							organizations.slug AS organization_slug,
                            organizations.status AS organization_status,
							logical_projects.id AS logical_project_id,
							logical_projects.key AS logical_project_key,
							instances.id AS project_instance_id,
							instances.key AS project_instance_key,
							instances.environment,
							instances.lifecycle_status,
							instances.internal_project
						FROM projects instances
						JOIN platform_projects logical_projects
							ON logical_projects.id = instances.platform_project_id
						JOIN platform_organizations organizations
							ON organizations.id = logical_projects.organization_id
						WHERE instances.id = $1
					`,
				values: [value],
			});
			const row = rows[0];
			return row === undefined
				? { kind: "not_found" }
				: { kind: "resolved", context: mapProjectContextRow(row) };
		} catch {
			return { kind: "unavailable" };
		}
	}
}

function mapProjectInstanceRow(row: {
	id: string;
	platform_project_id: string;
	key: string;
	name: string;
	environment: ProjectEnvironment;
	lifecycle_status: ProjectLifecycleStatus;
	internal_project: boolean;
}): PlatformProjectInstanceRecord {
	return {
		id: row.id,
		platformProjectId: row.platform_project_id,
		key: row.key,
		name: row.name,
		environment: row.environment,
		lifecycleStatus: row.lifecycle_status,
		internalProject: row.internal_project,
	};
}

function mapProjectContextRow(row: ProjectContextRow): ProjectInstanceContext {
	if (!environmentValues.has(row.environment as ProjectEnvironment)) {
		throw new Error("Database project environment is invalid");
	}
	if (!lifecycleValues.has(row.lifecycle_status as ProjectLifecycleStatus)) {
		throw new Error("Database project lifecycle is invalid");
	}
	return {
		organizationId: row.organization_id,
		organizationSlug: row.organization_slug,
		logicalProjectId: row.logical_project_id,
		logicalProjectKey: row.logical_project_key,
		projectInstanceId: row.project_instance_id,
		projectInstanceKey: row.project_instance_key,
		environment: row.environment as ProjectEnvironment,
		lifecycleStatus: row.lifecycle_status as ProjectLifecycleStatus,
		internalProject: row.internal_project,
		...(row.organization_status && row.organization_status !== "active"
			? { organizationStatus: row.organization_status }
			: {}),
	};
}

function verifierMatches(actual: Uint8Array, expected: Uint8Array): boolean {
	const actualBuffer = Buffer.from(actual);
	const expectedBuffer = Buffer.from(expected);
	return (
		actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
	);
}

export async function activateProjectProduction(
	client: import("bun").SQL,
	instanceId: string,
	organizationId: string,
	catalogRevisionId: string,
): Promise<boolean> {
	const rows =
		await client`UPDATE projects SET lifecycle_status='active' WHERE id=${instanceId} AND environment='production' AND lifecycle_status='inactive' AND published_catalog_revision_id=${catalogRevisionId}::bigint AND platform_project_id IN (SELECT id FROM platform_projects WHERE organization_id=${organizationId}) AND (SELECT count(*) FROM projects i JOIN platform_projects p ON p.id=i.platform_project_id WHERE p.organization_id=${organizationId} AND i.environment='production' AND i.lifecycle_status='active') < (SELECT production_limit FROM platform_organizations WHERE id=${organizationId}) RETURNING id`;
	return rows.length === 1;
}
