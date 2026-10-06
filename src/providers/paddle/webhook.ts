import { createHmac, timingSafeEqual } from "node:crypto";
import { BillingError } from "../../billing/errors";
import { type PaddleEvent, paddleEventSchema } from "./schemas";

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

/**
 * Parses the verified body into an event. A signed body that is not JSON, lacks the event
 * envelope, or holds a NUL character (which Postgres cannot store) answers 400 and queues nothing.
 */
export function parsePaddleEvent(rawBody: string): PaddleEvent {
	let json: unknown;
	try {
		json = JSON.parse(rawBody);
	} catch {
		throw invalidEvent();
	}
	const parsed = paddleEventSchema.safeParse(json);
	if (!parsed.success || containsNul(parsed.data)) throw invalidEvent();
	return parsed.data;
}

/** Iterative, so a deeply nested body cannot exhaust the stack. */
function containsNul(root: unknown): boolean {
	const pending: unknown[] = [root];
	while (pending.length > 0) {
		const value = pending.pop();
		if (typeof value === "string") {
			if (value.includes("\u0000")) return true;
		} else if (Array.isArray(value)) {
			for (const entry of value) pending.push(entry);
		} else if (typeof value === "object" && value !== null) {
			for (const [key, entry] of Object.entries(value)) {
				if (key.includes("\u0000")) return true;
				pending.push(entry);
			}
		}
	}
	return false;
}

function invalidEvent(): BillingError {
	return new BillingError("Invalid Paddle webhook body", "INVALID_REQUEST", 400);
}
