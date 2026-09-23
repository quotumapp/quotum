import type { MerchantScope } from "../contracts";
import type { MerchantSql } from "../database";
import { digest, MerchantError, requireCapability } from "../security";
import type { MerchantStore } from "../store";

export const MCP_SCOPES = ["quotum.read", "offline_access"];
export const MCP_INSTANCE_CLAIM = "https://quotum.dev/project_instance";
export const MCP_GRANT_CLAIM = "https://quotum.dev/mcp_authorization";
export const MCP_GRANT_MS = 30 * 24 * 60 * 60_000;

export interface McpGrant {
	id: string;
	principal_id: string;
	organization_id: string;
	project_instance_id: string;
	client_id: string;
	client_name: string;
	proof_session_id: string | null;
	code_hash: string | null;
	created_at: Date;
	expires_at: Date;
	approved_at: Date | null;
	revoked_at: Date | null;
}

/** Continuation signatures/timestamps change between steps; authorization parameters do not. */
export function authorizationFingerprint(query: string | URLSearchParams): string {
	const params = typeof query === "string" ? new URLSearchParams(query) : query;
	return digest(
		JSON.stringify(
			[
				"client_id",
				"redirect_uri",
				"state",
				"code_challenge",
				"code_challenge_method",
				"scope",
				"resource",
			].map((key) => [key, params.getAll(key).sort()]),
		),
	);
}

export class McpAuthorizations {
	constructor(readonly store: MerchantStore) {}

	tokenHash(token: string): string {
		return this.store.hash(`mcp:${token}`);
	}

	async proof(sessionId: string, query: string, tx: MerchantSql = this.store.sql) {
		const hash = authorizationFingerprint(query);
		const [proof] = await tx<
			{ user_id: string; mcp_request_hash: string | null }[]
		>`SELECT user_id,mcp_request_hash FROM platform_auth_sessions WHERE id=${sessionId} AND expires_at>${this.store.now()} AND proof_at>${new Date(this.store.now().getTime() - 300_000)} AND auth_method IS NOT NULL FOR UPDATE`;
		if (!proof)
			throw new MerchantError(
				"AUTHENTICATION_INCOMPLETE",
				"Sign in again to authorize access.",
				401,
			);
		if (proof.mcp_request_hash !== null && proof.mcp_request_hash !== hash)
			throw new MerchantError(
				"AUTHORIZATION_IN_PROGRESS",
				"This sign-in belongs to another authorization. Start again.",
				409,
			);
		await tx`UPDATE platform_auth_sessions SET mcp_request_hash=${hash} WHERE id=${sessionId}`;
		return this.principal(proof.user_id, tx);
	}

	async principal(userId: string, tx: MerchantSql = this.store.sql) {
		const [row] = await tx<
			{ id: string; name: string; email: string }[]
		>`SELECT p.id,u.name,u.email FROM platform_principals p JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE p.auth_user_id=${userId} AND p.status='active' AND u.email_verified=true`;
		if (!row) throw new MerchantError("FORBIDDEN", "This account cannot authorize access.", 403);
		return row;
	}

	async context(sessionId: string, query: string) {
		const principal = await this.store.sql.begin((tx) => this.proof(sessionId, query, tx));
		const clientId = new URLSearchParams(query).get("client_id") ?? "";
		const [client] = await this.store.sql<
			{ id: string; name: string }[]
		>`SELECT client_id AS id,COALESCE(name,client_id) AS name FROM platform_auth_oauth_clients WHERE client_id=${clientId} AND disabled IS NOT TRUE`;
		if (!client)
			throw new MerchantError("INVALID_REQUEST", "Restart authorization in your AI client.");
		const memberships = await this.store.memberships(principal.id);
		const projects = await this.store.sql.instances.forPrincipal(principal.id);
		const environments = projects.flatMap((project) => {
			const membership = memberships.find((m) => m.organizationSlug === project.organizationSlug);
			if (!membership?.capabilities.includes("billing.read")) return [];
			return project.instances.flatMap((instance) =>
				instance.lifecycleStatus === "active" &&
				!instance.internalProject &&
				instance.environment !== "internal"
					? [
							{
								scope: {
									kind: "merchant" as const,
									organizationSlug: project.organizationSlug,
									projectKey: project.key,
									environment: instance.environment,
								},
								organizationName: membership.organizationName,
								projectName: project.name,
								instanceId: instance.id,
							},
						]
					: [],
			);
		});
		const selected = await this.selection(sessionId);
		return {
			principal,
			client,
			environments: environments.map(({ instanceId: _, ...value }) => value),
			selection:
				environments.find((e) => e.instanceId === selected?.project_instance_id)?.scope ?? null,
		};
	}

