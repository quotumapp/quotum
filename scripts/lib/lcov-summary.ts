export interface LcovSummary {
	files: number;
	lines: { found: number; hit: number };
	functions: { found: number; hit: number };
}

export function summarizeLcov(text: string): LcovSummary {
	const summary: LcovSummary = {
		files: 0,
		lines: { found: 0, hit: 0 },
		functions: { found: 0, hit: 0 },
	};

	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.startsWith("SF:")) {
			summary.files += 1;
			continue;
		}
		if (line.startsWith("LF:")) {
			summary.lines.found += parseCount(line.slice(3));
			continue;
		}
		if (line.startsWith("LH:")) {
			summary.lines.hit += parseCount(line.slice(3));
			continue;
		}
		if (line.startsWith("FNF:")) {
			summary.functions.found += parseCount(line.slice(4));
			continue;
		}
		if (line.startsWith("FNH:")) {
			summary.functions.hit += parseCount(line.slice(4));
		}
	}

	if (summary.files === 0) {
		throw new Error("lcov report has no SF records");
	}
	return summary;
}

export function coverageShortfalls(
	summary: LcovSummary,
	minimum: { lines: number; functions: number },
): string[] {
	const shortfalls: string[] = [];
	if (coverageRatio(summary.lines) < minimum.lines) {
		shortfalls.push(shortfallMessage("lines", summary.lines, minimum.lines));
	}
	if (coverageRatio(summary.functions) < minimum.functions) {
		shortfalls.push(shortfallMessage("functions", summary.functions, minimum.functions));
	}
	return shortfalls;
}

export function formatLcovSummary(summary: LcovSummary): string {
	return `coverage: lines ${formatShare(summary.lines)}, functions ${formatShare(summary.functions)}`;
}

function parseCount(value: string): number {
	const count = Number(value);
	return Number.isFinite(count) ? count : 0;
}

function coverageRatio(part: { found: number; hit: number }): number {
	return part.found === 0 ? 1 : part.hit / part.found;
}

function formatPercent(ratio: number): string {
	return `${(ratio * 100).toFixed(2)}%`;
}

function formatShare(part: { found: number; hit: number }): string {
	return `${formatPercent(coverageRatio(part))} (${part.hit}/${part.found})`;
}

function shortfallMessage(
	kind: "lines" | "functions",
	part: { found: number; hit: number },
	minimum: number,
): string {
	return `${kind} ${formatPercent(coverageRatio(part))} is below the ${formatPercent(minimum)} minimum`;
}
