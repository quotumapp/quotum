import { expect, it } from "bun:test";
import { isPublicAddress, publicHttpsPost } from "../../../src/shared/safe-http";

it("denies private, metadata, mapped, reserved and non-global addresses", () => {
	for (const address of [
		"127.0.0.1",
		"10.0.0.1",
		"172.31.255.255",
		"192.168.0.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"::1",
		"::ffff:127.0.0.1",
		"64:ff9b::a00:1",
		"fc00::1",
		"fe80::1",
		"2001:db8::1",
		"2002:a00:1::1",
		"4000::1",
		"example.com",
	])
		expect(isPublicAddress(address)).toBe(false);
	for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
		expect(isPublicAddress(address)).toBe(true);
});
it("rejects insecure URLs and loopback without sending credentials", async () => {
	for (const url of [
		"http://example.com",
		"https://user:password@example.com",
		"https://127.0.0.1",
		"https://[::1]",
	])
		await expect(publicHttpsPost(url, "private", {})).rejects.toThrow();
});
