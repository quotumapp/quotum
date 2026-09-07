import type { SQL } from "bun";
import { BunPlatformUnitOfWork } from "../../src/composition/project-instance-persistence";
import { createBillingDatabaseConnection } from "../../src/db/client";
import type { PlatformBootstrapManifest } from "../../src/platform/bootstrap/manifest";
import { PlatformBootstrapService } from "../../src/platform/bootstrap/service";
import { generateProjectApiCredential } from "../../src/platform/credentials/project-api-token";
import type { ProjectInstanceContext } from "../../src/projects/context";

export interface TestPlatformBootstrapResult {
	contexts: readonly ProjectInstanceContext[];
	credentials: Readonly<Record<string, string>>;
}

export async function bootstrapTestPlatform(
	postgresUri: string,
	logicalProjectKeys: readonly string[],
): Promise<TestPlatformBootstrapResult> {
	const manifest = createTestPlatformManifest(logicalProjectKeys);
	const connection = createBillingDatabaseConnection({ postgresUri });
	try {
		const service = new PlatformBootstrapService(new BunPlatformUnitOfWork(connection.sql));
		const inspection = await service.inspect(manifest);
		const generated = inspection.credentialsToIssue.map((projectInstanceKey) => ({
			projectInstanceKey,
			...generateProjectApiCredential(),
		}));
		await service.apply(
			manifest,
			generated.map((credential) => ({
				credentialId: credential.credentialId,
				projectInstanceKey: credential.projectInstanceKey,
				secretVerifier: credential.secretVerifier,
			})),
		);

		return {
			contexts: await resolveTestPlatformContextsWithConnection(connection.sql, manifest),
			credentials: Object.fromEntries(
				generated.map((credential) => [credential.projectInstanceKey, credential.token]),
			),
		};
	} finally {
		await connection.sql.close();
	}
}

export async function resolveTestPlatformContexts(
	postgresUri: string,
	manifest: PlatformBootstrapManifest,
): Promise<readonly ProjectInstanceContext[]> {
	const connection = createBillingDatabaseConnection({ postgresUri });
	try {
		return await resolveTestPlatformContextsWithConnection(connection.sql, manifest);
	} finally {
		await connection.sql.close();
	}
}

export function createTestPlatformManifest(
	logicalProjectKeys: readonly string[],
): PlatformBootstrapManifest {
	if (logicalProjectKeys.length < 2) {
		throw new Error("Test platform topology requires at least two logical projects");
	}
	return {
		version: 1,
		organizations: logicalProjectKeys.map((logicalProjectKey, organizationIndex) => ({
			slug: `${logicalProjectKey}-test-organization`,
			name: `${testProjectName(logicalProjectKey)} Test Organization`,
			projects: [
				{
					key: logicalProjectKey,
					name: testProjectName(logicalProjectKey),
					instances: [
						{
							key: `${logicalProjectKey}-sandbox`,
							environment: "sandbox" as const,
							lifecycleStatus: "active" as const,
							issueCredential: true,
						},
						{
							key: logicalProjectKey,
							environment: "production" as const,
							lifecycleStatus: "active" as const,
							issueCredential: true,
						},
					],
				},
				...(organizationIndex === 0
					? [
							{
								key: "billing-internal",
								name: "Billing Internal",
								instances: [
									{
										key: "billing-internal",
										environment: "internal" as const,
										lifecycleStatus: "active" as const,
										issueCredential: false,
									},
								],
							},
						]
					: []),
			],
		})),
	};
}

function testProjectName(projectInstanceKey: string): string {
	return projectInstanceKey.charAt(0).toUpperCase() + projectInstanceKey.slice(1);
}

async function resolveTestPlatformContextsWithConnection(
	client: SQL,
	manifest: PlatformBootstrapManifest,
): Promise<readonly ProjectInstanceContext[]> {
	const projectInstanceKeys = manifest.organizations.flatMap((organization) =>
		organization.projects.flatMap((project) => project.instances.map((instance) => instance.key)),
	);
	const contexts: ProjectInstanceContext[] = [];
	for (const projectInstanceKey of projectInstanceKeys) {
		const [context] = await client<ProjectInstanceContext[]>`
            SELECT o.id AS "organizationId",o.slug AS "organizationSlug",p.id AS "logicalProjectId",p.key AS "logicalProjectKey",i.id AS "projectInstanceId",i.key AS "projectInstanceKey",i.environment,i.lifecycle_status AS "lifecycleStatus",i.internal_project AS "internalProject"
            FROM projects i JOIN platform_projects p ON p.id=i.platform_project_id JOIN platform_organizations o ON o.id=p.organization_id WHERE i.key=${projectInstanceKey}
        `;
		if (!context) throw new Error(`Test project instance ${projectInstanceKey} was not resolved`);
		contexts.push(context);
	}
	return contexts;
}
