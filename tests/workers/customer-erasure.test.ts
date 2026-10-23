import { describe, expect, it } from "bun:test";
import type { CustomerErasureRunOutcome } from "../../src/db/repository/customer-erasures";
import { CustomerErasureWorker } from "../../src/workers/customer-erasure";

function repository(outcomes: CustomerErasureRunOutcome[]) {
	const calls = { claims: 0, sweeps: 0, options: [] as unknown[] };
	return {
		calls,
		repository: {
			async runNextCustomerErasure(options: unknown) {
				calls.claims += 1;
				calls.options.push(options);
				return outcomes.shift() ?? ({ kind: "idle" } as const);
			},
			async sweepCustomerErasures() {
				calls.sweeps += 1;
				return 3;
			},
		},
	};
}

describe("CustomerErasureWorker", () => {
	it("works claims until none is due and counts what happened", async () => {
		const fake = repository([
			{ kind: "progressed", erasureId: "a" },
			{ kind: "completed", erasureId: "b" },
			{ kind: "failed", erasureId: "c" },
		]);
		const worker = new CustomerErasureWorker({ repository: fake.repository, workerId: "w1" });

		const result = await worker.runOnce();

		expect(result).toEqual({ progressed: 1, completed: 1, failed: 1, swept: 3 });
		expect(fake.calls.claims).toBe(4);
		expect(fake.calls.options[0]).toEqual({
			workerId: "w1",
			batchSize: 500,
			budgetMs: 15_000,
			leaseSeconds: 300,
		});
	});

	it("stops claiming at its per-run cap", async () => {
		const fake = repository(
			Array.from({ length: 10 }, (_, index) => ({
				kind: "progressed" as const,
				erasureId: String(index),
			})),
		);
		const worker = new CustomerErasureWorker({
			repository: fake.repository,
			workerId: "w1",
			maxClaims: 2,
		});

		await worker.runOnce();

		expect(fake.calls.claims).toBe(2);
	});

	it("sweeps at most once a minute", async () => {
		const fake = repository([]);
		const worker = new CustomerErasureWorker({ repository: fake.repository, workerId: "w1" });

		await worker.runOnce();
		await worker.runOnce();

		expect(fake.calls.sweeps).toBe(1);
	});

	it("uses the configured sweep interval, claim budget and batch", async () => {
		const fake = repository([]);
		let now = 10_000;
		const worker = new CustomerErasureWorker({
			repository: fake.repository,
			workerId: "w1",
			batchSize: 7,
			budgetMs: 100,
			sweepIntervalMs: 10,
			now: () => now,
		});
		await worker.runOnce();
		await worker.runOnce();
		expect(fake.calls.sweeps).toBe(1);
		now += 10;
		await worker.runOnce();
		expect(fake.calls.sweeps).toBe(2);
		expect(fake.calls.options[0]).toMatchObject({ batchSize: 7, budgetMs: 100, leaseSeconds: 300 });
	});

	it("rejects a lease that does not outlast its budget", () => {
		expect(
			() =>
				new CustomerErasureWorker({
					repository: repository([]).repository,
					workerId: "w1",
					budgetMs: 60_000,
					leaseSeconds: 30,
				}),
		).toThrow("lease must outlast");
		expect(
			() =>
				new CustomerErasureWorker({
					repository: repository([]).repository,
					workerId: "w1",
					batchSize: 0,
				}),
		).toThrow("batch size");
	});

	it("rethrows a failed run so the scheduler records it", async () => {
		const worker = new CustomerErasureWorker({
			workerId: "w1",
			repository: {
				async runNextCustomerErasure() {
					throw new Error("database down");
				},
				async sweepCustomerErasures() {
					return 0;
				},
			},
		});

		await expect(worker.runOnce()).rejects.toThrow("database down");
	});
});
