import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const self = "tests/architecture/test-lanes.test.ts";
const files = [...new Bun.Glob("{tests,integration}/**/*.ts").scanSync(root)]
	.filter((path) => path !== self)
	.map((path) => ({ path, source: readFileSync(join(root, path), "utf8") }));

/**
 * Each lane gate and the directories its runner passes to `bun test` with the gate's flag set.
 * Those runners fail on any skipped test; a gated suite anywhere else would run in no lane while
 * the unit lane reports it as an ordinary skip.
 */
const laneGates: Record<string, readonly string[]> = {
	describeLocalPostgres: ["tests/integration/", "integration/merchant/"],
	describeE2e: ["tests/e2e/"],
};

// Biome's noSkippedTests reports literal `.skip(...)` calls only. This also covers conditional
// and todo modifiers, and a skip function passed around instead of called.
const skipModifier =
	/\b(?:describe|it|test)\s*\.\s*(?:skip|skipIf|if|todo|todoIf)\b|\bx(?:describe|it|test)\b/g;

describe("test lanes", () => {
	it("see the whole test tree", () => {
		expect(files.map(({ path }) => path)).toContain("tests/integration/helpers/local-postgres.ts");
		expect(files.length).toBeGreaterThan(200);
	});

	it("gate suites only inside the directories their lane runs", () => {
		const misplaced = files.flatMap(({ path, source }) =>
			Object.entries(laneGates)
				.filter(
					([gate, directories]) =>
						source.includes(`${gate}(`) &&
						!directories.some((directory) => path.startsWith(directory)),
				)
				.map(([gate]) => `${path}: ${gate}`),
		);
		expect(misplaced).toEqual([]);
	});

	it("skip nothing outside a lane gate, which the unit lane would report as passing", () => {
		const skips = files.flatMap(({ path, source }) => {
			const ungated = Object.keys(laneGates).reduce(
				(text, gate) => text.replaceAll(`${gate}(describe, describe.skip)`, ""),
				source,
			);
			return [...ungated.matchAll(skipModifier)].map((match) => `${path}: ${match[0]}`);
		});
		expect(skips).toEqual([]);
	});
});
