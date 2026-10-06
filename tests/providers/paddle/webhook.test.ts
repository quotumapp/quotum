import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { parsePaddleEvent, verifyPaddleSignature } from "../../../src/providers/paddle/webhook";

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

describe("Paddle webhook body", () => {
	const event = {
		event_id: `evt_${"a".repeat(26)}`,
		event_type: "subscription.updated",
		occurred_at: "2026-10-03T10:00:00Z",
		data: { id: `sub_${"b".repeat(26)}`, nested: [{ note: "text" }] },
	};

	it("parses an event envelope and keeps unknown fields", () => {
		expect(parsePaddleEvent(JSON.stringify({ ...event, notification_id: "ntf_1" }))).toMatchObject({
			...event,
			notification_id: "ntf_1",
		});
	});

	it("refuses a signed body that is not an event, with the platform 400", () => {
		const bodies = [
			"{",
			"",
			"{}",
			"[]",
			"null",
			'"text"',
			JSON.stringify({ ...event, event_id: "evt_short" }),
			JSON.stringify({ ...event, occurred_at: "yesterday" }),
			JSON.stringify({ ...event, data: [] }),
			JSON.stringify({ ...event, event_type: "" }),
			JSON.stringify({ ...event, event_type: "x".repeat(201) }),
			JSON.stringify({ ...event, event_type: "subscription.updated\u0000" }),
			JSON.stringify({ ...event, data: { deep: { list: ["fine", "bad\u0000"] } } }),
			JSON.stringify({ ...event, data: { "key\u0000": 1 } }),
		];
		for (const body of bodies) {
			expect(() => parsePaddleEvent(body), body.slice(0, 40)).toThrow(
				"Invalid Paddle webhook body",
			);
			try {
				parsePaddleEvent(body);
			} catch (error) {
				expect(error).toMatchObject({ code: "INVALID_REQUEST", status: 400 });
			}
		}
	});

	it("scans a large nested body without exhausting the stack", () => {
		let nested: unknown = "leaf";
		for (let depth = 0; depth < 400; depth += 1) nested = { next: nested };
		const wide = Array.from({ length: 150_000 }, () => 1);
		expect(parsePaddleEvent(JSON.stringify({ ...event, data: { nested, wide } })).event_id).toBe(
			event.event_id,
		);
	});
});
