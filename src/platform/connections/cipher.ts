import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface SecretEnvelope {
	keyId: string;
	nonce: string;
	tag: string;
	ciphertext: string;
}
export interface SecretScope {
	instanceId: string;
	connectionId: string;
	versionId: string;
	purpose: string;
}

/** Keys belong to deployment secret storage, never the database or its backups. */
export class ConnectionCipher {
	constructor(
		readonly activeKeyId: string,
		private readonly keys: ReadonlyMap<string, Buffer>,
	) {
		if (!keys.has(activeKeyId) || [...keys.values()].some((key) => key.length !== 32))
			throw new Error("Connection encryption requires a 32-byte active key");
	}
	private aad(scope: SecretScope): Buffer {
		return Buffer.from(
			JSON.stringify([
				"quotum-connection-v1",
				scope.instanceId,
				scope.connectionId,
				scope.versionId,
				scope.purpose,
			]),
		);
	}
	encrypt(value: string, scope: SecretScope): SecretEnvelope {
		const key = this.keys.get(this.activeKeyId);
		if (!key) throw new Error("Connection encryption key unavailable");
		const nonce = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", key, nonce);
		cipher.setAAD(this.aad(scope));
		const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
		return {
			keyId: this.activeKeyId,
			nonce: nonce.toString("base64"),
			tag: cipher.getAuthTag().toString("base64"),
			ciphertext: ciphertext.toString("base64"),
		};
	}
	decrypt(envelope: SecretEnvelope, scope: SecretScope): string {
		try {
			const key = this.keys.get(envelope.keyId);
			if (
				!key ||
				Buffer.from(envelope.nonce, "base64").length !== 12 ||
				Buffer.from(envelope.tag, "base64").length !== 16
			)
				throw new Error("Invalid envelope");
			const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"));
			decipher.setAAD(this.aad(scope));
			decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
			return Buffer.concat([
				decipher.update(Buffer.from(envelope.ciphertext, "base64")),
				decipher.final(),
			]).toString("utf8");
		} catch {
			throw new Error("Connection secret is unavailable");
		}
	}
}

export function loadConnectionCipher(
	env: Record<string, string | undefined> = process.env,
): ConnectionCipher {
	const keys = new Map<string, Buffer>();
	for (const prefix of ["QUOTUM_SECRETS", "QUOTUM_SECRETS_PREVIOUS"]) {
		const id = env[`${prefix}_KEY_ID`];
		const value = env[`${prefix}_KEY_BASE64`];
		if (id === undefined && value === undefined && prefix.endsWith("PREVIOUS")) continue;
		if (
			!id ||
			!/^[a-zA-Z0-9_-]{1,64}$/.test(id) ||
			!value ||
			!/^[A-Za-z0-9+/]{43}=$/.test(value) ||
			keys.has(id)
		)
			throw new Error(`${prefix}_KEY_ID and a unique 32-byte ${prefix}_KEY_BASE64 are required`);
		keys.set(id, Buffer.from(value, "base64"));
	}
	return new ConnectionCipher(env.QUOTUM_SECRETS_KEY_ID ?? "", keys);
}
