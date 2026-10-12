import { describe, expect, it } from "bun:test";
import { evaluateLoadGates, isSuccessStatus } from "../../scripts/lib/load-gates";

const result = (overrides: Partial<Parameters<typeof evaluateLoadGates>[0][number]> = {}) => ({
	scenario: "hot",
	requests: 10,
	accepted: 10,
	denied: 0,
	statuses: { "200": 10 },
	rps: 50,
	clientMs: { p99: 20 },
	db: { projectionBacklogAfter: 0 },
	...overrides,
});

describe("evaluateLoadGates", () => {
	it("rejects lost scheduled users, business denials, and missing durable usage", () => {
		const arrivals = {
			scheduled: 100,
			accepted: 100,
			droppedCapacity: 0,
			droppedLate: 0,
			accounting: { missingAccepted: 0, invalidEvents: 0 },
		};
		expect(evaluateLoadGates([result({ scenario: "users", arrivals })])).toEqual([]);
		for (const failed of [
			{ ...arrivals, accepted: 99 },
			{ ...arrivals, accepted: 90, droppedCapacity: 10 },
			{ ...arrivals, accepted: 90, droppedLate: 10 },
			{ ...arrivals, accounting: { missingAccepted: 1, invalidEvents: 0 } },
			{ ...arrivals, accounting: { missingAccepted: 0, invalidEvents: 1 } },
		]) {
			expect(evaluateLoadGates([result({ scenario: "users", arrivals: failed })]).length).toBe(1);
		}
	});

	it("fails on status 0, 5xx, leftover backlog, and optional thresholds", () => {
		expect(
			evaluateLoadGates([result({ statuses: { "200": 9, "0": 1 }, accepted: 9 })]).filter((line) =>
				line.includes("status"),
			),
		).toEqual(["hot recorded 1 status 0 responses"]);
		expect(
			evaluateLoadGates([result({ statuses: { "200": 8, "503": 2 }, accepted: 8 })]).filter(
				(line) => line.includes("status"),
			),
		).toEqual(["hot recorded 2 status 503 responses"]);
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

	it("fails a lane whose every request was rejected with a client error", () => {
		// The shape the lane reported as green when it posted a body the API no longer accepted.
		const rejected = result({ requests: 13953, accepted: 0, statuses: { "400": 13953 } });
		expect(evaluateLoadGates([rejected])).toEqual([
			"hot recorded 13953 status 400 responses",
			"hot accepted 0/13953 requests (0 denied)",
		]);
	});

	it("fails on any non-2xx status, not only 0 and 5xx", () => {
		for (const status of ["302", "400", "401", "403", "404", "409", "422", "429"]) {
			const failures = evaluateLoadGates([
				result({ requests: 100, accepted: 99, statuses: { "200": 99, [status]: 1 } }),
			]);
			expect(failures).toContain(`hot recorded 1 status ${status} responses`);
		}
		expect(
			evaluateLoadGates([result({ requests: 10, accepted: 10, statuses: { "200": 9, "204": 1 } })]),
		).toEqual([]);
	});

	it("fails a scenario that sent nothing", () => {
		expect(evaluateLoadGates([result({ requests: 0, accepted: 0, statuses: {}, rps: 0 })])).toEqual(
			["hot sent no requests"],
		);
	});

	it("fails when requests are answered 200 but not allowed", () => {
		// A denied consume is HTTP 200 with allowed false: no status gate sees it.
		expect(
			evaluateLoadGates([
				result({ requests: 100, accepted: 10, denied: 90, statuses: { "200": 100 } }),
			]),
		).toEqual(["hot accepted 10/100 requests (90 denied)"]);
		// The fixture grants far more than a run spends, so even one denial is a defect.
		expect(
			evaluateLoadGates([
				result({ requests: 100, accepted: 99, denied: 1, statuses: { "200": 100 } }),
			]),
		).toEqual(["hot accepted 99/100 requests (1 denied)"]);
		// A 200 that is neither allowed nor denied is not accepted either.
		expect(
			evaluateLoadGates([
				result({ requests: 10, accepted: 9, denied: 0, statuses: { "200": 10 } }),
			]),
		).toEqual(["hot accepted 9/10 requests (0 denied)"]);
	});

	it("labels each arrival-rate level and applies the status gate to it", () => {
		const arrivals = {
			users: 1000,
			scheduled: 100,
			accepted: 100,
			droppedCapacity: 0,
			droppedLate: 0,
			accounting: { missingAccepted: 0, invalidEvents: 0 },
		};
		expect(
			evaluateLoadGates([
				result({
					scenario: "users",
					requests: 100,
					accepted: 100,
					statuses: { "200": 99, "429": 1 },
					arrivals,
				}),
			]),
		).toEqual(["users (1000 users) recorded 1 status 429 responses"]);
		const refused = { ...arrivals, accepted: 0 };
		expect(
			evaluateLoadGates([
				result({
					scenario: "users",
					requests: 100,
					accepted: 0,
					statuses: { "400": 100 },
					arrivals: refused,
				}),
			]),
		).toEqual([
			"users (1000 users) accepted 0/100 scheduled arrivals (capacity drops 0, generator drops 0)",
			"users (1000 users) recorded 100 status 400 responses",
		]);
	});
});

describe("isSuccessStatus", () => {
	it("accepts only 2xx", () => {
		expect([0, 199, 200, 204, 299, 300, 400, 503, Number.NaN].map(isSuccessStatus)).toEqual([
			false,
			false,
			true,
			true,
			true,
			false,
			false,
			false,
			false,
		]);
	});
});
