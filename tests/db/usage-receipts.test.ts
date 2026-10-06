import { describe, expect, it } from "bun:test";
import { parseReceiptId, receiptId } from "../../src/db/repository/usage-receipts";

describe("receipt event locators", () => {
	it("preserves database microseconds without JavaScript Date truncation", () => {
		const id = "1f524c44-64c8-4c18-bceb-234d84a51aca";
		const recordedAt = "2026-10-02 15:04:05.123456+00";
		expect(parseReceiptId(receiptId(id, recordedAt))).toEqual({ id, recordedAt });
	});
	it("rejects malformed and noncanonical locators before SQL", () => {
		for (const value of [
			"",
			"ur_bad",
			receiptId("not-a-uuid", "2026-10-02T00:00:00Z"),
			receiptId("1f524c44-64c8-4c18-bceb-234d84a51aca", "' OR true --"),
		])
			expect(() => parseReceiptId(value)).toThrow("Invalid receiptId");
	});
	it("rejects timestamps that name no instant before SQL casts them", () => {
		const id = "1f524c44-64c8-4c18-bceb-234d84a51aca";
		for (const recordedAt of [
			"2026-02-31T00:00:00Z",
			"2026-02-31 00:00:00.5+00",
			"2026-02-29T00:00:00Z",
			"2100-02-29T00:00:00Z",
			"2026-04-31T00:00:00Z",
			"2026-00-10T00:00:00Z",
			"2026-13-10T00:00:00Z",
			"2026-10-00T00:00:00Z",
			"0000-10-05T10:00:00Z",
			"2026-10-05T24:00:00Z",
			"2026-10-05T10:60:00Z",
			"2026-10-05T10:00:60Z",
			"2026-10-05T10:00:00+16:00",
			"2026-10-05T10:00:00+23:59",
			"2026-10-05T10:00:00-15:60",
		])
			expect(() => parseReceiptId(receiptId(id, recordedAt))).toThrow("Invalid receiptId");
	});
	it("accepts every timestamp form the database prints", () => {
		const id = "1f524c44-64c8-4c18-bceb-234d84a51aca";
		for (const recordedAt of [
			"2024-02-29T00:00:00Z",
			"2000-02-29 23:59:59.999999+00",
			"2026-12-31T23:59:59-05:30",
			"2026-10-05T10:00:00+15:59",
			"2026-10-05 10:00:00-0530",
			"0001-01-01T00:00:00Z",
			"9999-12-31T23:59:59Z",
		])
			expect(parseReceiptId(receiptId(id, recordedAt))).toEqual({ id, recordedAt });
	});
});
