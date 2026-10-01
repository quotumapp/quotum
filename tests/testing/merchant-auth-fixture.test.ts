import { expect, test } from "bun:test";
import type { MerchantEmail } from "../../src/platform/email";
import {
	MerchantOtpFixture,
	type OtpVerificationRow,
} from "../../src/testing/merchant-auth-fixture";

function fixture() {
	const messages: Pick<MerchantEmail, "to" | "kind">[] = [];
	const rows: OtpVerificationRow[] = [];
	const expired: string[] = [];
	const state = new MerchantOtpFixture({
		messages: () => messages,
		async readRows() {
			return structuredClone(rows);
		},
		async expireRow(id) {
			expired.push(id);
			return rows.some((row) => row.id === id);
		},
	});
	const row = (id: string): OtpVerificationRow => ({
		id,
		value: "synthetic-stored-hash",
		updatedAt: "2026-10-01T00:00:00Z",
		expiresAt: "2026-10-01T00:10:00Z",
	});
	return { state, messages, rows, expired, row };
}

test("OTP expiry tracks the captured recipient and preserves unrelated verification rows", async () => {
	const f = fixture();
	f.rows.push(f.row("unrelated"));
	await f.state.track(async () => {
		f.messages.push({ kind: "otp", to: "owner@example.com" });
		f.rows.push(f.row("challenge"));
		return new Response(null, { status: 200 });
	});
	expect(await f.state.expire("other@example.com")).toBe(false);
	expect(await f.state.expire("owner@example.com")).toBe(true);
	expect(f.expired).toEqual(["challenge"]);
});

test("OTP resend detects an updated existing row without requiring a new identifier", async () => {
	const f = fixture();
	f.rows.push(f.row("existing"));
	await f.state.track(async () => {
		f.messages.push({ kind: "otp", to: "owner@example.com" });
		f.rows[0].updatedAt = "2026-10-01T00:01:00Z";
		return new Response(null, { status: 200 });
	});
	expect(await f.state.expire("owner@example.com")).toBe(true);
	expect(f.expired).toEqual(["existing"]);
});

test("rejected requests cannot register a challenge even if email capture changed", async () => {
	const f = fixture();
	const response = await f.state.track(async () => {
		f.messages.push({ kind: "otp", to: "owner@example.com" });
		f.rows.push(f.row("rejected"));
		return new Response(null, { status: 429 });
	});
	expect(response.status).toBe(429);
	expect(await f.state.expire("owner@example.com")).toBe(false);
	expect(f.expired).toEqual([]);
});

test.each(["multiple rows", "multiple messages"])(
	"ambiguous OTP observation fails closed: %s",
	async (kind) => {
		const f = fixture();
		await expect(
			f.state.track(async () => {
				f.messages.push({ kind: "otp", to: "owner@example.com" });
				f.rows.push(f.row("one"));
				if (kind === "multiple rows") f.rows.push(f.row("two"));
				else f.messages.push({ kind: "otp", to: "other@example.com" });
				return new Response(null, { status: 200 });
			}),
		).rejects.toThrow("OTP fixture requires exactly one message and changed verification row");
		expect(await f.state.expire("owner@example.com")).toBe(false);
		expect(f.expired).toEqual([]);
	},
);

test("ambiguous resend invalidates a previously observed challenge", async () => {
	const f = fixture();
	await f.state.track(async () => {
		f.messages.push({ kind: "otp", to: "owner@example.com" });
		f.rows.push(f.row("challenge"));
		return new Response(null, { status: 200 });
	});
	await expect(
		f.state.track(async () => {
			f.messages.push({ kind: "otp", to: "owner@example.com" });
			f.rows[0].updatedAt = "2026-10-01T00:01:00Z";
			f.rows.push(f.row("other"));
			return new Response(null, { status: 200 });
		}),
	).rejects.toThrow("OTP fixture requires exactly one message and changed verification row");
	expect(await f.state.expire("owner@example.com")).toBe(false);
	expect(f.expired).toEqual([]);
});

test("fixture reset removes previous challenge mappings", async () => {
	const f = fixture();
	await f.state.track(async () => {
		f.messages.push({ kind: "otp", to: "owner@example.com" });
		f.rows.push(f.row("challenge"));
		return new Response(null, { status: 200 });
	});
	f.state.reset();
	expect(await f.state.expire("owner@example.com")).toBe(false);
	expect(f.expired).toEqual([]);
});
