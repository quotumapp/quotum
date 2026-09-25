export interface ReleaseMeta {
	version: string;
	prerelease: boolean;
	latest: boolean;
	previous: string | undefined;
}

export type PrTitleResult =
	| { ok: true; type: string; breaking: boolean; labels: string[] }
	| { ok: false; error: string };

interface ParsedVersion {
	core: [number, number, number];
	prerelease: string[];
}

const semverPattern =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const prTitlePattern =
	/^(feat|fix|perf|refactor|docs|test|build|ci|chore|revert)(\([a-z0-9._/-]+\))?(!)?: \S.*$/;
const maxPrTitleLength = 72;

const labelByType: Readonly<Record<string, string>> = {
	feat: "feature",
	fix: "bug",
	perf: "performance",
	docs: "documentation",
};

export function isVersion(value: string): boolean {
	return semverPattern.test(value);
}

function parseVersion(value: string): ParsedVersion {
	const match = semverPattern.exec(value);
	if (!match) {
		throw new Error(`Not a semantic version: ${value}`);
	}
	return {
		core: [Number(match[1]), Number(match[2]), Number(match[3])],
		prerelease: match[4] === undefined ? [] : match[4].split("."),
	};
}

function compareIdentifiers(left: string, right: string): number {
	const leftNumeric = /^\d+$/.test(left);
	const rightNumeric = /^\d+$/.test(right);
	if (leftNumeric && rightNumeric) {
		return Number(left) - Number(right);
	}
	if (leftNumeric !== rightNumeric) {
		return leftNumeric ? -1 : 1;
	}
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Orders versions by SemVer 2.0.0 precedence, so `1.0.0-rc.1` sorts before `1.0.0`. */
export function compareVersions(left: string, right: string): number {
	const a = parseVersion(left);
	const b = parseVersion(right);
	for (let index = 0; index < 3; index += 1) {
		const difference = a.core[index] - b.core[index];
		if (difference !== 0) {
			return Math.sign(difference);
		}
	}
	if (a.prerelease.length === 0 || b.prerelease.length === 0) {
		return Math.sign(b.prerelease.length - a.prerelease.length);
	}
	const length = Math.max(a.prerelease.length, b.prerelease.length);
	for (let index = 0; index < length; index += 1) {
		const leftIdentifier = a.prerelease[index];
		const rightIdentifier = b.prerelease[index];
		if (leftIdentifier === undefined || rightIdentifier === undefined) {
			return leftIdentifier === undefined ? -1 : 1;
		}
		const difference = compareIdentifiers(leftIdentifier, rightIdentifier);
		if (difference !== 0) {
			return Math.sign(difference);
		}
	}
	return 0;
}

/**
 * Derives release flags for a `vX.Y.Z` tag. Only the highest stable version is `latest`, so a
 * backport patch does not move it. A stable release compares against the previous stable tag; a
 * prerelease compares against the closest lower tag of any kind.
 */
export function releaseMeta(tag: string, tags: readonly string[]): ReleaseMeta {
	if (!tag.startsWith("v") || !isVersion(tag.slice(1))) {
		throw new Error(`Release tags must be v plus a semantic version: ${tag}`);
	}
	const version = tag.slice(1);
	const prerelease = parseVersion(version).prerelease.length > 0;
	const versions = tags
		.filter((candidate) => candidate.startsWith("v") && isVersion(candidate.slice(1)))
		.map((candidate) => candidate.slice(1));
	const stable = versions.filter((candidate) => parseVersion(candidate).prerelease.length === 0);

	const latest =
		!prerelease && stable.every((candidate) => compareVersions(candidate, version) <= 0);
	const lower = (prerelease ? versions : stable)
		.filter((candidate) => compareVersions(candidate, version) < 0)
		.sort(compareVersions);
	const previous = lower.at(-1);

	return {
		version,
		prerelease,
		latest,
		previous: previous === undefined ? undefined : `v${previous}`,
	};
}

/** Returns the highest stable `vX.Y.Z` tag, or undefined when none exists. */
export function latestStableTag(tags: readonly string[]): string | undefined {
	const stable = tags
		.filter((candidate) => candidate.startsWith("v") && isVersion(candidate.slice(1)))
		.map((candidate) => candidate.slice(1))
		.filter((candidate) => parseVersion(candidate).prerelease.length === 0)
		.sort(compareVersions);
	const highest = stable.at(-1);
	return highest === undefined ? undefined : `v${highest}`;
}

export interface ImageManifestInput {
	repository: string;
	version: string;
	digest: string;
	commit: string;
	workflowRun: string | undefined;
}

/** Records the digest-pinned image a release was built from, attached as `image.json`. */
export function renderImageManifest(input: ImageManifestInput): string {
	if (!digestPattern.test(input.digest)) {
		throw new Error(`Image digest must be sha256:<64 hex>: ${input.digest}`);
	}
	const image = `ghcr.io/${input.repository}`;
	return `${JSON.stringify(
		{
			image,
			version: input.version,
			digest: input.digest,
			reference: `${image}@${input.digest}`,
			commit: input.commit,
			workflowRun: input.workflowRun ?? null,
		},
		null,
		2,
	)}\n`;
}

/**
 * Validates a pull request title as a Conventional Commit subject, which becomes the squash
 * commit on `main`, and maps it to the labels that group generated release notes.
 */
export function classifyPrTitle(title: string): PrTitleResult {
	if (title.length >= maxPrTitleLength) {
		return {
			ok: false,
			error: `PR title must be under ${maxPrTitleLength} characters (has ${title.length}).`,
		};
	}
	const match = prTitlePattern.exec(title);
	if (!match) {
		return {
			ok: false,
			error:
				"PR title must be a Conventional Commit subject such as `feat: add x`, `fix(db): y` or " +
				"`feat!: z`. Allowed types: feat, fix, perf, refactor, docs, test, build, ci, chore, revert.",
		};
	}
	const type = match[1];
	const breaking = match[3] === "!";
	if (type === "chore" && match[2] === "(release)") {
		return { ok: true, type, breaking, labels: ["ignore-for-release"] };
	}
	const labels = [labelByType[type] ?? "maintenance"];
	if (breaking) {
		labels.unshift("breaking");
	}
	return { ok: true, type, breaking, labels };
}

export interface UnreleasedSummaryInput {
	since: string | undefined;
	subjects: readonly string[];
}

export function renderUnreleasedSummary(input: UnreleasedSummaryInput): string {
	const lines = ["## Release status", ""];
	if (input.since === undefined) {
		lines.push("No stable release tag exists yet.");
	} else if (input.subjects.length === 0) {
		lines.push(`No changes since ${input.since}.`);
	} else {
		lines.push(`Changes since ${input.since}:`, "");
		for (const subject of input.subjects) lines.push(`- ${subject}`);
	}
	lines.push("");
	return lines.join("\n");
}

/** Tags define releases; branch builds identify their source commit. */
export function buildVersion(
	refType: string | undefined,
	refName: string | undefined,
	sha: string,
): string {
	if (refType === "tag") return releaseMeta(refName ?? "", []).version;
	if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error("Invalid build commit");
	return `0.0.0-dev.${sha}`;
}

export function versionedContract(contract: string, version: string): string {
	if (!isVersion(version)) throw new Error(`Not a semantic version: ${version}`);
	const document = JSON.parse(contract);
	document.info.version = version;
	return `${JSON.stringify(document, null, 2)}\n`;
}

/** Compare content, not timestamps; --no-renames reports both sides of a renamed baseline. */
export function baselineChanges(base: string, head: string, cwd = process.cwd()): string[] {
	for (const ref of [base, head]) {
		if (!ref || ref.startsWith("-")) throw new Error("Invalid baseline comparison revision");
	}
	const result = Bun.spawnSync(
		[
			"git",
			"diff",
			"--no-ext-diff",
			"--no-renames",
			"--raw",
			"--no-abbrev",
			"-z",
			base,
			head,
			"--",
			"migrations/*.sql",
		],
		{ cwd, stderr: "pipe" },
	);
	if (result.exitCode !== 0)
		throw new Error(`Cannot compare baseline migrations: ${result.stderr.toString().trim()}`);
	const records = result.stdout.toString().split("\0");
	const changed: string[] = [];
	for (let index = 0; index + 1 < records.length; index += 2) {
		const fields = records[index].split(" ");
		// A chmod changes tree metadata but leaves the migration checksum unchanged.
		if (fields[2] !== fields[3]) changed.push(records[index + 1]);
	}
	return changed.sort();
}

export function migrationNoteErrors(body: string, changed: readonly string[]): string[] {
	if (!changed.length) return [];
	const lines = body.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
	const start = lines.findIndex((line) =>
		/^\s*(?:#{1,6}\s+)?(?:\*\*)?Upgrade notes(?:\*\*)?\s*:?(?:\s|$)/i.test(line),
	);
	if (start < 0)
		return ["Baseline changes require an Upgrade notes section naming every changed file."];
	const first = lines[start].replace(/^\s*(?:#{1,6}\s+)?(?:\*\*)?Upgrade notes(?:\*\*)?\s*:?/i, "");
	const section = [first];
	for (const line of lines.slice(start + 1)) {
		if (/^#{1,6}\s|^\*\*[^*]+\*\*\s*:?\s*$/.test(line)) break;
		section.push(line);
	}
	const notes = section.join("\n").trim();
	if (!notes || /^(?:none|n\/a|no changes)\b/i.test(notes))
		return ["Upgrade notes must describe baseline changes, not None."];
	return changed
		.filter((path) => {
			const filename = path.split("/").at(-1) ?? path;
			return !notes
				.split(/[^\w./-]+/)
				.some(
					(token) => token.replace(/\.+$/, "") === path || token.replace(/\.+$/, "") === filename,
				);
		})
		.map((path) => `Upgrade notes must name ${path}.`);
}

export function baselineReleaseWarning(
	previous: string | undefined,
	next: string | undefined,
	changed: readonly string[],
): string | undefined {
	if (!previous || !next || !changed.length) return undefined;
	const before = parseVersion(previous.replace(/^v/, "")).core;
	const after = parseVersion(next.replace(/^v/, "")).core;
	return before[0] === after[0] && before[1] === after[1] && after[2] > before[2]
		? "Baseline migrations changed in a patch release; checksum changes require explicit database upgrade planning."
		: undefined;
}
