import { createBillingDatabaseConnection } from "../../db/client";
import { loadEnv } from "../../env";
import { loadMerchantConfig, merchantPlatformEnabled } from "../../platform/config";
import { MerchantStore } from "../../platform/store";
import { writeStdout } from "../../shared/cli-output";
import { merchantSql } from "../merchant-persistence";

if (import.meta.main) {
	await createServicePrincipal(process.argv[2]);
}

async function createServicePrincipal(name: string | undefined): Promise<void> {
	if (!name || !/^[a-z0-9-]{3,64}$/.test(name))
		throw new Error("Usage: quotum merchant service-principal <service-name>");
	if (!merchantPlatformEnabled())
		throw new Error(
			"The merchant platform is off (QUOTUM_MERCHANT_ENABLED=false), so there is no merchant proxy to authorize",
		);
	const config = loadMerchantConfig();
	const connection = createBillingDatabaseConnection(loadEnv());
	try {
		const token = await new MerchantStore(
			merchantSql(connection.sql),
			config,
		).createServicePrincipal(name);
		// The explicit operator command creates a new principal, refusing to rotate an existing one.
		writeStdout("Store this once as the merchant Worker's MERCHANT_SERVICE_TOKEN secret:");
		writeStdout(token);
	} finally {
		await connection.sql.close();
	}
}
