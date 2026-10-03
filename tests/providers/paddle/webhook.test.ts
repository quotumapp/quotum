import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { verifyPaddleSignature } from "../../../src/providers/paddle/webhook";

const secret = "paddle-test-secret-not-a-credential";
const body = '{"event_id":"evt_test", "data":{}}';
const now = new Date("2026-10-03T10:00:00Z");
const timestamp = String(now.getTime() / 1000);
const signature = `ts=${timestamp};h1=${createHmac("sha256", secret).update(`${timestamp}:${body}`).digest("hex")}`;

describe("Paddle webhook signature", () => {
	// capability: webhook.ingest
	it("verifies the original body and permits multiple rotation signatures", () => {
		expect(() =>
			verifyPaddleSignature({ body, signature: `${signature};h1=${"0".repeat(64)}`, secret, now }),
		).not.toThrow();
	});
	it("rejects modified bytes, foreign secrets and duplicate timestamps", () => {
		for (const input of [
			{ body: JSON.stringify(JSON.parse(body)), signature, secret },
			{ body, signature, secret: "foreign-secret" },
			{ body, signature: `${signature};ts=${timestamp}`, secret },
			{ body, signature: "ts=invalid;h1=invalid", secret },
			{ body, signature: null, secret },
		])
			expect(() => verifyPaddleSignature({ ...input, now })).toThrow("signature is invalid");
	});
	it("rejects stale and future timestamps", () => {
		for (const offset of [-6000, 6000]) {
			expect(() =>
				verifyPaddleSignature({ body, signature, secret, now: new Date(now.getTime() + offset) }),
			).toThrow("signature is invalid");
		}
		for (const offset of [-5000, 5000]) {
			expect(() =>
				verifyPaddleSignature({ body, signature, secret, now: new Date(now.getTime() + offset) }),
			).not.toThrow();
		}
	});
});
