import { createHash, randomBytes } from "node:crypto";

const credentialPattern =
	/^qpk_v1\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;

export interface GeneratedProjectApiCredential {
	credentialId: string;
	token: string;
	secretVerifier: Uint8Array;
}

export interface ParsedProjectApiCredential {
	credentialId: string;
	secretVerifier: Uint8Array;
}

export function generateProjectApiCredential(): GeneratedProjectApiCredential {
	const credentialId = crypto.randomUUID();
	const secret = randomBytes(32).toString("base64url");
	const token = `qpk_v1.${credentialId}.${secret}`;
	return { credentialId, token, secretVerifier: hashProjectApiCredential(token) };
}

export function parseProjectApiCredential(token: string): ParsedProjectApiCredential | null {
	const match = credentialPattern.exec(token);
	if (match === null) return null;
	return {
		credentialId: match[1],
		secretVerifier: hashProjectApiCredential(token),
	};
}

export function hashProjectApiCredential(token: string): Uint8Array {
	return createHash("sha256").update(token, "utf8").digest();
}
