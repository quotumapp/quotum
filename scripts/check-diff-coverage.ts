import { readFileSync } from "node:fs";
import { createCliBillingLogger } from "../src/observability/logger";
import { writeStdout } from "../src/shared/cli-output";
import { completeCoverage, mergeLcov, trackedSources } from "./lib/coverage-map";
import { changedLines, diffCoverage } from "./lib/diff-coverage";

try {
	const [base, ...paths] = process.argv.slice(2);
	if (!base || !paths.length) throw new Error("Usage: check-diff-coverage.ts <base> <lcov>...");
	const diff = Bun.spawnSync(
		["git", "diff", "--no-ext-diff", "--no-renames", "-U0", `${base}...HEAD`, "--", "src"],
		{ stderr: "pipe" },
	);
	if (diff.exitCode !== 0) throw new Error(`Cannot read base diff: ${diff.stderr.toString()}`);
	const map = mergeLcov(paths.map((path) => readFileSync(path, "utf8")));
	await completeCoverage(map, trackedSources());
	const result = diffCoverage(map, changedLines(diff.stdout.toString()));
	for (const { path, line } of result.uncovered)
		writeStdout(
			`::warning file=${path.replaceAll("%", "%25").replaceAll(",", "%2C")},line=${line}::Changed executable line is not covered`,
		);
	const ratio = result.found ? result.hit / result.found : 1;
	writeStdout(
		`Changed-line coverage: ${(ratio * 100).toFixed(2)}% (${result.hit}/${result.found})`,
	);
	if (ratio < 0.8) process.exitCode = 1;
} catch (error) {
	createCliBillingLogger().error("Diff coverage check failed", error);
	process.exitCode = 1;
}
