/**
 * Keyed digests that let an erasure tombstone recognise a billing account id without keeping it.
 *
 * The digest is HMAC-SHA256 over the project instance and the id, so an equal id in another
 * project does not match and a database reader cannot re-derive the digest from a guessed id
 * without the key. The key lives in the process environment, never in the database, and every
 * tombstone records the id of the key that wrote it so a rotated key keeps matching until the
 * tombstone expires.
 */

export interface ErasureKey {
	/** Opaque label stored beside each digest; never secret. */
	id: string;
	key: Uint8Array;
}

export interface ErasureKeyring {
	current: ErasureKey;
	/** Kept configured for at least one tombstone window after a rotation. */
	previous: ErasureKey | null;
}

export interface ErasureDigest {
	keyId: string;
	digest: string;
}

export const erasureKeyIdMaxLength = 64;
export const erasureKeyMinBytes = 32;

const keyIdPattern = /^[A-Za-z0-9._-]+$/;

export function erasureKeyFromBase64(id: string, base64: string): ErasureKey {
	if (id.length === 0 || id.length > erasureKeyIdMaxLength || !keyIdPattern.test(id)) {
		throw new Error(
			`erasure key id must be 1-${erasureKeyIdMaxLength} characters of letters, digits, '.', '_' or '-'`,
		);
	}
	const key = new Uint8Array(Buffer.from(base64, "base64"));
	if (key.length < erasureKeyMinBytes) {
		throw new Error(`erasure key ${id} must decode to at least ${erasureKeyMinBytes} bytes`);
	}
	return { id, key };
}

/** The digest of one id under one key. The NUL separator keeps `a`+`bc` apart from `ab`+`c`. */
export function erasureDigest(
	key: ErasureKey,
	projectId: string,
	billingAccountId: string,
): string {
	return new Bun.CryptoHasher("sha256", key.key)
		.update(`${projectId}\0${billingAccountId}`)
		.digest("base64url");
}

/** One digest per configured key, the current key first. */
export function erasureDigests(
	keyring: ErasureKeyring,
	projectId: string,
	billingAccountId: string,
): ErasureDigest[] {
	const keys = keyring.previous === null ? [keyring.current] : [keyring.current, keyring.previous];
	return keys.map((key) => ({
		keyId: key.id,
		digest: erasureDigest(key, projectId, billingAccountId),
	}));
}

/** A keyed digest of any text, for request fingerprints that would otherwise hash the id. */
export function erasureFingerprint(key: ErasureKey, text: string): string {
	return new Bun.CryptoHasher("sha256", key.key).update(text).digest("base64url");
}