	async selection(sessionId: string) {
		const [grant] = await this.store.sql<
			McpGrant[]
		>`SELECT * FROM platform_mcp_authorizations WHERE proof_session_id=${sessionId}`;
		return grant ?? null;
	}

	async select(sessionId: string, query: string, scope: MerchantScope) {
		return this.store.sql.begin(async (tx) => {
			const principal = await this.proof(sessionId, query, tx);
			const access = await this.authorizeScope(principal.id, scope);
			const clientId = new URLSearchParams(query).get("client_id") ?? "";
			const [client] = await tx<
				{ name: string }[]
			>`SELECT COALESCE(name,client_id) AS name FROM platform_auth_oauth_clients WHERE client_id=${clientId} AND disabled IS NOT TRUE`;
			if (!client)
				throw new MerchantError("INVALID_REQUEST", "Restart authorization in your AI client.");
			await tx`INSERT INTO platform_mcp_authorizations(principal_id,organization_id,project_instance_id,client_id,client_name,proof_session_id,created_at,expires_at) VALUES(${principal.id},${access.organizationId},${access.projectInstanceId},${clientId},${client.name},${sessionId},${this.store.now()},${new Date(this.store.now().getTime() + MCP_GRANT_MS)}) ON CONFLICT(proof_session_id) DO NOTHING`;
			const [grant] = await tx<
				McpGrant[]
			>`SELECT * FROM platform_mcp_authorizations WHERE proof_session_id=${sessionId}`;
			if (
				!grant ||
				grant.project_instance_id !== access.projectInstanceId ||
				grant.client_id !== clientId
			)
				throw new MerchantError(
					"AUTHORIZATION_IN_PROGRESS",
					"This sign-in already selected an environment. Start again.",
					409,
				);
			return { projectInstanceId: grant.project_instance_id };
		});
	}

	async authorizeScope(principalId: string, scope: MerchantScope) {
		const member = await this.store.membership(this.store.sql, principalId, scope.organizationSlug);
		requireCapability(member.role, "billing.read");
		const projects = await this.store.sql.instances.forPrincipal(principalId);
		const project = projects.find(
			(p) => p.key === scope.projectKey && p.organizationSlug === scope.organizationSlug,
		);
		const instance = project?.instances.find(
			(i) =>
				i.environment === scope.environment && i.lifecycleStatus === "active" && !i.internalProject,
		);
		if (!instance)
			throw new MerchantError(
				"CONTEXT_UNAVAILABLE",
				"The selected environment is unavailable.",
				404,
			);
		return { principalId, organizationId: member.organization_id, projectInstanceId: instance.id };
	}

	async validate(grant: McpGrant | undefined, approved = true) {
		if (
			!grant ||
			grant.revoked_at ||
			grant.expires_at <= this.store.now() ||
			(approved && !grant.approved_at)
		)
			throw new MerchantError(
				"MCP_AUTHORIZATION_REVOKED",
				"Reconnect Quotum to authorize access.",
				401,
			);
		const [principal] = await this.store.sql<
			{ auth_user_id: string }[]
		>`SELECT p.auth_user_id FROM platform_principals p JOIN platform_auth_oauth_clients c ON c.client_id=${grant.client_id} WHERE p.id=${grant.principal_id} AND p.status='active' AND c.disabled IS NOT TRUE`;
		if (!principal) throw new MerchantError("FORBIDDEN", "This account cannot access Quotum.", 403);
		const projects = await this.store.sql.instances.forPrincipal(grant.principal_id);
		const project = projects.find((p) =>
			p.instances.some((i) => i.id === grant.project_instance_id),
		);
		const instance = project?.instances.find((i) => i.id === grant.project_instance_id);
		if (!project || !instance || instance.lifecycleStatus !== "active" || instance.internalProject)
			throw new MerchantError("CONTEXT_UNAVAILABLE", "The environment is unavailable.", 403);
		const member = await this.store.membership(
			this.store.sql,
			grant.principal_id,
			project.organizationSlug,
		);
		requireCapability(member.role, "billing.read");
		if (member.organization_id !== grant.organization_id)
			throw new MerchantError("FORBIDDEN", "The environment is unavailable.", 403);
		return { ...grant, userId: principal.auth_user_id };
	}

