import { readFileSync } from "node:fs";
import { createCliBillingLogger } from "../src/observability/logger";
import { writeStderr, writeStdout } from "../src/shared/cli-output";
import { coverageShortfalls, formatLcovSummary, summarizeLcov } from "./lib/lcov-summary";

const minimum = {
	lines: 0.48,
	functions: 0.55,
} as const;

const reportPath = process.argv[2] ?? "coverage/lcov.info";

try {
	const summary = summarizeLcov(readFileSync(reportPath, "utf8"));
	writeStdout(formatLcovSummary(summary));
	const shortfalls = coverageShortfalls(summary, minimum);
	if (shortfalls.length > 0) {
		for (const line of shortfalls) {
			writeStderr(line);
		}
		process.exitCode = 1;
	}
} catch (error) {
	createCliBillingLogger().error("Coverage report could not be read", error);
	process.exitCode = 1;
}
