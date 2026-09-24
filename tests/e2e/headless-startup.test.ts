import { describe, expect, it } from "bun:test";
import { run, startPostgresContainer } from "../../scripts/lib/postgres-container";
import { e2eServiceEnv } from "./helpers/e2e-env";
import { describeE2e } from "./helpers/gating";
import { startBillingService } from "./helpers/service-process";

const e2eDescribe = describeE2e(describe, describe.skip);

e2eDescribe("E2E headless startup", () => {
	it("serves /v1 without any merchant platform settings", async () => {
		const container = await startPostgresContainer({ postgresDatabase: "quotum_headless_startup" });
		try {
			const env = e2eServiceEnv({ postgresUri: container.getConnectionUri() });
			delete env.BILLING_TEST_CONNECTIONS_JSON;
			for (const name of Object.keys(env))
				if (/^(MERCHANT_|QUOTUM_EMAIL_|QUOTUM_AUTH_SECRET$|QUOTUM_MCP_)/.test(name))
					delete env[name];
			env.QUOTUM_MERCHANT_ENABLED = "false";
			run("bun", ["run", "migrate"], { env });
			const service = await startBillingService(env, { entrypoint: "src/index.ts" });
			try {
				expect((await service.request("/livez")).status).toBe(200);
				expect((await service.request("/ready")).status).toBe(200);
				expect((await service.request("/v1/catalog")).status).toBe(401);
				// The merchant platform does not exist, so its routes are unknown paths.
				const merchant = await fetch(`${service.baseUrl}/api/platform/session`);
				expect(merchant.status).toBe(404);
				// Provider setup ingress stays: it verifies saved connection versions, not merchants.
				const setup = await fetch(
					`${service.baseUrl}/v1/projects/unknown/connections/00000000-0000-4000-8000-000000000000/webhooks/stripe`,
					{ method: "POST", body: "{}", headers: { "content-type": "application/json" } },
				);
				expect(setup.status).toBe(404);
				expect(await setup.json()).toEqual({ success: false });
			} finally {
				await service.stop();
			}
		} finally {
			await container.stop();
		}
	}, 60_000);
});
