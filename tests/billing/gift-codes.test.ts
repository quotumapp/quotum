import { describe, expect, it } from "bun:test";
import {
	GIFT_CODE_ALPHABET,
	GIFT_CODE_SYMBOLS,
	generateGiftCode,
	type RandomBytes,
} from "../../src/billing/gift-codes";
import { normalizePromotionCode, PROMOTION_CODE_PATTERN } from "../../src/billing/promotions";

/** Serves the given byte runs in order, one run per draw. */
function scripted(...runs: number[][]): RandomBytes {
	const remaining = [...runs];
	return (length) => {
		const run = remaining.shift();
		if (run === undefined) throw new Error("The script ran out of draws");
		expect(run).toHaveLength(length);
		return Uint8Array.from(run);
	};
}

describe("gift codes", () => {
	it("uses 31 symbols with none of the look-alikes", () => {
		expect(GIFT_CODE_ALPHABET).toHaveLength(31);
		expect(new Set(GIFT_CODE_ALPHABET).size).toBe(31);
		for (const lookAlike of ["0", "1", "I", "L", "O"]) {
			expect(GIFT_CODE_ALPHABET).not.toContain(lookAlike);
		}
		expect(GIFT_CODE_ALPHABET).toBe(GIFT_CODE_ALPHABET.toUpperCase());
	});

	it("carries at least 80 bits", () => {
		expect(GIFT_CODE_SYMBOLS * Math.log2(GIFT_CODE_ALPHABET.length)).toBeGreaterThan(80);
	});

	it("is five hyphenated groups of four that redeem like any promotion code", () => {
		const code = generateGiftCode();

		expect(code).toMatch(/^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){4}$/);
		expect(code).toHaveLength(24);
		expect(PROMOTION_CODE_PATTERN.test(code)).toBe(true);
		expect(normalizePromotionCode(code)).toBe(code);
	});

	it("does not repeat", () => {
		const codes = new Set(Array.from({ length: 2_000 }, () => generateGiftCode()));

		expect(codes.size).toBe(2_000);
	});

	it("maps bytes to symbols and discards bytes that would bias the draw", () => {
		// 248 is the largest multiple of 31 that fits a byte, so 248..255 are refused and 247 is the
		// last byte accepted. The first draw is refused whole, the second loses two bytes (248, 249)
		// and the third supplies the two symbols still missing.
		const second = [
			247, 248, 0, 1, 30, 31, 32, 249, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73,
		];
		const code = generateGiftCode(
			scripted(
				Array.from({ length: 20 }, () => 255),
				second,
				[0, 0],
			),
		);

		const accepted = [...second.filter((byte) => byte < 248), 0, 0];
		const symbols = accepted.map((byte) => GIFT_CODE_ALPHABET.charAt(byte % 31)).join("");
		expect(code).toBe((symbols.match(/.{4}/g) ?? []).join("-"));
		expect(code.startsWith("Z23Z-23")).toBe(true);
	});

	it("refuses a random source that returns the wrong number of bytes", () => {
		expect(() => generateGiftCode(() => new Uint8Array(3))).toThrow("unexpected number of bytes");
	});
});
