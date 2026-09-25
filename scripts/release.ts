import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createCliBillingLogger } from "../src/observability/logger";
import { writeStderr, writeStdout } from "../src/shared/cli-output";
import {
	baselineChanges,
	baselineReleaseWarning,
	buildVersion,
	classifyPrTitle,
	latestStableTag,
	migrationNoteErrors,
	releaseMeta,
	renderImageManifest,
	renderUnreleasedSummary,
	versionedContract,
} from "./lib/release";

const logger = createCliBillingLogger();

const usage = `Usage:
  bun scripts/release.ts build-version
  bun scripts/release.ts contracts <version> [--out-dir dir]
  bun scripts/release.ts meta <tag>
  bun scripts/release.ts image-manifest <version> --digest sha256:... [--out-dir dir]
  bun scripts/release.ts pr-migrations       (reads PR_BODY, BASE_SHA, HEAD_SHA)
  bun scripts/release.ts pr-title            (reads PR_TITLE)
  bun scripts/release.ts unreleased`;

function git(...args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { stderr: "pipe" });
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString();
}

function releaseTags(): string[] {
	return git("tag", "--list", "v*")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function writeOutputs(values: Record<string, string>) {
	const lines = `${Object.entries(values)
		.map(([key, value]) => `${key}=${value}`)
		.join("\n")}\n`;
	const outputPath = process.env.GITHUB_OUTPUT;
	if (outputPath) {
		appendFileSync(outputPath, lines);
	}
	process.stdout.write(lines);
}

function repository(): string {
	return process.env.GITHUB_REPOSITORY ?? "quotumapp/quotum";
}

function meta(positionals: string[]) {
	const tag = positionals[0];
	if (!tag) {
		throw new Error(usage);
	}
	const result = releaseMeta(tag, releaseTags());
	const changed = result.previous ? baselineChanges(result.previous, tag) : [];
	reportBaselines(result.previous, tag, changed);
	writeOutputs({
		version: result.version,
		prerelease: String(result.prerelease),
		latest: String(result.latest),
		previous: result.previous ?? "",
		baseline_changes: changed.join(","),
	});
}

function imageManifest(positionals: string[], values: { digest?: string; "out-dir"?: string }) {
	const version = positionals[0];
	if (!version || !values.digest) {
		throw new Error(usage);
	}
	const outDir = values["out-dir"] ?? "release";
	const serverUrl = process.env.GITHUB_SERVER_URL;
	const runId = process.env.GITHUB_RUN_ID;
	const manifest = renderImageManifest({
		repository: repository(),
		version,
		digest: values.digest,
		commit: process.env.GITHUB_SHA ?? git("rev-parse", "HEAD").trim(),
		workflowRun:
			serverUrl && runId ? `${serverUrl}/${repository()}/actions/runs/${runId}` : undefined,
	});
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, "image.json"), manifest);
	logger.info(`Wrote ${join(outDir, "image.json")}`);
}

function prTitle() {
	const title = process.env.PR_TITLE;
	if (title === undefined) {
		throw new Error("PR_TITLE is not set");
	}
	const result = classifyPrTitle(title);
	if (!result.ok) {
		logger.error(result.error, undefined);
		process.exitCode = 1;
		return;
	}
	writeStdout(result.labels.join("\n"));
}

function reportBaselines(
	previous: string | undefined,
	next: string | undefined,
	changed: string[],
): string {
	const text = changed.length
		? `Baseline migrations changed:\n${changed.map((path) => `- ${path}`).join("\n")}\n`
		: "Baseline migrations changed: none.\n";
	const warning = baselineReleaseWarning(previous, next, changed);
	if (warning) writeStderr(`::warning::${warning}`);
	writeStderr(text);
	return text + (warning ? `\nWarning: ${warning}\n` : "");
}

function prMigrations() {
	const { PR_BODY, BASE_SHA, HEAD_SHA } = process.env;
	if (PR_BODY === undefined || !BASE_SHA || !HEAD_SHA)
		throw new Error("PR_BODY, BASE_SHA and HEAD_SHA are required");
	const changed = baselineChanges(BASE_SHA, HEAD_SHA);
	const errors = migrationNoteErrors(PR_BODY, changed);
	for (const error of errors) writeStderr(error);
	if (errors.length) process.exitCode = 1;
	else writeStdout(`Migration notes verified (${changed.length} changed baselines).`);
}

function unreleased() {
	const tags = releaseTags();
	const since = latestStableTag(tags);
	const subjects =
		since === undefined
			? []
			: git("log", "--format=%s", `${since}..HEAD`)
					.split("\n")
					.map((line) => line.trim())
					.filter(Boolean);
	const changed = since ? baselineChanges(since, "HEAD") : [];
	const summary =
		renderUnreleasedSummary({ since, subjects }) +
		"\n" +
		reportBaselines(since, process.env.NEXT_VERSION, changed);
	const summaryPath = process.env.GITHUB_STEP_SUMMARY;
	if (summaryPath) {
		appendFileSync(summaryPath, summary);
	}
	writeStdout(summary);
}

try {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		options: {
			digest: { type: "string" },
			"out-dir": { type: "string" },
		},
	});
	const [command, ...rest] = positionals;
	switch (command) {
		case "build-version":
			writeOutputs({
				version: buildVersion(
					process.env.GITHUB_REF_TYPE,
					process.env.GITHUB_REF_NAME,
					process.env.GITHUB_SHA ?? git("rev-parse", "HEAD").trim(),
				),
			});
			break;
		case "contracts": {
			const content = versionedContract(
				readFileSync("contracts/v1/openapi.json", "utf8"),
				rest[0] ?? "",
			);
			const outDir = values["out-dir"] ?? "release";
			mkdirSync(outDir, { recursive: true });
			writeFileSync(join(outDir, "openapi.json"), content);
			copyFileSync("contracts/v1/errors.json", join(outDir, "errors.json"));
			break;
		}
		case "meta":
			meta(rest);
			break;
		case "image-manifest":
			imageManifest(rest, values);
			break;
		case "pr-migrations":
			prMigrations();
			break;
		case "pr-title":
			prTitle();
			break;
		case "unreleased":
			unreleased();
			break;
		default:
			throw new Error(usage);
	}
} catch (error) {
	logger.error("Release command failed", error);
	process.exitCode = 1;
}
