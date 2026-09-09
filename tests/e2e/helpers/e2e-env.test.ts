import { describe, expect, it } from "bun:test";
import { e2eServiceEnv } from "./e2e-env";

describe("E2E env helpers", () => {
	it("does not leak ambient billing configuration into service env", () => {
		const previous = preserveEnv([
			"BILLING_AUTH_MODE",
			"BILLING_TEST_CONNECTIONS_JSON",
			"BILLING_PROJECTS_JSON",
			"BILLING_TRUST_GATEWAY_PROJECT_HEADER",
			"SENTRY_DSN",
		]);
		try {
			process.env.BILLING_AUTH_MODE = "gateway";
			process.env.BILLING_TEST_CONNECTIONS_JSON = "[]";
			process.env.BILLING_PROJECTS_JSON = "[]";
			process.env.BILLING_TRUST_GATEWAY_PROJECT_HEADER = "true";
			process.env.SENTRY_DSN = "https://real.example/1";

			const env = e2eServiceEnv({ postgresUri: "postgres://local/e2e" });

			expect(env.BILLING_AUTH_MODE).toBe("api_key");
			expect(env.BILLING_TEST_CONNECTIONS_JSON).not.toBe("[]");
			expect(env.BILLING_PROJECTS_JSON).toBeUndefined();
			expect(env.BILLING_TRUST_GATEWAY_PROJECT_HEADER).toBe("false");
			expect(env.SENTRY_DSN).toBe("");
		} finally {
			restoreEnv(previous);
		}
	});
});

function preserveEnv(keys: string[]): Map<string, string | undefined> {
	return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(previous: Map<string, string | undefined>): void {
	for (const [key, value] of previous) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
}
