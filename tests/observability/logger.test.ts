import { describe, expect, it } from "bun:test";
import { createConsoleBillingLogger } from "../../src/observability/logger";

describe("createConsoleBillingLogger", () => {
	it("writes structured JSON events with deterministic timestamps", () => {
		const lines: string[] = [];
		const logger = createConsoleBillingLogger({
			now: () => new Date("2026-05-31T12:00:00.000Z"),
			write: {
				info: (line) => lines.push(line),
				warn: (line) => lines.push(line),
				error: (line) => lines.push(line),
			},
		});

		logger.info("Billing worker started", { workerId: "worker-a", claimed: 2 });
		logger.warn("Billing worker delayed", { reason: "backoff" });

		expect(lines.map((line) => JSON.parse(line))).toEqual([
			{
				level: "info",
				message: "Billing worker started",
				timestamp: "2026-05-31T12:00:00.000Z",
				context: { workerId: "worker-a", claimed: 2 },
			},
			{
				level: "warn",
				message: "Billing worker delayed",
				timestamp: "2026-05-31T12:00:00.000Z",
				context: { reason: "backoff" },
			},
		]);
	});

	it("normalizes thrown errors", () => {
		const lines: string[] = [];
		const logger = createConsoleBillingLogger({
			now: () => new Date("2026-05-31T12:00:00.000Z"),
			write: {
				info: (line) => lines.push(line),
				warn: (line) => lines.push(line),
				error: (line) => lines.push(line),
			},
		});
		const error = new TypeError("projection failed");
		error.stack = "TypeError: projection failed\n    at test";

		logger.error("Projection sync failed", error, { jobId: "job_1" });

		expect(JSON.parse(lines[0] ?? "")).toEqual({
			level: "error",
			message: "Projection sync failed",
			timestamp: "2026-05-31T12:00:00.000Z",
			context: { jobId: "job_1" },
			error: {
				name: "TypeError",
				message: "projection failed",
				stack: "TypeError: projection failed\n    at test",
			},
		});
	});

	it("normalizes non-error throwables", () => {
		const lines: string[] = [];
		const logger = createConsoleBillingLogger({
			now: () => new Date("2026-05-31T12:00:00.000Z"),
			write: {
				info: (line) => lines.push(line),
				warn: (line) => lines.push(line),
				error: (line) => lines.push(line),
			},
		});

		logger.error("Webhook failed", "invalid signature");

		expect(JSON.parse(lines[0] ?? "")).toEqual({
			level: "error",
			message: "Webhook failed",
			timestamp: "2026-05-31T12:00:00.000Z",
			error: { name: "Error", message: "invalid signature" },
		});
	});

	it("does not throw for circular context", () => {
		const lines: string[] = [];
		const logger = createConsoleBillingLogger({
			now: () => new Date("2026-05-31T12:00:00.000Z"),
			write: {
				info: (line) => lines.push(line),
				warn: (line) => lines.push(line),
				error: (line) => lines.push(line),
			},
		});
		const context: Record<string, unknown> = { eventId: "event_1" };
		context.self = context;

		expect(() => logger.info("Store event replay completed", context)).not.toThrow();
		expect(JSON.parse(lines[0] ?? "")).toEqual({
			level: "info",
			message: "Store event replay completed",
			timestamp: "2026-05-31T12:00:00.000Z",
			context: { eventId: "event_1", self: "[Circular]" },
		});
	});

	it("does not throw for BigInt context or invalid timestamps", () => {
		const lines: string[] = [];
		const logger = createConsoleBillingLogger({
			now: () => new Date("not-a-date"),
			write: {
				info: (line) => lines.push(line),
				warn: (line) => lines.push(line),
				error: (line) => lines.push(line),
			},
		});

		expect(() => logger.info("Metric rendered", { count: 1n })).not.toThrow();
		expect(JSON.parse(lines[0] ?? "")).toEqual({
			level: "info",
			message: "Metric rendered",
			timestamp: "Invalid Date",
			context: { count: "1" },
		});
	});

	it("does not throw when the writer throws", () => {
		const logger = createConsoleBillingLogger({
			write: {
				info() {
					throw new Error("writer failed");
				},
				warn() {
					throw new Error("writer failed");
				},
				error() {
					throw new Error("writer failed");
				},
			},
		});

		expect(() => logger.info("Billing worker started")).not.toThrow();
		expect(() => logger.warn("Billing worker delayed")).not.toThrow();
		expect(() => logger.error("Billing worker failed", new Error("failure"))).not.toThrow();
	});
});
