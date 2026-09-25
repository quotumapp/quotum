import { readFileSync, writeFileSync } from "node:fs";
import { createCliBillingLogger } from "../src/observability/logger";
import { writeStderr, writeStdout } from "../src/shared/cli-output";
import {
	completeCoverage,
	mergeLcov,
	ratchetErrors,
	renderLcov,
	trackedSources,
} from "./lib/coverage-map";
import { coverageShortfalls, formatLcovSummary, summarizeLcov } from "./lib/lcov-summary";

try {
	const args = process.argv.slice(2);
	const write = args.includes("--write");
	const combined = args.includes("--combined") || write;
	const paths = args.filter((arg) => !arg.startsWith("--"));
	if (!combined) {
		const summary = summarizeLcov(readFileSync(paths[0] ?? "coverage/lcov.info", "utf8"));
		writeStdout(formatLcovSummary(summary));
		for (const error of coverageShortfalls(summary, { lines: 0.48, functions: 0.55 })) {
			writeStderr(error);
			process.exitCode = 1;
		}
	} else {
		if (paths.length < 3)
			throw new Error("Combined coverage requires unit, integration and merchant reports");
		const map = mergeLcov(paths.map((path) => readFileSync(path, "utf8")));
		await completeCoverage(map, trackedSources());
		const floors = JSON.parse(readFileSync("coverage-floors.json", "utf8")) as Record<
			string,
			number
		>;
		for (const prefix of [
			"total",
			"src/billing/",
			"src/db/repository/",
			"src/providers/",
			"src/platform/",
			"src/http/",
		]) {
			const summary = summarizeLcov(renderLcov(map, prefix === "total" ? "src/" : prefix));
			const actual = summary.lines.found ? (100 * summary.lines.hit) / summary.lines.found : 100;
			writeStdout(`${prefix}: ${formatLcovSummary(summary).split(", functions")[0]}`);
			if (write) floors[prefix] = Math.max(0, Math.floor((actual - 0.5) * 100) / 100);
			else
				for (const error of ratchetErrors(actual, floors[prefix])) {
					writeStderr(`${prefix}: ${error}`);
					process.exitCode = 1;
				}
		}
		if (write) writeFileSync("coverage-floors.json", `${JSON.stringify(floors, null, "\t")}\n`);
	}
} catch (error) {
	createCliBillingLogger().error("Coverage check failed", error);
	process.exitCode = 1;
}
