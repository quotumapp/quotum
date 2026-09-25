import { readFileSync } from "node:fs";
import { relative } from "node:path";

export interface FileCoverage {
	lines: Map<number, number>;
	functions: Map<string, number>;
}
export type CoverageMap = Map<string, FileCoverage>;

export function normalizeSource(path: string): string {
	return (path.startsWith("/") ? relative(process.cwd(), path) : path).replace(/^\.\//, "");
}

/** Intersect line inventories only among reports containing the file; absent files are not lanes. */
export function mergeLcov(reports: readonly string[]): CoverageMap {
	const records = new Map<string, FileCoverage[]>();
	for (const report of reports) {
		let current: FileCoverage | undefined;
		let count = 0;
		for (const row of report.split(/\r?\n/)) {
			if (row.startsWith("SF:")) {
				const path = normalizeSource(row.slice(3));
				current = { lines: new Map(), functions: new Map() };
				const entries = records.get(path) ?? [];
				entries.push(current);
				records.set(path, entries);
				count++;
			} else if (row.startsWith("DA:") && current) {
				const [line, hits] = row.slice(3).split(",").map(Number);
				if (!Number.isInteger(line) || line < 1 || !Number.isFinite(hits) || hits < 0)
					throw new Error("Invalid LCOV line");
				current.lines.set(line, hits);
			} else if (row.startsWith("FNDA:") && current) {
				const comma = row.indexOf(",");
				const hits = Number(row.slice(5, comma));
				if (comma < 0 || !Number.isFinite(hits) || hits < 0)
					throw new Error("Invalid LCOV function");
				current.functions.set(row.slice(comma + 1), hits);
			} else if (row === "end_of_record") current = undefined;
		}
		if (!count) throw new Error("lcov report has no SF records");
	}
	const merged: CoverageMap = new Map();
	for (const [path, entries] of records) {
		const lines = new Map<number, number>();
		const functions = new Map<string, number>();
		for (const [line] of entries[0].lines) {
			if (entries.every((entry) => entry.lines.has(line)))
				lines.set(line, Math.max(...entries.map((entry) => entry.lines.get(line) ?? 0)));
		}
		for (const entry of entries)
			for (const [name, hits] of entry.functions)
				functions.set(name, Math.max(hits, functions.get(name) ?? 0));
		merged.set(path, { lines, functions });
	}
	return merged;
}

/** Source-map locations identify runtime code even when no test imports a tracked module. */
export async function runtimeLines(source: string): Promise<number[]> {
	const output = await Bun.build({
		entrypoints: ["coverage-source.ts"],
		target: "bun",
		external: ["*"],
		sourcemap: "external",
		plugins: [
			{
				name: "coverage-source",
				setup(build) {
					build.onResolve({ filter: /^coverage-source\.ts$/ }, () => ({
						path: "coverage-source.ts",
						namespace: "coverage",
					}));
					build.onLoad({ filter: /.*/, namespace: "coverage" }, () => ({
						contents: source,
						loader: "ts",
					}));
				},
			},
		],
	});
	if (!output.success) throw new Error("Cannot identify runtime lines");
	const sourceMap = output.outputs.find((artifact) => artifact.kind === "sourcemap");
	const mappings = sourceMap ? ((await sourceMap.json()).mappings as string) : "";
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let originalLine = 0;
	const lines = new Set<number>();
	for (const segment of mappings.split(/[;,]/)) {
		const values: number[] = [];
		let value = 0;
		let shift = 0;
		for (const char of segment) {
			const digit = alphabet.indexOf(char);
			value += (digit & 31) << shift;
			if (digit & 32) shift += 5;
			else {
				values.push(value & 1 ? -(value >> 1) : value >> 1);
				value = 0;
				shift = 0;
			}
		}
		if (values.length >= 4) {
			originalLine += values[2];
			lines.add(originalLine + 1);
		}
	}
	return [...lines];
}

export async function completeCoverage(
	map: CoverageMap,
	sources: ReadonlyMap<string, string>,
): Promise<void> {
	for (const [path, source] of sources) {
		if (map.has(path)) continue;
		const lines = await runtimeLines(source);
		if (lines.length)
			map.set(path, { lines: new Map(lines.map((line) => [line, 0])), functions: new Map() });
	}
}

export function trackedSources(): Map<string, string> {
	const result = Bun.spawnSync(["git", "ls-files", "-z", "--", "src"], { stderr: "pipe" });
	if (result.exitCode !== 0) throw new Error("Cannot enumerate tracked source files");
	return new Map(
		result.stdout
			.toString()
			.split("\0")
			.filter(
				(path) =>
					/\.tsx?$/.test(path) && !path.endsWith(".d.ts") && !path.startsWith("src/testing/"),
			)
			.map((path) => [path, readFileSync(path, "utf8")]),
	);
}

export function renderLcov(map: CoverageMap, prefix = "src/"): string {
	return [...map]
		.filter(([path]) => path.startsWith(prefix))
		.map(([path, record]) =>
			[
				`SF:${path}`,
				...[...record.lines].map(([line, hits]) => `DA:${line},${hits}`),
				`LF:${record.lines.size}`,
				`LH:${[...record.lines.values()].filter((hits) => hits > 0).length}`,
				`FNF:${record.functions.size}`,
				`FNH:${[...record.functions.values()].filter((hits) => hits > 0).length}`,
				"end_of_record",
			].join("\n"),
		)
		.join("\n");
}

export function ratchetErrors(actual: number, floor: number): string[] {
	if (!Number.isFinite(floor) || floor < 0 || floor > 100) return ["Invalid coverage floor"];
	if (actual + 1e-8 < floor) return [`${actual.toFixed(2)}% is below ${floor.toFixed(2)}%`];
	if (actual > floor + 2 + 1e-8)
		return [
			`${actual.toFixed(2)}% exceeds floor by more than 2 points; run check-coverage.ts --write with all lane reports`,
		];
	return [];
}
