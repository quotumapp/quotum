import { describe, expect, it } from "bun:test";
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

	it("previews only the usage the target does not hold", () => {
		expect(carriedUsageQuantity("30.000000000", 30_000_000_000n)).toBe("0");
		expect(carriedUsageQuantity("40", 30_000_000_000n)).toBe("10");
		expect(carriedUsageQuantity("30", 0n)).toBe("30");
	});
});
