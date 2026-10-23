/** JavaScript timers overflow above this signed 32-bit millisecond delay. */
export const MAX_POLL_INTERVAL_MS = 2_147_483_647;

export function validatePollInterval(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > MAX_POLL_INTERVAL_MS) {
		throw new Error(`${name} must be an integer between 1 and ${MAX_POLL_INTERVAL_MS}`);
	}
	return value;
}
