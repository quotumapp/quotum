import { randomUUID } from "node:crypto";
import type { StripeOAuthPort } from "./oauth-port";
import { ConnectionRepository, type ConnectionVersion } from "./repository";
/** A short transaction claims refresh; provider I/O runs outside the transaction. */
export async function resolveStripeOAuth(
	repository: ConnectionRepository,
	version: ConnectionVersion,
	environment: "sandbox" | "production",
	provider: StripeOAuthPort,
) {
	const lease = randomUUID();
	const initial = await repository.sql.begin(async (tx) => {
		await tx`SELECT id FROM platform_connection_versions WHERE id=${version.id} AND connection_id=${version.connection_id} FOR UPDATE`;
		const secrets = await new ConnectionRepository(tx, repository.cipher).secrets(version);
		if (
			Number.isFinite(Number(secrets.expiresAt)) &&
			Number(secrets.expiresAt) > Date.now() + 60_000
		)
			return { secrets, claimed: false };
		const rows =
			await tx`UPDATE platform_connection_versions SET refresh_lease_id=${lease},refresh_lease_until=now()+interval '60 seconds' WHERE id=${version.id} AND (refresh_lease_until IS NULL OR refresh_lease_until<now()) RETURNING id`;
		if (!rows.length) throw new Error("Stripe token refresh is in progress; retry shortly");
		return { secrets, claimed: true };
	});
	if (!initial.claimed)
		return {
			secretKey: initial.secrets.accessToken ?? "",
			webhookSecret: provider.webhookSecret(environment),
		};
	try {
		const refreshed = await provider.refresh(environment, initial.secrets.refreshToken ?? "");
		if (
			refreshed.accountId !== version.external_identity ||
			refreshed.livemode !== (environment === "production")
		)
			throw new Error("Stripe OAuth identity changed");
		const secrets = {
			accessToken: refreshed.accessToken,
			refreshToken: refreshed.refreshToken,
			expiresAt: String(refreshed.expiresAt),
		};
		await repository.sql.begin(async (tx) => {
			const rows =
				await tx`UPDATE platform_connection_versions SET refresh_lease_id=NULL,refresh_lease_until=NULL WHERE id=${version.id} AND refresh_lease_id=${lease} AND refresh_lease_until>now() RETURNING id`;
			if (!rows.length) throw new Error("Stripe token refresh lease expired; reconnect Stripe");
			for (const [purpose, value] of Object.entries(secrets)) {
				const envelope = repository.cipher.encrypt(value, {
					instanceId: version.project_instance_id,
					connectionId: version.connection_id,
					versionId: version.id,
					purpose,
				});
				await tx`UPDATE platform_connection_secrets SET envelope=${JSON.stringify(envelope)}::text::jsonb WHERE connection_id=${version.connection_id} AND version_id=${version.id} AND purpose=${purpose}`;
			}
		});
		return { secretKey: secrets.accessToken, webhookSecret: provider.webhookSecret(environment) };
	} finally {
		await repository.sql`UPDATE platform_connection_versions SET refresh_lease_id=NULL,refresh_lease_until=NULL WHERE id=${version.id} AND refresh_lease_id=${lease}`;
	}
}
