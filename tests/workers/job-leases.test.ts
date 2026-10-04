import { expect, it } from "bun:test";
import {
	JobLeaseRenewalError,
	jobHeartbeatInterval,
	startJobLeases,
} from "../../src/workers/job-leases";
import { createDeferred } from "../helpers/deferred";
import { heartbeatTimers } from "../helpers/heartbeat-timers";

it("bounds heartbeat intervals by the reclaim window", () => {
	expect(jobHeartbeatInterval(300_000)).toBe(60_000);
	expect(jobHeartbeatInterval(90)).toBe(30);
	expect(jobHeartbeatInterval(300_000, 50)).toBe(50);
	for (const interval of [0, -1, 300_000, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(() => jobHeartbeatInterval(300_000, interval)).toThrow("shorter than the lease");
	}
	expect(() => jobHeartbeatInterval(Number.POSITIVE_INFINITY)).toThrow("shorter than the lease");
});

it("renews waiting claims, isolates errors, retries a transient failure, and drops finished jobs", async () => {
	const clock = heartbeatTimers();
	const calls: string[] = [];
	const errors: unknown[] = [];
	let fail = true;
	const leases = startJobLeases({
		jobs: ["first", "waiting"],
		intervalMs: 50,
		timers: clock.timers,
		async renew(job) {
			calls.push(job);
			if (job === "first" && fail) throw new Error("database unavailable");
			return true;
		},
		onLost() {},
		onError: (error) => errors.push(error),
	});
	clock.tick();
	await Bun.sleep(0);
	expect(calls).toEqual(["first", "waiting"]);
	expect(errors).toHaveLength(1);
	fail = false;
	expect(await leases.owns("first")).toBe(true);
	leases.release("first");
	calls.length = 0;
	clock.tick();
	await Bun.sleep(0);
	expect(calls).toEqual(["waiting"]);
	expect(await leases.owns("first")).toBe(false);
	await leases.stop();
	expect(clock.active).toBe(0);
});

it("coalesces overlapping ownership checks and waits for a heartbeat during shutdown", async () => {
	const clock = heartbeatTimers();
	const gate = createDeferred<boolean>();
	let calls = 0;
	const leases = startJobLeases({
		jobs: ["job"],
		intervalMs: 50,
		timers: clock.timers,
		renew: async () => {
			calls++;
			return await gate.promise;
		},
		onLost() {},
		onError() {},
	});
	clock.tick();
	const first = leases.owns("job");
	const second = leases.owns("job");
	expect(first).toBe(second);
	let stopped = false;
	const stopping = leases.stop().then(() => {
		stopped = true;
	});
	await Bun.sleep(0);
	expect(calls).toBe(1);
	expect(stopped).toBe(false);
	gate.resolve(true);
	expect(await first).toBe(true);
	await stopping;
	expect(clock.active).toBe(0);
});

it("never authorizes a lost lease again, even when its diagnostic logger throws", async () => {
	let calls = 0;
	const leases = startJobLeases({
		jobs: ["job"],
		intervalMs: 50,
		async renew() {
			calls++;
			return false;
		},
		onLost() {
			throw new Error("logger failed");
		},
		onError() {},
	});
	expect(await leases.owns("job")).toBe(false);
	expect(await leases.owns("job")).toBe(false);
	expect(calls).toBe(1);
	await leases.stop();
});

it("classifies a failed ownership check independently of provider failures", async () => {
	const leases = startJobLeases({
		jobs: ["job"],
		intervalMs: 50,
		async renew() {
			throw new Error("database unavailable");
		},
		onLost() {},
		onError() {
			throw new Error("logger failed");
		},
	});
	await expect(leases.owns("job")).rejects.toThrow(JobLeaseRenewalError);
	await leases.stop();
});

it("ignores late renewal results after a job is removed", async () => {
	const gate = createDeferred<boolean>();
	const lost: string[] = [];
	const leases = startJobLeases({
		jobs: ["job"],
		intervalMs: 50,
		renew: () => gate.promise,
		onLost: (job) => lost.push(job),
		onError() {},
	});
	const pending = leases.owns("job");
	leases.release("job");
	gate.resolve(false);
	expect(await pending).toBe(false);
	expect(lost).toEqual([]);
	await leases.stop();
});

it("does not schedule an empty batch", async () => {
	const clock = heartbeatTimers();
	const leases = startJobLeases({
		jobs: [],
		intervalMs: 50,
		timers: clock.timers,
		async renew() {
			throw new Error("empty batch");
		},
		onLost() {},
		onError() {},
	});
	expect(clock.active).toBe(0);
	await leases.stop();
});
