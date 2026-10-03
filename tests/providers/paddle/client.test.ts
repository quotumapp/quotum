import { describe, expect, it } from "bun:test";
import {
	PaddleClient,
	PaddleRequestRejected,
	PaddleWriteUncertain,
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
