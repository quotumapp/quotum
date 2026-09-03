import { readFileSync } from "node:fs";
import type { GooglePlayBillingEnv } from "../../env";

export interface GooglePlayConfig {
	packageName: string;
	serviceAccountCredentials: Record<string, unknown>;
	obfuscatedAccountIdSecret: string;
	previousObfuscatedAccountIdSecrets: string[];
	rtdnAudience: string | null;
	rtdnServiceAccountEmail: string | null;
	rtdnAuthorizedParty: string | null;
	enablePublisherMutations: boolean;
}

export function buildGooglePlayConfig(env: GooglePlayBillingEnv): GooglePlayConfig {
	const credentials = parseServiceAccountCredentials(env);

	return {
		packageName: env.packageName,
		serviceAccountCredentials: credentials,
		obfuscatedAccountIdSecret: env.obfuscatedAccountIdSecret,
		previousObfuscatedAccountIdSecrets: env.previousObfuscatedAccountIdSecrets,
		rtdnAudience: env.rtdnAudience,
		rtdnServiceAccountEmail: env.rtdnServiceAccountEmail,
		rtdnAuthorizedParty: env.rtdnAuthorizedParty,
		enablePublisherMutations: env.enablePublisherMutations,
	};
}

function parseServiceAccountCredentials(env: GooglePlayBillingEnv): Record<string, unknown> {
	const rawCredentials =
		env.serviceAccountJson ??
		(env.serviceAccountKeyFile === null ? null : readFileSync(env.serviceAccountKeyFile, "utf8"));

	if (rawCredentials === null) {
		throw new Error("Google Play service account credentials are required");
	}

	const parsed = JSON.parse(rawCredentials) as Record<string, unknown>;
	if (
		typeof parsed.client_email !== "string" ||
		parsed.client_email.trim() === "" ||
		typeof parsed.private_key !== "string" ||
		parsed.private_key.trim() === ""
	) {
		throw new Error(
			"Google Play service account credentials must include client_email and private_key",
		);
	}

	return parsed;
}
