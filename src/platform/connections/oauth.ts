import { randomUUID } from "node:crypto";
import type { MerchantScope } from "../contracts";
import { MerchantError, randomToken } from "../security";
import type { MerchantIdentity, MerchantStore } from "../store";
import type { StripeOAuthPort } from "./oauth-port";
import type { ConnectionValidationPort } from "./ports";
import type { ConnectionRepository } from "./repository";
import type { MerchantConnections } from "./service";
export class MerchantStripeOAuth {
	constructor(
		private store: MerchantStore,
		private connections: MerchantConnections,
		private repository: ConnectionRepository,
		private provider: StripeOAuthPort,
		private validator: ConnectionValidationPort,
	) {}
	async start(
		identity: MerchantIdentity,
		scope: MerchantScope,
		settings: Record<string, unknown>,
		expectedRevision: number,
	) {
		const normalized = this.validator.normalize("stripe", scope.environment, {
			settings,
			secrets: {
				secretKey:
					scope.environment === "production"
						? "rk_live_oauth_placeholder"
						: "rk_test_oauth_placeholder",
				webhookSecret: "whsec_oauth_placeholder",
			},
		});
		const state = randomToken();
		const authorizeUrl = this.provider.authorize(scope.environment, state);
		await this.store.sql.begin(async (tx) => {
			const instance = await this.connections.scope(identity, scope, true, tx);
			await tx`INSERT INTO platform_connection_oauth_states(state_hash,project_instance_id,principal_id,session_id,expected_revision,settings,expires_at) VALUES(${this.store.hash(state)},${instance.id},${identity.principalId},${identity.sessionId},${expectedRevision},${JSON.stringify({ scope, settings: normalized.settings })}::text::jsonb,${new Date(this.store.now().getTime() + 600_000)})`;
		});
		return { authorizeUrl };
	}
	async complete(identity: MerchantIdentity, state: string, code: string) {
		const [pending] = await this.store.sql<
			{
				id: string;
				project_instance_id: string;
				expected_revision: number;
				settings: { scope: MerchantScope; settings: Record<string, unknown> };
			}[]
		>`UPDATE platform_connection_oauth_states SET consumed_at=${this.store.now()} WHERE state_hash=${this.store.hash(state)} AND principal_id=${identity.principalId} AND session_id=${identity.sessionId} AND consumed_at IS NULL AND expires_at>${this.store.now()} RETURNING *`;
		if (!pending)
			throw new MerchantError("OAUTH_STATE_EXPIRED", "Start Stripe authorization again.", 409);
		const { scope, settings } = pending.settings;
		await this.connections.scope(identity, scope, true);
		const tokens = await this.provider.exchange(scope.environment, code);
		if (
			tokens.livemode !== (scope.environment === "production") ||
			!tokens.accountId ||
			!tokens.accessToken ||
			!tokens.refreshToken ||
			!Number.isFinite(tokens.expiresAt)
		)
			throw new MerchantError(
				"OAUTH_ACCOUNT_INVALID",
				"Authorize the correct Stripe environment again.",
				409,
			);
		return this.store.sql.begin(async (tx) => {
			const instance = await this.connections.scope(identity, scope, true, tx);
			if (instance.id !== pending.project_instance_id)
				throw new MerchantError("CONTEXT_CHANGED", "Restart connection setup.", 409);
			await tx`INSERT INTO platform_connections(project_instance_id,kind) VALUES(${instance.id},'stripe') ON CONFLICT(project_instance_id,kind) DO NOTHING`;
			const [connection] = await tx<
				{ id: string; revision: number }[]
			>`SELECT id,revision FROM platform_connections WHERE project_instance_id=${instance.id} AND kind='stripe' FOR UPDATE`;
			if (!connection || connection.revision !== pending.expected_revision)
				throw new MerchantError("CONNECTION_CHANGED", "Refresh connection setup.", 409);
			const id = randomUUID();
			await tx`INSERT INTO platform_connection_versions(id,connection_id,project_instance_id,expected_revision,settings,request_key,request_fingerprint,external_identity) VALUES(${id},${connection.id},${instance.id},${pending.expected_revision},${JSON.stringify({ ...settings, authMethod: "oauth" })}::text::jsonb,${pending.id},${this.store.hash(pending.id)},${tokens.accountId})`;
			await this.repository.saveSecrets(
				tx,
				{ id, connection_id: connection.id, project_instance_id: instance.id },
				{
					accessToken: tokens.accessToken,
					refreshToken: tokens.refreshToken,
					expiresAt: String(tokens.expiresAt),
				},
			);
			const member = await this.store.membership(tx, identity.principalId, scope.organizationSlug);
			await this.store.audit(
				tx,
				identity.principalId,
				member.organization_id,
				"stripe.authorized",
				connection.id,
				{ versionId: id, accountId: tokens.accountId },
			);
			return { draftId: id, accountId: tokens.accountId, scope, secretDisclosed: false };
		});
	}
}
