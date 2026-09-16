import { describe, expect, it } from "bun:test";
import {
	buildVersion,
	classifyPrTitle,
	compareVersions,
	latestStableTag,
	releaseMeta,
	renderImageManifest,
	renderUnreleasedSummary,
	versionedContract,
} from "../../scripts/lib/release";

const digest = `sha256:${"a".repeat(64)}`;

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

describe("renderImageManifest", () => {
	it("rejects a digest that is not sha256", () => {
		expect(() =>
			renderImageManifest({
				repository: "quotumapp/quotum",
				version: "0.10.1",
				digest: "sha256:abc",
				commit: "69eac11",
				workflowRun: undefined,
			}),
		).toThrow("Image digest must be sha256:<64 hex>");
	});

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
		["chore(release): v0.11.0", ["ignore-for-release"]],
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

describe("tag-based builds", () => {
	it("uses stable and prerelease tags regardless of package version", () => {
		expect(buildVersion("tag", "v1.2.3", "abcdef0")).toBe("1.2.3");
		expect(buildVersion("tag", "v1.2.3-rc.1", "abcdef0")).toBe("1.2.3-rc.1");
		expect(() => buildVersion("tag", "v1.2", "abcdef0")).toThrow();
		expect(buildVersion("branch", "main", "abcdef0")).toBe("0.0.0-dev.abcdef0");
	});
	it("stamps only the OpenAPI version", () => {
		const document = { info: { title: "Quotum", version: "0.0.0-dev" }, paths: { "/health": {} } };
		expect(JSON.parse(versionedContract(JSON.stringify(document), "1.2.3"))).toEqual({
			...document,
			info: { ...document.info, version: "1.2.3" },
		});
		expect(() => versionedContract(JSON.stringify(document), "bad")).toThrow();
	});
});

describe("renderUnreleasedSummary", () => {
	it("lists changes since the last release", () => {
		expect(renderUnreleasedSummary({ since: "v0.9.3", subjects: ["fix: retry (#8)"] })).toContain(
			"Changes since v0.9.3:\n\n- fix: retry (#8)",
		);
	});
	it("handles no changes and no stable release", () => {
		expect(renderUnreleasedSummary({ since: "v0.10.1", subjects: [] })).toContain(
			"No changes since v0.10.1.",
		);
		expect(renderUnreleasedSummary({ since: undefined, subjects: [] })).toContain(
			"No stable release tag exists yet.",
		);
	});
});
