import { describe, expect, it } from "bun:test";
import {
	startPollingRuntime,
	startProjectionSyncRuntime,
	type TimeoutHandle,
} from "../../src/workers/runtime";

const createDeferred = <T = void>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});

	return { promise, resolve, reject };
};

describe("projection sync runtime", () => {
	it("polls the worker and reschedules after success", async () => {
		const scheduled: Array<{ callback: () => void; ms: number; handle: TimeoutHandle }> = [];
		const calls: string[] = [];

		startProjectionSyncRuntime({
			worker: {
				async runOnce() {
					calls.push("runOnce");
					return { claimed: 0, succeeded: 0, failed: 0 };
				},
			},
			pollIntervalMs: 2500,
			timers: {
				setTimeout(callback, ms) {
					const handle = { id: scheduled.length + 1 };
					scheduled.push({ callback, ms, handle });
					return handle;
				},
				clearTimeout() {
					throw new Error("should not clear");
				},
			},
			logger: { error: () => undefined },
		});

		expect(scheduled.map((entry) => entry.ms)).toEqual([2500]);

		scheduled[0].callback();
		await Promise.resolve();

		expect(calls).toEqual(["runOnce"]);
		expect(scheduled.map((entry) => entry.ms)).toEqual([2500, 2500]);
	});

	it("logs generic worker failures with worker name context and keeps polling", async () => {
		const scheduled: Array<() => void> = [];
		const errors: unknown[] = [];

		startPollingRuntime({
			name: "store_event_replay",
			worker: {
				async runOnce() {
					throw new Error("database unavailable");
				},
			},
			pollIntervalMs: 1000,
			timers: {
				setTimeout(callback) {
					scheduled.push(callback);
					return scheduled.length;
				},
				clearTimeout() {
					throw new Error("should not clear");
				},
			},
			logger: {
				error(message, error, context) {
					errors.push({ message, error, context });
				},
			},
		});

		scheduled[0]();
		await Promise.resolve();

		expect(errors).toEqual([
			{
				message: "store_event_replay worker poll failed",
				error: new Error("database unavailable"),
				context: { worker: "store_event_replay" },
			},
		]);
		expect(scheduled).toHaveLength(2);
	});

	it("logs projection compatibility wrapper failures and keeps polling", async () => {
		const scheduled: Array<() => void> = [];
		const errors: unknown[] = [];

		startProjectionSyncRuntime({
			worker: {
				async runOnce() {
					throw new Error("database unavailable");
				},
			},
			pollIntervalMs: 1000,
			timers: {
				setTimeout(callback) {
					scheduled.push(callback);
					return scheduled.length;
				},
				clearTimeout() {
					throw new Error("should not clear");
				},
			},
			logger: {
				error(message, error, context) {
					errors.push({ message, error, context });
				},
			},
		});

		scheduled[0]();
		await Promise.resolve();

		expect(errors).toEqual([
			{
				message: "projection_sync worker poll failed",
				error: new Error("database unavailable"),
				context: { worker: "projection_sync" },
			},
		]);
		expect(scheduled).toHaveLength(2);
	});

	it("stop cancels the pending poll and prevents rescheduling", async () => {
		const scheduled: Array<{ callback: () => void; handle: TimeoutHandle }> = [];
		const cleared: TimeoutHandle[] = [];
		const running = createDeferred();
		let calls = 0;

		const runtime = startProjectionSyncRuntime({
			worker: {
				async runOnce() {
					calls += 1;
					await running.promise;
					return { claimed: 0, succeeded: 0, failed: 0 };
				},
			},
			pollIntervalMs: 1000,
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
			logger: { error: () => undefined },
		});

		expect(scheduled).toHaveLength(1);
		await runtime.stop();

		expect(cleared).toEqual([scheduled[0].handle]);

		scheduled[0].callback();
		expect(calls).toBe(0);

		running.resolve();
		await Promise.resolve();
		expect(scheduled).toHaveLength(1);
	});

	it("stop waits for an active poll before resolving", async () => {
		const scheduled: Array<{ callback: () => void; handle: TimeoutHandle }> = [];
		const running = createDeferred();
		let stopResolved = false;

		const runtime = startProjectionSyncRuntime({
			worker: {
				async runOnce() {
					await running.promise;
					return { claimed: 0, succeeded: 0, failed: 0 };
				},
			},
			pollIntervalMs: 1000,
			timers: {
				setTimeout(callback) {
					const handle = { id: scheduled.length + 1 };
					scheduled.push({ callback, handle });
					return handle;
				},
				clearTimeout() {
					return;
				},
			},
			logger: { error: () => undefined },
		});

		scheduled[0].callback();
		await Promise.resolve();

		const stopPromise = runtime.stop().then(() => {
			stopResolved = true;
		});
		await Promise.resolve();
		expect(stopResolved).toBe(false);

		running.resolve();
		await stopPromise;
		expect(stopResolved).toBe(true);
		expect(scheduled).toHaveLength(1);
	});
});
