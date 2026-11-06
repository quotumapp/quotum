/** Server-owned preview lifetime options; never populated from an HTTP request body. */
export interface PreviewOptions {
	ttlSeconds?: number;
}

export function previewExpiry(ttlSeconds: number, now = Date.now(), name = "Preview TTL"): Date {
	const milliseconds = ttlSeconds * 1000;
	const deadline = now + milliseconds;
	const expiry = new Date(deadline);
	if (
		!Number.isSafeInteger(ttlSeconds) ||
		ttlSeconds < 1 ||
		!Number.isSafeInteger(milliseconds) ||
		!Number.isSafeInteger(deadline) ||
		!Number.isFinite(expiry.getTime())
	)
		throw new Error(`${name} must be a positive integer duration within the supported date range`);
	return expiry;
}
