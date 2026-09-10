import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
	canonicalDecimal,
	databaseDecimal,
	decimalToUnits,
	positiveDecimal,
	sha256Hex,
	signedDecimalToUnits,
	stableJson,
	unitsToDecimal,
} from "../../src/billing/decimal";
import { InvalidRequestError } from "../../src/billing/errors";

const renderedDecimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;

describe("canonicalDecimal", () => {
	it("trims trailing zeros and surrounding whitespace", () => {
		expect(canonicalDecimal("1.500", "amount")).toBe("1.5");
		expect(canonicalDecimal("0.000", "amount")).toBe("0");
		expect(canonicalDecimal(" 7 ", "amount")).toBe("7");
		expect(canonicalDecimal("1.0", "amount")).toBe("1");
		expect(canonicalDecimal("0", "amount")).toBe("0");
		expect(canonicalDecimal("1.123456789", "amount")).toBe("1.123456789");
	});

	it("rejects non-canonical decimal strings", () => {
		for (const value of [
			"1e3",
			"+1",
			"-0",
			".5",
			"5.",
			"01",
			"",
			"00.5",
			"1,5",
			"Infinity",
			"NaN",
		]) {
			expect(() => canonicalDecimal(value, "amount")).toThrow(
				new InvalidRequestError("amount must be a non-negative decimal string"),
			);
		}
	});

	it("rejects values that exceed the scale", () => {
		expect(() => canonicalDecimal("1.0000000001", "amount")).toThrow(
			new InvalidRequestError("amount supports at most 9 decimal places"),
		);
		expect(() => canonicalDecimal("1.12", "amount", 1)).toThrow(
			new InvalidRequestError("amount supports at most 1 decimal places"),
		);
	});
});

describe("positiveDecimal", () => {
	it("rejects zero before returning a canonical positive value", () => {
		expect(() => positiveDecimal("0", "amount", 2)).toThrow(
			new InvalidRequestError("amount must be greater than zero"),
		);
		expect(() => positiveDecimal("0.0", "amount", 2)).toThrow(
			new InvalidRequestError("amount must be greater than zero"),
		);
		expect(() => positiveDecimal("0.001", "amount", 2)).toThrow(
			new InvalidRequestError("amount supports at most 2 decimal places"),
		);
		expect(positiveDecimal("0.01", "amount", 2)).toBe("0.01");
		expect(positiveDecimal("1", "amount", 2)).toBe("1");
	});
});

describe("decimalToUnits", () => {
	it("scales canonical decimals into integer units", () => {
		expect(decimalToUnits("1.5", 2)).toBe(150n);
		expect(decimalToUnits("0.05", 2)).toBe(5n);
		expect(decimalToUnits("7", 0)).toBe(7n);
		expect(decimalToUnits("7.0", 0)).toBe(7n);
	});

	it("rejects values that exceed the requested scale or are signed", () => {
		expect(() => decimalToUnits("1.005", 2)).toThrow(
			new InvalidRequestError("decimal supports at most 2 decimal places"),
		);
		expect(() => decimalToUnits("7.5", 0)).toThrow(
			new InvalidRequestError("decimal supports at most 0 decimal places"),
		);
		expect(() => decimalToUnits("-1", 2)).toThrow(
			new InvalidRequestError("decimal must be a non-negative decimal string"),
		);
	});
});

describe("unitsToDecimal", () => {
	it("renders integer units without trailing zeros", () => {
		expect(unitsToDecimal(-5n, 2)).toBe("-0.05");
		expect(unitsToDecimal(150n, 2)).toBe("1.5");
		expect(unitsToDecimal(0n, 3)).toBe("0");
		expect(unitsToDecimal(5n, 0)).toBe("5");
		expect(unitsToDecimal(-5n, 0)).toBe("-5");
		expect(unitsToDecimal(100n, 2)).toBe("1");
		expect(unitsToDecimal(1n, 9)).toBe("0.000000001");
		expect(unitsToDecimal(-1n, 9)).toBe("-0.000000001");
		expect(unitsToDecimal(123456n, 3)).toBe("123.456");
	});
});

