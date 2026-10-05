import { describe, expect, it } from "bun:test";
import { ProviderUnavailableError } from "../../../src/billing/errors";
import {
	PaddleClient,
	PaddleRequestRejected,
	PaddleWriteUncertain,
	paddleUnavailable,
} from "../../../src/providers/paddle/client";

const config = { apiKey: "pdl_sdbx_test_only" };
const cooldown = () => {
	let retryAt = 0;
	return {
		get: () => retryAt,
		set: (value: number) => {
			retryAt = value;
		},
	};
};

describe("Paddle transport", () => {
	it("pins sandbox and API version without forwarding idempotency assumptions", async () => {
		const client = new PaddleClient(
			config,
			async (url, init) => {
				expect(String(url)).toBe("https://sandbox-api.paddle.com/transactions");
				expect(init?.redirect).toBe("error");
				expect(new Headers(init?.headers).get("paddle-version")).toBe("1");
				expect(new Headers(init?.headers).get("idempotency-key")).toBeNull();
				return Response.json({ data: { id: "txn_1" } });
			},
			Date.now,
			cooldown(),
		);
		expect(await client.write("POST", "/transactions", { items: [] })).toEqual({
			data: { id: "txn_1" },
		});
	});
	it("never retries a create whose response was lost", async () => {
		let requests = 0;
		const client = new PaddleClient(
			config,
			async () => {
				requests++;
				throw new Error("secret transport detail");
			},
			Date.now,
			cooldown(),
		);
		await expect(client.write("POST", "/transactions", {})).rejects.toBeInstanceOf(
			PaddleWriteUncertain,
		);
		expect(requests).toBe(1);
	});
	it("keeps server errors and malformed success responses uncertain", async () => {
		for (const response of [
			Response.json({ error: { code: "internal_error" } }, { status: 500 }),
			new Response("invalid"),
		]) {
			const client = new PaddleClient(config, async () => response, Date.now, cooldown());
			await expect(client.write("POST", "/transactions", {})).rejects.toBeInstanceOf(
				PaddleWriteUncertain,
			);
		}
	});
	it("shares rate-limit cooldown across clients without sleeping or resending writes", async () => {
		const gate = cooldown();
		let requests = 0;
		const fetcher = async () => {
			requests++;
			return Response.json(
				{ error: { code: "too_many_requests" } },
				{ status: 429, headers: { "retry-after": "12" } },
			);
		};
		const first = new PaddleClient(config, fetcher, () => 1000, gate);
		const second = new PaddleClient(config, fetcher, () => 1000, gate);
		await expect(first.write("POST", "/transactions", {})).rejects.toBeInstanceOf(
			PaddleRequestRejected,
		);
		await expect(second.get("/customers")).rejects.toMatchObject({
			code: "PADDLE_RATE_LIMITED",
			retryAfterMs: 12000,
		});
		expect(requests).toBe(1);
	});
	it("refuses a write before it is prepared only while the shared cooldown is active", () => {
		const gate = cooldown();
		const client = new PaddleClient(
			config,
			async () => Response.json({ data: {} }),
			() => 1000,
			gate,
		);
		expect(() => client.assertAvailable()).not.toThrow();
		gate.set(13_500);
		let refused: unknown;
		try {
			client.assertAvailable();
		} catch (error) {
			refused = error;
		}
		expect(refused).toBeInstanceOf(ProviderUnavailableError);
		expect(refused).toMatchObject({
			code: "BILLING_PROVIDER_UNAVAILABLE",
			status: 503,
			details: { retryAfterSeconds: 13 },
		});
		gate.set(900);
		expect(() =>
			new PaddleClient(config, fetch, () => 14_000, gate).assertAvailable(),
		).not.toThrow();
	});
	it("stores one receipt code for every rate limit Paddle answers with", async () => {
		const client = new PaddleClient(
			config,
			async () =>
				Response.json(
					{ error: { code: "too_many_requests" } },
					{ status: 429, headers: { "retry-after": "7" } },
				),
			() => 1000,
			cooldown(),
		);
		await expect(client.write("POST", "/customers", {})).rejects.toMatchObject({
			status: 429,
			code: "PADDLE_RATE_LIMITED",
			retryAfterMs: 7000,
		});
		const other = new PaddleClient(
			config,
			async () => Response.json({ error: { code: "customer_already_exists" } }, { status: 409 }),
			() => 1000,
			cooldown(),
		);
		await expect(other.write("POST", "/customers", {})).rejects.toMatchObject({
			status: 409,
			code: "customer_already_exists",
		});
	});
	it("turns only a rate limit or an outage into a retryable provider error", () => {
		const limited = paddleUnavailable(new PaddleRequestRejected(429, "PADDLE_RATE_LIMITED", 1500));
		expect(limited).toBeInstanceOf(ProviderUnavailableError);
		expect(limited).toMatchObject({ status: 503, details: { retryAfterSeconds: 2 } });
		const unhinted = paddleUnavailable(new PaddleRequestRejected(429, "PADDLE_RATE_LIMITED", null));
		expect(unhinted).toBeInstanceOf(ProviderUnavailableError);
		expect(unhinted).not.toHaveProperty("details");
		const outage = paddleUnavailable(new PaddleWriteUncertain());
		expect(outage).toBeInstanceOf(ProviderUnavailableError);
		expect(outage).toMatchObject({ code: "BILLING_PROVIDER_UNAVAILABLE", status: 503 });
		const missing = new PaddleRequestRejected(404, "not_found", null);
		expect(paddleUnavailable(missing)).toBe(missing);
		const unrelated = new Error("bug");
		expect(paddleUnavailable(unrelated)).toBe(unrelated);
	});
	it("rejects production credentials and foreign destinations before fetch", async () => {
		expect(() => new PaddleClient({ apiKey: "pdl_live_secret" })).toThrow("sandbox API key");
		let requests = 0;
		const client = new PaddleClient(
			config,
			async () => {
				requests++;
				return Response.json({ data: {} });
			},
			Date.now,
			cooldown(),
		);
		for (const path of [
			"https://example.com",
			"//example.com",
			"/customers\\@example.com",
			"/not-a-resource",
		]) {
			await expect(client.get(path)).rejects.toThrow("Invalid Paddle API");
		}
		expect(requests).toBe(0);
	});
});
