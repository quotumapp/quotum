import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createTestPlatformManifest } from "../../scripts/lib/test-platform-bootstrap";
import {
	BunPlatformUnitOfWork,
	PostgresProjectInstanceContextResolver,
} from "../../src/composition/project-instance-persistence";
import { PlatformBootstrapService } from "../../src/platform/bootstrap/service";
import {
	generateProjectApiCredential,
	parseProjectApiCredential,
} from "../../src/platform/credentials/project-api-token";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import {
	integrationProjectContext,
	integrationProjectCredential,
} from "./helpers/platform-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const manifest = createTestPlatformManifest(["voysee", "wiseley"]);
let context: LocalPostgresContext;

localDescribe("platform project identity persistence", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("keeps bootstrap idempotent and rejects topology drift", async () => {
		const service = new PlatformBootstrapService(new BunPlatformUnitOfWork(context.sql));
		await expect(service.inspect(manifest)).resolves.toEqual({
			state: "exact",
			organizationCount: 2,
			logicalProjectCount: 3,
			projectInstanceCount: 5,
			credentialsToIssue: [],
		});
		await expect(service.apply(manifest, [])).resolves.toEqual({
			state: "exact",
			organizationCount: 2,
			logicalProjectCount: 3,
			projectInstanceCount: 5,
			credentialsToIssue: [],
			credentialsIssued: 0,
		});

		const unexpected = generateProjectApiCredential();
		await expect(
			service.apply(manifest, [
				{
					credentialId: unexpected.credentialId,
					projectInstanceKey: "voysee",
					secretVerifier: unexpected.secretVerifier,
				},
			]),
		).rejects.toThrow("Prepared credentials do not match the platform bootstrap plan");

		const drifted = structuredClone(manifest);
		const organization = drifted.organizations[0];
		if (organization === undefined) throw new Error("Expected a bootstrap organization");
		organization.name = "Drifted Organization";
		await expect(service.inspect(drifted)).rejects.toThrow(
			"BILLING_PLATFORM_BOOTSTRAP_JSON does not match database state",
		);
	});

	it("installs the complete constrained and indexed platform ownership schema", async () => {
		const tables = await context.sql<Array<{ table_name: string }>>`
			SELECT table_name
			FROM information_schema.tables
			WHERE table_schema = current_schema()
				AND table_name LIKE 'platform!_%' ESCAPE '!'
			ORDER BY table_name
		`;
		expect(tables.map((row) => row.table_name)).toEqual([
			"platform_audit_events",
			"platform_auth_accounts",
			"platform_auth_links",
			"platform_auth_rate_limits",
			"platform_auth_sessions",
			"platform_auth_two_factors",
			"platform_auth_users",
			"platform_auth_verifications",
			"platform_connection_oauth_states",
			"platform_connection_operations",
			"platform_connection_secrets",
			"platform_connection_versions",
			"platform_connections",
			"platform_external_identities",
			"platform_idempotency",
			"platform_invitations",
			"platform_memberships",
			"platform_merchant_sessions",
			"platform_onboarding_drafts",
			"platform_organizations",
			"platform_policy_acceptances",
			"platform_principals",
			"platform_project_api_credentials",
			"platform_projects",
			"platform_provisioning_operations",
			"platform_provisioning_steps",
			"platform_rate_limits",
			"platform_service_principals",
			"platform_step_up_grants",
			"platform_stripe_app_events",
		]);

		const constraints = await context.sql<Array<{ table_name: string; constraint_name: string }>>`
			SELECT relation.relname AS table_name, constraint_record.conname AS constraint_name
			FROM pg_constraint constraint_record
			JOIN pg_class relation ON relation.oid = constraint_record.conrelid
			JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = current_schema()
				AND relation.relname IN (
					'platform_organizations',
					'platform_projects',
					'projects',
					'platform_project_api_credentials'
				)
		`;
		const constraintNames = new Set(constraints.map((row) => row.constraint_name));
		for (const expected of [
			"platform_organizations_slug_format_check",
			"platform_organizations_name_check",
			"platform_projects_organization_id_fkey",
			"platform_projects_key_format_check",
			"platform_projects_name_check",
			"platform_projects_organization_key_unique",
			"projects_platform_project_id_fkey",
			"projects_key_format_check",
			"projects_name_check",
			"projects_environment_check",
			"projects_lifecycle_status_check",
			"projects_internal_environment_check",
			"projects_platform_project_environment_unique",
			"platform_project_api_credentials_project_instance_id_fkey",
			"platform_project_api_credentials_audience_check",
			"platform_project_api_credentials_verifier_check",
			"platform_project_api_credentials_expiry_check",
			"platform_project_api_credentials_revocation_check",
		]) {
			expect(constraintNames.has(expected)).toBe(true);
		}

		const foreignKeys = await context.sql<
			Array<{ constraint_name: string; delete_action: string }>
		>`
			SELECT
				constraint_record.conname AS constraint_name,
				constraint_record.confdeltype::text AS delete_action
			FROM pg_constraint constraint_record
			JOIN pg_class relation ON relation.oid = constraint_record.conrelid
			JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = current_schema()
				AND constraint_record.conname IN (
					'platform_projects_organization_id_fkey',
					'projects_platform_project_id_fkey',
					'platform_project_api_credentials_project_instance_id_fkey'
				)
			ORDER BY constraint_record.conname
		`;
		expect(foreignKeys).toEqual([
			{
				constraint_name: "platform_project_api_credentials_project_instance_id_fkey",
				delete_action: "r",
			},
			{ constraint_name: "platform_projects_organization_id_fkey", delete_action: "r" },
			{ constraint_name: "projects_platform_project_id_fkey", delete_action: "r" },
		]);

		const indexes = await context.sql<Array<{ indexname: string }>>`
			SELECT indexname
			FROM pg_indexes
			WHERE schemaname = current_schema()
		`;
		const indexNames = new Set(indexes.map((row) => row.indexname));
		for (const expected of [
			"idx_platform_organizations_slug",
			"idx_platform_projects_organization",
			"idx_billing_projects_platform_project",
			"idx_platform_project_api_credentials_instance",
			"idx_platform_project_api_credentials_active_instance",
		]) {
			expect(indexNames.has(expected)).toBe(true);
		}
	});

	it("resolves the same database-authoritative context by credential, key, and id", async () => {
		const resolver = new PostgresProjectInstanceContextResolver(context.sql);
		const expected = integrationProjectContext("voysee");
		const sandbox = integrationProjectContext("voysee-sandbox");
		const otherOrganization = integrationProjectContext("wiseley");
		const otherSandbox = integrationProjectContext("wiseley-sandbox");
		expect(expected.logicalProjectId).toBe(sandbox.logicalProjectId);
		expect(expected.logicalProjectKey).toBe("voysee");
		expect(expected.environment).toBe("production");
		expect(sandbox.environment).toBe("sandbox");
		expect(expected.projectInstanceId).not.toBe(sandbox.projectInstanceId);
		expect(expected.organizationId).not.toBe(otherOrganization.organizationId);
		expect(otherOrganization.logicalProjectId).toBe(otherSandbox.logicalProjectId);
		expect(otherOrganization.environment).toBe("production");
		expect(otherSandbox.environment).toBe("sandbox");
		expect(otherOrganization.projectInstanceId).not.toBe(otherSandbox.projectInstanceId);
		await expect(
			resolver.resolveCredential(integrationProjectCredential("voysee")),
		).resolves.toEqual({ kind: "resolved", context: expected });
		await expect(resolver.resolveInstanceKey(expected.projectInstanceKey)).resolves.toEqual({
			kind: "resolved",
			context: expected,
		});
		await expect(resolver.resolveInstanceId(expected.projectInstanceId)).resolves.toEqual({
			kind: "resolved",
			context: expected,
		});

		const credential = integrationProjectCredential("voysee");
		const modified = `${credential.slice(0, -1)}${credential.endsWith("A") ? "B" : "A"}`;
		await expect(resolver.resolveCredential(modified)).resolves.toEqual({ kind: "not_found" });
	});

	it("resolves an internal project instance without issuing a public credential", async () => {
		const key = "billing-internal";
		const expected = integrationProjectContext(key);
		const resolver = new PostgresProjectInstanceContextResolver(context.sql);
		await expect(resolver.resolveInstanceKey(key)).resolves.toEqual({
			kind: "resolved",
			context: expected,
		});
		expect(expected.environment).toBe("internal");
		expect(expected.internalProject).toBe(true);
		const credentials = await context.sql<Array<{ count: number }>>`
			SELECT count(*)::integer AS count
			FROM platform_project_api_credentials
			WHERE project_instance_id = ${expected.projectInstanceId}
		`;
		expect(credentials[0]?.count).toBe(0);
	});

	it("stores only a verifier and treats expired credentials as ineligible", async () => {
		const token = integrationProjectCredential("voysee");
		const parsed = parseProjectApiCredential(token);
		if (parsed === null) throw new Error("Expected a versioned integration credential");
		const rows = await context.sql<
			Array<{ verifier_hex: string; created_at: Date; expires_at: Date | null }>
		>`
			SELECT encode(secret_verifier, 'hex') AS verifier_hex, created_at, expires_at
			FROM platform_project_api_credentials
			WHERE id = ${parsed.credentialId}
		`;
		const row = rows[0];
		if (row === undefined) throw new Error("Expected a persisted credential verifier");
		expect(row.verifier_hex).toBe(Buffer.from(parsed.secretVerifier).toString("hex"));
		expect(row.verifier_hex).not.toContain(token);

		try {
			await context.sql`
				UPDATE platform_project_api_credentials
				SET created_at = now() - INTERVAL '2 days',
					expires_at = now() - INTERVAL '1 day',
					updated_at = now()
				WHERE id = ${parsed.credentialId}
			`;
			const resolver = new PostgresProjectInstanceContextResolver(context.sql);
			await expect(resolver.resolveCredential(token)).resolves.toEqual({ kind: "ineligible" });
		} finally {
			await context.sql`
				UPDATE platform_project_api_credentials
				SET created_at = ${row.created_at.toISOString()},
					expires_at = ${row.expires_at?.toISOString() ?? null},
					updated_at = now()
				WHERE id = ${parsed.credentialId}
			`;
		}
	});
});
