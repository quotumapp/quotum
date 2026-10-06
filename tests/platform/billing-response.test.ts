import { describe, expect, it } from "bun:test";
import { billingResultResponse } from "../../src/platform/billing";

const unavailable = (details?: Record<string, unknown>) => ({
	status: 503,
	body: {
		success: false,
		error: { code: "BILLING_PROVIDER_UNAVAILABLE", message: "Paddle is unavailable", details },
	},
});

describe("billingResultResponse", () => {
	it("keeps a provider outage's wait in retry-after", async () => {
		const response = billingResultResponse(unavailable({ retryAfterSeconds: 45 }));
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("45");
		expect((await response.json()).error.details).toEqual({ retryAfterSeconds: 45 });
	});

	it("adds no header without a usable wait or for other answers", () => {
		for (const result of [
			unavailable(),
			unavailable({ retryAfterSeconds: 0 }),
			unavailable({ retryAfterSeconds: 1.5 }),
			unavailable({ retryAfterSeconds: "45" }),
			{ status: 200, body: { success: true, data: null } },
			{ status: 503, body: null },
			{ status: 503, body: { error: { code: "OTHER", details: { retryAfterSeconds: 5 } } } },
			{ status: 429, body: unavailable({ retryAfterSeconds: 5 }).body },
		]) {
			expect(billingResultResponse(result).headers.get("retry-after")).toBeNull();
		}
	});
});
