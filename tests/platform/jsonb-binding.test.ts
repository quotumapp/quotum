import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

function sources(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sources(path);
		return entry.name.endsWith(".ts") ? [path] : [];
	});
}

/**
 * Platform and composition SQL binds JSON as `${JSON.stringify(value)}::text::jsonb`. A bare
 * `::jsonb` on a bound string is typed jsonb by a prepared statement, and the driver then encodes
 * the string as a JSON string: the column holds `"[\"a\"]"` instead of `["a"]`. The merchant
 * integration lane runs prepared statements for the same reason.
 */
describe("JSON bound in platform SQL", () => {
	it("is cast through text, never straight to jsonb", () => {
		const offenders = ["src/platform", "src/composition", "src/testing"]
			.flatMap((directory) => sources(join(root, directory)))
			.flatMap((file) =>
				readFileSync(file, "utf8")
					.split("\n")
					.flatMap((line, index) =>
						/\}\s*::jsonb/.test(line) ? [`${relative(root, file)}:${index + 1}`] : [],
					),
			);
		expect(offenders).toEqual([]);
	});
});
