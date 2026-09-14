import { describe, expect, it } from "bun:test";
import {
	createRuntimeLifecycle,
	type QuotumRuntimeScheduler,
} from "../../src/composition/runtime-lifecycle";
import { createDeferred } from "../helpers/deferred";

function fixture(overrides: Partial<Parameters<typeof createRuntimeLifecycle>[0]> = {}) {
	const events: string[] = [];
	const runtime = createRuntimeLifecycle({
		acquire() {
			events.push("acquire");
			return () => {
				events.push("release");
			};
		},
		async initialize() {
			events.push("initialize");
		},
		compose() {
			events.push("compose");
			return {
				app: { fetch: () => new Response("core") },
				jobs: ["one", "two"].map((name) => ({
					name,
					pollIntervalMs: 10,
					async runOnce() {
						events.push(name);
					},
				})),
			};
		},
		scheduler: {
			schedule(job) {
				events.push(`schedule:${job.name}`);
				return {
					async stop() {
						events.push(`stop:${job.name}`);
					},
				};
			},
		},
		cleanup: [
			async () => {
				events.push("cleanup");
			},
		],
		...overrides,
	});
	return { runtime, events };
}

describe("distribution lifecycle", () => {
	it("constructs without starting work, and starts/stops once under concurrent calls", async () => {
		const { runtime, events } = fixture();
		expect(events).toEqual([]);
		expect((await runtime.app.fetch(new Request("http://localhost/ready"))).status).toBe(503);
		const first = runtime.start();
		expect(runtime.start()).toBe(first);
		await first;
		expect(await (await runtime.app.fetch(new Request("http://localhost/"))).text()).toBe("core");
		const stop = runtime.stop();
		expect(runtime.stop()).toBe(stop);
		await stop;
		expect(events).toEqual([
			"acquire",
			"initialize",
			"compose",
			"schedule:one",
			"schedule:two",
			"stop:one",
			"stop:two",
			"cleanup",
			"release",
		]);
		await expect(runtime.start()).rejects.toThrow("cannot be restarted");
	});
	it("drains requests and schedules before cleaning up persistence", async () => {
		const request = createDeferred<Response>();
		const worker = createDeferred();
		const cleaned = createDeferred();
		const { runtime } = fixture({
			compose: () => ({
				app: { fetch: () => request.promise },
				jobs: [{ name: "slow", pollIntervalMs: 1, async runOnce() {} }],
			}),
			scheduler: { schedule: () => ({ stop: () => worker.promise }) },
			cleanup: [
				async () => {
					cleaned.resolve();
				},
			],
		});
		await runtime.start();
		const response = runtime.app.fetch(new Request("http://localhost/"));
		let done = false;
		const stopping = runtime.stop().then(() => {
			done = true;
		});
		worker.resolve();
		await Promise.resolve();
		expect(done).toBe(false);
		expect((await runtime.app.fetch(new Request("http://localhost/"))).status).toBe(503);
		request.resolve(new Response("finished"));
		await response;
		await stopping;
		await cleaned.promise;
	});
	it("cleans partial scheduler startup and still releases ownership", async () => {
		let stopped = 0;
		const scheduler: QuotumRuntimeScheduler = {
			schedule(job) {
				if (job.name === "two") throw new Error("scheduler unavailable");
				return {
					async stop() {
						stopped++;
					},
				};
			},
		};
		const { runtime, events } = fixture({ scheduler });
		await expect(runtime.start()).rejects.toThrow("scheduler unavailable");
		await runtime.stop();
		expect(stopped).toBe(1);
		expect(events.slice(-2)).toEqual(["cleanup", "release"]);
	});
	it("cancels initialization without starting schedules", async () => {
		const initialized = createDeferred();
		const { runtime, events } = fixture({ initialize: () => initialized.promise });
		const starting = runtime.start();
		const outcome = starting.catch((error: unknown) => error);
		const stopping = runtime.stop();
		initialized.resolve();
		expect(String(await outcome)).toContain("stopped during startup");
		await stopping;
		expect(events).toEqual(["acquire", "cleanup", "release"]);
	});
	it("never disposes another runtime after ownership acquisition is rejected", async () => {
		const { runtime, events } = fixture({
			acquire() {
				throw new Error("already active");
			},
		});
		await expect(runtime.start()).rejects.toThrow("already active");
		await runtime.stop();
		expect(events).toEqual([]);
	});
	it("runs all cleanup and releases ownership even when a stop or cleanup fails", async () => {
		const cleaned: number[] = [];
		const { runtime, events } = fixture({
			scheduler: {
				schedule: () => ({
					async stop() {
						throw new Error("stop failed");
					},
				}),
			},
			cleanup: [
				async () => {
					cleaned.push(1);
					throw new Error("cleanup failed");
				},
				async () => {
					cleaned.push(2);
				},
			],
		});
		await runtime.start();
		await expect(runtime.stop()).rejects.toThrow("cleanup failed");
		expect(cleaned).toEqual([1, 2]);
		expect(events.at(-1)).toBe("release");
	});
	it("does not allocate anything when stopped before start", async () => {
		const { runtime, events } = fixture();
		await runtime.stop();
		await expect(runtime.start()).rejects.toThrow("cannot be restarted");
		expect(events).toEqual([]);
	});
});
