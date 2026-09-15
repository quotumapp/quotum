import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SQL } from "bun";
import {
	checkPostgresHealth,
	getPostgresStartupHealth,
	initializePostgresHealth,
} from "../../src/db/client";

type CountingSqlClient = ((
	strings: TemplateStringsArray,
	...values: unknown[]
) => Promise<unknown>) & { getCallCount: () => number };

function createCountingSqlClient(results: Array<Error | unknown>): CountingSqlClient {
	let callCount = 0;
	const client = () => {
		const result = results[callCount++];
		return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
	};

	return Object.assign(client, { getCallCount: () => callCount });
}

function asSqlClient(client: CountingSqlClient): SQL {
	return client as unknown as SQL;
}

describe("billing database client", () => {
	it("configures bounded Postgres session timeouts", () => {
		const source = readFileSync(join(process.cwd(), "src/db/client.ts"), "utf8");

		expect(source).toContain("connection:");
		expect(source).toContain("statement_timeout");
		expect(source).toContain("idle_in_transaction_session_timeout");
	});

	it("caches a healthy startup check", async () => {
		const client = createCountingSqlClient([[{ "?column?": 1 }]]);

		const result = await initializePostgresHealth(asSqlClient(client));

		expect(result.healthy).toBe(true);
		expect(result.checkedAt).toBeString();
		expect(result.error).toBeUndefined();
		expect(getPostgresStartupHealth()).toEqual(result);
		expect(client.getCallCount()).toBe(1);
	});

	it("caches a failed startup check without throwing", async () => {
		const client = createCountingSqlClient([new Error("database unavailable")]);

		const result = await initializePostgresHealth(asSqlClient(client));

		expect(result.healthy).toBe(false);
		expect(result.checkedAt).toBeString();
		expect(result.error).toBe("Postgres connection failed");
		expect(getPostgresStartupHealth()).toEqual(result);
		expect(client.getCallCount()).toBe(1);
	});

	it("reads cached startup health without querying again", async () => {
		const client = createCountingSqlClient([[{ "?column?": 1 }]]);

		await initializePostgresHealth(asSqlClient(client));
		getPostgresStartupHealth();
		getPostgresStartupHealth();

		expect(client.getCallCount()).toBe(1);
	});

	it("retries a transient SQLSTATE error reported on errno and returns healthy", async () => {
		const client = createCountingSqlClient([
			new SQL.PostgresError("protocol violation", {
				code: "ERR_POSTGRES_SERVER_ERROR",
				errno: "08P01",
			}),
			[{ "?column?": 1 }],
		]);

		expect(await checkPostgresHealth(asSqlClient(client))).toBe(true);
		expect(client.getCallCount()).toBe(2);
	});

	it("reports a non-transient SQLSTATE unhealthy without a second attempt", async () => {
		const client = createCountingSqlClient([
			new SQL.PostgresError("division by zero", {
				code: "ERR_POSTGRES_SERVER_ERROR",
				errno: "22012",
			}),
			[{ "?column?": 1 }],
		]);

		expect(await checkPostgresHealth(asSqlClient(client))).toBe(false);
		expect(client.getCallCount()).toBe(1);
	});
});
