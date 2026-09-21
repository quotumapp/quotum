import { BillingError } from "../billing/errors";
import { sql } from "../db/client";
import { loadConnectionCipher } from "../platform/connections/cipher";
import { resolveStripeOAuth } from "../platform/connections/oauth-runtime";
import { ConnectionRepository } from "../platform/connections/repository";
import type { MerchantSql } from "../platform/database";
import {
	appleProjectConfigSchema,
	googlePlayProjectConfigSchema,
	stripeProjectConfigSchema,
} from "../projects/config";
import type {
	RuntimeConnectionConfigs,
	RuntimeConnectionDescription,
	RuntimeConnectionKind,
	RuntimeConnectionResolver,
} from "../projects/connections";
import type { ProjectInstanceContext } from "../projects/context";
import { merchantSql } from "./merchant-persistence";
import { createStripeOAuthPort } from "./stripe-oauth";

export function createConnectionRepository(persistence: MerchantSql = merchantSql(sql)) {
	return new ConnectionRepository(persistence, loadConnectionCipher());
}
/**
 * Maps a connection row joined to its active version. `external_identity` is optional because the
 * platform's connection list does not select it.
 */
export function connectionDescription(row: {
	enabled: boolean;
	active_version_id: string | null;
	settings: Record<string, unknown> | null;
	validated_at: Date | string | null;
	external_identity?: string | null;
}): RuntimeConnectionDescription {
	const active = row.active_version_id !== null;
	const validatedAt =
		active && row.validated_at !== null ? new Date(row.validated_at).toISOString() : null;
	return {
		enabled: row.enabled,
		active,
		validated: validatedAt !== null,
		validatedAt,
		accountIdentity: active ? (row.external_identity ?? null) : null,
		settings: Object.fromEntries(
			Object.entries(row.settings ?? {}).filter(
				(entry): entry is [string, string | boolean] =>
					typeof entry[1] === "string" || typeof entry[1] === "boolean",
			),
		),
	};
}

function connectionUnavailable(): BillingError {
	return new BillingError("This project integration is unavailable", "CONNECTION_UNAVAILABLE", 503);
}

export function createRuntimeConnectionResolver(
	repository: ConnectionRepository,
	persistence?: MerchantSql,
): RuntimeConnectionResolver {
	return {
		async resolve<K extends RuntimeConnectionKind>(
			project: ProjectInstanceContext,
			kind: K,
			purpose: "new" | "recovery" = "new",
		): Promise<RuntimeConnectionConfigs[K] | null> {
			try {
				const current = await repository.active(
					project.projectInstanceId,
					kind,
					purpose === "recovery",
				);
				if (!current) return null;
				const value = { ...current.version.settings, ...current.secrets };
				const accountIdentity = current.version.external_identity ?? null;
				let parsed: unknown;
				if (kind === "stripe") {
					if (current.version.settings.authMethod === "oauth") {
						if (project.environment === "internal")
							throw new Error("Merchant OAuth is unavailable internally");
						const oauth = createStripeOAuthPort();
						if (!oauth) throw new Error("Stripe app unavailable");
						const { authMethod: _, ...settings } = current.version.settings;
						if (!persistence) throw new Error("Merchant persistence is unavailable");
						const tokens = await resolveStripeOAuth(
							repository,
							current.version,
							project.environment,
							oauth,
							persistence,
						);
						parsed = {
							...stripeProjectConfigSchema.parse({
								...settings,
								...tokens,
								secretKey: project.environment === "production" ? "rk_live_oauth" : "rk_test_oauth",
							}),
							...tokens,
							connectedAccountId: current.version.external_identity,
							connectedAccountLivemode: project.environment === "production",
							accountIdentity,
						};
					} else parsed = { ...stripeProjectConfigSchema.parse(value), accountIdentity };
				} else if (kind === "apple")
					parsed = {
						...appleProjectConfigSchema.parse({ ...value, rootCertificatesDir: null }),
						accountIdentity,
					};
				else if (kind === "google")
					parsed = {
						...googlePlayProjectConfigSchema.parse({ ...value, serviceAccountKeyFile: null }),
						accountIdentity,
					};
				else
					parsed = {
						projectionUrl: value.projectionUrl,
						projectionSecret: value.projectionSecret,
						projectionContract: "billing_state_v1",
						usageDelivery: value.usageDelivery === "off" ? "off" : "coalesced",
					};
				return parsed as RuntimeConnectionConfigs[K];
			} catch {
				throw connectionUnavailable();
			}
		},
		async describe(project, kind) {
			try {
				const row = await repository.describe(project.projectInstanceId, kind);
				return row === null ? null : connectionDescription(row);
			} catch {
				throw connectionUnavailable();
			}
		},
	};
}
