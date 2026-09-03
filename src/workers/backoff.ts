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
