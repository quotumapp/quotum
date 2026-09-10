import { describe, expect, it } from "bun:test";
import { registerBillingRuntimeShutdown, registerProjectionRuntimeShutdown } from "../src/shutdown";
import type { TimeoutHandle } from "../src/workers/runtime";

const createDeferred = <T = void>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});

	return { promise, resolve, reject };
};

describe("projection runtime shutdown", () => {
	it("stops billing runtimes in order before exiting on SIGTERM", async () => {
		const handlers = new Map<string, () => void>();
		const stopped: string[] = [];
		const exitCodes: number[] = [];

		const processLike = {
			on(signal: string, handler: () => void) {
				handlers.set(signal, handler);
				return processLike;
			},
			exit(code?: number) {
				exitCodes.push(code ?? 0);
				throw new Error("process exited");
			},
		};

		registerBillingRuntimeShutdown({
			process: processLike,
			runtimes: [
				{
					async stop() {
						stopped.push("projection_sync");
					},
				},
				{
					async stop() {
						stopped.push("store_event_replay");
					},
				},
				{
					async stop() {
						stopped.push("subscription_reconciliation");
					},
				},
			],
		});

		await expect(async () => handlers.get("SIGTERM")?.()).toThrow("process exited");
		expect(stopped).toEqual([
			"projection_sync",
			"store_event_replay",
			"subscription_reconciliation",
		]);
		expect(exitCodes).toEqual([0]);
	});

	it("calls later runtime stops before waiting for a slow first runtime", async () => {
		const handlers = new Map<string, () => void | Promise<void>>();
		const firstStop = createDeferred();
		const stopped: string[] = [];
		const exitCodes: number[] = [];

		const processLike = {
			on(signal: string, handler: () => void | Promise<void>) {
				handlers.set(signal, handler);
				return processLike;
			},
			exit(code?: number) {
				exitCodes.push(code ?? 0);
				throw new Error("process exited");
			},
		};

		registerBillingRuntimeShutdown({
			process: processLike,
			runtimes: [
				{
					stop() {
						stopped.push("first");
						return firstStop.promise;
					},
				},
				{
					stop() {
						stopped.push("second");
					},
				},
				{
					stop() {
						stopped.push("third");
					},
				},
			],
		});

		const shutdown = Promise.resolve(handlers.get("SIGTERM")?.()).catch((error) => error);
		await Promise.resolve();

		expect(stopped).toEqual(["first", "second", "third"]);
		expect(exitCodes).toEqual([]);

		firstStop.resolve();
		await expect(shutdown).resolves.toEqual(new Error("process exited"));
		expect(exitCodes).toEqual([0]);
	});

	it("logs rejected stops, still stops remaining runtimes, and exits nonzero", async () => {
		const handlers = new Map<string, () => void | Promise<void>>();
		const stopped: string[] = [];
		const exitCodes: number[] = [];
		const loggedErrors: unknown[] = [];
		const stopError = new Error("stop failed");

		const processLike = {
			on(signal: string, handler: () => void | Promise<void>) {
				handlers.set(signal, handler);
				return processLike;
			},
			exit(code?: number) {
				exitCodes.push(code ?? 0);
				throw new Error("process exited");
			},
		};

		registerBillingRuntimeShutdown({
			process: processLike,
			runtimes: [
				{
					stop() {
						stopped.push("first");
						return Promise.reject(stopError);
					},
				},
				{
					stop() {
						stopped.push("second");
					},
				},
			],
			logger: {
				error(message, error) {
					loggedErrors.push({ message, error });
				},
			},
		});

		await expect(async () => handlers.get("SIGTERM")?.()).toThrow("process exited");
		expect(stopped).toEqual(["first", "second"]);
		expect(loggedErrors).toEqual([{ message: "Billing runtime stop failed", error: stopError }]);
		expect(exitCodes).toEqual([1]);
	});

	it("runs cleanup hooks after runtimes stop before exiting", async () => {
		const handlers = new Map<string, () => void | Promise<void>>();
		const events: string[] = [];
		const exitCodes: number[] = [];

		const processLike = {
			on(signal: string, handler: () => void | Promise<void>) {
				handlers.set(signal, handler);
				return processLike;
			},
			exit(code?: number) {
				exitCodes.push(code ?? 0);
				throw new Error("process exited");
			},
		};

		registerBillingRuntimeShutdown({
			process: processLike,
			runtimes: [
				{
					stop() {
						events.push("runtime");
					},
				},
			],
			cleanup: [
				async () => {
					events.push("pool");
				},
				async () => {
					events.push("sentry");
				},
			],
		});

		await expect(async () => handlers.get("SIGTERM")?.()).toThrow("process exited");
		expect(events).toEqual(["runtime", "pool", "sentry"]);
		expect(exitCodes).toEqual([0]);
	});

	it("exits nonzero when the hard shutdown deadline expires", async () => {
		const handlers = new Map<string, () => void | Promise<void>>();
		const exitCodes: number[] = [];
		const loggedErrors: unknown[] = [];
		const scheduled: Array<{ callback: () => void; ms: number; handle: TimeoutHandle }> = [];
		const cleared: TimeoutHandle[] = [];

		const processLike = {
			on(signal: string, handler: () => void | Promise<void>) {
				handlers.set(signal, handler);
				return processLike;
			},
			exit(code?: number) {
				exitCodes.push(code ?? 0);
				throw new Error("process exited");
			},
		};

		registerBillingRuntimeShutdown({
			process: processLike,
			runtimes: [
				{
					stop() {
						return new Promise<void>(() => undefined);
					},
				},
			],
			shutdownTimeoutMs: 1000,
			logger: {
				error(message, error) {
					loggedErrors.push({ message, error });
				},
			},
			timers: {
				setTimeout(callback, ms) {
					const handle = { id: scheduled.length + 1 };
					scheduled.push({ callback, ms, handle });
					return handle;
				},
				clearTimeout(handle) {
					cleared.push(handle);
				},
			},
		});

		const pending = Promise.resolve(handlers.get("SIGTERM")?.()).catch((error) => error);
		await Promise.resolve();
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.ms).toBe(1000);
		expect(exitCodes).toEqual([]);
		scheduled[0]?.callback();
		expect(await pending).toEqual(new Error("process exited"));
		expect(loggedErrors).toEqual([
			{ message: "Billing runtime shutdown timed out", error: new Error("shutdown timed out") },
		]);
		expect(exitCodes).toEqual([1]);
		expect(cleared).toEqual([scheduled[0]?.handle]);
	});

	it("clears the shutdown timer when runtimes stop immediately", async () => {
		const handlers = new Map<string, () => void | Promise<void>>();
		const exitCodes: number[] = [];
		const scheduled: Array<{ callback: () => void; handle: TimeoutHandle }> = [];
		const cleared: TimeoutHandle[] = [];

		const processLike = {
			on(signal: string, handler: () => void | Promise<void>) {
				handlers.set(signal, handler);
				return processLike;
			},
			exit(code?: number) {
				exitCodes.push(code ?? 0);
				throw new Error("process exited");
			},
		};

		registerBillingRuntimeShutdown({
			process: processLike,
			runtimes: [
				{
					stop() {
						return Promise.resolve();
					},
				},
			],
			shutdownTimeoutMs: 1000,
			timers: {
				setTimeout(callback) {
					const handle = { id: scheduled.length + 1 };
					scheduled.push({ callback, handle });
					return handle;
				},
				clearTimeout(handle) {
					cleared.push(handle);
				},
			},
		});

		await expect(async () => handlers.get("SIGTERM")?.()).toThrow("process exited");
		expect(exitCodes).toEqual([0]);
		expect(cleared).toEqual([scheduled[0]?.handle]);
		scheduled[0]?.callback();
		expect(exitCodes).toEqual([0]);
	});

	it("logs fatal process errors, stops runtimes, and exits nonzero", async () => {
		const handlers = new Map<string, (...args: unknown[]) => void | Promise<void>>();
		const stopped: string[] = [];
		const exitCodes: number[] = [];
		const loggedErrors: unknown[] = [];
		const fatalError = new Error("worker loop escaped");

		const processLike = {
			on(signal: string, handler: (...args: unknown[]) => void | Promise<void>) {
				handlers.set(signal, handler);
				return processLike;
			},
			exit(code?: number) {
				exitCodes.push(code ?? 0);
				throw new Error("process exited");
			},
		};

		registerBillingRuntimeShutdown({
			process: processLike,
			runtimes: [
				{
					stop() {
						stopped.push("projection_sync");
					},
				},
				{
					stop() {
						stopped.push("store_event_replay");
					},
				},
			],
			logger: {
				error(message, error) {
					loggedErrors.push({ message, error });
				},
			},
		});

		await expect(async () => handlers.get("unhandledRejection")?.(fatalError)).toThrow(
			"process exited",
		);
		expect(stopped).toEqual(["projection_sync", "store_event_replay"]);
		expect(loggedErrors).toEqual([{ message: "Billing runtime fatal error", error: fatalError }]);
		expect(exitCodes).toEqual([1]);
		expect(handlers.has("uncaughtException")).toBe(true);
	});

	it("awaits the runtime stop before exiting on termination signals", async () => {
		const handlers = new Map<string, () => void>();
		const stopped: string[] = [];
		const exitCodes: number[] = [];

		const processLike = {
			on(signal: string, handler: () => void) {
				handlers.set(signal, handler);
				return processLike;
			},
			exit(code?: number) {
				exitCodes.push(code ?? 0);
				throw new Error("process exited");
			},
		};

		registerProjectionRuntimeShutdown({
			process: processLike,
			runtime: {
				stop() {
					stopped.push("stop");
				},
			},
		});

		await expect(async () => handlers.get("SIGTERM")?.()).toThrow("process exited");
		await expect(async () => handlers.get("SIGINT")?.()).toThrow("process exited");
		expect(stopped).toEqual(["stop", "stop"]);
		expect(exitCodes).toEqual([0, 0]);
	});
});
