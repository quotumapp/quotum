import type { PlatformQueryExecutor } from "./query-executor";

export interface PlatformOrganizationRecord {
	id: string;
	slug: string;
	name: string;
}

export interface PlatformLogicalProjectRecord {
	id: string;
	organizationId: string;
	key: string;
	name: string;
}

export interface PlatformProjectCredentialRecord {
	id: string;
	projectInstanceId: string;
	revokedAt: Date | null;
}

export class PlatformOrganizationRepository {
	constructor(private readonly executor: PlatformQueryExecutor) {}

	async list(): Promise<readonly PlatformOrganizationRecord[]> {
		const rows = await this.executor.query<{
			id: string;
			slug: string;
			name: string;
		}>({
			text: `
				SELECT id, slug, name
				FROM platform_organizations
				ORDER BY slug
			`,
			values: [],
		});
		return rows;
	}

	async create(input: { slug: string; name: string }): Promise<PlatformOrganizationRecord> {
		const rows = await this.executor.query<{
			id: string;
			slug: string;
			name: string;
		}>({
			text: `
				INSERT INTO platform_organizations (slug, name)
				VALUES ($1, $2)
				RETURNING id, slug, name
			`,
			values: [input.slug, input.name],
		});
		const row = rows[0];
		if (row === undefined) throw new Error("Platform organization could not be created");
		return row;
	}
}

export class PlatformLogicalProjectRepository {
	constructor(private readonly executor: PlatformQueryExecutor) {}

	async list(): Promise<readonly PlatformLogicalProjectRecord[]> {
		const rows = await this.executor.query<{
			id: string;
			organization_id: string;
			key: string;
			name: string;
		}>({
			text: `
				SELECT id, organization_id, key, name
				FROM platform_projects
				ORDER BY organization_id, key
			`,
			values: [],
		});
		return rows.map((row) => ({
			id: row.id,
			organizationId: row.organization_id,
			key: row.key,
			name: row.name,
		}));
	}

	async create(input: {
		organizationId: string;
		key: string;
		name: string;
	}): Promise<PlatformLogicalProjectRecord> {
		const rows = await this.executor.query<{
			id: string;
			organization_id: string;
			key: string;
			name: string;
		}>({
			text: `
				INSERT INTO platform_projects (organization_id, key, name)
				VALUES ($1, $2, $3)
				RETURNING id, organization_id, key, name
			`,
			values: [input.organizationId, input.key, input.name],
		});
		const row = rows[0];
		if (row === undefined) throw new Error("Platform logical project could not be created");
		return {
			id: row.id,
			organizationId: row.organization_id,
			key: row.key,
			name: row.name,
		};
	}
}

export class PlatformProjectCredentialRepository {
	constructor(private readonly executor: PlatformQueryExecutor) {}

	async list(): Promise<readonly PlatformProjectCredentialRecord[]> {
		const rows = await this.executor.query<{
			id: string;
			project_instance_id: string;
			revoked_at: Date | null;
		}>({
			text: `
				SELECT id, project_instance_id, revoked_at
				FROM platform_project_api_credentials
				ORDER BY project_instance_id, created_at
			`,
			values: [],
		});
		return rows.map((row) => ({
			id: row.id,
			projectInstanceId: row.project_instance_id,
			revokedAt: row.revoked_at,
		}));
	}

	async create(input: {
		id: string;
		projectInstanceId: string;
		secretVerifier: Uint8Array;
	}): Promise<void> {
		await this.executor.query({
			text: `
				INSERT INTO platform_project_api_credentials (
					id,
					project_instance_id,
					audience,
					secret_verifier
				)
				VALUES ($1, $2, 'billing_api', $3)
			`,
			values: [input.id, input.projectInstanceId, input.secretVerifier],
		});
	}
}

export async function acquirePlatformBootstrapLock(executor: PlatformQueryExecutor): Promise<void> {
	await executor.query({
		text: "SELECT pg_advisory_xact_lock($1, $2)",
		values: [760_911, 520_384_007],
	});
}
