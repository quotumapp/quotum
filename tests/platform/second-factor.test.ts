import { describe, expect, it } from "bun:test";
import {
	codeKind,
	generateRecoveryCodes,
	matchTotpStep,
	RECOVERY_CODE_COUNT,
} from "../../src/platform/second-factor";

// RFC 6238 appendix B: SHA-1, secret "12345678901234567890". A 6-digit code is the last six digits
// of the published 8-digit value, because both truncate the same 31-bit integer.
const rfcSecret = "12345678901234567890";
const vectors: readonly [number, string][] = [
	[59, "287082"],
	[1111111109, "081804"],
	[1111111111, "050471"],
	[1234567890, "005924"],
	[2000000000, "279037"],
	[20000000000, "353130"],
];

describe("TOTP step matching", () => {
	for (const [seconds, code] of vectors)
		it(`accepts the RFC 6238 vector at ${seconds} s and names its step`, async () => {
			expect(await matchTotpStep(rfcSecret, code, new Date(seconds * 1000))).toBe(
				Math.floor(seconds / 30),
			);
		});

	it("accepts a code one step either side of now and nothing further", async () => {
		// The 59 s vector belongs to step 1; it is checked at the step before, at, and after it.
		const code = "287082";
		expect(await matchTotpStep(rfcSecret, code, new Date(1_000))).toBe(1); // now is step 0
		expect(await matchTotpStep(rfcSecret, code, new Date(59_000))).toBe(1); // now is step 1
		expect(await matchTotpStep(rfcSecret, code, new Date(89_000))).toBe(1); // now is step 2
		expect(await matchTotpStep(rfcSecret, code, new Date(90_000))).toBeNull(); // now is step 3
	});

	it("does not accept a code for another secret", async () => {
		expect(await matchTotpStep("another secret entirely", "287082", new Date(59_000))).toBeNull();
	});

	it("refuses anything that is not six digits without computing a code", async () => {
		for (const code of ["", "12345", "1234567", "12345a", " 287082", "287082 ", "２８７０８２"])
			expect(await matchTotpStep(rfcSecret, code, new Date(59_000))).toBeNull();
	});
});

describe("code shapes", () => {
	it("tells an authenticator code from a recovery code and rejects the rest", () => {
		expect(codeKind("287082")).toBe("totp");
		expect(codeKind("aB3dE-9fGh1")).toBe("recovery_code");
		for (const input of ["", "28708", "2870820", "abcde12345", "abcde-1234", "abcde_12345"])
			expect(codeKind(input)).toBeNull();
	});
});

describe("recovery codes", () => {
	it("issues a full set of distinct codes in the form people can type", () => {
		const codes = generateRecoveryCodes();
		expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
		expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
		for (const code of codes) expect(codeKind(code)).toBe("recovery_code");
	});
});
