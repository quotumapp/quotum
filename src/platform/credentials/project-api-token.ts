import { createHash, randomBytes } from "node:crypto";
import type { CredentialAccess } from "../../shared/credential-access";

export type ProjectApiCredentialEnvironment = "sandbox" | "production";

// The third letter names the kind: `p` for a full project key, `r` for a read-only one.
const prefixes: Readonly<
	Record<ProjectApiCredentialEnvironment, Readonly<Record<CredentialAccess, string>>>
> = {
	sandbox: { full: "sqpk_", read_only: "sqrk_" },
	production: { full: "pqpk_", read_only: "pqrk_" },
};
const credentialPattern = /^([sp])q([pr])k_[A-Za-z0-9_-]{43}$/u;

export interface GeneratedProjectApiCredential {
	/** Internal row identity. It is not part of the token and cannot be derived from it. */
	credentialId: string;
	environment: ProjectApiCredentialEnvironment;
	access: CredentialAccess;
	token: string;
	secretVerifier: Uint8Array;
}

export interface ParsedProjectApiCredential {
	environment: ProjectApiCredentialEnvironment;
	/** What the prefix claims. The stored credential is authoritative and must agree. */
	access: CredentialAccess;
	secretVerifier: Uint8Array;
}

/** `access` is required so that no caller mints a full key by leaving it out. */
export function generateProjectApiCredential(
	environment: ProjectApiCredentialEnvironment,
	access: CredentialAccess,
): GeneratedProjectApiCredential {
	if (environment !== "sandbox" && environment !== "production") {
		throw new Error("Project API credentials are issued only for sandbox or production instances");
	}
	if (access !== "full" && access !== "read_only") {
		throw new Error("Project API credentials are either full or read_only");
	}
	const secret = randomBytes(32).toString("base64url");
	const token = `${prefixes[environment][access]}${secret}`;
	return {
		credentialId: crypto.randomUUID(),
		environment,
		access,
		token,
		secretVerifier: hashProjectApiCredential(token),
	};
}

export function parseProjectApiCredential(token: string): ParsedProjectApiCredential | null {
	const match = credentialPattern.exec(token);
	if (match === null) return null;
	return {
		environment: match[1] === "s" ? "sandbox" : "production",
		access: match[2] === "p" ? "full" : "read_only",
		secretVerifier: hashProjectApiCredential(token),
	};
}

export function hashProjectApiCredential(token: string): Uint8Array {
	return createHash("sha256").update(token, "utf8").digest();
}
