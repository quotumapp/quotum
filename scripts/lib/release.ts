export interface ChangelogSection {
	version: string;
	date: string;
	body: string;
}

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
const versionHeadingPattern = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/;
// CommonMark fenced code: three or more backticks or tildes, indented by at most three spaces.
const fencePattern = /^ {0,3}(`{3,}|~{3,})(.*)$/;
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
 * Reads released versions from a Keep a Changelog file. Sections keep file order, `[Unreleased]`
 * is skipped, and every other level-two heading must be `## [X.Y.Z] - YYYY-MM-DD`.
 */
export function parseChangelog(text: string): ChangelogSection[] {
	const sections: ChangelogSection[] = [];
	const seen = new Set<string>();
	let current: { version: string; date: string; lines: string[] } | undefined;
	let fence: string | undefined;

	const finish = () => {
		if (current) {
			sections.push({
				version: current.version,
				date: current.date,
				body: current.lines.join("\n").trim(),
			});
		}
		current = undefined;
	};

	for (const line of text.split(/\r?\n/)) {
		const marker = fencePattern.exec(line);
		const inFence = fence !== undefined;
		if (fence === undefined) {
			if (marker && !(marker[1].startsWith("`") && marker[2].includes("`"))) {
				fence = marker[1];
			}
		} else if (
			marker &&
			marker[1][0] === fence[0] &&
			marker[1].length >= fence.length &&
			marker[2].trim() === ""
		) {
			fence = undefined;
		}
		if (inFence || !line.startsWith("## ")) {
			current?.lines.push(line);
			continue;
		}
		finish();
		if (line === "## [Unreleased]") {
			continue;
		}
		const match = versionHeadingPattern.exec(line);
		if (!match || !isVersion(match[1])) {
			throw new Error(`Malformed changelog heading: ${line}`);
		}
		if (seen.has(match[1])) {
			throw new Error(`Duplicate changelog section: ${match[1]}`);
		}
		seen.add(match[1]);
		current = { version: match[1], date: match[2], lines: [] };
	}
	finish();
	return sections;
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

export interface ReleaseNotesInput {
	sections: readonly ChangelogSection[];
	version: string;
	previous: string | undefined;
	digest: string;
	repository: string;
}

/**
 * Renders the hand-written part of a GitHub Release body: every changelog section after the
 * previous release up to this version, then the digest-pinned image and upgrade pointers. GitHub
 * appends the generated pull request list after this text.
 */
export function renderReleaseNotes(input: ReleaseNotesInput): string {
	const { sections, version, previous, digest, repository } = input;
	if (!digestPattern.test(digest)) {
		throw new Error(`Image digest must be sha256:<64 hex>: ${digest}`);
	}
	if (!sections.some((section) => section.version === version)) {
		throw new Error(`CHANGELOG.md has no section for ${version}`);
	}
	const previousVersion = previous?.replace(/^v/, "");
	const included = sections.filter(
		(section) =>
			compareVersions(section.version, version) <= 0 &&
			(previousVersion === undefined
				? section.version === version
				: compareVersions(section.version, previousVersion) > 0),
	);

	const image = `ghcr.io/${repository}`;
	const tag = `v${version}`;
	const lines: string[] = [];
	for (const section of included) {
		lines.push(`## ${section.version} (${section.date})`, "", section.body, "");
	}
	lines.push(
		"## Container image",
		"",
		"```sh",
		`docker pull ${image}:${version}`,
		"```",
		"",
		`Pin deployments to the digest: \`${image}@${digest}\``,
		"",
		`Read the [upgrade guide](https://github.com/${repository}/blob/${tag}/docs/operations.md#upgrade)`,
		`before rolling out. \`gh release verify ${tag} --repo ${repository}\` checks this release.`,
		"",
	);
	return lines.join("\n");
}

export interface ImageManifestInput {
	repository: string;
	version: string;
	digest: string;
	commit: string;
	workflowRun: string | undefined;
}

export function renderImageManifest(input: ImageManifestInput): string {
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
	const labels = [labelByType[type] ?? "maintenance"];
	if (breaking) {
		labels.unshift("breaking");
	}
	return { ok: true, type, breaking, labels };
}

export interface UnreleasedSummaryInput {
	version: string;
	tags: readonly string[];
	since: string | undefined;
	subjects: readonly string[];
}

export function renderUnreleasedSummary(input: UnreleasedSummaryInput): {
	tagged: boolean;
	markdown: string;
} {
	const tagged = input.tags.includes(`v${input.version}`);
	const lines = ["## Release status", ""];
	lines.push(
		tagged
			? `\`v${input.version}\` is tagged.`
			: `\`package.json\` is at ${input.version}, but \`v${input.version}\` is not tagged yet.`,
		"",
	);
	if (input.since === undefined) {
		lines.push("No stable release tag exists yet.");
	} else if (input.subjects.length === 0) {
		lines.push(`No changes since ${input.since}.`);
	} else {
		lines.push(`Changes since ${input.since}:`, "");
		for (const subject of input.subjects) {
			lines.push(`- ${subject}`);
		}
	}
	lines.push("");
	return { tagged, markdown: lines.join("\n") };
}
