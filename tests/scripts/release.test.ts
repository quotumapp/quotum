import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	classifyPrTitle,
	compareVersions,
	latestStableTag,
	parseChangelog,
	releaseMeta,
	renderImageManifest,
	renderReleaseNotes,
	renderUnreleasedSummary,
} from "../../scripts/lib/release";

const digest = `sha256:${"a".repeat(64)}`;

const changelogFixture = [
	"# Changelog",
	"",
	"Intro text.",
	"",
	"## [Unreleased]",
	"",
	"- Pending work.",
	"",
	"## [0.10.1] - 2026-09-16",
	"",
	"### Fixed",
	"",
	"- Deadlock retry.",
	"",
	"## [0.10.0] - 2026-09-14",
	"",
	"### Changed",
	"",
	"```sh",
	"## not a heading inside a fence",
	"```",
	"",
	"## [0.9.3] - 2026-09-10",
	"",
	"- Email providers.",
	"",
].join("\n");

describe("compareVersions", () => {
	it("orders by SemVer precedence", () => {
		const ordered = [
			"0.9.3",
			"0.10.0-rc.1",
			"0.10.0-rc.2",
			"0.10.0-rc.10",
			"0.10.0",
			"0.10.1",
			"1.0.0-alpha",
			"1.0.0-alpha.1",
			"1.0.0-beta",
			"1.0.0",
		];
		expect([...ordered].reverse().sort(compareVersions)).toEqual(ordered);
	});

	it("rejects values that are not semantic versions", () => {
		expect(() => compareVersions("0.10", "0.10.0")).toThrow("Not a semantic version: 0.10");
	});
});

describe("parseChangelog", () => {
	it("returns released sections in file order and skips Unreleased and fenced headings", () => {
		const sections = parseChangelog(changelogFixture);
		expect(sections.map((section) => section.version)).toEqual(["0.10.1", "0.10.0", "0.9.3"]);
		expect(sections[0]).toEqual({
			version: "0.10.1",
			date: "2026-09-16",
			body: "### Fixed\n\n- Deadlock retry.",
		});
		expect(sections[1].body).toContain("## not a heading inside a fence");
	});

	it("ignores headings inside tilde, indented and longer fences", () => {
		const text = [
			"## [0.2.0] - 2026-09-16",
			"",
			"~~~md",
			"## tilde fence",
			"```",
			"## backticks do not close a tilde fence",
			"~~~",
			"",
			"- Example:",
			"   ````sh",
			"## indented fence",
			"   ```",
			"## shorter marker does not close it",
			"   ````",
			"",
			"## [0.1.0] - 2026-09-15",
			"",
			"- First.",
		].join("\n");
		const sections = parseChangelog(text);
		expect(sections.map((section) => section.version)).toEqual(["0.2.0", "0.1.0"]);
		expect(sections[0].body).toContain("## shorter marker does not close it");
		expect(sections[1].body).toBe("- First.");
	});

	it("rejects duplicate versions", () => {
		const text = "## [0.9.3] - 2026-09-10\n\n- a\n\n## [0.9.3] - 2026-09-10\n\n- b\n";
		expect(() => parseChangelog(text)).toThrow("Duplicate changelog section: 0.9.3");
	});

	it("rejects malformed version headings", () => {
		expect(() => parseChangelog("## [0.9.3]\n")).toThrow("Malformed changelog heading");
		expect(() => parseChangelog("## 0.9.3 - 2026-09-10\n")).toThrow("Malformed changelog heading");
	});
});

describe("releaseMeta", () => {
	const tags = ["v0.9.1", "v0.9.2", "v0.9.3", "v0.10.1", "v1.0.0-rc.1"];

	it("marks the highest stable tag latest and compares with the previous stable tag", () => {
		expect(releaseMeta("v0.10.1", tags)).toEqual({
			version: "0.10.1",
			prerelease: false,
			latest: true,
			previous: "v0.9.3",
		});
	});

	it("does not move latest for a backport patch", () => {
		expect(releaseMeta("v0.9.4", [...tags, "v0.9.4"])).toEqual({
			version: "0.9.4",
			prerelease: false,
			latest: false,
			previous: "v0.9.3",
		});
	});

	it("compares a prerelease with the closest lower tag of any kind", () => {
		expect(releaseMeta("v1.0.0-rc.2", [...tags, "v1.0.0-rc.2"])).toEqual({
			version: "1.0.0-rc.2",
			prerelease: true,
			latest: false,
			previous: "v1.0.0-rc.1",
		});
	});

	it("compares a stable release after candidates with the previous stable tag", () => {
		expect(releaseMeta("v1.0.0", [...tags, "v1.0.0"])).toMatchObject({
			latest: true,
			previous: "v0.10.1",
		});
	});

	it("has no previous tag for the first release and ignores non-release tags", () => {
		expect(releaseMeta("v0.1.0", ["v0.1.0", "vnext", "upstream/v0.0.1"])).toEqual({
			version: "0.1.0",
			prerelease: false,
			latest: true,
			previous: undefined,
		});
	});

	it("rejects tags that are not v plus a semantic version", () => {
		expect(() => releaseMeta("0.10.1", tags)).toThrow("Release tags must be v plus");
		expect(() => releaseMeta("v0.10", tags)).toThrow("Release tags must be v plus");
	});
});

describe("latestStableTag", () => {
	it("ignores prereleases and non-release tags", () => {
		expect(latestStableTag(["v0.9.3", "v0.10.1", "v1.0.0-rc.1", "M0-baseline"])).toBe("v0.10.1");
		expect(latestStableTag(["v1.0.0-rc.1"])).toBeUndefined();
	});
});

