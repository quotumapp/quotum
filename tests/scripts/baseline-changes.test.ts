import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	baselineChanges,
	baselineReleaseWarning,
	migrationNoteErrors,
} from "../../scripts/lib/release";

describe("baseline migration gates", () => {
	it("requires real upgrade notes naming every changed baseline", () => {
		const files = ["migrations/003_metering.sql", "migrations/004_merchant.sql"];
		expect(migrationNoteErrors("", [])).toEqual([]);
		expect(migrationNoteErrors("## Upgrade notes\nNone", files)[0]).toContain("not None");
		expect(
			migrationNoteErrors("## Summary\n003_metering.sql\n004_merchant.sql", files)[0],
		).toContain("require");
		expect(
			migrationNoteErrors(
				"## Upgrade notes\nRecreate disposable DB for `003_metering.sql`.\n## Other\n004_merchant.sql",
				files,
			),
		).toEqual(["Upgrade notes must name migrations/004_merchant.sql."]);
		expect(
			migrationNoteErrors(
				"## Upgrade notes\nRecreate disposable DB after reviewing migrations/003_metering.sql and 004_merchant.sql.",
				files,
			),
		).toEqual([]);
		expect(
			migrationNoteErrors("Upgrade notes: None\n003_metering.sql\n004_merchant.sql", files)[0],
		).toContain("not None");
		expect(
			migrationNoteErrors(
				"## Upgrade notes\nRecreate DB. <!-- 003_metering.sql 004_merchant.sql -->",
				files,
			),
		).toHaveLength(2);
	});
	it("warns only when changed baselines accompany a patch", () => {
		expect(baselineReleaseWarning("v0.14.0", "v0.14.1", ["migrations/003.sql"])).toContain(
			"patch release",
		);
		expect(baselineReleaseWarning("v0.14.0", "0.15.0", ["migrations/003.sql"])).toBeUndefined();
		expect(baselineReleaseWarning("v0.14.0", "0.14.1", [])).toBeUndefined();
	});
	it("compares git contents including additions, deletions and renames", () => {
		const cwd = mkdtempSync(join(tmpdir(), "quotum-baselines-"));
		const git = (...args: string[]) => {
			const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
			if (result.exitCode) throw new Error(result.stderr.toString());
			return result.stdout.toString().trim();
		};
		try {
			git("init", "-q");
			git("config", "user.name", "Test");
			git("config", "user.email", "test@example.test");
			mkdirSync(join(cwd, "migrations"));
			writeFileSync(join(cwd, "migrations/001.sql"), "SELECT 1;\n");
			writeFileSync(join(cwd, "migrations/002.sql"), "SELECT 2;\n");
			git("add", ".");
			git("commit", "-qm", "initial");
			const base = git("rev-parse", "HEAD");
			expect(baselineChanges(base, base, cwd)).toEqual([]);
			git("update-index", "--chmod=+x", "migrations/001.sql");
			git("commit", "-qm", "mode only");
			expect(baselineChanges(base, "HEAD", cwd)).toEqual([]);
			writeFileSync(join(cwd, "migrations/001.sql"), "SELECT 3;\n");
			git("mv", "migrations/002.sql", "migrations/003.sql");
			writeFileSync(join(cwd, "README.md"), "unrelated");
			git("add", ".");
			git("commit", "-qm", "change");
			expect(baselineChanges(base, "HEAD", cwd)).toEqual([
				"migrations/001.sql",
				"migrations/002.sql",
				"migrations/003.sql",
			]);
			expect(() => baselineChanges("missing-ref", "HEAD", cwd)).toThrow("Cannot compare");
			const command = join(process.cwd(), "scripts/release.ts");
			const runCheck = (body: string) =>
				Bun.spawnSync([process.execPath, command, "pr-migrations"], {
					cwd,
					env: { ...process.env, PR_BODY: body, BASE_SHA: base, HEAD_SHA: "HEAD" },
					stdout: "pipe",
					stderr: "pipe",
				}).exitCode;
			expect(runCheck("## Upgrade notes\nNone")).toBe(1);
			expect(
				runCheck(
					"## Upgrade notes\nRecreate disposable databases for 001.sql, 002.sql and 003.sql.",
				),
			).toBe(0);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
