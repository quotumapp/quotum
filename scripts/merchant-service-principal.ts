import { merchantSql } from "../src/composition/merchant-persistence";
import { createBillingDatabaseConnection } from "../src/db/client";
import { loadEnv } from "../src/env";
import { loadMerchantConfig } from "../src/platform/config";
import { MerchantStore } from "../src/platform/store";
import { writeStdout } from "../src/shared/cli-output";

const name = process.argv[2];
if (!name || !/^[a-z0-9-]{3,64}$/.test(name))
	throw new Error("Usage: bun scripts/merchant-service-principal.ts <service-name>");
const config = loadMerchantConfig();
const connection = createBillingDatabaseConnection(loadEnv());
try {
	const token = await new MerchantStore(merchantSql(connection.sql), config).createServicePrincipal(
		name,
	);
	// The explicit operator command creates a new principal, refusing to rotate an existing one.
	writeStdout("Store this once as the merchant Worker's MERCHANT_SERVICE_TOKEN secret:");
	writeStdout(token);
} finally {
	await connection.sql.close();
}
