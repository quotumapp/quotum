import { timingSafeEqual } from "node:crypto";

export function constantTimeEquals(actual: string, expected: string): boolean {
	const actualBuffer = Buffer.from(actual, "utf8");
	const expectedBuffer = Buffer.from(expected, "utf8");

	if (actualBuffer.byteLength !== expectedBuffer.byteLength) {
		return false;
	}

	return timingSafeEqual(actualBuffer, expectedBuffer);
}
