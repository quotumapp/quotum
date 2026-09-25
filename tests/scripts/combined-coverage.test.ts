import { describe, expect, it } from "bun:test";
import {
	completeCoverage,
	mergeLcov,
	ratchetErrors,
	renderLcov,
	runtimeLines,
} from "../../scripts/lib/coverage-map";
import { changedLines, diffCoverage } from "../../scripts/lib/diff-coverage";
import { summarizeLcov } from "../../scripts/lib/lcov-summary";

function report(path: string, lines: string) {
	return `SF:${path}\n${lines}\nend_of_record\n`;
}

describe("combined coverage", () => {
	it("intersects inventories for the same file and takes maximum hits", () => {
		const map = mergeLcov([
			report("src/a.ts", "DA:1,0\nDA:2,9\nDA:3,0"),
			report("src/a.ts", "DA:1,4\nDA:3,0\nDA:4,1"),
		]);
		expect([...(map.get("src/a.ts")?.lines ?? [])]).toEqual([
			[1, 4],
			[3, 0],
		]);
		expect(summarizeLcov(renderLcov(map)).lines).toEqual({ found: 2, hit: 1 });
	});
	it("retains files unique to a lane and merges function hits", () => {
		const map = mergeLcov([
			report("src/a.ts", "DA:1,0\nFNDA:0,run"),
			report("src/a.ts", "DA:1,1\nFNDA:2,run") + report("src/b.ts", "DA:8,1"),
		]);
		expect(summarizeLcov(renderLcov(map))).toEqual({
			files: 2,
			lines: { found: 2, hit: 2 },
			functions: { found: 1, hit: 1 },
		});
	});
	it("fails closed on empty or malformed reports", () => {
		expect(() => mergeLcov([""])).toThrow("no SF records");
		expect(() => mergeLcov([report("src/a.ts", "DA:no,1")])).toThrow("Invalid LCOV line");
	});
	it("includes unimported runtime files but excludes type-only files", async () => {
		const map = mergeLcov([report("src/a.ts", "DA:1,1")]);
		await completeCoverage(
			map,
			new Map([
				["src/a.ts", "export const a = 1;"],
				["src/missing.ts", "// comment\nexport const missing = 2;"],
				["src/types.ts", "export interface OnlyType { id: string }\nexport type Name = string;"],
			]),
		);
		expect(map.get("src/missing.ts")?.lines.get(2)).toBe(0);
		expect(map.has("src/types.ts")).toBe(false);
		expect(await runtimeLines("// just a comment\n")).toEqual([]);
	});
	it("checks floors and demands a ratchet only above two points", () => {
		expect(ratchetErrors(90, 90)).toEqual([]);
		expect(ratchetErrors(92, 90)).toEqual([]);
		expect(ratchetErrors(89.99, 90)[0]).toContain("below");
		expect(ratchetErrors(92.01, 90)[0]).toContain("exceeds");
		expect(ratchetErrors(90, Number.NaN)).toEqual(["Invalid coverage floor"]);
	});
	it("selects per-area records without prefix collisions", () => {
		const map = mergeLcov([
			report("src/http/a.ts", "DA:1,1") + report("src/http-other.ts", "DA:1,0"),
		]);
		expect(summarizeLcov(renderLcov(map, "src/http/")).lines).toEqual({ found: 1, hit: 1 });
	});
	it("counts changed executable lines, including wholly missing files", async () => {
		const changes = changedLines(
			"+++ b/src/a.ts\n@@ -0,0 +1,3 @@\n+x\n+++ b/src/missing.ts\n@@ -0,0 +1 @@\n+x\n+++ /dev/null\n@@ -1 +0,0 @@",
		);
		const map = mergeLcov([report("src/a.ts", "DA:2,1\nDA:3,0")]);
		await completeCoverage(map, new Map([["src/missing.ts", "export const missing = 1;"]]));
		expect(diffCoverage(map, changes)).toEqual({
			found: 3,
			hit: 1,
			uncovered: [
				{ path: "src/a.ts", line: 3 },
				{ path: "src/missing.ts", line: 1 },
			],
		});
	});
});
