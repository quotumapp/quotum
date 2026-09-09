import { describe, expect, it } from "bun:test";
import { run, startPostgresContainer } from "../../scripts/lib/postgres-container";
import { e2eServiceEnv } from "./helpers/e2e-env";
import { describeE2e } from "./helpers/gating";
import { startBillingService } from "./helpers/service-process";

const e2eDescribe = describeE2e(describe, describe.skip);

e2eDescribe("E2E empty startup", () => {
	it("boots and becomes ready on a migrated database without bootstrapped customers", async () => {
		const container = await startPostgresContainer({ postgresDatabase: "quotum_empty_startup" });
		try {
			const env = e2eServiceEnv({ postgresUri: container.getConnectionUri() });
			delete env.BILLING_TEST_CONNECTIONS_JSON;
			run("bun", ["run", "migrate"], { env });
			const service = await startBillingService(env, { entrypoint: "src/index.ts" });
			try {
				expect((await service.request("/livez")).status).toBe(200);
				expect((await service.request("/ready")).status).toBe(200);
				expect((await service.request("/v1/catalog")).status).toBe(401);
			} finally {
				await service.stop();
			}
		} finally {
			await container.stop();
		}
	}, 60_000);
});
