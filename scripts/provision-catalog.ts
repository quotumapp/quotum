import { parseCatalogImports } from "../src/catalog/import-config";
import { syncConfiguredCatalog } from "../src/catalog/provision";
import { PostgresProjectInstanceContextResolver } from "../src/composition/project-instance-persistence";
import { createBillingDatabaseConnection } from "../src/db/client";
import { createCliBillingLogger } from "../src/observability/logger";

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

function requiredEnvironmentValue(name: string): string {
	const value = process.env[name]?.trim();
	if (value === undefined || value === "")
		throw new Error(`${name} environment variable is required`);
	return value;
}
