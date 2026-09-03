import { describe, expect, it } from "bun:test";
import {
	createIntegrationBillingEnv,
	createLocalPostgresContext,
	isPostgresIntegrationEnabled,
} from "./local-postgres";

describe("local Postgres integration helper", () => {
	it("is disabled unless RUN_POSTGRES_INTEGRATION_TESTS is exactly 1", () => {
		expect(isPostgresIntegrationEnabled({})).toBe(false);
		expect(isPostgresIntegrationEnabled({ RUN_POSTGRES_INTEGRATION_TESTS: "0" })).toBe(false);
		expect(isPostgresIntegrationEnabled({ RUN_POSTGRES_INTEGRATION_TESTS: "1" })).toBe(true);
	});

	it("creates integration env from POSTGRES_URI", () => {
		const env = createIntegrationBillingEnv(
			"postgresql://postgres:postgres@127.0.0.1:5432/postgres",
		);

		expect(env.postgresUri).toBe("postgresql://postgres:postgres@127.0.0.1:5432/postgres");
		expect(env.operatorApiKey).toBe("billing-integration-operator-key");
	});

	it("uses HTTP projection delivery config in integration env projects", () => {
		const env = createIntegrationBillingEnv(
			"postgresql://postgres:postgres@127.0.0.1:5432/postgres",
		);

		expect(env.projects).toEqual([
			{
				key: "voysee",
				apiKey: "voysee-integration-api-key",
				active: true,
				projectionUrl: "https://voysee.projection.integration.test",
				projectionSecret: "voysee-projection-secret",
			},
			{
				key: "wiseley",
				apiKey: "wiseley-integration-api-key",
				active: true,
				projectionUrl: "https://wiseley.projection.integration.test",
				projectionSecret: "wiseley-projection-secret",
			},
		]);
	});

	it("applies explicit env overrides last", () => {
		const env = createIntegrationBillingEnv(
			"postgresql://postgres:postgres@127.0.0.1:5432/postgres",
			{
				rateLimit: {
					windowMs: 1000,
					verifyLimit: 2,
					webhookLimit: 3,
					adminLimit: 1,
					meteringLimit: 4,
					trustProxyHeaders: true,
				},
				projects: [
					{
						key: "voysee",
						apiKey: "override-key",
						active: true,
						projectionUrl: "http://localhost:1234",
						projectionSecret: "override-secret",
					},
				],
			},
		);

		expect(env.rateLimit.verifyLimit).toBe(2);
		expect(env.rateLimit.trustProxyHeaders).toBe(true);
		expect(env.projects).toEqual([
			{
				key: "voysee",
				apiKey: "override-key",
				active: true,
				projectionUrl: "http://localhost:1234",
				projectionSecret: "override-secret",
			},
		]);
	});

	it("does not connect when integration tests are disabled", async () => {
		const previous = process.env.RUN_POSTGRES_INTEGRATION_TESTS;
		delete process.env.RUN_POSTGRES_INTEGRATION_TESTS;
		try {
			await expect(createLocalPostgresContext()).rejects.toThrow(
				"Postgres integration tests are disabled",
			);
		} finally {
			if (previous === undefined) {
				delete process.env.RUN_POSTGRES_INTEGRATION_TESTS;
			} else {
				process.env.RUN_POSTGRES_INTEGRATION_TESTS = previous;
			}
		}
	});
});
