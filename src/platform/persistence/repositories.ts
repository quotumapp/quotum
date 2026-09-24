import type { CredentialAccess } from "../../shared/credential-access";
import type { PlatformQueryExecutor } from "./query-executor";

export interface PlatformOrganizationRecord {
	id: string;
	slug: string;
	name: string;
}

export interface PlatformOrganizationListing extends PlatformOrganizationRecord {
	status: "active" | "suspended" | "removed";
	/** Whether any principal ever joined. Merchant onboarding always adds the organization's owner. */
	hasMembers: boolean;
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
	access: CredentialAccess;
	revokedAt: Date | null;
}

export class PlatformOrganizationRepository {
	constructor(private readonly executor: PlatformQueryExecutor) {}

	async list(): Promise<readonly PlatformOrganizationListing[]> {
		const rows = await this.executor.query<{
			id: string;
			slug: string;
			name: string;
			status: PlatformOrganizationListing["status"];
			has_members: boolean;
		}>({
			text: `
				SELECT
					o.id,
					o.slug,
					o.name,
					o.status,
					EXISTS (
						SELECT 1
						FROM platform_memberships m
						WHERE m.organization_id = o.id
					) AS has_members
				FROM platform_organizations o
				ORDER BY o.slug
			`,
			values: [],
		});
		return rows.map((row) => ({
			id: row.id,
			slug: row.slug,
			name: row.name,
			status: row.status,
			hasMembers: row.has_members,
		}));
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

	/** Serializes a draft step with a rename; the id never moves, so the lock cannot miss the row. */
	async lockById(id: string): Promise<void> {
		await this.executor.query({
			text: `
				SELECT id
				FROM platform_organizations
				WHERE id = $1
				FOR UPDATE
			`,
			values: [id],
		});
	}

	async slugBelongsToAnotherOrganization(slug: string, organizationId: string): Promise<boolean> {
		const rows = await this.executor.query<{ id: string }>({
			text: `
				SELECT id
				FROM platform_organizations
				WHERE slug = $1 AND id <> $2
			`,
			values: [slug, organizationId],
		});
		return rows.length > 0;
	}

	async update(input: { id: string; name: string; slug: string; updatedAt: Date }): Promise<void> {
		await this.executor.query({
			text: `
				UPDATE platform_organizations
				SET name = $1, slug = $2, updated_at = $3
				WHERE id = $4
			`,
			values: [input.name, input.slug, input.updatedAt, input.id],
		});
	}
}

export class PlatformOnboardingDraftRepository {
	constructor(private readonly executor: PlatformQueryExecutor) {}

	async bumpRevision(input: {
		id: string;
		expectedRevision: number;
		updatedAt: Date;
	}): Promise<boolean> {
		const rows = await this.executor.query<{ id: string }>({
			text: `
				UPDATE platform_onboarding_drafts
				SET revision = revision + 1, updated_at = $1
				WHERE id = $2 AND revision = $3
				RETURNING id
			`,
			values: [input.updatedAt, input.id, input.expectedRevision],
		});
		return rows.length > 0;
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
			access: CredentialAccess;
			revoked_at: Date | null;
		}>({
			text: `
				SELECT id, project_instance_id, access, revoked_at
				FROM platform_project_api_credentials
				ORDER BY project_instance_id, created_at
			`,
			values: [],
		});
		return rows.map((row) => ({
			id: row.id,
			projectInstanceId: row.project_instance_id,
			access: row.access,
			revokedAt: row.revoked_at,
		}));
	}

	/** `access` is named on every insert: the column default would otherwise mint a full key. */
	async create(input: {
		id: string;
		projectInstanceId: string;
		access: CredentialAccess;
		secretVerifier: Uint8Array;
	}): Promise<void> {
		await this.executor.query({
			text: `
				INSERT INTO platform_project_api_credentials (
					id,
					project_instance_id,
					audience,
					access,
					secret_verifier
				)
				VALUES ($1, $2, 'billing_api', $3, $4)
			`,
			values: [input.id, input.projectInstanceId, input.access, input.secretVerifier],
		});
	}
}

export async function acquirePlatformBootstrapLock(executor: PlatformQueryExecutor): Promise<void> {
	await executor.query({
		text: "SELECT pg_advisory_xact_lock($1, $2)",
		values: [760_911, 520_384_007],
	});
}
