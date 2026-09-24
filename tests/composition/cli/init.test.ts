import { describe, expect, it } from "bun:test";
import { renderInitEnv } from "../../../src/composition/cli/init";
import { loadEnv } from "../../../src/env";
import { loadConnectionCipher } from "../../../src/platform/connections/cipher";

function parseDotenv(text: string): Record<string, string> {
	return Object.fromEntries(
		text
			.split("\n")
			.filter((line) => line !== "" && !line.startsWith("#"))
			.map((line) => {
				const separator = line.indexOf("=");
				return [line.slice(0, separator), line.slice(separator + 1)];
			}),
	);
}

describe("quotum init", () => {
	it("prints settings the service accepts", () => {
		const env = parseDotenv(renderInitEnv(new Date("2026-09-24T12:00:00.000Z")));

		expect(Object.keys(env)).toEqual([
			"QUOTUM_SECRETS_KEY_ID",
			"QUOTUM_SECRETS_KEY_BASE64",
			"QUOTUM_AUTH_SECRET",
			"BILLING_OPERATOR_API_KEY",
		]);
		expect(env.QUOTUM_SECRETS_KEY_ID).toBe("key-20260924");
		expect(loadConnectionCipher(env).activeKeyId).toBe("key-20260924");
		expect(env.QUOTUM_AUTH_SECRET?.length).toBeGreaterThanOrEqual(32);
		expect(loadEnv({ POSTGRES_URI: "postgres://localhost/quotum", ...env }).operatorApiKey).toBe(
			env.BILLING_OPERATOR_API_KEY,
		);
	});

	it("generates different secrets on every run", () => {
		const now = new Date("2026-09-24T12:00:00.000Z");
		const first = parseDotenv(renderInitEnv(now));
		const second = parseDotenv(renderInitEnv(now));
		for (const name of [
			"QUOTUM_SECRETS_KEY_BASE64",
			"QUOTUM_AUTH_SECRET",
			"BILLING_OPERATOR_API_KEY",
		])
			expect(first[name]).not.toBe(second[name]);
	});
});
