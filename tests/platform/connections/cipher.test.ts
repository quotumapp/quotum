import { describe, expect, it } from "bun:test";
import { ConnectionCipher, loadConnectionCipher } from "../../../src/platform/connections/cipher";

const scope = {
	instanceId: "tenant-a",
	connectionId: "stripe-a",
	versionId: "version-a",
	purpose: "secretKey",
};
const key = Buffer.alloc(32, 1);
const cipher = new ConnectionCipher("a", new Map([["a", key]]));
describe("connection encryption", () => {
	it("uses fresh authenticated ciphertext for each write", () => {
		const first = cipher.encrypt("rk_live_private", scope),
			second = cipher.encrypt("rk_live_private", scope);
		expect(first.nonce).not.toBe(second.nonce);
		expect(JSON.stringify(first)).not.toContain("rk_live_private");
		expect(cipher.decrypt(first, scope)).toBe("rk_live_private");
	});
	it("rejects ciphertext moved between tenants, connections, versions or fields", () => {
		const envelope = cipher.encrypt("private", scope);
		for (const field of Object.keys(scope))
			expect(() => cipher.decrypt(envelope, { ...scope, [field]: "different" })).toThrow(
				"Connection secret is unavailable",
			);
	});
	it("rejects corrupted data, authentication tags and missing keys", () => {
		const envelope = cipher.encrypt("private", scope);
		for (const field of ["ciphertext", "tag", "nonce", "keyId"] as const)
			expect(() => cipher.decrypt({ ...envelope, [field]: "invalid" }, scope)).toThrow(
				"Connection secret is unavailable",
			);
	});
	it("reads the previous key and writes only with the new active key", () => {
		const rotating = loadConnectionCipher({
			QUOTUM_SECRETS_KEY_ID: "b",
			QUOTUM_SECRETS_KEY_BASE64: Buffer.alloc(32, 2).toString("base64"),
			QUOTUM_SECRETS_PREVIOUS_KEY_ID: "a",
			QUOTUM_SECRETS_PREVIOUS_KEY_BASE64: key.toString("base64"),
		});
		const old = cipher.encrypt("private", scope);
		expect(rotating.decrypt(old, scope)).toBe("private");
		const current = rotating.encrypt(rotating.decrypt(old, scope), scope);
		expect(current.keyId).toBe("b");
		expect(() => cipher.decrypt(current, scope)).toThrow();
	});
	it("requires an external key and rejects incomplete or duplicated key configuration", () => {
		expect(() => loadConnectionCipher({})).toThrow();
		expect(() =>
			loadConnectionCipher({ QUOTUM_SECRETS_KEY_ID: "a", QUOTUM_SECRETS_KEY_BASE64: "short" }),
		).toThrow();
		expect(() =>
			loadConnectionCipher({
				QUOTUM_SECRETS_KEY_ID: "a",
				QUOTUM_SECRETS_KEY_BASE64: key.toString("base64"),
				QUOTUM_SECRETS_PREVIOUS_KEY_ID: "a",
				QUOTUM_SECRETS_PREVIOUS_KEY_BASE64: key.toString("base64"),
			}),
		).toThrow();
	});
});
