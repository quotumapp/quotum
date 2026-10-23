const ONE_MINUTE_MS = 60_000;
const MAX_DELAY_MS = 24 * 60 * 60 * 1000;

export interface CalculateNextAttemptInput {
	attempts: number;
	maxAttempts: number;
	now?: Date;
	jitterMs?: number;
}

export function calculateNextAttemptAt({
	attempts,
	maxAttempts,
	now = new Date(),
	jitterMs = Math.floor(Math.random() * 1000),
}: CalculateNextAttemptInput): Date | null {
	const nextAttemptNumber = attempts + 1;
	if (nextAttemptNumber >= maxAttempts) {
		return null;
	}

	const delay = Math.min(MAX_DELAY_MS, ONE_MINUTE_MS * 2 ** attempts);
	return new Date(now.getTime() + delay + jitterMs);
}

/**
 * Like `calculateNextAttemptAt`, for work that must not be given up on. Once `maxAttempts` attempts
 * have failed it keeps retrying at the longest delay instead of returning `null`, so an outage
 * longer than the backoff window cannot park the job for good.
 */
export function calculateNextRetryAt({
	attempts,
	maxAttempts,
	now = new Date(),
	jitterMs = Math.floor(Math.random() * 1000),
}: CalculateNextAttemptInput): Date {
	return (
		calculateNextAttemptAt({ attempts, maxAttempts, now, jitterMs }) ??
		new Date(now.getTime() + MAX_DELAY_MS + jitterMs)
	);
}

export function normalizeWorkerError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	if (typeof error === "string") {
		return error;
	}

	try {
		const normalized = JSON.stringify(error);
		return typeof normalized === "string" && normalized.length > 0
			? normalized
			: "Unknown worker error";
	} catch {
		return "Unknown worker error";
	}
}

/** Backoff duration; persistence adds it to the database clock when recording failure. */
export function calculateRetryDelayMs({
	attempts,
	maxAttempts,
	jitterMs = Math.floor(Math.random() * 1000),
}: Omit<CalculateNextAttemptInput, "now">): number | null {
	if (attempts + 1 >= maxAttempts) return null;
	return Math.min(MAX_DELAY_MS, ONE_MINUTE_MS * 2 ** attempts) + jitterMs;
}

export function calculateNextRetryDelayMs(input: Omit<CalculateNextAttemptInput, "now">): number {
	return (
		calculateRetryDelayMs(input) ??
		MAX_DELAY_MS + (input.jitterMs ?? Math.floor(Math.random() * 1000))
	);
}
