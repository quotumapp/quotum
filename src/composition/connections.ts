import { BillingError } from "../billing/errors";
import { sql } from "../db/client";
import { loadConnectionCipher } from "../platform/connections/cipher";
import { resolveStripeOAuth } from "../platform/connections/oauth-runtime";
import { ConnectionRepository } from "../platform/connections/repository";
import {
	appleProjectConfigSchema,
	googlePlayProjectConfigSchema,
	stripeProjectConfigSchema,
} from "../projects/config";
import type {
	RuntimeConnectionConfigs,
	RuntimeConnectionKind,
	RuntimeConnectionResolver,
} from "../projects/connections";
import type { ProjectInstanceContext } from "../projects/context";
import { merchantSql } from "./merchant-persistence";
import { createStripeOAuthPort } from "./stripe-oauth";

export function createConnectionRepository() {
	return new ConnectionRepository(merchantSql(sql), loadConnectionCipher());
}
export function createRuntimeConnectionResolver(
	repository: ConnectionRepository,
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
				let parsed: unknown;
				if (kind === "stripe") {
					if (current.version.settings.authMethod === "oauth") {
						if (project.environment === "internal")
							throw new Error("Merchant OAuth is unavailable internally");
						const oauth = createStripeOAuthPort();
						if (!oauth) throw new Error("Stripe app unavailable");
						const { authMethod: _, ...settings } = current.version.settings;
						const tokens = await resolveStripeOAuth(
							repository,
							current.version,
							project.environment,
							oauth,
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
						};
					} else parsed = stripeProjectConfigSchema.parse(value);
				} else if (kind === "apple")
					parsed = appleProjectConfigSchema.parse({ ...value, rootCertificatesDir: null });
				else if (kind === "google")
					parsed = googlePlayProjectConfigSchema.parse({ ...value, serviceAccountKeyFile: null });
				else
					parsed = {
						projectionUrl: value.projectionUrl,
						projectionSecret: value.projectionSecret,
						projectionContract: "billing_state_v1",
						usageDelivery: value.usageDelivery === "off" ? "off" : "coalesced",
					};
				return parsed as RuntimeConnectionConfigs[K];
			} catch {
				throw new BillingError(
					"This project integration is unavailable",
					"CONNECTION_UNAVAILABLE",
					503,
				);
			}
		},
	};
}
