import { describe, expect, it } from "bun:test";
import { evaluateLoadGates } from "../../scripts/lib/load-gates";

const result = (overrides: Partial<Parameters<typeof evaluateLoadGates>[0][number]> = {}) => ({
	scenario: "hot",
	statuses: { "200": 10 },
	rps: 50,
	clientMs: { p99: 20 },
	db: { projectionBacklogAfter: 0 },
	...overrides,
});

describe("evaluateLoadGates", () => {
	it("fails on status 0, 5xx, leftover backlog, and optional thresholds", () => {
		expect(evaluateLoadGates([result({ statuses: { "0": 1 } })])).toEqual([
			"hot recorded 1 status 0 responses",
		]);
		expect(evaluateLoadGates([result({ statuses: { "503": 2 } })])).toEqual([
			"hot recorded 2 status 503 responses",
		]);
		expect(evaluateLoadGates([result({ db: { projectionBacklogAfter: 3 } })])).toEqual([
			"hot left a projection backlog of 3",
		]);
		expect(
			evaluateLoadGates([result({ scenario: "workers-off", db: { projectionBacklogAfter: 3 } })]),
		).toEqual([]);
		expect(evaluateLoadGates([result({ rps: 1 })], { minRps: 10 })).toEqual([
			"hot rps 1 is below 10",
		]);
		expect(evaluateLoadGates([result({ clientMs: { p99: 80 } })], { maxP99Ms: 50 })).toEqual([
			"hot p99 80ms exceeds 50ms",
		]);
		expect(evaluateLoadGates([result()])).toEqual([]);
	});
});
