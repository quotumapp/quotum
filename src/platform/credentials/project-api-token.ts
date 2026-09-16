import { createHash, randomBytes } from "node:crypto";

export type ProjectApiCredentialEnvironment = "sandbox" | "production";

const prefixes: Readonly<Record<ProjectApiCredentialEnvironment, string>> = {
	sandbox: "sqpk_",
	production: "pqpk_",
};
const credentialPattern = /^([sp])qpk_[A-Za-z0-9_-]{43}$/u;

export interface GeneratedProjectApiCredential {
	/** Internal row identity. It is not part of the token and cannot be derived from it. */
	credentialId: string;
	environment: ProjectApiCredentialEnvironment;
	token: string;
	secretVerifier: Uint8Array;
}

export interface ParsedProjectApiCredential {
	environment: ProjectApiCredentialEnvironment;
	secretVerifier: Uint8Array;
}

export function generateProjectApiCredential(
	environment: ProjectApiCredentialEnvironment,
): GeneratedProjectApiCredential {
	if (environment !== "sandbox" && environment !== "production") {
		throw new Error("Project API credentials are issued only for sandbox or production instances");
	}
	const secret = randomBytes(32).toString("base64url");
	const token = `${prefixes[environment]}${secret}`;
	return {
		credentialId: crypto.randomUUID(),
		environment,
		token,
		secretVerifier: hashProjectApiCredential(token),
	};
}

export function parseProjectApiCredential(token: string): ParsedProjectApiCredential | null {
	const match = credentialPattern.exec(token);
	if (match === null) return null;
	return {
		environment: match[1] === "s" ? "sandbox" : "production",
		secretVerifier: hashProjectApiCredential(token),
	};
}

export function hashProjectApiCredential(token: string): Uint8Array {
	return createHash("sha256").update(token, "utf8").digest();
}