describe("signedDecimalToUnits", () => {
	it("accepts a leading minus and canonical zero", () => {
		expect(signedDecimalToUnits("-1.5", 2)).toBe(-150n);
		expect(signedDecimalToUnits("1.5", 2)).toBe(150n);
		expect(signedDecimalToUnits("-0", 2)).toBe(0n);
		expect(signedDecimalToUnits("-0.0", 2)).toBe(0n);
	});

	it("rejects extra signs", () => {
		expect(() => signedDecimalToUnits("--1", 2)).toThrow(
			new InvalidRequestError("decimal must be a non-negative decimal string"),
		);
		expect(() => signedDecimalToUnits("-", 2)).toThrow(
			new InvalidRequestError("decimal must be a non-negative decimal string"),
		);
		expect(() => signedDecimalToUnits("+1", 2)).toThrow(
			new InvalidRequestError("decimal must be a non-negative decimal string"),
		);
	});
});

describe("databaseDecimal", () => {
	it("rejects values that are not safe non-negative integers or canonical strings", () => {
		for (const value of [1.5, 2 ** 53, -1, null, undefined, 5n, true]) {
			expect(() => databaseDecimal(value, "price")).toThrow("Invalid database decimal for price");
		}
		expect(() => databaseDecimal("abc", "price")).toThrow(
			new InvalidRequestError("price must be a non-negative decimal string"),
		);
		expect(databaseDecimal(2 ** 53 - 1, "price")).toBe("9007199254740991");
		expect(databaseDecimal("1.50", "price")).toBe("1.5");
		expect(databaseDecimal(5, "price")).toBe("5");
		expect(databaseDecimal(0, "price")).toBe("0");
	});
});

describe("sha256Hex", () => {
	it("hashes empty and abc inputs", () => {
		expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});
});

describe("stableJson", () => {
	it("sorts object keys with localeCompare", () => {
		expect(stableJson({ b: 1, a: [{ d: 1, c: 2 }], Z: null, _u: "x" })).toBe(
			'{"_u":"x","a":[{"c":2,"d":1}],"b":1,"Z":null}',
		);
	});

	// Known divergences from canonicalJson: undefined is emitted, Date becomes {},
	// and key order uses localeCompare. Persisted intent_hash depends on this helper.
	it("characterizes undefined, Date, and BigInt behaviour as known divergences from canonicalJson", () => {
		expect(stableJson({ a: undefined, b: 1 })).toBe('{"a":undefined,"b":1}');
		expect(stableJson([undefined, 1])).toBe("[,1]");
		expect(stableJson(new Date(0))).toBe("{}");
		expect(typeof stableJson(undefined)).toBe("undefined");
		expect(() => stableJson(1n)).toThrow(TypeError);
	});
});

describe("decimal properties", () => {
	it("round-trips signed units through decimal rendering", () => {
		fc.assert(
			fc.property(
				fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }),
				fc.integer({ min: 0, max: 9 }),
				(units, scale) => {
					expect(signedDecimalToUnits(unitsToDecimal(units, scale), scale)).toBe(units);
				},
			),
		);
	});

	it("renders canonical decimals without leading or trailing zeros", () => {
		fc.assert(
			fc.property(
				fc.bigInt({ min: 0n, max: 10n ** 18n }),
				fc.integer({ min: 0, max: 9 }),
				(units, scale) => {
					const rendered = unitsToDecimal(units, scale);
					expect(canonicalDecimal(rendered, "x", scale)).toBe(rendered);
					expect(decimalToUnits(rendered, scale)).toBe(units);
					expect(rendered).toMatch(renderedDecimalPattern);
				},
			),
		);
	});
});
