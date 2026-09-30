import { describe, expect, it } from "bun:test";
import {
	bigintIdSchema,
	isBigintId,
	isStorableInstant,
	isStorableText,
	maxBigintId,
	storableDateTimeSchema,
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
});
