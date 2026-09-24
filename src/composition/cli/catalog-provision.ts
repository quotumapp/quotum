import { parseCatalogImports } from "../../catalog/import-config";
import { syncConfiguredCatalog } from "../../catalog/provision";
import { createBillingDatabaseConnection } from "../../db/client";
import { createCliBillingLogger } from "../../observability/logger";
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
		await syncConfiguredCatalog(
			imports,
			new PostgresProjectInstanceContextResolver(connection.sql),
			connection.db,
		);
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
