import { describe, expect, it } from "bun:test";
import { startLeaseHeartbeat } from "../../src/workers/lease-heartbeat";
import { createDeferred } from "../helpers/deferred";

describe("startLeaseHeartbeat", () => {
	it("rejects non-positive intervals without scheduling", () => {
		let scheduled = 0;
		const timers = {
			setInterval() {
				scheduled += 1;
				return { id: 1 };
			},
			clearInterval() {},
		};
		for (const intervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() =>
				startLeaseHeartbeat({
					intervalMs,
					heartbeat: async () => undefined,
					timers,
				}),
			).toThrow("Lease heartbeat interval must be positive");
		}
		expect(scheduled).toBe(0);
	});

	it("schedules once, suppresses overlap, and resumes after the in-flight heartbeat", async () => {
		const scheduled: Array<{ callback: () => void; ms: number; handle: { id: number } }> = [];
		const inFlight = createDeferred();
		let heartbeats = 0;
		startLeaseHeartbeat({
			intervalMs: 25,
			heartbeat: async () => {
				heartbeats += 1;
				await inFlight.promise;
			},
			timers: {
				setInterval(callback, ms) {
					const handle = { id: scheduled.length + 1 };
					scheduled.push({ callback, ms, handle });
					return handle;
				},
				clearInterval() {},
			},
		});

		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.ms).toBe(25);
		scheduled[0]?.callback();
		await Promise.resolve();
		expect(heartbeats).toBe(1);
		scheduled[0]?.callback();
		scheduled[0]?.callback();
		await Promise.resolve();
		expect(heartbeats).toBe(1);
		inFlight.resolve();
		await inFlight.promise;
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		scheduled[0]?.callback();
		await Promise.resolve();
		expect(heartbeats).toBe(2);
	});

	it("reports heartbeat rejections to onError and continues", async () => {
		const scheduled: Array<{ callback: () => void }> = [];
		const errors: unknown[] = [];
		const failure = new Error("lease renew failed");
		let heartbeats = 0;
		startLeaseHeartbeat({
			intervalMs: 10,
			heartbeat: async () => {
				heartbeats += 1;
				if (heartbeats === 1) {
					throw failure;
				}
			},
			onError: (error) => {
				errors.push(error);
			},
			timers: {
				setInterval(callback) {
					scheduled.push({ callback });
					return { id: 1 };
				},
				clearInterval() {},
			},
		});

		scheduled[0]?.callback();
		await Promise.resolve();
		await Promise.resolve();
		expect(errors).toEqual([failure]);
		scheduled[0]?.callback();
		await Promise.resolve();
		expect(heartbeats).toBe(2);
	});

	it("swallows rejections when onError is omitted", async () => {
		const scheduled: Array<{ callback: () => void }> = [];
		startLeaseHeartbeat({
			intervalMs: 10,
			heartbeat: async () => {
				throw new Error("ignored");
			},
			timers: {
				setInterval(callback) {
					scheduled.push({ callback });
					return { id: 1 };
				},
				clearInterval() {},
			},
		});

		scheduled[0]?.callback();
		await Promise.resolve();
		await Promise.resolve();
	});

	it("unrefs the interval handle when available", () => {
		let unrefed = 0;
		const handle = {
			id: 1,
			unref() {
				unrefed += 1;
			},
		};
		startLeaseHeartbeat({
			intervalMs: 10,
			heartbeat: async () => undefined,
			timers: {
				setInterval() {
					return handle;
				},
				clearInterval() {},
			},
		});
		expect(unrefed).toBe(1);
	});

	it("stop waits for an in-flight heartbeat before settling", async () => {
		const scheduled: Array<{ callback: () => void; handle: { id: number } }> = [];
		const cleared: unknown[] = [];
		const inFlight = createDeferred();
		let stopSettled = false;
		const stop = startLeaseHeartbeat({
			intervalMs: 10,
			heartbeat: async () => {
				await inFlight.promise;
			},
			timers: {
				setInterval(callback) {
					const handle = { id: 1 };
					scheduled.push({ callback, handle });
					return handle;
				},
				clearInterval(handle) {
					cleared.push(handle);
				},
			},
		});

		scheduled[0]?.callback();
		const stopping = stop().then(() => {
			stopSettled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(stopSettled).toBe(false);
		expect(cleared).toEqual([scheduled[0]?.handle]);
		inFlight.resolve();
		await stopping;
		expect(stopSettled).toBe(true);
	});
});
