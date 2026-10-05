import { type LeaseHeartbeatTimers, startLeaseHeartbeat } from "./lease-heartbeat";

/** A failed ownership read must never enter the provider-error/failure-marker path. */
export class JobLeaseRenewalError extends Error {
	constructor(cause: unknown) {
		super("Could not verify worker job ownership", { cause });
	}
}

export function jobHeartbeatInterval(staleAfterMs: number, intervalMs?: number): number {
	const interval = intervalMs ?? Math.min(60_000, staleAfterMs / 3);
	if (
		!Number.isFinite(staleAfterMs) ||
		!Number.isFinite(interval) ||
		interval <= 0 ||
		interval >= staleAfterMs
	) {
		throw new Error("Job heartbeat interval must be positive and shorter than the lease");
	}
	return interval;
}

/** Keeps waiting claims alive too; only an awaited ownership check authorizes provider work. */
export function startJobLeases<Job>({
	jobs,
	intervalMs,
	renew,
	onLost,
	onError,
	timers,
}: {
	jobs: readonly Job[];
	intervalMs: number;
	renew: (job: Job) => Promise<boolean>;
	onLost: (job: Job) => void;
	onError: (error: unknown, job: Job) => void;
	timers?: LeaseHeartbeatTimers;
}) {
	const pending = new Map(
		jobs.map((job) => [job, { lost: false, inFlight: null as Promise<boolean> | null }]),
	);
	const owns = (job: Job): Promise<boolean> => {
		const state = pending.get(job);
		if (state === undefined || state.lost) return Promise.resolve(false);
		if (state.inFlight !== null) return state.inFlight;
		state.inFlight = Promise.resolve()
			.then(() => renew(job))
			.then((owned) => {
				if (!pending.has(job)) return false;
				if (!owned) {
					state.lost = true;
					report(() => onLost(job));
				}
				return owned;
			})
			.catch((error: unknown) => {
				if (pending.has(job)) report(() => onError(error, job));
				throw new JobLeaseRenewalError(error);
			})
			.finally(() => {
				state.inFlight = null;
			});
		return state.inFlight;
	};
	const stopHeartbeat =
		pending.size === 0
			? async () => undefined
			: startLeaseHeartbeat({
					intervalMs,
					timers,
					heartbeat: async () => {
						await Promise.allSettled([...pending.keys()].map(owns));
					},
				});
	return {
		owns,
		release(job: Job) {
			pending.delete(job);
		},
		async stop() {
			await stopHeartbeat();
			pending.clear();
		},
	};
}

function report(callback: () => void): void {
	try {
		callback();
	} catch {
		// Diagnostics cannot change lease ownership or abandon the rest of the batch.
	}
}
