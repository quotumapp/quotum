import { describe, expect, it } from "bun:test";
import {
	erasureDigest,
	erasureDigests,
	erasureFingerprint,
	erasureKeyFromBase64,
} from "../../src/shared/erasure-digest";

const keyA = erasureKeyFromBase64("a1", Buffer.alloc(32, 1).toString("base64"));
const keyB = erasureKeyFromBase64("b1", Buffer.alloc(32, 2).toString("base64"));

describe("erasure digests", () => {
	it("is deterministic and never contains the id", () => {
		const first = erasureDigest(keyA, "project-1", "user@example.com");
		expect(erasureDigest(keyA, "project-1", "user@example.com")).toBe(first);
		expect(first).not.toContain("example");
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("separates projects, ids and keys", () => {
		const base = erasureDigest(keyA, "project-1", "acct");
		expect(erasureDigest(keyA, "project-2", "acct")).not.toBe(base);
		expect(erasureDigest(keyA, "project-1", "acct2")).not.toBe(base);
		expect(erasureDigest(keyB, "project-1", "acct")).not.toBe(base);
	});

	it("keeps the project and id boundary unambiguous", () => {
		expect(erasureDigest(keyA, "ab", "c")).not.toBe(erasureDigest(keyA, "a", "bc"));
	});

	it("returns the current key first and the previous key second", () => {
		const digests = erasureDigests({ current: keyA, previous: keyB }, "project-1", "acct");
		expect(digests.map((entry) => entry.keyId)).toEqual(["a1", "b1"]);
		expect(digests[0]?.digest).toBe(erasureDigest(keyA, "project-1", "acct"));
		expect(erasureDigests({ current: keyA, previous: null }, "project-1", "acct")).toHaveLength(1);
	});

	it("fingerprints text under the key", () => {
		expect(erasureFingerprint(keyA, "x")).not.toBe(erasureFingerprint(keyB, "x"));
		expect(erasureFingerprint(keyA, "x")).toBe(erasureFingerprint(keyA, "x"));
	});

	it("rejects short keys and malformed key ids", () => {
		expect(() => erasureKeyFromBase64("k", Buffer.alloc(16).toString("base64"))).toThrow(
			"at least 32 bytes",
		);
		expect(() => erasureKeyFromBase64("", Buffer.alloc(32).toString("base64"))).toThrow(
			"erasure key id",
		);
		expect(() => erasureKeyFromBase64("has space", Buffer.alloc(32).toString("base64"))).toThrow(
			"erasure key id",
		);
		expect(() => erasureKeyFromBase64("x".repeat(65), Buffer.alloc(32).toString("base64"))).toThrow(
			"erasure key id",
		);
	});
});
