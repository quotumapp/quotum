import { describe, expect, it } from "bun:test";
import { coverageShortfalls, summarizeLcov } from "../../scripts/lib/lcov-summary";

const twoRecordFixture = [
	"SF:src/a.ts",
	"FNF:2",
	"FNH:1",
	"LF:10",
	"LH:5",
	"end_of_record",
	"SF:src/b.ts",
	"FNF:4",
	"FNH:3",
	"LF:20",
	"LH:15",
	"end_of_record",
	"",
].join("\n");

describe("summarizeLcov", () => {
	it("sums LF/LH/FNF/FNH across SF records", () => {
		expect(summarizeLcov(twoRecordFixture)).toEqual({
			files: 2,
			lines: { found: 30, hit: 20 },
			functions: { found: 6, hit: 4 },
		});
	});

	it("treats a record without FN* lines as zero functions", () => {
		const fixture = ["SF:src/a.ts", "LF:8", "LH:3", "end_of_record", ""].join("\n");
		expect(summarizeLcov(fixture)).toEqual({
			files: 1,
			lines: { found: 8, hit: 3 },
			functions: { found: 0, hit: 0 },
		});
	});

	it("throws when the report has no SF records", () => {
		expect(() => summarizeLcov("")).toThrow("lcov report has no SF records");
		expect(() => summarizeLcov("TN:\nend_of_record\n")).toThrow("lcov report has no SF records");
	});
});

describe("coverageShortfalls", () => {
	const exact = {
		files: 1,
		lines: { found: 100, hit: 47 },
		functions: { found: 100, hit: 54 },
	};
	const minimum = { lines: 0.47, functions: 0.54 };

	it("returns no shortfalls when totals match the minimums", () => {
		expect(coverageShortfalls(exact, minimum)).toEqual([]);
	});

	it("reports only the metric that is one point below its minimum", () => {
		expect(
			coverageShortfalls(
				{
					files: 1,
					lines: { found: 10000, hit: 4690 },
					functions: { found: 100, hit: 54 },
				},
				minimum,
			),
		).toEqual(["lines 46.90% is below the 47.00% minimum"]);
	});

	it("reports both metrics when each total is below its minimum", () => {
		expect(
			coverageShortfalls(
				{
					files: 1,
					lines: { found: 100, hit: 46 },
					functions: { found: 100, hit: 53 },
				},
				minimum,
			),
		).toEqual([
			"lines 46.00% is below the 47.00% minimum",
			"functions 53.00% is below the 54.00% minimum",
		]);
	});
});
