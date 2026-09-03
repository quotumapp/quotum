export interface LeaseHeartbeatOptions {
	intervalMs: number;
	heartbeat: () => Promise<void>;
	onError?: (error: unknown) => void;
}

export function startLeaseHeartbeat({
	intervalMs,
	heartbeat,
	onError = () => undefined,
}: LeaseHeartbeatOptions): () => Promise<void> {
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		throw new Error("Lease heartbeat interval must be positive");
	}

	let inFlight: Promise<void> | null = null;
	const timer = setInterval(() => {
		if (inFlight !== null) {
			return;
		}

		inFlight = heartbeat()
			.catch(onError)
			.finally(() => {
				inFlight = null;
			});
	}, intervalMs);
	timer.unref?.();

	return async () => {
		clearInterval(timer);
		await inFlight;
	};
}
