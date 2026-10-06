import { hasUnstorableText } from "../../shared/input-bounds";
import type {
	BillingChangeInput,
	BillingChangePreview,
	BillingChangesPort,
} from "../application/billing-changes";
import type { MerchantCapability, MerchantScope } from "../contracts";
import type { MerchantSql } from "../database";
import { digest, IDLE_MS, MerchantError, requireCapability } from "../security";
import { canonicalJson, MerchantStepUp, mutationTarget } from "../step-up";
import type { MerchantIdentity, MerchantStore } from "../store";
import { MCP_WRITE_SCOPE, McpAuthorizations } from "./authorization";

interface ChangeRow {
	id: string;
	authorization_id: string;
	principal_id: string;
	project_instance_id: string;
	request_hash: string;
	action: string;
	parameters: string[];
	body: unknown;
	reason: string;
	preview: BillingChangePreview;
	capability: MerchantCapability;
	step_up_action: string;
	sensitive: boolean;
	scope: MerchantScope;
	status: string;
	result: unknown;
	created_at: Date;
	expires_at: Date;
}
export class McpChanges {
	constructor(
		readonly store: MerchantStore,
		readonly port: BillingChangesPort,
	) {}
	private async access(authorizationId: string, write = true) {
		const grant = await new McpAuthorizations(this.store).byId(authorizationId);
		if (!grant.scopes.includes(MCP_WRITE_SCOPE))
			throw new MerchantError("FORBIDDEN", "Reconnect with billing write consent.", 403);
		if (write && !this.store.config.mcp?.writesEnabled)
			throw new MerchantError("MCP_WRITES_DISABLED", "MCP writes are disabled.", 403);
		const projects = await this.store.sql.instances.forPrincipal(grant.principal_id);
		const project = projects.find((p) =>
			p.instances.some((i) => i.id === grant.project_instance_id),
		);
		const instance = project?.instances.find((i) => i.id === grant.project_instance_id);
		if (!project || !instance || instance.environment === "internal")
			throw new MerchantError("FORBIDDEN", "Environment unavailable.", 403);
		const member = await this.store.membership(
			this.store.sql,
			grant.principal_id,
			project.organizationSlug,
		);
		const scope: MerchantScope = {
			kind: "merchant",
			organizationSlug: project.organizationSlug,
			projectKey: project.key,
			environment: instance.environment,
		};
		return {
			grant,
			member,
			scope,
			context: {
				projectInstanceId: grant.project_instance_id,
				actor: `merchant:${grant.principal_id}`,
			},
		};
	}
	async inspect(
		authorizationId: string,
		input: { resource: string; parameters: string[]; query: Record<string, string> },
	) {
		const access = await this.access(authorizationId, false);
		requireCapability(access.member.role, "billing.read");
		return this.port.inspect(access.context, input);
	}
	async capabilities(authorizationId: string) {
		const access = await this.access(authorizationId, false);
		return this.port.actions.map((action) => {
			const capability =
				action.action === "catalog.publish" && access.scope.environment === "production"
					? "catalog.publish.production"
					: action.capability;
			let available = this.store.config.mcp?.writesEnabled === true;
			try {
				requireCapability(access.member.role, capability);
			} catch {
				available = false;
			}
			return { ...action, capability, available, approvalRequired: true };
		});
	}
	/**
	 * Row locks in the one order every writer of these rows uses: session, organization, membership,
	 * authorization, then the change. Member administration locks organization and membership and,
	 * through its revoke trigger, the authorization; credential resets lock sessions before grants.
	 * Any other order deadlocks with those paths or with a concurrent proposal, replacement,
	 * cancellation or approval on the same grant. These are blind locks: the checks that follow keep
	 * their error precedence.
	 */
	private async lockProposal(
		tx: MerchantSql,
		input: {
			sessionId?: string;
			principalId: string;
			organizationSlug: string;
			authorizationId: string;
			changeId?: string;
		},
	) {
		if (input.sessionId !== undefined)
			await tx`SELECT id FROM platform_merchant_sessions WHERE id=${input.sessionId} FOR UPDATE`;
		await tx`SELECT id FROM platform_organizations WHERE slug=${input.organizationSlug} FOR UPDATE`;
		await tx`SELECT m.id FROM platform_memberships m JOIN platform_organizations o ON o.id=m.organization_id WHERE m.principal_id=${input.principalId} AND o.slug=${input.organizationSlug} FOR UPDATE OF m`;
		await tx`SELECT id FROM platform_mcp_authorizations WHERE id=${input.authorizationId} FOR UPDATE`;
		if (input.changeId !== undefined)
			await tx`SELECT id FROM platform_mcp_changes WHERE id=${input.changeId} FOR UPDATE`;
	}
	async prepare(
		authorizationId: string,
		input: BillingChangeInput & { requestKey: string; reason: string; replacesChangeId?: string },
	) {
		// Text Postgres cannot store would fail the insert below as a 503, so the proposal is
		// refused up front whatever caller built it.
		if (hasUnstorableText(input))
			throw new MerchantError(
				"INVALID_REQUEST",
				"Proposal text cannot contain NUL or unpaired surrogate characters.",
			);
		const access = await this.access(authorizationId);
		const action = this.port.actions.find((a) => a.action === input.action);
		if (!action) throw new MerchantError("ACTION_REJECTED", "Unsupported billing change.");
		const capability =
			action.action === "catalog.publish" && access.scope.environment === "production"
				? "catalog.publish.production"
				: action.capability;
		requireCapability(access.member.role, capability);
		const hash = digest(
			canonicalJson({ ...input, replacesChangeId: input.replacesChangeId ?? null }),
		);
		const [existing] = await this.store.sql<
			ChangeRow[]
		>`SELECT * FROM platform_mcp_changes WHERE authorization_id=${authorizationId} AND request_key=${input.requestKey}`;
		if (existing) {
			if (existing.request_hash !== hash)
				throw new MerchantError(
					"IDEMPOTENCY_CONFLICT",
					"Use a new request key when a proposal changes.",
					409,
				);
			return this.view(existing);
		}
		const preview = await this.port.prepare(access.context, input);
		const expiry = new Date(
			Math.min(
				this.store.now().getTime() + 900_000,
				preview.expiresAt ? new Date(preview.expiresAt).getTime() : Infinity,
			),
		);
		return this.store.sql.begin(async (tx) => {
			await this.lockProposal(tx, {
				principalId: access.grant.principal_id,
				organizationSlug: access.scope.organizationSlug,
				authorizationId,
				changeId: input.replacesChangeId,
			});
			const grants =
				await tx`SELECT id FROM platform_mcp_authorizations WHERE id=${authorizationId} AND revoked_at IS NULL AND expires_at>${this.store.now()} FOR UPDATE`;
			if (!grants.length)
				throw new MerchantError("MCP_AUTHORIZATION_REVOKED", "Reconnect Quotum.", 401);
			const member = await this.store.membership(
				tx,
				access.grant.principal_id,
				access.scope.organizationSlug,
				true,
			);
			requireCapability(member.role, capability);
			const [replayed] = await tx<
				ChangeRow[]
			>`SELECT * FROM platform_mcp_changes WHERE authorization_id=${authorizationId} AND request_key=${input.requestKey}`;
			if (replayed) {
				if (replayed.request_hash !== hash)
					throw new MerchantError("IDEMPOTENCY_CONFLICT", "Use a new request key.", 409);
				return this.view(replayed);
			}
			if (input.replacesChangeId) {
				const changed =
					await tx`UPDATE platform_mcp_changes SET status='cancelled' WHERE id=${input.replacesChangeId} AND authorization_id=${authorizationId} AND status='pending' RETURNING id`;
				if (!changed.length)
					throw new MerchantError(
						"ACTION_REJECTED",
						"Only your pending proposal can be replaced.",
						409,
					);
			}
			await tx`INSERT INTO platform_mcp_changes(authorization_id,principal_id,project_instance_id,request_key,request_hash,action,parameters,body,reason,preview,capability,step_up_action,sensitive,scope,expires_at) VALUES(${authorizationId},${access.grant.principal_id},${access.grant.project_instance_id},${input.requestKey},${hash},${input.action},${JSON.stringify(preview.input.parameters)}::jsonb,${JSON.stringify(preview.input.body)}::jsonb,${input.reason},${JSON.stringify(preview)}::jsonb,${capability},${action.stepUpAction},${access.scope.environment === "production" || action.alwaysSensitive},${JSON.stringify(access.scope)}::jsonb,${expiry}) ON CONFLICT(authorization_id,request_key) DO NOTHING`;
			const [row] = await tx<
				ChangeRow[]
			>`SELECT * FROM platform_mcp_changes WHERE authorization_id=${authorizationId} AND request_key=${input.requestKey}`;
			if (!row || row.request_hash !== hash)
				throw new MerchantError("IDEMPOTENCY_CONFLICT", "Use a new request key.", 409);
			await this.store.audit(
				tx,
				access.grant.principal_id,
				access.grant.organization_id,
				"mcp.change_prepared",
				row.id,
				{ action: input.action },
			);
			return this.view(row);
		});
	}
	private view(row: ChangeRow) {
		return {
			id: row.id,
			action: row.action,
			parameters: row.parameters,
			reason: row.reason,
			scope: row.scope,
			requestHash: row.request_hash,
			status:
				row.status === "pending" && row.expires_at <= this.store.now() ? "expired" : row.status,
			before: row.preview.before,
			after: row.preview.after,
			result: row.result,
			expiresAt: row.expires_at.toISOString(),
			createdAt: row.created_at.toISOString(),
			approvalUrl: `${this.store.config.origin}/mcp/changes/${row.id}`,
			stepUp: row.sensitive
				? {
						action: row.step_up_action,
						target: mutationTarget("POST", `/api/platform/mcp/changes/${row.id}/approve`, {
							requestHash: row.request_hash,
						}),
					}
				: null,
		};
	}
	private async row(id: string, tx: MerchantSql = this.store.sql) {
		const [row] = await tx<ChangeRow[]>`SELECT * FROM platform_mcp_changes WHERE id=${id}`;
		if (!row) throw new MerchantError("NOT_FOUND", "Change not found.", 404);
		return row;
	}
	async get(authorizationId: string, id: string) {
		await this.access(authorizationId, false);
		const row = await this.row(id);
		if (row.authorization_id !== authorizationId)
			throw new MerchantError("NOT_FOUND", "Change not found.", 404);
		return this.view(await this.recover(row));
	}
	async list(authorizationId: string) {
		await this.access(authorizationId, false);
		const rows = await this.store.sql<
			ChangeRow[]
		>`SELECT * FROM platform_mcp_changes WHERE authorization_id=${authorizationId} ORDER BY created_at DESC,id DESC LIMIT 25`;
		return rows.map((row) => this.view(row));
	}
	async cancel(authorizationId: string, id: string) {
		await this.get(authorizationId, id);
		const access = await this.access(authorizationId, false);
		await this.store.sql.begin(async (tx) => {
			await this.lockProposal(tx, {
				principalId: access.grant.principal_id,
				organizationSlug: access.scope.organizationSlug,
				authorizationId,
				changeId: id,
			});
			const rows =
				await tx`UPDATE platform_mcp_changes SET status='cancelled' WHERE id=${id} AND authorization_id=${authorizationId} AND status='pending' RETURNING id`;
			if (rows.length)
				await this.store.audit(
					tx,
					access.grant.principal_id,
					access.grant.organization_id,
					"mcp.change_cancelled",
					id,
				);
		});
		return this.get(authorizationId, id);
	}
	async browserGet(identity: MerchantIdentity, id: string) {
		const row = await this.row(id);
		if (row.principal_id !== identity.principalId)
			throw new MerchantError("NOT_FOUND", "Change not found.", 404);
		const access = await this.access(row.authorization_id, false);
		requireCapability(access.member.role, row.capability);
		return this.view(await this.recover(row));
	}
	private async recover(row: ChangeRow): Promise<ChangeRow> {
		if (row.status !== "applying" && row.status !== "needs_review") return row;
		const result = await this.port.recover(
			{ projectInstanceId: row.project_instance_id, actor: `merchant:${row.principal_id}` },
			`mcp:${row.id}`,
		);
		if (result) {
			await this.store
				.sql`UPDATE platform_mcp_changes SET status=${result.status < 400 ? "completed" : "failed"},result=${JSON.stringify(result)}::jsonb WHERE id=${row.id} AND status IN ('applying','needs_review')`;
			return this.row(row.id);
		}
		if (row.status === "applying" && row.expires_at <= this.store.now()) {
			await this.store
				.sql`UPDATE platform_mcp_changes SET status='needs_review' WHERE id=${row.id} AND status='applying'`;
			return this.row(row.id);
		}
		return row;
	}
	async decide(
		identity: MerchantIdentity,
		id: string,
		approve: boolean,
		stepUpToken: string | null,
	) {
		await this.browserGet(identity, id);
		const saved = await this.row(id);
		const access = await this.access(saved.authorization_id, approve);
		const claimed = await this.store.sql.begin(async (tx) => {
			await this.lockProposal(tx, {
				sessionId: identity.sessionId,
				principalId: identity.principalId,
				organizationSlug: saved.scope.organizationSlug,
				authorizationId: saved.authorization_id,
				changeId: id,
			});
			const [row] = await tx<
				ChangeRow[]
			>`SELECT * FROM platform_mcp_changes WHERE id=${id} FOR UPDATE`;
			if (!row || row.principal_id !== identity.principalId)
				throw new MerchantError("NOT_FOUND", "Change not found.", 404);
			if (row.status !== "pending") return false;
			if (row.expires_at <= this.store.now()) {
				await tx`UPDATE platform_mcp_changes SET status='expired' WHERE id=${id}`;
				return false;
			}
			const sessions =
				await tx`SELECT id FROM platform_merchant_sessions WHERE id=${identity.sessionId} AND principal_id=${identity.principalId} AND revoked_at IS NULL AND absolute_expires_at>${this.store.now()} AND last_seen_at>${new Date(this.store.now().getTime() - IDLE_MS)} FOR UPDATE`;
			if (!sessions.length) throw new MerchantError("UNAUTHORIZED", "Sign in again.", 401);
			const member = await this.store.membership(
				tx,
				identity.principalId,
				row.scope.organizationSlug,
				true,
			);
			requireCapability(member.role, row.capability);
			const grants =
				await tx`SELECT id FROM platform_mcp_authorizations WHERE id=${row.authorization_id} AND revoked_at IS NULL AND expires_at>${this.store.now()} FOR UPDATE`;
			if (!grants.length)
				throw new MerchantError("MCP_AUTHORIZATION_REVOKED", "Reconnect Quotum.", 401);
			if (approve && row.sensitive)
				await new MerchantStepUp(this.store).consume(
					tx,
					identity,
					row.scope,
					row.step_up_action,
					mutationTarget("POST", `/api/platform/mcp/changes/${id}/approve`, {
						requestHash: row.request_hash,
					}),
					stepUpToken,
				);
			await tx`UPDATE platform_mcp_changes SET status=${approve ? "applying" : "rejected"} WHERE id=${id}`;
			await this.store.audit(
				tx,
				identity.principalId,
				member.organization_id,
				approve ? "mcp.change_approved" : "mcp.change_rejected",
				id,
				{ action: row.action },
			);
			return approve;
		});
		if (!claimed) return this.browserGet(identity, id);
		try {
			const result = await this.port.apply(access.context, saved.preview, `mcp:${id}`);
			const status =
				result.status < 400
					? "completed"
					: result.status === 409
						? "stale"
						: result.status >= 500
							? "needs_review"
							: "failed";
			await this.store.sql.begin(async (tx) => {
				await tx`UPDATE platform_mcp_changes SET status=${status},result=${JSON.stringify(result)}::jsonb,applied_at=now() WHERE id=${id}`;
				await this.store.audit(
					tx,
					identity.principalId,
					access.grant.organization_id,
					"mcp.change_result",
					id,
					{ action: saved.action, status },
				);
			});
		} catch {
			await this.store
				.sql`UPDATE platform_mcp_changes SET status='needs_review' WHERE id=${id} AND status='applying'`;
		}
		return this.browserGet(identity, id);
	}
}
