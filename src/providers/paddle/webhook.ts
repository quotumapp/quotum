import { createHmac, timingSafeEqual } from "node:crypto";
import { BillingError } from "../../billing/errors";

/** Verify the original bytes before parsing. Multiple h1 signatures permit secret rotation. */
export function verifyPaddleSignature(input: {
	body: string;
	signature: string | null;
	secret: string;
	now?: Date;
}): void {
	const parts = (input.signature ?? "").split(";").map((part) => part.trim());
	const timestamps = parts.filter((part) => part.startsWith("ts="));
	const timestamp = timestamps[0]?.slice(3) ?? "";
	const seconds = Number(timestamp);
	const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
	if (
		timestamps.length !== 1 ||
		!/^\d+$/.test(timestamp) ||
		!Number.isSafeInteger(seconds) ||
		// Match Paddle's SDK default tolerance; retries arrive with a new delivery timestamp.
		Math.abs(now - seconds) > 5 ||
		input.secret.length === 0
	)
		throw invalidSignature();
	const expected = createHmac("sha256", input.secret).update(`${timestamp}:${input.body}`).digest();
	const verified = parts.some((part) => {
		if (!/^h1=[a-fA-F0-9]{64}$/.test(part)) return false;
		return timingSafeEqual(expected, Buffer.from(part.slice(3), "hex"));
	});
	if (!verified) throw invalidSignature();
}

function invalidSignature(): BillingError {
	return new BillingError("Paddle webhook signature is invalid", "PADDLE_SIGNATURE_INVALID", 400);
}
