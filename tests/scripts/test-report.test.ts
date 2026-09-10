import { describe, expect, it } from "bun:test";
import {
	assertLaneReport,
	junitReporterArgs,
	readJunitSummary,
} from "../../scripts/lib/test-report";

describe("lane junit reports", () => {
	it("parses Bun testsuites attributes", () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="9" failures="0" skipped="9" time="0.01">
</testsuites>
`;
		expect(readJunitSummary(xml)).toEqual({ tests: 9, failures: 0, skipped: 9 });
		expect(junitReporterArgs("/tmp/report.xml")).toEqual([
			"--reporter=junit",
			"--reporter-outfile=/tmp/report.xml",
		]);
	});

	it("fails empty and skipped lanes", () => {
		expect(() => assertLaneReport({ tests: 0, failures: 0, skipped: 0 }, "integration")).toThrow(
			"integration lane reported 0 tests",
		);
		expect(() => assertLaneReport({ tests: 9, failures: 0, skipped: 1 }, "e2e")).toThrow(
			"e2e lane skipped 1 tests",
		);
		expect(() =>
			assertLaneReport({ tests: 9, failures: 0, skipped: 0 }, "integration"),
		).not.toThrow();
	});
});
