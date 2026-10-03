import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { type CarriedUsageEdge, sharedCarriedUsage } from "../../src/db/repository/carry-over";
import { carriedUsageQuantity } from "../../src/db/repository/recurring-pricing";

const edge = (from: string, to: string, applied: bigint): CarriedUsageEdge => ({
	from,
	to,
	applied,
});

describe("usage a carry shares with the allowance it returns to", () => {
	it("counts usage carried from the returning allowance onto the outgoing one", () => {
		// A -> B carried 30; B -> A must not carry it back.
		expect(sharedCarriedUsage([edge("a", "b", 30n)], "b", "a")).toBe(30n);
	});

	it("counts usage the returning allowance was carried from the outgoing one", () => {
		// A -> B carried 30, B -> A carried B's own 10; A -> B again shares both.
		const edges = [edge("a", "b", 30n), edge("b", "a", 10n)];
		expect(sharedCarriedUsage(edges, "a", "b")).toBe(40n);
	});

	it("follows a chain of carries, up to what each step applied", () => {
		// A -> B 30, B -> C 30: C holds A's 30. A clamped step passes on only what it applied.
		expect(sharedCarriedUsage([edge("a", "b", 30n), edge("b", "c", 30n)], "c", "a")).toBe(30n);
		expect(sharedCarriedUsage([edge("a", "b", 30n), edge("b", "c", 20n)], "c", "a")).toBe(20n);
	});

	it("ignores unrelated and empty carries and stops at cycles", () => {
		expect(sharedCarriedUsage([edge("x", "b", 30n), edge("a", "b", 0n)], "b", "a")).toBe(0n);
		const cycle = [edge("b", "c", 5n), edge("c", "b", 5n)];
		expect(sharedCarriedUsage(cycle, "b", "a")).toBe(0n);
	});

	it("does not count overlapping paths around three plans twice", () => {
		// A and B share A's 20 and B's 20, but C's 20 has only reached A.
		const edges = [edge("a", "b", 20n), edge("b", "c", 40n), edge("c", "a", 40n)];
		expect(sharedCarriedUsage(edges, "a", "b")).toBe(40n);
		expect(sharedCarriedUsage(edges, "b", "a")).toBe(40n);
	});

	it("recognizes the same usage carried from a common ancestor", () => {
		// A -> B carries A's first unit; B -> A carries B's unit; A -> C adds A's next unit.
		const edges = [edge("a", "b", 1n), edge("b", "a", 1n), edge("a", "c", 3n)];
		expect(sharedCarriedUsage(edges, "c", "b")).toBe(2n);
	});

	it("preserves partially carried portions when branches converge", () => {
		const edges = [edge("a", "b", 30n), edge("b", "c", 20n), edge("b", "d", 25n)];
		expect(sharedCarriedUsage(edges, "c", "d")).toBe(20n);
		// C has another 10 of its own; D has room for only 5 of those.
		edges.push(edge("c", "d", 5n));
		expect(sharedCarriedUsage(edges, "c", "d")).toBe(25n);
		expect(sharedCarriedUsage(edges, "b", "d")).toBe(25n);
		// D -> C adds only the 5 of B's usage that C has not yet received.
		edges.push(edge("d", "c", 5n));
		expect(sharedCarriedUsage(edges, "b", "c")).toBe(25n);
		expect(sharedCarriedUsage(edges, "c", "d")).toBe(30n);
	});

	it("matches distinct consumed units across repeated switches with optional carries", () => {
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						consumed: fc.integer({ min: 0, max: 5 }),
						offset: fc.integer({ min: 1, max: 3 }),
						carry: fc.boolean(),
					}),
					{ minLength: 1, maxLength: 30 },
				),
				(switches) => {
					// The oracle tracks individual consumed units, independently of the carry totals.
					const allowances = Array.from({ length: 4 }, () => new Set<number>());
					const edges: CarriedUsageEdge[] = [];
					let active = 0;
					let unit = 0;
					for (const change of switches) {
						const incoming = (active + change.offset) % allowances.length;
						const from = allowances[active] as Set<number>;
						const to = allowances[incoming] as Set<number>;
						for (let used = 0; used < change.consumed; used++) from.add(unit++);
						const shared = [...from].filter((id) => to.has(id)).length;
						expect(sharedCarriedUsage(edges, String(active), String(incoming))).toBe(
							BigInt(shared),
						);
						if (change.carry) {
							edges.push(edge(String(active), String(incoming), BigInt(from.size - shared)));
							for (const id of from) to.add(id);
						}
						active = incoming;
					}
				},
			),
			{ seed: 20261003, numRuns: 200 },
		);
	});

	it("previews only the usage the target does not hold", () => {
		expect(carriedUsageQuantity("30.000000000", 30_000_000_000n)).toBe("0");
		expect(carriedUsageQuantity("40", 30_000_000_000n)).toBe("10");
		expect(carriedUsageQuantity("30", 0n)).toBe("30");
	});
});
