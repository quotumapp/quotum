import { describe, expect, it } from "bun:test";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";
import { loadBillingLogLevel } from "../../src/observability/log-level";
import {
	createPinoBillingLogger,
	type PinoBillingLoggerOptions,
} from "../../src/observability/logger";

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
			toJSON() {
				throw new Error("cannot serialize");
			},
			toString() {
				throw new Error("cannot stringify");
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
			toJSON() {
				throw new Error("bad context");
			},
		});
		expect(events()[0]).toMatchObject({ msg: "Metric rendered", context: "[Unserializable]" });
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
