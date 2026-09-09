import { createPrivateKey, randomUUID } from "node:crypto";
import { AppStoreServerAPIClient, Environment } from "@apple/app-store-server-library";
import { androidpublisher } from "@googleapis/androidpublisher";
import { GoogleAuth } from "google-auth-library";
import Stripe from "stripe";
import { z } from "zod";
import type { ConnectionValidationPort } from "../platform/connections/ports";
import type { ConnectionKind } from "../platform/connections/repository";
import { MerchantError } from "../platform/security";
import { createProjectionSignatureHeaders } from "../projections/http-types";
import {
	appleProjectConfigSchema,
	googlePlayProjectConfigSchema,
	stripeProjectConfigSchema,
} from "../projects/config";
import { publicHttpsPost } from "../shared/safe-http";

const secretFields: Record<ConnectionKind, string[]> = {
	stripe: ["secretKey", "webhookSecret"],
	apple: ["privateKey"],
	google: ["serviceAccountJson", "obfuscatedAccountIdSecret"],
	projection: ["projectionSecret"],
};
const projectionSchema = z
	.object({ projectionUrl: z.url(), projectionSecret: z.string().optional() })
	.strict();
export function createConnectionValidation(): ConnectionValidationPort {
	return {
		normalize(kind, environment, input) {
			const secrets = secretFields[kind];
			if (
				Object.keys(input.settings).some((key) => secrets.includes(key)) ||
				Object.keys(input.secrets).some((key) => !secrets.includes(key))
			)
				throw new MerchantError(
					"INVALID_CONNECTION",
					"Submit credentials only in the secret fields.",
				);
			const combined = { ...input.settings, ...input.secrets };
			let parsed: Record<string, unknown>;
			try {
				if (kind === "stripe") {
					parsed = stripeProjectConfigSchema.parse(combined);
					if (
						!String(parsed.secretKey).startsWith(
							environment === "production" ? "rk_live_" : "rk_test_",
						)
					)
						throw new Error("Restricted key mode mismatch");
					const returns = [
						parsed.checkoutSuccessUrl,
						parsed.checkoutCancelUrl,
						parsed.portalReturnUrl,
					];
					const origins = parsed.allowedReturnOrigins as string[] | undefined;
					for (const value of [...returns, ...(origins ?? [])]) {
						const url = new URL(String(value));
						if (url.username || url.password || url.protocol !== "https:")
							throw new Error("HTTPS return URLs required");
					}
					if (origins && returns.some((value) => !origins.includes(new URL(String(value)).origin)))
						throw new Error("Return origin mismatch");
				} else if (kind === "apple") {
					parsed = appleProjectConfigSchema.parse({
						...combined,
						environment,
						enableOnlineChecks: true,
						rootCertificatesDir: null,
					});
					const key = createPrivateKey(String(parsed.privateKey));
					if (
						key.asymmetricKeyType !== "ec" ||
						key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
					)
						throw new Error("Apple requires P-256 key");
				} else if (kind === "google") {
					parsed = googlePlayProjectConfigSchema.parse({
						...combined,
						serviceAccountKeyFile: null,
						previousObfuscatedAccountIdSecrets: [],
					});
					const serviceAccount = JSON.parse(String(parsed.serviceAccountJson));
					if (
						serviceAccount.type !== "service_account" ||
						typeof serviceAccount.private_key !== "string" ||
						typeof serviceAccount.client_email !== "string"
					)
						throw new Error("Invalid service account");
					if (
						serviceAccount.token_uri !== "https://oauth2.googleapis.com/token" ||
						(serviceAccount.universe_domain &&
							serviceAccount.universe_domain !== "googleapis.com") ||
						!serviceAccount.client_email.endsWith(".iam.gserviceaccount.com") ||
						createPrivateKey(serviceAccount.private_key).asymmetricKeyType !== "rsa"
					)
						throw new Error("Unsupported service account");
					if (
						!parsed.rtdnAudience ||
						!parsed.rtdnServiceAccountEmail ||
						!parsed.rtdnAuthorizedParty
					)
						throw new Error("RTDN configuration required");
				} else {
					parsed = projectionSchema.parse(combined);
					const url = new URL(String(parsed.projectionUrl));
					if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
						throw new Error("Invalid receiver URL");
				}
			} catch {
				throw new MerchantError(
					"INVALID_CONNECTION",
					"Check the integration fields and environment.",
				);
			}
			return {
				settings: Object.fromEntries(
					Object.entries(parsed).filter(([key]) => !secrets.includes(key)),
				),
				secrets: Object.fromEntries(
					Object.entries(parsed)
						.filter(([key]) => secrets.includes(key))
						.map(([key, value]) => [key, String(value)]),
				),
			};
		},
		async validate(kind, environment, input, context) {
			if (kind === "projection") {
				const challenge = randomUUID();
				const url = new URL(String(input.settings.projectionUrl));
				url.pathname = `${url.pathname.replace(/\/+$/, "")}/internal/billing/projections/verify`;
				const body = JSON.stringify({ challenge, projectKey: context.instanceKey });
				const secret = input.secrets.projectionSecret;
				if (!secret)
					throw new MerchantError("CONNECTION_INVALID", "Generate a receiver secret first.");
				const response = await publicHttpsPost(url.toString(), body, {
					authorization: `Bearer ${secret}`,
					"content-type": "application/json",
					...createProjectionSignatureHeaders({ secret, body, now: () => new Date() }),
				});
				let result: unknown;
				try {
					result = JSON.parse(response.body);
				} catch {
					result = null;
				}
				if (
					response.status !== 200 ||
					!z
						.object({ success: z.literal(true), challenge: z.literal(challenge) })
						.strict()
						.safeParse(result).success
				)
					throw new MerchantError(
						"PROJECTION_VERIFICATION_FAILED",
						"Install the verification endpoint and current secret on your receiver.",
						422,
					);
				return {
					identity: new URL(String(input.settings.projectionUrl)).origin,
					eventVerified: true,
					checks: [{ code: "PROJECTION_DELIVERY", passed: true }],
				};
			}
			if (kind === "stripe") {
				try {
					const client = new Stripe(input.secrets.accessToken ?? input.secrets.secretKey ?? "", {
						timeout: 10_000,
						maxNetworkRetries: 0,
					});
					const account = await client.accounts.retrieve(null);
					await client.prices.list({ limit: 1 });
					return {
						identity: account.id,
						eventVerified: false,
						checks: [
							{ code: "STRIPE_ACCOUNT", passed: true },
							{ code: "STRIPE_CATALOG_ACCESS", passed: true },
						],
					};
				} catch {
					throw new MerchantError(
						"STRIPE_CONNECTION_INVALID",
						"Check the restricted key permissions and account.",
						422,
					);
				}
			}
			try {
				if (kind === "apple") {
					const client = new AppStoreServerAPIClient(
						input.secrets.privateKey ?? "",
						String(input.settings.keyId),
						String(input.settings.issuerId),
						String(input.settings.bundleId),
						environment === "production" ? Environment.PRODUCTION : Environment.SANDBOX,
					);
					await client.requestTestNotification();
				} else {
					const credentials = JSON.parse(input.secrets.serviceAccountJson ?? "{}");
					const auth = new GoogleAuth({
						credentials,
						scopes: ["https://www.googleapis.com/auth/androidpublisher"],
					});
					await androidpublisher({ version: "v3", auth }).monetization.subscriptions.list({
						packageName: String(input.settings.packageName),
						pageSize: 1,
					});
				}
			} catch {
				throw new MerchantError(
					"PROVIDER_CONNECTION_INVALID",
					"Check the provider credentials and app permissions.",
					422,
				);
			}
			return {
				identity: String(kind === "apple" ? input.settings.bundleId : input.settings.packageName),
				eventVerified: false,
				checks: [{ code: `${kind.toUpperCase()}_API_ACCESS`, passed: true }],
			};
		},
	};
}
