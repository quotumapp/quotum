import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { canonicalJson } from "../../src/shared/canonical-json";

describe("canonicalJson", () => {
	it("is invariant to object key insertion order", () => {
		expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
		expect(canonicalJson({ outer: { b: 1, a: 2 } })).toBe(canonicalJson({ outer: { a: 2, b: 1 } }));
	});

	it("preserves array order and encodes dates as ISO strings", () => {
		expect(canonicalJson([2, 1])).toBe("[2,1]");
		expect(canonicalJson(new Date(0))).toBe('"1970-01-01T00:00:00.000Z"');
	});

	it("drops undefined properties, encodes undefined as null, and sorts by code unit", () => {
		expect(canonicalJson(undefined)).toBe("null");
		expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
		expect(canonicalJson([undefined, 1])).toBe("[null,1]");
		expect(canonicalJson({ Z: null, _u: 1, b: 1 })).toBe('{"Z":null,"_u":1,"b":1}');
	});

	it("does not change JSON-equivalent dictionaries when keys are reversed", () => {
		fc.assert(
			fc.property(fc.dictionary(fc.string(), fc.jsonValue()), (value) => {
				const reversed = Object.fromEntries(Object.entries(value).reverse());
				expect(canonicalJson(reversed)).toBe(canonicalJson(value));
				expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
			}),
		);
	});
});
