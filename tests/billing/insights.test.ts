import { describe, expect, it } from "bun:test";
import {
	decodeInvoiceCursor,
	decodeUsageCursor,
	encodeInvoiceCursor,
	encodeUsageCursor,
} from "../../src/billing/insights";

describe("usage insight cursors", () => {
	it("round trips an opaque timestamp and UUID cursor", () => {
		const cursor = {
			recordedAt: "2026-08-28T12:00:00.000Z",
			id: "11111111-1111-4111-8111-111111111111",
		};
		expect(decodeUsageCursor(encodeUsageCursor(cursor))).toEqual(cursor);
	});

	it("rejects a timestamp a timestamptz column cannot hold", () => {
		for (const recordedAt of ["0000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z"]) {
			const cursor = Buffer.from(
				JSON.stringify({ recordedAt, id: "11111111-1111-4111-8111-111111111111" }),
			).toString("base64url");
			expect(decodeUsageCursor(cursor)).toBeNull();
		}
	});

	it("rejects malformed base64, timestamps, and UUID-shaped database hazards", () => {
		const valid = encodeUsageCursor({
			recordedAt: "2026-08-28T12:00:00.000Z",
			id: "11111111-1111-4111-8111-111111111111",
		});
		expect(decodeUsageCursor("not-json")).toBeNull();
		expect(decodeUsageCursor(`${valid}$`)).toBeNull();
		expect(decodeUsageCursor(`${valid}====`)).toBeNull();
		expect(decodeUsageCursor(`${valid}A`)).toBeNull();
		expect(
			decodeUsageCursor(
				Buffer.from(
					JSON.stringify({
						recordedAt: "not-a-date",
						id: "11111111-1111-4111-8111-111111111111",
					}),
				).toString("base64url"),
			),
		).toBeNull();
		expect(
			decodeUsageCursor(
				Buffer.from(
					JSON.stringify({
						recordedAt: "2026-08-28T12:00:00.000Z",
						id: "111111111111111111111111111111111---",
					}),
				).toString("base64url"),
			),
		).toBeNull();
		expect(
			decodeUsageCursor(
				Buffer.from(
					JSON.stringify({
						recordedAt: "2026-02-31T12:00:00.000Z",
						id: "11111111-1111-4111-8111-111111111111",
					}),
				).toString("base64url"),
			),
		).toBeNull();
	});

	it("round trips a cursor with the exact microsecond", () => {
		const cursor = {
			recordedAt: "2026-08-28T12:00:00.123456Z",
			id: "11111111-1111-4111-8111-111111111111",
		};
		expect(decodeUsageCursor(encodeUsageCursor(cursor))).toEqual(cursor);
	});

	it("rejects a microsecond timestamp that is not a real instant or not canonical", () => {
		for (const recordedAt of [
			"2026-02-31T12:00:00.123456Z",
			"0000-01-01T00:00:00.123456Z",
			"2026-08-28T12:00:00.12345Z",
			"2026-08-28T12:00:00.1234567Z",
			"2026-08-28T12:00:00.123456+00:00",
			"2026-08-28 12:00:00.123456Z",
		]) {
			const cursor = Buffer.from(
				JSON.stringify({ recordedAt, id: "11111111-1111-4111-8111-111111111111" }),
			).toString("base64url");
			expect(decodeUsageCursor(cursor)).toBeNull();
		}
	});
});

describe("invoice cursors", () => {
	const cursor = {
		createdAt: "2026-09-01T10:20:30.123456Z",
		id: "0198f2a4-6b1c-7a3e-8d5f-123456789abc",
	};

	it("round trips a microsecond instant and a UUID", () => {
		expect(decodeInvoiceCursor(encodeInvoiceCursor(cursor))).toEqual(cursor);
	});

	it("does not accept a usage cursor, nor the other way round", () => {
		const usage = encodeUsageCursor({ recordedAt: "2026-09-01T10:20:30.123Z", id: cursor.id });
		expect(decodeInvoiceCursor(usage)).toBeNull();
		expect(decodeUsageCursor(encodeInvoiceCursor(cursor))).toBeNull();
	});

	it("rejects malformed base64, instants and identifiers", () => {
		const valid = encodeInvoiceCursor(cursor);
		const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
		expect(decodeInvoiceCursor("not-json")).toBeNull();
		expect(decodeInvoiceCursor(`${valid}$`)).toBeNull();
		expect(decodeInvoiceCursor(`${valid}A`)).toBeNull();
		expect(decodeInvoiceCursor(encode({ ...cursor, createdAt: "not-a-date" }))).toBeNull();
		expect(
			decodeInvoiceCursor(encode({ ...cursor, createdAt: "2026-02-31T00:00:00.000Z" })),
		).toBeNull();
		expect(decodeInvoiceCursor(encode({ ...cursor, id: "in_123" }))).toBeNull();
		expect(decodeInvoiceCursor(encode({ createdAt: cursor.createdAt }))).toBeNull();
	});
});
