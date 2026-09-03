export function createGoogleObfuscatedAccountId(billingAccountId: string, secret: string): string {
	const normalized = billingAccountId.trim();
	if (!normalized) {
		throw new Error("billingAccountId is required");
	}

	const digest = new Bun.CryptoHasher("sha256", secret).update(normalized).digest("base64url");
	return `gpa_${digest.slice(0, 52)}`;
}
