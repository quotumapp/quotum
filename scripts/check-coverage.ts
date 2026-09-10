import { readFileSync } from "node:fs";
import { coverageShortfalls, formatLcovSummary, summarizeLcov } from "./lib/lcov-summary";

const minimum = {
	lines: 0.48,
	functions: 0.55,
} as const;

const reportPath = process.argv[2] ?? "coverage/lcov.info";

try {
	const summary = summarizeLcov(readFileSync(reportPath, "utf8"));
	console.log(formatLcovSummary(summary));
	const shortfalls = coverageShortfalls(summary, minimum);
	if (shortfalls.length > 0) {
		for (const line of shortfalls) {
			console.error(line);
		}
		process.exitCode = 1;
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exitCode = 1;
}
