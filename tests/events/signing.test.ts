import { describe, expect, it } from "bun:test";
import {
	createWebhookHeaders,
	generateWebhookSecret,
	isWebhookSecret,
	verifyWebhookSignature,
	webhookTimestampToleranceSeconds,
} from "../../src/events/signing";

const at = (seconds: number) => () => new Date(seconds * 1000);

describe("Standard Webhooks signing", () => {
	it("matches the specification's published test vector", () => {
		// https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
		const vector = {
			secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
			webhookId: "msg_p5jXN8AQM9LWM0D4loKWxJek",
			timestamp: "1614265330",
			body: '{"test": 2432232314}',
			signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
		};

		const headers = createWebhookHeaders({
			webhookId: vector.webhookId,
			body: vector.body,
			secrets: [vector.secret],
			now: at(1614265330),
		});

		expect(headers).toEqual({
			"webhook-id": vector.webhookId,
			"webhook-timestamp": vector.timestamp,
			"webhook-signature": vector.signature,
		});
		expect(verifyWebhookSignature({ ...vector, now: at(1614265330) })).toBe(true);
	});

	it("signs with every secret during a rotation overlap, so either one verifies", () => {
		const current = generateWebhookSecret();
		const previous = generateWebhookSecret();
		const body = JSON.stringify({ id: "event", type: "webhook.test" });
		const headers = createWebhookHeaders({
			webhookId: "event",
			body,
			secrets: [current, previous],
			now: at(1_760_000_000),
		});
		const check = (secret: string) =>
			verifyWebhookSignature({
				secret,
				body,
				webhookId: "event",
				timestamp: headers["webhook-timestamp"],
				signature: headers["webhook-signature"],
				now: at(1_760_000_000),
			});

		expect(headers["webhook-signature"].split(" ")).toHaveLength(2);
		expect(check(current)).toBe(true);
		expect(check(previous)).toBe(true);
		expect(check(generateWebhookSecret())).toBe(false);
	});

	it("refuses a changed body, id or a timestamp outside the tolerance", () => {
		const secret = generateWebhookSecret();
		const body = '{"amount":"10"}';
		const headers = createWebhookHeaders({
			webhookId: "event",
			body,
			secrets: [secret],
			now: at(1_760_000_000),
		});
		const verify = (overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]>) =>
			verifyWebhookSignature({
				secret,
				body,
				webhookId: "event",
				timestamp: headers["webhook-timestamp"],
				signature: headers["webhook-signature"],
				now: at(1_760_000_000),
				...overrides,
			});

		expect(verify({})).toBe(true);
		expect(verify({ body: '{"amount":"100"}' })).toBe(false);
		expect(verify({ webhookId: "other" })).toBe(false);
		expect(verify({ now: at(1_760_000_000 + webhookTimestampToleranceSeconds + 1) })).toBe(false);
		expect(verify({ timestamp: "1760000000.5" })).toBe(false);
		expect(verify({ signature: "v2,abc" })).toBe(false);
		expect(verify({ secret: "not-a-secret" })).toBe(false);
	});

	it("generates 32-byte whsec_ secrets and needs one to sign", () => {
		const secret = generateWebhookSecret();

		expect(isWebhookSecret(secret)).toBe(true);
		expect(Buffer.from(secret.slice("whsec_".length), "base64")).toHaveLength(32);
		expect(isWebhookSecret("whsec_short")).toBe(false);
		expect(() => createWebhookHeaders({ webhookId: "event", body: "{}", secrets: [] })).toThrow(
			"A webhook delivery needs a signing secret",
		);
	});
});
