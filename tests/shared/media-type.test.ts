import { describe, expect, it } from "bun:test";
import { hasMediaType } from "../../src/shared/media-type";

describe("hasMediaType", () => {
	it("matches the type and subtype exactly, whatever their case and parameters", () => {
		for (const value of [
			"application/json",
			"Application/JSON",
			"APPLICATION/json",
			"application/json; charset=utf-8",
			"application/json;charset=UTF-8",
			"  application/json  ;  charset=utf-8  ",
		]) {
			expect({ value, match: hasMediaType(value, "application/json") }).toEqual({
				value,
				match: true,
			});
		}
	});

	it("refuses a longer subtype, a structured suffix, another type and a missing header", () => {
		for (const value of [
			"application/jsonx",
			"application/json-seq",
			"application/jsonl",
			"application/vnd.api+json",
			"application/json, text/plain",
			"text/json",
			"xapplication/json",
			"application/",
			"application/json/extra",
			"",
			"text/plain",
		]) {
			expect({ value, match: hasMediaType(value, "application/json") }).toEqual({
				value,
				match: false,
			});
		}
		expect(hasMediaType(null, "application/json")).toBe(false);
	});

	it("compares the expected type case-insensitively too", () => {
		expect(
			hasMediaType(
				"application/x-www-form-urlencoded; charset=UTF-8",
				"application/x-www-form-urlencoded",
			),
		).toBe(true);
		expect(
			hasMediaType("application/x-www-form-urlencodedx", "application/x-www-form-urlencoded"),
		).toBe(false);
	});
});
