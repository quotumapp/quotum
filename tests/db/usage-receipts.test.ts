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
});
