export interface ArrivalSample<T> {
	index: number;
	account: number;
	lagMs: number;
	ms: number;
	finishedAtMs: number;
	outcome: T | null;
}

export interface ArrivalRun<T> {
	scheduled: number;
	sent: number;
	droppedCapacity: number;
	droppedLate: number;
	peakInFlight: number;
	inFlightAtEnd: number;
	elapsedMs: number;
	samples: ArrivalSample<T>[];
}

/** One request per account per second, staggered evenly and independent of response time. */
export async function driveUserArrivals<T>(
	options: {
		users: number;
		durationMs: number;
		maxInFlight: number;
		maxLagMs: number;
	},
	request: (account: number, index: number) => Promise<T>,
	clock = { now: () => performance.now(), sleep: (ms: number) => Bun.sleep(ms) },
): Promise<ArrivalRun<T>> {
	for (const [name, value] of Object.entries(options)) {
		if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive`);
	}
	if (!Number.isInteger(options.users) || !Number.isInteger(options.maxInFlight)) {
		throw new Error("users and maxInFlight must be integers");
	}
	const startedAt = clock.now();
	const scheduled = Math.ceil((options.users * options.durationMs) / 1000);
	const intervalMs = 1000 / options.users;
	const pending = new Set<Promise<void>>();
	const samples: ArrivalSample<T>[] = [];
	let next = 0;
	let sent = 0;
	let droppedCapacity = 0;
	let droppedLate = 0;
	let peakInFlight = 0;
	while (next < scheduled) {
		const elapsed = clock.now() - startedAt;
		// A stalled generator reports missed arrivals instead of replaying them as a burst.
		const firstTimely = Math.min(
			scheduled,
			Math.max(next, Math.ceil((elapsed - options.maxLagMs) / intervalMs)),
		);
		droppedLate += firstTimely - next;
		next = firstTimely;
		const due = Math.min(scheduled, Math.floor(elapsed / intervalMs) + 1);
		while (next < due) {
			const index = next++;
			if (pending.size >= options.maxInFlight) {
				droppedCapacity += 1;
				continue;
			}
			const dispatchedAt = clock.now();
			const lagMs = dispatchedAt - startedAt - index * intervalMs;
			if (lagMs > options.maxLagMs) {
				droppedLate += 1;
				continue;
			}
			const account = index % options.users;
			sent += 1;
			const task = Promise.resolve()
				.then(() => request(account, index))
				.catch(() => null)
				.then((outcome) => {
					const finishedAt = clock.now();
					samples.push({
						index,
						account,
						lagMs,
						ms: finishedAt - dispatchedAt,
						finishedAtMs: finishedAt - startedAt,
						outcome,
					});
					pending.delete(task);
				});
			pending.add(task);
			peakInFlight = Math.max(peakInFlight, pending.size);
		}
		await clock.sleep(Math.max(1, Math.min(5, next * intervalMs - (clock.now() - startedAt))));
	}
	// Observe the entire offered-load window even if the final arrival was sent earlier.
	await clock.sleep(Math.max(0, options.durationMs - (clock.now() - startedAt)));
	await Promise.all(pending);
	const inFlightAtEnd = samples.filter(
		(sample) =>
			sample.index * intervalMs + sample.lagMs < options.durationMs &&
			sample.finishedAtMs > options.durationMs,
	).length;
	return {
		scheduled,
		sent,
		droppedCapacity,
		droppedLate,
		peakInFlight,
		inFlightAtEnd,
		elapsedMs: clock.now() - startedAt,
		samples,
	};
}
