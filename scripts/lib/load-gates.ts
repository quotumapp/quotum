export interface LoadGateResult {
	scenario: string;
	statuses: Record<string, number>;
	rps: number;
	clientMs: { p99: number };
	db: { projectionBacklogAfter: number };
	arrivals?: {
		users?: number;
		scheduled: number;
		accepted: number;
		droppedCapacity: number;
		droppedLate: number;
		accounting: { missingAccepted: number; invalidEvents: number };
	};
}

export function evaluateLoadGates(
	results: readonly LoadGateResult[],
	options: { minRps?: number; maxP99Ms?: number } = {},
): string[] {
	const failures: string[] = [];
	for (const result of results) {
		const label =
			result.arrivals?.users === undefined
				? result.scenario
				: `${result.scenario} (${result.arrivals.users} users)`;
		if (result.arrivals !== undefined) {
			const arrivals = result.arrivals;
			if (arrivals.accepted !== arrivals.scheduled) {
				failures.push(
					`${label} accepted ${arrivals.accepted}/${arrivals.scheduled} scheduled arrivals (capacity drops ${arrivals.droppedCapacity}, generator drops ${arrivals.droppedLate})`,
				);
			}
			if (arrivals.accounting.missingAccepted > 0 || arrivals.accounting.invalidEvents > 0) {
				failures.push(`${label} failed durable usage reconciliation`);
			}
		}
		for (const [status, count] of Object.entries(result.statuses)) {
			const code = Number(status);
			if ((code === 0 || code >= 500) && count > 0) {
				failures.push(`${label} recorded ${count} status ${status} responses`);
			}
		}
		if (result.scenario !== "workers-off" && result.db.projectionBacklogAfter > 0) {
			failures.push(`${label} left a projection backlog of ${result.db.projectionBacklogAfter}`);
		}
		if (options.minRps !== undefined && result.rps < options.minRps) {
			failures.push(`${label} rps ${result.rps} is below ${options.minRps}`);
		}
		if (options.maxP99Ms !== undefined && result.clientMs.p99 > options.maxP99Ms) {
			failures.push(`${label} p99 ${result.clientMs.p99}ms exceeds ${options.maxP99Ms}ms`);
		}
	}
	return failures;
}
