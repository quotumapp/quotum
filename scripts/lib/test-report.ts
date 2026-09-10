export function junitReporterArgs(outfile: string): string[] {
	return ["--reporter=junit", `--reporter-outfile=${outfile}`];
}

export interface JunitSummary {
	tests: number;
	failures: number;
	skipped: number;
}

export function readJunitSummary(xml: string): JunitSummary {
	const open = xml.match(/<testsuites\b[^>]*>/);
	if (open === null) {
		throw new Error("junit report is missing testsuites attributes");
	}
	const tests = numberAttribute(open[0], "tests");
	const skipped = numberAttribute(open[0], "skipped");
	const failures = numberAttribute(open[0], "failures");
	if (tests === null || skipped === null || failures === null) {
		throw new Error("junit report is missing testsuites attributes");
	}
	return { tests, skipped, failures };
}

export function assertLaneReport(summary: JunitSummary, lane: string): void {
	if (summary.tests === 0) {
		throw new Error(`${lane} lane reported 0 tests`);
	}
	if (summary.skipped > 0) {
		throw new Error(`${lane} lane skipped ${summary.skipped} tests`);
	}
}

function numberAttribute(tag: string, name: string): number | null {
	const match = tag.match(new RegExp(`\\b${name}="(\\d+)"`));
	return match?.[1] === undefined ? null : Number(match[1]);
}
