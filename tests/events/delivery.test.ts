import { describe, expect, it } from "bun:test";
import { parseRetryAfter, sendWebhook, type WebhookPost } from "../../src/events/delivery";
import { generateWebhookSecret, verifyWebhookSignature } from "../../src/events/signing";
import { DestinationError } from "../../src/shared/safe-http";

const now = () => new Date("2026-10-19T08:00:00.000Z");
const secret = generateWebhookSecret();
const request = {
	url: "https://hooks.example.com/quotum",
	webhookId: "0192f3a1-7c4e-7b1a-9d3e-5a6b7c8d9e10",
	body: '{"type":"webhook.test"}',
	secrets: [secret],
};

function answering(status: number, retryAfter?: string) {
	const sent: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
	const post: WebhookPost = async (url, body, headers) => {
		sent.push({ url, body, headers });
		return { status, body: "ignored", ...(retryAfter === undefined ? {} : { retryAfter }) };
	};
	return { post, sent };
}

describe("sendWebhook", () => {
	it("signs the exact body and treats any 2xx as delivered", async () => {
		const { post, sent } = answering(204);

		const result = await sendWebhook(post, request, now);

		expect(result).toEqual({ ok: true, statusCode: 204 });
		const [attempt] = sent;
		expect(attempt?.url).toBe(request.url);
		expect(attempt?.body).toBe(request.body);
		expect(attempt?.headers["content-type"]).toBe("application/json");
		expect(attempt?.headers["webhook-id"]).toBe(request.webhookId);
		expect(
			verifyWebhookSignature({
				secret,
				body: attempt?.body ?? "",
				webhookId: attempt?.headers["webhook-id"] ?? "",
				timestamp: attempt?.headers["webhook-timestamp"] ?? "",
				signature: attempt?.headers["webhook-signature"] ?? "",
				now,
			}),
		).toBe(true);
	});

	it("reports other statuses as failures and reads Retry-After only on 429 and 503", async () => {
		expect(await sendWebhook(answering(500).post, request, now)).toEqual({
			ok: false,
			statusCode: 500,
			error: "Receiver answered 500",
			retryAfterSeconds: null,
		});
		expect(await sendWebhook(answering(429, "120").post, request, now)).toMatchObject({
			ok: false,
			statusCode: 429,
			retryAfterSeconds: 120,
		});
		expect(await sendWebhook(answering(400, "120").post, request, now)).toMatchObject({
			retryAfterSeconds: null,
		});
		expect(
			await sendWebhook(answering(503, "Sun, 19 Oct 2026 08:05:00 GMT").post, request, now),
		).toMatchObject({ statusCode: 503, retryAfterSeconds: 300 });
	});

	it("reports an unreachable receiver without a status, and hides local faults", async () => {
		const refused: WebhookPost = () =>
			Promise.reject(new DestinationError("Receiver request failed"));
		const broken: WebhookPost = () => Promise.reject(new TypeError("secret detail"));

		expect(await sendWebhook(refused, request, now)).toEqual({
			ok: false,
			statusCode: null,
			error: "Receiver request failed",
			retryAfterSeconds: null,
		});
		expect(await sendWebhook(broken, request, now)).toMatchObject({
			error: "Webhook delivery failed locally",
		});
	});
});

describe("parseRetryAfter", () => {
	it("reads delta-seconds and HTTP dates, and ignores anything else", () => {
		const at = new Date("2026-10-19T08:00:00.000Z");

		expect(parseRetryAfter(undefined, at)).toBeNull();
		expect(parseRetryAfter(" 30 ", at)).toBe(30);
		expect(parseRetryAfter("Sun, 19 Oct 2026 08:01:00 GMT", at)).toBe(60);
		expect(parseRetryAfter("Sun, 19 Oct 2026 07:00:00 GMT", at)).toBe(0);
		expect(parseRetryAfter("soon", at)).toBeNull();
	});
});