	async byId(id: string) {
		const [grant] = await this.store.sql<
			McpGrant[]
		>`SELECT * FROM platform_mcp_authorizations WHERE id=${id}`;
		return this.validate(grant);
	}

	async revokeCode(code: string, clientId: string) {
		const [grant] = await this.store.sql<
			McpGrant[]
		>`SELECT * FROM platform_mcp_authorizations WHERE code_hash=${this.tokenHash(code)} AND client_id=${clientId}`;
		if (grant) await this.revoke(grant.id, grant.principal_id);
	}

	/** Seal consent while the browser proof is fresh; the code then owns its own lifetime. */
	async issueCode(code: string, sessionId: string, query: string, expiresAt: Date) {
		await this.store.sql.begin(async (tx) => {
			await this.proof(sessionId, query, tx);
			const hash = this.tokenHash(code);
			const rows =
				await tx`UPDATE platform_mcp_authorizations SET code_hash=${hash} WHERE proof_session_id=${sessionId} AND (code_hash IS NULL OR code_hash=${hash}) RETURNING id`;
			if (!rows.length)
				throw new MerchantError("INVALID_REQUEST", "Restart authorization in your AI client.");
			// The provider requires the session row during code redemption. Its browser proof
			// still expires through proof_at; this extends only code redemption, never consent.
			await tx`UPDATE platform_auth_sessions SET expires_at=${expiresAt} WHERE id=${sessionId}`;
		});
	}

	async forCode(code: string) {
		const hash = this.tokenHash(code);
		const [grant] = await this.store.sql<
			McpGrant[]
		>`SELECT * FROM platform_mcp_authorizations WHERE code_hash=${hash}`;
		return this.validate(grant, false);
	}

	/** Approval races must revoke only this issuance and always discard its transient proof. */
	async completeCode(code: string, issued = true) {
		const [grant] = await this.store.sql<
			McpGrant[]
		>`SELECT * FROM platform_mcp_authorizations WHERE code_hash=${this.tokenHash(code)}`;
		if (!grant) return this.validate(undefined);
		try {
			if (!issued) {
				await this.revoke(grant.id, grant.principal_id);
				return;
			}
			await this.validate(grant, false);
			await this.approve(grant);
		} catch (error) {
			await this.revoke(grant.id, grant.principal_id);
			throw error;
		} finally {
			await this.store.sql.begin(async (tx) => {
				const [session] = await tx<
					{ user_id: string }[]
				>`DELETE FROM platform_auth_sessions WHERE id=${grant.proof_session_id} RETURNING user_id`;
				if (session)
					await tx`UPDATE platform_auth_accounts SET access_token=NULL,refresh_token=NULL,id_token=NULL WHERE user_id=${session.user_id} AND provider_id='google'`;
			});
		}
	}

	async forRefresh(token: string) {
		const [grant] = await this.store.sql<
			McpGrant[]
		>`SELECT g.* FROM platform_mcp_authorizations g JOIN platform_auth_oauth_refresh_tokens t ON t.authorization_code_id=g.code_hash WHERE t.token=${this.tokenHash(token)}`;
		return this.validate(grant);
	}

