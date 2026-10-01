import { describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";
import { loadBillingLogLevel } from "../../src/observability/log-level";
import {
	createPinoBillingLogger,
	type PinoBillingLoggerOptions,
} from "../../src/observability/logger";
import {
	databaseFailure,
	diagnosticParameters,
	diagnosticQuery,
} from "../helpers/database-diagnostic";

const instant = new Date("2026-05-31T12:00:00.000Z");

function capture(options: PinoBillingLoggerOptions = {}) {
	const lines: string[] = [];
	const logger = createPinoBillingLogger({
		level: "info",
		now: () => instant,
		destination: { write: (line) => lines.push(line) },
		...options,
	});
	return { logger, lines, events: () => lines.map((line) => JSON.parse(line)) };
}

describe("createPinoBillingLogger", () => {
	it("writes standard Pino JSON with isolated structured context", () => {
		const { logger, events } = capture();
		logger.info("Billing worker started", { workerId: "worker-a", level: "spoofed", msg: "other" });
		logger.warn("Billing worker delayed", { reason: "backoff" });
		expect(events()).toEqual([
			{
				level: 30,
				time: instant.getTime(),
				pid: process.pid,
				hostname: expect.any(String),
				msg: "Billing worker started",
				context: { workerId: "worker-a", level: "spoofed", msg: "other" },
			},
			{
				level: 40,
				time: instant.getTime(),
				pid: process.pid,
				hostname: expect.any(String),
				msg: "Billing worker delayed",
				context: { reason: "backoff" },
			},
		]);
	});

	it("serializes errors without copying arbitrary provider or request properties", () => {
		const { logger, events, lines } = capture();
		const error = Object.assign(new TypeError("projection failed"), { token: "provider-secret" });
		error.stack = "TypeError: projection failed\n    at test";
		logger.error("Projection sync failed", error, { jobId: "job_1" });
		expect(events()[0]).toMatchObject({
			level: 50,
			msg: "Projection sync failed",
			context: { jobId: "job_1" },
			err: { type: "TypeError", message: "projection failed", stack: error.stack },
		});
		expect(lines.join("")).not.toContain("provider-secret");
	});

	it("normalizes non-error and unserializable throwables", () => {
		const { logger, events } = capture();
		logger.error("Webhook failed", "invalid signature");
		logger.error("Unexpected failure", {
			get message() {
				throw new Error("cannot inspect");
			},
		});
		expect(events().map((event) => event.err)).toEqual([
			{ type: "Error", message: "invalid signature" },
			{ type: "Error", message: "[Unserializable]" },
		]);
	});

	it("handles circular context and preserves BigInt precision", () => {
		const { logger, events } = capture();
		const context: Record<string, unknown> = { count: 900719925474099312345n };
		context.self = context;
		logger.info("Metric rendered", context);
		expect(events()[0].context).toEqual({ count: "900719925474099312345", self: "[Circular]" });
		expect(context.self).toBe(context);
		expect(context.count).toBe(900719925474099312345n);
	});

	it("retains a diagnostic when context serialization fails", () => {
		const { logger, events } = capture();
		logger.info("Metric rendered", {
			get count() {
				throw new Error("bad context");
			},
		});
		expect(events()[0]).toMatchObject({ msg: "Metric rendered", context: "[Unserializable]" });
	});

	it.each(["40P01", "23505"])(
		"keeps SQLSTATE %s without SQL, values or driver messages",
		(sqlState) => {
			const { logger, events, lines } = capture();
			const original = databaseFailure(sqlState);
			const stack = original.stack;
			const outer = new Error(`wrapped: ${original.message}`, { cause: original });
			logger.error("Billing request failed", outer, { requestId: "request-1", jobId: "job-1" });
			expect(events()[0].err).toEqual({
				type: "DatabaseError",
				message: "Database operation failed",
				sqlState,
				constraint: "customers_project_id_id_unique",
			});
			for (const marker of [diagnosticQuery, ...diagnosticParameters])
				expect(lines.join("")).not.toContain(marker);
			expect(events()[0].context).toEqual({ requestId: "request-1", jobId: "job-1" });
			expect(original.stack).toBe(stack);
			expect(original.params).toBe(diagnosticParameters);
			expect(outer.cause).toBe(original);
		},
	);

	it("recognizes database failures without a SQLSTATE, including flattened Drizzle messages", () => {
		const { logger, events } = capture();
		const drizzle = new DrizzleQueryError(
			diagnosticQuery,
			diagnosticParameters,
			new Error("offline"),
		);
		for (const error of [
			drizzle,
			drizzle.message,
			new SQL.PostgresError(diagnosticParameters[2] ?? "", {
				code: "ERR_POSTGRES_CONNECTION_CLOSED",
			}),
		]) {
			logger.error("Database failed", error);
		}
		expect(events().map((event) => event.err)).toEqual(
			Array.from({ length: 3 }, () => ({
				type: "DatabaseError",
				message: "Database operation failed",
			})),
		);
	});

	it("accepts SQLSTATE on code and drops unsafe constraint names", () => {
		const { logger, events, lines } = capture();
		for (const constraint of ["bad constraint", "x".repeat(64), diagnosticParameters[0]]) {
			logger.error(
				"Database failed",
				Object.assign(new Error(diagnosticParameters[2]), { code: "23505", constraint }),
			);
		}
		expect(events().map((event) => event.err)).toEqual(
			Array.from({ length: 3 }, () => ({
				type: "DatabaseError",
				message: "Database operation failed",
				sqlState: "23505",
			})),
		);
		expect(lines.join("")).not.toContain("private customer note");
	});

	it("handles aggregate and cyclic causes and fails closed on excessive or unreadable causes", () => {
		const { logger, events } = capture();
		const cycle = databaseFailure();
		cycle.cause = cycle;
		logger.error("Database failed", cycle);
		logger.error("Database failed", new AggregateError([new Error("other"), databaseFailure()]));
		let deep: Error = databaseFailure();
		for (let i = 0; i < 10; i++) deep = new Error("wrapper", { cause: deep });
		logger.error("Database failed", deep);
		logger.error(
			"Database failed",
			new AggregateError(Array.from({ length: 9 }, () => new Error("secret"))),
		);
		logger.error("Database failed", {
			get cause() {
				throw new Error("secret");
			},
		});
		expect(
			events()
				.slice(0, 2)
				.map((event) => event.err.type),
		).toEqual(["DatabaseError", "DatabaseError"]);
		expect(
			events()
				.slice(2)
				.map((event) => event.err),
		).toEqual(
			Array.from({ length: 3 }, () => ({
				type: "Error",
				message: "[Unserializable]",
			})),
		);
	});

	it("scrubs every log level, ordinary errors and nested context using the shared privacy policy", () => {
		const { logger, events, lines } = capture();
		const context = {
			projectKey: "acme",
			requestId: "request-1",
			workerId: "worker-a",
			jobId: "job-1",
			customerId: "private-customer",
			authorization: "Bearer private-bearer",
			url: "https://api.example.com/v1/billing-accounts/private-customer?secret=query#fragment",
			nested: {
				email: diagnosticParameters[0],
				message: `Bearer private-bearer ${diagnosticParameters[0]}`,
			},
			query: diagnosticQuery,
			params: diagnosticParameters,
			error: databaseFailure(),
		};
		const message = `Request for ${diagnosticParameters[0]} with ${diagnosticParameters[1]}`;
		logger.info(message, context);
		logger.warn(message, context);
		logger.error(message, new Error(message), context);
		for (const marker of [
			...diagnosticParameters,
			diagnosticQuery,
			"private-customer",
			"private-bearer",
			"secret=query",
		]) {
			expect(lines.join("")).not.toContain(marker);
		}
		expect(events().map((event) => event.level)).toEqual([30, 40, 50]);
		expect(events()[0].context).toEqual({
			projectKey: "acme",
			requestId: "request-1",
			workerId: "worker-a",
			jobId: "job-1",
			url: "https://api.example.com/v1/billing-accounts/:id",
			nested: { message: "Bearer [Filtered] [email]" },
			error: {
				type: "DatabaseError",
				message: "Database operation failed",
				sqlState: "40P01",
				constraint: "customers_project_id_id_unique",
			},
		});
		expect(context.customerId).toBe("private-customer");
	});

	it("keeps account, usage-receipt and declared-scope failures free of identifiers and SQL", () => {
		const { logger, events, lines } = capture();
		// v0.19.0 routes: explicit accounts and immutable usage receipts carry the account and receipt
		// ids in the path; a failed lookup must log neither them nor the query's parameters.
		for (const path of [
			"/v1/billing-accounts/private-customer",
			"/v1/billing-accounts/private-customer/usage/receipts/private-receipt-0001",
		]) {
			logger.error("Billing request failed", databaseFailure(), { requestId: "request-1", path });
		}
		// The declared-scope safety net logs the plans that mix scopes; it carries no SQL.
		logger.error(
			"Meter limits mix declared scopes",
			new Error("Meter limits on tokens mix scopes"),
			{
				requestId: "request-2",
				path: "/v1/billing-accounts/private-customer/usage/consume",
				featureKey: "tokens",
			},
		);
		for (const marker of [
			...diagnosticParameters,
			diagnosticQuery,
			"private-customer",
			"private-receipt-0001",
		]) {
			expect(lines.join("")).not.toContain(marker);
		}
		expect(events().map((event) => event.context.path)).toEqual([
			"/v1/billing-accounts/:id",
			"/v1/billing-accounts/:id/usage/receipts/:id",
			"/v1/billing-accounts/:id/usage/consume",
		]);
		expect(events()[0].err).toMatchObject({
			message: "Database operation failed",
			sqlState: "40P01",
		});
	});

	it("bounds diagnostics and never invokes context serialization hooks or redacted getters", () => {
		const { logger, events } = capture();
		logger.error(
			"x".repeat(2000),
			{ token: "private-token", safe: "y".repeat(2000) },
			{
				toJSON() {
					throw new Error("should not run");
				},
				get authorization() {
					throw new Error("should not read");
				},
				message: "z".repeat(2000),
				items: Array.from({ length: 100 }, (_, i) => i),
			},
		);
		expect(events()[0].msg).toHaveLength(1024);
		expect(events()[0].err.message.length).toBeLessThanOrEqual(1024);
		expect(events()[0].err.message).not.toContain("private-token");
		expect(events()[0].context.message).toHaveLength(1024);
		expect(events()[0].context.items).toHaveLength(50);
		expect(events()[0].context).not.toHaveProperty("toJSON");
	});

	it.each([
		["trace", [30, 40, 50]],
		["debug", [30, 40, 50]],
		["info", [30, 40, 50]],
		["warn", [40, 50]],
		["error", [50]],
		["fatal", []],
		["silent", []],
	] as const)("filters at level %s", (level, expected) => {
		const { logger, events } = capture({ level });
		logger.info("Info");
		logger.warn("Warning");
		logger.error("Error", new Error("failure"));
		expect(events().map((event) => event.level)).toEqual([...expected]);
	});

	it("uses a valid epoch timestamp when an injected clock fails", () => {
		for (const now of [
			() => new Date("invalid"),
			() => {
				throw new Error("clock failed");
			},
		]) {
			const { logger, events } = capture({ now });
			logger.info("Worker started");
			expect(Number.isFinite(events()[0].time)).toBe(true);
		}
	});

	it("does not throw when the destination fails", () => {
		const { logger } = capture({
			destination: {
				write() {
					throw new Error("writer failed");
				},
			},
		});
		expect(() => logger.info("Billing worker started")).not.toThrow();
		expect(() => logger.warn("Billing worker delayed")).not.toThrow();
		expect(() => logger.error("Billing worker failed", new Error("failure"))).not.toThrow();
	});

	it("writes service and CLI logs synchronously to their separate streams before exit", async () => {
		const loggerUrl = new URL("../../src/observability/logger.ts", import.meta.url).href;
		const shutdownUrl = new URL("../../src/shutdown.ts", import.meta.url).href;
		const child = Bun.spawn({
			cmd: [
				process.execPath,
				"--no-env-file",
				"--eval",
				`
				import { createPinoBillingLogger, createCliBillingLogger } from ${JSON.stringify(loggerUrl)};
				import { registerBillingRuntimeShutdown } from ${JSON.stringify(shutdownUrl)};
				createPinoBillingLogger().info("filtered");
				createPinoBillingLogger().warn("service");
				createCliBillingLogger().error("command", new Error("failed"));
				registerBillingRuntimeShutdown({ process, runtimes: [] });
				process.emit("uncaughtException", new Error("fatal"));
			`,
			],
			env: { ...createSanitizedProcessEnv(), BILLING_LOG_LEVEL: "warn" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code).toBe(1);
		expect(
			stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line).msg),
		).toEqual(["service", "Billing runtime fatal error"]);
		expect(JSON.parse(stderr).msg).toBe("command");
	});
});

describe("loadBillingLogLevel", () => {
	it("defaults independently of database and merchant configuration", () => {
		expect(loadBillingLogLevel({})).toBe("info");
		expect(loadBillingLogLevel({ BILLING_LOG_LEVEL: "silent" })).toBe("silent");
	});

	it("rejects invalid or blank levels with the setting name", () => {
		for (const level of ["", "verbose", "WARN"]) {
			expect(() => loadBillingLogLevel({ BILLING_LOG_LEVEL: level })).toThrow("BILLING_LOG_LEVEL");
		}
	});
});
