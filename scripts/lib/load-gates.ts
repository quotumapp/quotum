export interface LoadGateResult {
	scenario: string;
	/** Requests the scenario sent, and how many came back 200 with the operation allowed. */
	requests: number;
	accepted: number;
	/** Requests answered 200 with `allowed: false`. */
	denied: number;
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

/**
 * Only a 2xx answer counts as served. A business denial is itself HTTP 200 with `allowed: false`,
 * so it never passes through here; it is gated by the accepted count instead. A status that does not
 * parse as a number is not a success.
 */
export function isSuccessStatus(status: number): boolean {
	return status >= 200 && status < 300;
}

/**
 * The lane's fixture grants every account far more than a run can spend, so no request is expected
 * to be denied, rejected or fail: every non-2xx status fails the lane, and so does any closed-loop
 * request that was not accepted. A scenario that sent nothing measured nothing and fails too.
 */
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
			if (!isSuccessStatus(Number(status)) && count > 0) {
				failures.push(`${label} recorded ${count} status ${status} responses`);
			}
		}
		// Arrival-rate levels are gated above, against what was scheduled.
		if (result.arrivals === undefined) {
			if (result.requests === 0) {
				failures.push(`${label} sent no requests`);
			} else if (result.accepted < result.requests) {
				failures.push(
					`${label} accepted ${result.accepted}/${result.requests} requests (${result.denied} denied)`,
				);
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