	/** Check before the provider's replay shortcut; never revoke a sibling authorization. */
	async checkRefresh(token: string, clientId: string) {
		const grant = await this.forRefresh(token);
		if (grant.client_id !== clientId)
			throw new MerchantError("INVALID_REQUEST", "Invalid refresh token.");
		const [row] = await this.store.sql<
			{
				revoked: Date | null;
				rotated_at: Date | null;
				rotation_replay_expires_at: Date | null;
				expires_at: Date;
			}[]
		>`SELECT revoked,rotated_at,rotation_replay_expires_at,expires_at FROM platform_auth_oauth_refresh_tokens WHERE token=${this.tokenHash(token)}`;
		if (!row || row.expires_at <= this.store.now())
			throw new MerchantError("INVALID_REQUEST", "Invalid refresh token.");
		if (
			row.revoked &&
			(!row.rotated_at ||
				!row.rotation_replay_expires_at ||
				row.rotation_replay_expires_at < this.store.now())
		) {
			await this.revoke(grant.id, grant.principal_id);
			throw new MerchantError(
				"MCP_AUTHORIZATION_REVOKED",
				"Reconnect Quotum to authorize access.",
				401,
			);
		}
		return grant;
	}

	/** RFC 7009: unknown tokens are a non-enumerating no-op, including expired grants. */
	async revokeToken(token: string, clientId: string) {
		const [grant] = await this.store.sql<
			McpGrant[]
		>`SELECT g.* FROM platform_mcp_authorizations g JOIN platform_auth_oauth_refresh_tokens t ON t.authorization_code_id=g.code_hash WHERE t.token=${this.tokenHash(token)} AND g.client_id=${clientId}`;
		if (grant) await this.revoke(grant.id, grant.principal_id);
	}

	async approve(grant: McpGrant) {
		await this.store.sql.begin(async (tx) => {
			const rows =
				await tx`UPDATE platform_mcp_authorizations SET approved_at=${this.store.now()} WHERE id=${grant.id} AND approved_at IS NULL AND revoked_at IS NULL AND expires_at>${this.store.now()} RETURNING id`;
			if (rows.length)
				await this.store.audit(
					tx,
					grant.principal_id,
					grant.organization_id,
					"mcp.authorized",
					grant.id,
					{ clientId: grant.client_id, projectInstanceId: grant.project_instance_id },
				);
		});
		return this.byId(grant.id);
	}

	async list(principalId: string, scope: MerchantScope) {
		const access = await this.authorizeScope(principalId, scope);
		const rows = await this.store.sql<
			McpGrant[]
		>`SELECT * FROM platform_mcp_authorizations WHERE principal_id=${principalId} AND project_instance_id=${access.projectInstanceId} AND approved_at IS NOT NULL AND revoked_at IS NULL AND expires_at>${this.store.now()} ORDER BY created_at DESC`;
		return {
			connections: rows.map((r) => ({
				id: r.id,
				clientId: r.client_id,
				clientName: r.client_name,
				createdAt: r.created_at.toISOString(),
				expiresAt: r.expires_at.toISOString(),
			})),
			mcpUrl: this.store.config.mcp ? `${this.store.config.mcp.origin}/mcp` : null,
		};
	}

	async revoke(id: string, principalId: string, instanceId?: string) {
		return this.store.sql.begin(async (tx) => {
			const [row] = await tx<
				McpGrant[]
			>`SELECT * FROM platform_mcp_authorizations WHERE id=${id} AND principal_id=${principalId} FOR UPDATE`;
			if (!row || (instanceId && row.project_instance_id !== instanceId))
				throw new MerchantError("NOT_FOUND", "Connection not found.", 404);
			if (row.revoked_at) return { revoked: false };
			await tx`UPDATE platform_mcp_authorizations SET revoked_at=${this.store.now()} WHERE id=${id}`;
			await tx`UPDATE platform_auth_oauth_refresh_tokens SET revoked=${this.store.now()},rotation_replay_response=NULL,rotation_replay_expires_at=NULL WHERE authorization_code_id=${row.code_hash}`;
			await this.store.audit(tx, principalId, row.organization_id, "mcp.revoked", id, {
				clientId: row.client_id,
				projectInstanceId: row.project_instance_id,
			});
			return { revoked: true };
		});
	}

	async revokeUser(userId: string) {
		await this.store.sql.begin(async (tx) => {
			await tx`UPDATE platform_mcp_authorizations SET revoked_at=${this.store.now()} WHERE principal_id IN (SELECT id FROM platform_principals WHERE auth_user_id=${userId}) AND revoked_at IS NULL`;
			await tx`UPDATE platform_auth_oauth_refresh_tokens SET revoked=${this.store.now()},rotation_replay_response=NULL,rotation_replay_expires_at=NULL WHERE user_id=${userId}`;
		});
	}
}
