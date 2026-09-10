const globalLeaseHeartbeatTimers: LeaseHeartbeatTimers = {
	setInterval(callback, ms) {
		return setInterval(callback, ms);
	},
	clearInterval(handle) {
		clearInterval(handle as ReturnType<typeof setInterval>);
	},
};

export type LeaseHeartbeatHandle = ReturnType<typeof setInterval> | number | object;

export interface LeaseHeartbeatTimers {
	setInterval(callback: () => void, ms: number): LeaseHeartbeatHandle;
	clearInterval(handle: LeaseHeartbeatHandle): void;
}

export interface LeaseHeartbeatOptions {
	intervalMs: number;
	heartbeat: () => Promise<void>;
	onError?: (error: unknown) => void;
	timers?: LeaseHeartbeatTimers;
}

export function startLeaseHeartbeat({
	intervalMs,
	heartbeat,
	onError = () => undefined,
	timers = globalLeaseHeartbeatTimers,
}: LeaseHeartbeatOptions): () => Promise<void> {
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		throw new Error("Lease heartbeat interval must be positive");
	}

	let inFlight: Promise<void> | null = null;
	const timer = timers.setInterval(() => {
		if (inFlight !== null) {
			return;
		}

		inFlight = heartbeat()
			.catch(onError)
			.finally(() => {
				inFlight = null;
			});
	}, intervalMs);
	(timer as { unref?: () => unknown }).unref?.();

	return async () => {
		timers.clearInterval(timer);
		await inFlight;
	};
}
