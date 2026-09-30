import { describe, expect, it } from "bun:test";
import {
	bigintIdSchema,
	displayNameSchema,
	isBigintId,
	isDisplayName,
	isStorableInstant,
	isStorableText,
	maxBigintId,
	storableDateTimeSchema,
	toDisplayName,
} from "../../src/shared/input-bounds";

describe("input bounds", () => {
	it("accepts ids within the bigint range only", () => {
		expect(isBigintId(maxBigintId.toString())).toBe(true);
		expect(isBigintId("1")).toBe(true);
		for (const value of ["9223372036854775808", "99999999999999999999", "", "1a", "-1"]) {
			expect(isBigintId(value)).toBe(false);
		}
		expect(bigintIdSchema().safeParse("9223372036854775807").success).toBe(true);
		expect(bigintIdSchema().safeParse("9223372036854775808").success).toBe(false);
	});

	it("refuses text Postgres cannot store", () => {
		expect(isStorableText("plain text, ünïcode and 🙂")).toBe(true);
		for (const value of ["a\u0000b", "\ud800", "x\udc00y"]) {
			expect(isStorableText(value)).toBe(false);
		}
	});

	it("accepts timestamps a timestamptz column round-trips", () => {
		expect(isStorableInstant(new Date("0001-01-01T00:00:00Z"))).toBe(true);
		expect(isStorableInstant(new Date("9999-12-31T23:59:59Z"))).toBe(true);
		expect(isStorableInstant(new Date("0000-12-31T23:59:59Z"))).toBe(false);
		expect(isStorableInstant(new Date(Number.NaN))).toBe(false);
		expect(storableDateTimeSchema().safeParse("2026-09-30T12:00:00+03:00").success).toBe(true);
		expect(storableDateTimeSchema().safeParse("0000-01-01T00:00:00Z").success).toBe(false);
	});

	it("accepts display names without control or text-direction characters", () => {
		for (const value of ["Acme Company", "Ünïcode & Co. 🙂", "شركة أكمي", "O'Brien-Smith (UK)"]) {
			expect(isDisplayName(value)).toBe(true);
		}
		for (const value of [
			"a\u0000b",
			"Acme\r\nBcc: victim@example.com",
			"tab\there",
			"del\u007f",
			"c1\u0085",
			"line\u2028separator",
			"paragraph\u2029separator",
			"invoice\u202egnp.exe",
			"isolate\u2066x\u2069",
			"\ud800",
		]) {
			expect(isDisplayName(value)).toBe(false);
		}
	});

	it("trims and bounds display names", () => {
		const schema = displayNameSchema(2, 100);
		expect(schema.parse("  Acme Company  ")).toBe("Acme Company");
		expect(schema.safeParse("A").success).toBe(false);
		expect(schema.safeParse("a".repeat(100)).success).toBe(true);
		expect(schema.safeParse("a".repeat(101)).success).toBe(false);
		expect(schema.safeParse("Acme\nCompany").success).toBe(false);
		expect(schema.safeParse("Acme\u202eCompany").success).toBe(false);
	});

	it("turns a provider-supplied name into a display name", () => {
		expect(toDisplayName("  Jane\r\nDoe\u202e  ", 100)).toBe("Jane Doe");
		expect(toDisplayName("a\u0000b\ud800", 100)).toBe("a b\ufffd");
		expect(toDisplayName("\u0000\u202e", 100)).toBe("");
		// Truncation never splits a surrogate pair.
		expect(toDisplayName(`${"a".repeat(99)}🙂`, 100)).toBe("a".repeat(99));
		expect(toDisplayName("a".repeat(150), 100)).toHaveLength(100);
	});
});
