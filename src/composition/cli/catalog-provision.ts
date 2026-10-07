import type { ProjectCatalogImport } from "../../catalog/import-config";
import { parseCatalogImports } from "../../catalog/import-config";
import { syncConfiguredCatalog } from "../../catalog/provision";
import { createBillingDatabaseConnection } from "../../db/client";
import { createCliBillingLogger } from "../../observability/logger";
import type { ProjectInstanceContextResolver } from "../../projects/context";
import { PostgresProjectInstanceContextResolver } from "../project-instance-persistence";

if (import.meta.main) {
	await provisionCatalog();
}

async function provisionCatalog(): Promise<void> {
	const logger = createCliBillingLogger();
	const postgresUri = requiredEnvironmentValue("POSTGRES_URI");
	const imports = parseCatalogImports(requiredEnvironmentValue("BILLING_CATALOG_IMPORT_JSON"));
	const connection = createBillingDatabaseConnection({ postgresUri });
	try {
		const resolver = new PostgresProjectInstanceContextResolver(connection.sql);
		await assertDevelopmentCatalogImports(imports, resolver);
		await syncConfiguredCatalog(imports, resolver, connection.db);
		logger.info("Configured billing catalog synchronized");
	} finally {
		await connection.sql.close();
	}
}

function requiredEnvironmentValue(name: string): string {
	const value = process.env[name]?.trim();
	if (value === undefined || value === "")
		throw new Error(`${name} environment variable is required`);
	return value;
}

export async function assertDevelopmentCatalogImports(
	imports: readonly ProjectCatalogImport[],
	resolver: ProjectInstanceContextResolver,
): Promise<void> {
	for (const item of imports) {
		const resolution = await resolver.resolveInstanceKey(item.projectInstanceKey);
		if (resolution.kind === "resolved" && resolution.context.environment === "production")
			throw new Error(
				"Development catalog provision cannot import a production instance; use quotum catalog bindings adopt.",
			);
	}
}
