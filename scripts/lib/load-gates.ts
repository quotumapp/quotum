export interface LoadGateResult {
	scenario: string;
	statuses: Record<string, number>;
	rps: number;
	clientMs: { p99: number };
	db: { projectionBacklogAfter: number };
}

export function evaluateLoadGates(
	results: readonly LoadGateResult[],
	options: { minRps?: number; maxP99Ms?: number } = {},
): string[] {
	const failures: string[] = [];
	for (const result of results) {
		for (const [status, count] of Object.entries(result.statuses)) {
			const code = Number(status);
			if ((code === 0 || code >= 500) && count > 0) {
				failures.push(`${result.scenario} recorded ${count} status ${status} responses`);
			}
		}
		if (result.scenario !== "workers-off" && result.db.projectionBacklogAfter > 0) {
			failures.push(
				`${result.scenario} left a projection backlog of ${result.db.projectionBacklogAfter}`,
			);
		}
		if (options.minRps !== undefined && result.rps < options.minRps) {
			failures.push(`${result.scenario} rps ${result.rps} is below ${options.minRps}`);
		}
		if (options.maxP99Ms !== undefined && result.clientMs.p99 > options.maxP99Ms) {
			failures.push(
				`${result.scenario} p99 ${result.clientMs.p99}ms exceeds ${options.maxP99Ms}ms`,
			);
		}
	}
	return failures;
}
