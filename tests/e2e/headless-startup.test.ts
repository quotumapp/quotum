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
			// Headless operators may approve private projection receivers.
			env.BILLING_PROJECTION_ALLOWED_NETWORKS = "10.20.0.0/16";
			env.BILLING_PROJECTION_ALLOW_INSECURE_HTTP = "true";
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

	it("refuses private projection receivers while the merchant platform is on", async () => {
		// Composition fails before any connection is opened, so no database is needed.
		const env = e2eServiceEnv({
			postgresUri: "postgres://quotum@127.0.0.1:9/unused",
			overrides: { BILLING_PROJECTION_ALLOWED_NETWORKS: "10.20.0.0/16" },
		});
		delete env.BILLING_TEST_CONNECTIONS_JSON;
		const proc = Bun.spawn(["bun", "src/index.ts"], { env, stdout: "pipe", stderr: "pipe" });
		const exited = await Promise.race([
			proc.exited,
			Bun.sleep(30_000).then(() => {
				proc.kill();
				return "timeout" as const;
			}),
		]);
		expect(exited).not.toBe(0);
		expect(exited).not.toBe("timeout");
		// The runtime reports the refusal through its fatal-error log line.
		const output = `${await new Response(proc.stdout).text()}${await new Response(proc.stderr).text()}`;
		expect(output).toContain(
			"BILLING_PROJECTION_ALLOWED_NETWORKS and BILLING_PROJECTION_ALLOW_INSECURE_HTTP require QUOTUM_MERCHANT_ENABLED=false",
		);
	}, 60_000);
});
