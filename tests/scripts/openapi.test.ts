import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactJson, syncGeneratedFile } from "../../scripts/openapi";

const stale = "Provider capability contract is stale. Run bun run openapi:generate.";
const directories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "quotum-openapi-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("artifactJson", () => {
	it("sorts keys, keeps array order, drops undefined and ends with a newline", () => {
		expect(artifactJson({ b: [2, 1], a: { d: undefined, c: true } })).toBe(
			'{\n  "a": {\n    "c": true\n  },\n  "b": [\n    2,\n    1\n  ]\n}\n',
		);
	});
});

describe("syncGeneratedFile", () => {
	it("writes missing or changed files and leaves current files untouched", async () => {
		const path = join(temporaryDirectory(), "nested", "artifact.json");
		await syncGeneratedFile(path, "one\n", { check: false, stale });
		expect(readFileSync(path, "utf8")).toBe("one\n");

		const written = statSync(path).mtimeMs;
		await Bun.sleep(5);
		await syncGeneratedFile(path, "one\n", { check: false, stale });
		expect(statSync(path).mtimeMs).toBe(written);

		await syncGeneratedFile(path, "two\n", { check: false, stale });
		expect(readFileSync(path, "utf8")).toBe("two\n");
	});

	it("passes a current file and fails a stale or missing one in check mode", async () => {
		const directory = temporaryDirectory();
		const path = join(directory, "artifact.json");
		writeFileSync(path, "current\n");
		await syncGeneratedFile(path, "current\n", { check: true, stale });

		let staleError: unknown;
		try {
			await syncGeneratedFile(path, "regenerated\n", { check: true, stale });
		} catch (error) {
			staleError = error;
		}
		expect(staleError).toBeInstanceOf(Error);
		expect((staleError as Error).message).toBe(stale);
		expect(readFileSync(path, "utf8")).toBe("current\n");

		let missingError: unknown;
		try {
			await syncGeneratedFile(join(directory, "missing.json"), "{}\n", { check: true, stale });
		} catch (error) {
			missingError = error;
		}
		expect((missingError as Error).message).toBe(stale);
	});
});
