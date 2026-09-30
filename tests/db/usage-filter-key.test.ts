import { describe, expect, it } from "bun:test";
import { canonicalFilterKey } from "../../src/db/repository/metering-persistence";

describe("canonicalFilterKey", () => {
	it("has no key without filter values", () => {
		expect(canonicalFilterKey(undefined)).toBeNull();
		expect(canonicalFilterKey({})).toBeNull();
	});

	it("compares filter values as text, in any key order", () => {
		const key = canonicalFilterKey({ region: "us", model: "1", streaming: "true" });

		expect(canonicalFilterKey({ model: 1, streaming: true, region: "us" })).toBe(key);
		expect(canonicalFilterKey({ region: "us", model: "1.5", streaming: "true" })).not.toBe(key);
	});

	it("keeps the key of text values unchanged", () => {
		// sha256 of the stable JSON `{"model":"opus","region":"us"}`, the key windows already carry.
		expect(canonicalFilterKey({ region: "us", model: "opus" })).toBe(
			new Bun.CryptoHasher("sha256").update('{"model":"opus","region":"us"}').digest("hex"),
		);
	});
});
