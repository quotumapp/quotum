import { syncConfiguredProjectsAndCatalog } from "../src/catalog/provision";
import { closePool } from "../src/db/client";
import { loadEnv } from "../src/env";

try {
	const env = loadEnv();
	await syncConfiguredProjectsAndCatalog(env);
	console.log("Configured billing projects and catalog synchronized");
} finally {
	await closePool();
}
