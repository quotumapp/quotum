import type { CoverageMap } from "./coverage-map";

export function changedLines(diff: string): Map<string, Set<number>> {
	const result = new Map<string, Set<number>>();
	let path: string | undefined;
	for (const row of diff.split("\n")) {
		if (row.startsWith("+++ b/")) {
			path = row.slice(6);
			result.set(path, new Set());
		} else if (row.startsWith("+++ ")) path = undefined;
		else if (path) {
			const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(row);
			if (match)
				for (let offset = 0; offset < Number(match[2] ?? 1); offset++)
					result.get(path)?.add(Number(match[1]) + offset);
		}
	}
	return result;
}

export function diffCoverage(map: CoverageMap, changes: Map<string, Set<number>>) {
	let found = 0;
	let hit = 0;
	const uncovered: { path: string; line: number }[] = [];
	for (const [path, lines] of changes) {
		const record = map.get(path);
		for (const line of lines) {
			if (!record?.lines.has(line)) continue;
			found++;
			if ((record.lines.get(line) ?? 0) > 0) hit++;
			else uncovered.push({ path, line });
		}
	}
	return { found, hit, uncovered };
}