describe("renderReleaseNotes", () => {
	const sections = parseChangelog(changelogFixture);

	it("includes every section after the previous release and the pinned image", () => {
		const notes = renderReleaseNotes({
			sections,
			version: "0.10.1",
			previous: "v0.9.3",
			digest,
			repository: "quotumapp/quotum",
		});
		expect(notes).toContain("## 0.10.1 (2026-09-16)\n\n### Fixed\n\n- Deadlock retry.");
		expect(notes).toContain("## 0.10.0 (2026-09-14)");
		expect(notes).not.toContain("## 0.9.3");
		expect(notes).not.toContain("Pending work");
		expect(notes).toContain("docker pull ghcr.io/quotumapp/quotum:0.10.1");
		expect(notes).toContain(`\`ghcr.io/quotumapp/quotum@${digest}\``);
		expect(notes).toContain(
			"https://github.com/quotumapp/quotum/blob/v0.10.1/docs/operations.md#upgrade",
		);
		expect(notes.indexOf("## 0.10.1")).toBeLessThan(notes.indexOf("## 0.10.0"));
	});

	it("excludes newer sections when rendering a backport", () => {
		const notes = renderReleaseNotes({
			sections,
			version: "0.9.3",
			previous: "v0.9.2",
			digest,
			repository: "quotumapp/quotum",
		});
		expect(notes).toContain("## 0.9.3 (2026-09-10)");
		expect(notes).not.toContain("## 0.10");
	});

	it("includes only its own section without a previous release", () => {
		const notes = renderReleaseNotes({
			sections,
			version: "0.10.0",
			previous: undefined,
			digest,
			repository: "quotumapp/quotum",
		});
		expect(notes).toContain("## 0.10.0");
		expect(notes).not.toContain("## 0.9.3");
		expect(notes).not.toContain("## 0.10.1");
	});

	it("fails without a changelog section or a valid digest", () => {
		const input = { sections, previous: "v0.9.3", digest, repository: "quotumapp/quotum" };
		expect(() => renderReleaseNotes({ ...input, version: "0.10.2" })).toThrow(
			"CHANGELOG.md has no section for 0.10.2",
		);
		expect(() => renderReleaseNotes({ ...input, version: "0.10.1", digest: "sha256:abc" })).toThrow(
			"Image digest must be sha256:<64 hex>",
		);
	});
});

describe("renderImageManifest", () => {
	it("records the digest-pinned reference", () => {
		expect(
			JSON.parse(
				renderImageManifest({
					repository: "quotumapp/quotum",
					version: "0.10.1",
					digest,
					commit: "69eac11",
					workflowRun: undefined,
				}),
			),
		).toEqual({
			image: "ghcr.io/quotumapp/quotum",
			version: "0.10.1",
			digest,
			reference: `ghcr.io/quotumapp/quotum@${digest}`,
			commit: "69eac11",
			workflowRun: null,
		});
	});
});

describe("classifyPrTitle", () => {
	it.each([
		["feat: add releases", ["feature"]],
		["fix(db): retry deadlocks on the driver's SQLSTATE errno", ["bug"]],
		["perf: batch consume", ["performance"]],
		["docs: explain releases", ["documentation"]],
		["ci: publish GitHub Releases", ["maintenance"]],
		["chore(test): harden suite gating", ["maintenance"]],
		["feat!: rewrite HTTP layer from Hono to Elysia", ["breaking", "feature"]],
		["refactor(platform/auth)!: drop legacy issuer", ["breaking", "maintenance"]],
	])("labels %p", (title, labels) => {
		expect(classifyPrTitle(title)).toMatchObject({ ok: true, labels });
	});

	it.each([
		"Update stuff",
		"feat add releases",
		"feature: add releases",
		"Feat: add releases",
		"feat:  add releases",
		"feat(DB): add releases",
		'Revert "feat: add releases"',
	])("rejects %p", (title) => {
		expect(classifyPrTitle(title)).toMatchObject({ ok: false });
	});

	it("rejects titles of 72 characters or more", () => {
		const title = `feat: ${"x".repeat(66)}`;
		expect(title).toHaveLength(72);
		expect(classifyPrTitle(title)).toEqual({
			ok: false,
			error: "PR title must be under 72 characters (has 72).",
		});
		expect(classifyPrTitle(title.slice(0, 71))).toMatchObject({ ok: true });
	});
});

describe("renderUnreleasedSummary", () => {
	it("warns when the package version is untagged and lists changes since the last release", () => {
		const summary = renderUnreleasedSummary({
			version: "0.10.1",
			tags: ["v0.9.3"],
			since: "v0.9.3",
			subjects: ["fix(db): retry deadlocks (#8)", "feat!: rewrite HTTP layer (#7)"],
		});
		expect(summary.tagged).toBe(false);
		expect(summary.markdown).toContain("`v0.10.1` is not tagged yet");
		expect(summary.markdown).toContain("Changes since v0.9.3:\n\n- fix(db): retry deadlocks (#8)");
	});

	it("reports a tagged version with no further changes", () => {
		const summary = renderUnreleasedSummary({
			version: "0.10.1",
			tags: ["v0.10.1"],
			since: "v0.10.1",
			subjects: [],
		});
		expect(summary).toEqual({
			tagged: true,
			markdown: "## Release status\n\n`v0.10.1` is tagged.\n\nNo changes since v0.10.1.\n",
		});
	});
});

describe("repository changelog", () => {
	it("parses and has a section for the package version", () => {
		const sections = parseChangelog(readFileSync("CHANGELOG.md", "utf8"));
		const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
		expect(sections.map((section) => section.version)).toContain(version);
	});
});
