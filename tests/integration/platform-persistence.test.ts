import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
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

		const unexpected = generateProjectApiCredential("production", "full");
		await expect(
			service.apply(manifest, [
				{
					credentialId: unexpected.credentialId,
					projectInstanceKey: "voysee",
					environment: unexpected.environment,
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
			"platform_project_api_credentials_access_check",
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
			"idx_platform_project_api_credentials_secret_verifier",
			"idx_platform_project_api_credentials_instance",
			"idx_platform_project_api_credentials_active_instance",
			"idx_platform_project_api_credentials_active_access",
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
		).resolves.toEqual({ kind: "resolved", context: expected, access: "full" });
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

	it("stores only a whole-token verifier under the internal credential UUID", async () => {
		const token = integrationProjectCredential("voysee");
		const sandboxToken = integrationProjectCredential("voysee-sandbox");
		expect(token).toMatch(/^pqpk_[A-Za-z0-9_-]{43}$/u);
		expect(sandboxToken).toMatch(/^sqpk_[A-Za-z0-9_-]{43}$/u);
		const parsed = parseProjectApiCredential(token);
		if (parsed === null) throw new Error("Expected an environment-prefixed integration credential");
		const rows = await context.sql<
			Array<{
				id: string;
				project_instance_id: string;
				verifier_hex: string;
				created_at: Date;
				expires_at: Date | null;
			}>
		>`
			SELECT id, project_instance_id, encode(secret_verifier, 'hex') AS verifier_hex, created_at,
				expires_at
			FROM platform_project_api_credentials
			WHERE secret_verifier = ${parsed.secretVerifier}
		`;
		const row = rows[0];
		if (row === undefined) throw new Error("Expected a persisted credential verifier");
		expect(rows).toHaveLength(1);
		expect(row.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
		expect(token).not.toContain(row.id);
		expect(row.project_instance_id).toBe(integrationProjectContext("voysee").projectInstanceId);
		expect(row.verifier_hex).toBe(Buffer.from(parsed.secretVerifier).toString("hex"));
		expect(row.verifier_hex).toBe(createHash("sha256").update(token, "utf8").digest("hex"));
		expect(row.verifier_hex).not.toContain(token.slice("pqpk_".length));

		const plan = await context.sql.begin(async (transaction) => {
			await transaction`SET LOCAL enable_seqscan = off`;
			return await transaction<Array<Record<string, string>>>`
				EXPLAIN (COSTS OFF)
				SELECT id FROM platform_project_api_credentials
				WHERE secret_verifier = ${parsed.secretVerifier}
			`;
		});
		expect(plan.map((line) => Object.values(line).join("")).join("\n")).toContain(
			"idx_platform_project_api_credentials_secret_verifier",
		);

		const resolver = new PostgresProjectInstanceContextResolver(context.sql);
		try {
			await context.sql`
				UPDATE platform_project_api_credentials
				SET created_at = now() - INTERVAL '2 days',
					expires_at = now() - INTERVAL '1 day',
					updated_at = now()
				WHERE id = ${row.id}
			`;
			await expect(resolver.resolveCredential(token)).resolves.toEqual({ kind: "ineligible" });
		} finally {
			await context.sql`
				UPDATE platform_project_api_credentials
				SET created_at = ${row.created_at.toISOString()},
					expires_at = ${row.expires_at?.toISOString() ?? null},
					updated_at = now()
				WHERE id = ${row.id}
			`;
		}
		await expect(resolver.resolveCredential(token)).resolves.toMatchObject({
			kind: "resolved",
		});
	});

	it("enforces verifier uniqueness across credentials", async () => {
		const token = integrationProjectCredential("voysee");
		const parsed = parseProjectApiCredential(token);
		if (parsed === null) throw new Error("Expected an environment-prefixed integration credential");
		const otherInstance = integrationProjectContext("wiseley").projectInstanceId;

		let captured: unknown = null;
		try {
			await context.sql`
				INSERT INTO platform_project_api_credentials (project_instance_id, secret_verifier)
				VALUES (${otherInstance}, ${parsed.secretVerifier})
			`;
		} catch (error) {
			captured = error;
		}
		expect((captured as { errno?: unknown } | null)?.errno).toBe("23505");
		const [count] = await context.sql<Array<{ count: number }>>`
			SELECT count(*)::integer AS count
			FROM platform_project_api_credentials
			WHERE secret_verifier = ${parsed.secretVerifier}
		`;
		expect(count?.count).toBe(1);
	});

	it("rejects a credential whose prefix does not match the stored instance environment", async () => {
		const resolver = new PostgresProjectInstanceContextResolver(context.sql);
		const production = integrationProjectContext("voysee");
		const sandbox = integrationProjectContext("voysee-sandbox");
		const internal = integrationProjectContext("billing-internal");
		const cases = [
			{
				token: generateProjectApiCredential("sandbox", "full"),
				instanceId: production.projectInstanceId,
			},
			{
				token: generateProjectApiCredential("production", "full"),
				instanceId: sandbox.projectInstanceId,
			},
			{
				token: generateProjectApiCredential("production", "full"),
				instanceId: internal.projectInstanceId,
			},
			{
				token: generateProjectApiCredential("sandbox", "full"),
				instanceId: internal.projectInstanceId,
			},
		];
		try {
			for (const { token, instanceId } of cases) {
				// Bootstrapped instances already hold their one live full key, so these rows are stored
				// revoked. A mismatch is `not_found`; only a matching revoked row is `ineligible`.
				await context.sql`
					INSERT INTO platform_project_api_credentials (
						id, project_instance_id, access, secret_verifier, revoked_at
					)
					VALUES (${token.credentialId}, ${instanceId}, 'full', ${token.secretVerifier}, now())
				`;
				await expect(resolver.resolveCredential(token.token)).resolves.toEqual({
					kind: "not_found",
				});
			}
			const unknown = generateProjectApiCredential("production", "full");
			await expect(resolver.resolveCredential(unknown.token)).resolves.toEqual({
				kind: "not_found",
			});
			const legacy = `qpk_v1.${cases[0]?.token.credentialId}.${cases[0]?.token.token.slice(5)}`;
			await expect(resolver.resolveCredential(legacy)).resolves.toEqual({ kind: "not_found" });
		} finally {
			await context.sql`
				DELETE FROM platform_project_api_credentials
				WHERE id IN ${context.sql(cases.map(({ token }) => token.credentialId))}
			`;
		}
	});
	it("stores the access level, keeps it authoritative, and allows one live key of each kind", async () => {
		const resolver = new PostgresProjectInstanceContextResolver(context.sql);
		const production = integrationProjectContext("voysee");
		const readOnly = generateProjectApiCredential("production", "read_only");
		const mislabelled = generateProjectApiCredential("production", "read_only");
		const second = generateProjectApiCredential("production", "read_only");
		const insert = (token: typeof readOnly, access: string, revoked: boolean) => context.sql`
			INSERT INTO platform_project_api_credentials (
				id, project_instance_id, access, secret_verifier, revoked_at
			)
			VALUES (
				${token.credentialId}, ${production.projectInstanceId}, ${access},
				${token.secretVerifier}, CASE WHEN ${revoked} THEN now() ELSE NULL END
			)
		`;
		try {
			await insert(readOnly, "read_only", false);
			await expect(resolver.resolveCredential(readOnly.token)).resolves.toEqual({
				kind: "resolved",
				context: production,
				access: "read_only",
			});
			// The full key of the same instance is untouched by the read-only one.
			await expect(
				resolver.resolveCredential(integrationProjectCredential("voysee")),
			).resolves.toMatchObject({ kind: "resolved", access: "full" });

			// A read-only token stored as full must not authenticate as either kind.
			await insert(mislabelled, "full", true);
			await expect(resolver.resolveCredential(mislabelled.token)).resolves.toEqual({
				kind: "not_found",
			});

			let duplicate: unknown;
			try {
				await insert(second, "read_only", false);
			} catch (error) {
				duplicate = error;
			}
			expect(String((duplicate as { constraint?: string; message?: string })?.message)).toContain(
				"idx_platform_project_api_credentials_active_access",
			);

			let invalid: unknown;
			try {
				await insert(second, "admin", true);
			} catch (error) {
				invalid = error;
			}
			expect(String((invalid as { message?: string })?.message)).toContain(
				"platform_project_api_credentials_access_check",
			);

			await context.sql`
				UPDATE platform_project_api_credentials SET revoked_at = now()
				WHERE id = ${readOnly.credentialId}
			`;
			await expect(resolver.resolveCredential(readOnly.token)).resolves.toEqual({
				kind: "ineligible",
			});
		} finally {
			await context.sql`
				DELETE FROM platform_project_api_credentials
				WHERE id IN ${context.sql([readOnly.credentialId, mislabelled.credentialId, second.credentialId])}
			`;
		}
	});
});
