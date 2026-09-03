import { describe, expect, it } from "bun:test";
import { decodeUsageCursor, encodeUsageCursor } from "../../src/billing/insights";

describe("usage insight cursors", () => {
	it("round trips an opaque timestamp and UUID cursor", () => {
		const cursor = {
			recordedAt: "2026-08-28T12:00:00.000Z",
			id: "11111111-1111-4111-8111-111111111111",
		};
		expect(decodeUsageCursor(encodeUsageCursor(cursor))).toEqual(cursor);
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
});
