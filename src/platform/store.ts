import { insertPlatformAuditEvent } from "./audit";
import type { MerchantConfig } from "./config";
import type {
	MerchantAuthMethod,
	MerchantMembershipView,
	MerchantRole,
	MerchantScope,
	MerchantSessionView,
	OnboardingDraftView,
} from "./contracts";
import type { MerchantSql } from "./database";
import type { PlatformQueryExecutor } from "./persistence/query-executor";
import {
	ABSOLUTE_MS,
	CSRF_COOKIE,
	capabilitiesFor,
	cookieValue,
	digest,
	IDLE_MS,
	MerchantError,
	randomToken,
	SESSION_COOKIE,
	SESSION_TOUCH_MS,
	tokenHash,
} from "./security";

export interface MerchantIdentity {
	principalId: string;
	authUserId: string;
	sessionId: string;
	name: string;
	email: string;
	authMethod: MerchantAuthMethod;
	issuer: string;
	subject: string;
	createdAt: Date;
	lastSeenAt: Date;
	absoluteExpiresAt: Date;
}
interface MerchantSessionRow {
	id: string;
	principal_id: string;
	auth_user_id: string;
	name: string;
	email: string;
	auth_method: MerchantAuthMethod;
	issuer: string;
	subject: string;
	created_at: Date;
	last_seen_at: Date;
	absolute_expires_at: Date;
	csrf_hash: string;
}
export interface MembershipRecord {
	id: string;
	organization_id: string;
	principal_id: string;
	role: MerchantRole;
	revision: number;
	name: string;
	slug: string;
	member_limit: number;
}
/** A billing dispatch outcome, stored so an idempotent repeat can be answered without re-running. */
export interface StoredDispatchResponse {
	status: number;
	body: unknown;
}
type StoredDispatch =
	| { state: "pending" }
	| { state: "completed"; response: StoredDispatchResponse };
export class MerchantStore {
	readonly sql: MerchantSql;
	constructor(
		sql: MerchantSql,
		readonly config: MerchantConfig,
		readonly now: () => Date = () => new Date(),
	) {
		this.sql = sql;
	}
	hash(value: string): string {
		return tokenHash(value, this.config.secret);
	}
	async audit(
		executor: PlatformQueryExecutor,
		principal: string | null,
		organization: string | null,
		action: string,
		target: string | null,
		metadata: Record<string, unknown> = {},
	): Promise<void> {
		await insertPlatformAuditEvent(executor, {
			principalId: principal,
			organizationId: organization,
			action,
			target,
			metadata,
		});
	}
	async createServicePrincipal(name: string): Promise<string> {
		const token = randomToken();
		await this
			.sql`INSERT INTO platform_service_principals(name,token_hash) VALUES(${name},${this.hash(token)})`;
		return token;
	}
	async serviceAuthorized(token: string | null): Promise<boolean> {
		if (!token) return false;
		const rows = await this
			.sql`SELECT id FROM platform_service_principals WHERE token_hash=${this.hash(token)} AND active=true`;
		return rows.length === 1;
	}
	async rateLimit(key: string, limit: number, windowMs: number): Promise<void> {
		const now = this.now();
		const [row] = await this.sql<
			{ count: number; reset_at: Date }[]
		>`INSERT INTO platform_rate_limits(key_hash,count,reset_at) VALUES(${this.hash(key)},1,${new Date(now.getTime() + windowMs)}) ON CONFLICT(key_hash) DO UPDATE SET count=CASE WHEN platform_rate_limits.reset_at<=${now} THEN 1 ELSE platform_rate_limits.count+1 END, reset_at=CASE WHEN platform_rate_limits.reset_at<=${now} THEN EXCLUDED.reset_at ELSE platform_rate_limits.reset_at END RETURNING count,reset_at`;
		if (row && row.count > limit)
			throw new MerchantError(
				"RATE_LIMITED",
				"Too many attempts. Please try again later.",
				429,
				Math.max(1, Math.ceil((row.reset_at.getTime() - now.getTime()) / 1000)),
			);
	}
	async registerLink(
		token: string,
		kind: "verification" | "reset" | "signup" | "invitation",
		expiresMs: number,
		payload: Record<string, unknown> = {},
	): Promise<void> {
		await this
			.sql`INSERT INTO platform_auth_links(token_hash,kind,payload,expires_at) VALUES(${this.hash(token)},${kind},${JSON.stringify(payload)}::text::jsonb,${new Date(this.now().getTime() + expiresMs)}) ON CONFLICT(token_hash) DO NOTHING`;
	}
	async releaseRateLimit(key: string): Promise<void> {
		await this
			.sql`UPDATE platform_rate_limits SET count=greatest(count-1,0) WHERE key_hash=${this.hash(key)} AND reset_at>${this.now()}`;
	}
	async consumeLink(
		token: string,
		kind: "verification" | "reset" | "signup",
	): Promise<Record<string, unknown>> {
		const [link] = await this.sql<
			{ payload: Record<string, unknown> }[]
		>`UPDATE platform_auth_links SET consumed_at=${this.now()} WHERE token_hash=${this.hash(token)} AND kind=${kind} AND consumed_at IS NULL AND expires_at>${this.now()} RETURNING payload`;
		if (!link)
			throw new MerchantError(
				"LINK_EXPIRED",
				"This link has expired or has already been used.",
				410,
			);
		return link.payload;
	}
	async readLink(
		token: string,
		kind: "signup" | "invitation",
	): Promise<Record<string, unknown> | null> {
		const [row] = await this.sql<
			{ payload: Record<string, unknown> }[]
		>`SELECT payload FROM platform_auth_links WHERE token_hash=${this.hash(token)} AND kind=${kind} AND consumed_at IS NULL AND expires_at>${this.now()}`;
		return row?.payload ?? null;
	}
	async authenticate(request: Request): Promise<MerchantIdentity> {
		const raw = cookieValue(request.headers, SESSION_COOKIE);
		if (!raw) throw new MerchantError("SESSION_REQUIRED", "Sign in to continue.", 401);
		const row = await this.touchSession(this.hash(raw), this.now());
		if (!row)
			throw new MerchantError(
				"SESSION_EXPIRED",
				"Your session expired after 30 minutes of inactivity or 12 hours. Sign in again.",
				401,
			);
		if (request.method !== "GET" && request.method !== "HEAD") {
			const csrf = cookieValue(request.headers, CSRF_COOKIE);
			if (!csrf || this.hash(csrf) !== row.csrf_hash)
				throw new MerchantError("CSRF_REJECTED", "Refresh this page and try again.", 403);
		}
		return {
			principalId: row.principal_id,
			authUserId: row.auth_user_id,
			sessionId: row.id,
			name: row.name,
			email: row.email,
			authMethod: row.auth_method,
			issuer: row.issuer,
			subject: row.subject,
			createdAt: row.created_at,
			lastSeenAt: row.last_seen_at,
			absoluteExpiresAt: row.absolute_expires_at,
		};
	}
	private async readValidSession(hash: string, now: Date): Promise<MerchantSessionRow | undefined> {
		const [row] = await this.sql<
			MerchantSessionRow[]
		>`SELECT s.*,p.auth_user_id,u.name,u.email FROM platform_merchant_sessions s JOIN platform_principals p ON s.principal_id=p.id JOIN platform_auth_users u ON p.auth_user_id=u.id WHERE s.token_hash=${hash} AND p.status='active' AND s.revoked_at IS NULL AND s.absolute_expires_at>${now} AND s.last_seen_at>${new Date(now.getTime() - IDLE_MS)}`;
		return row;
	}
	private async touchSession(hash: string, now: Date): Promise<MerchantSessionRow | undefined> {
		const row = await this.readValidSession(hash, now);
		const cutoff = new Date(now.getTime() - SESSION_TOUCH_MS);
		if (!row || row.last_seen_at > cutoff) return row;
		// Recheck validity and the interval under the UPDATE row lock. Concurrent requests
		// can read the same old timestamp, but only one must write at this boundary.
		const [updated] = await this.sql<
			MerchantSessionRow[]
		>`UPDATE platform_merchant_sessions s SET last_seen_at=${now} FROM platform_principals p,platform_auth_users u WHERE s.token_hash=${hash} AND s.principal_id=p.id AND p.auth_user_id=u.id AND p.status='active' AND s.revoked_at IS NULL AND s.absolute_expires_at>${now} AND s.last_seen_at>${new Date(now.getTime() - IDLE_MS)} AND s.last_seen_at<=${cutoff} RETURNING s.*,p.auth_user_id,u.name,u.email`;
		// A missed update can mean a concurrent touch, revocation, rotation or deactivation.
		// Never authorize from the stale first read. Re-read through the same validity checks.
		return updated ?? this.readValidSession(hash, this.now());
	}
	async exchange(
		authToken: string,
		previousToken: string | null = null,
	): Promise<{ token: string; csrf: string; principalId: string }> {
		const now = this.now();
		const token = randomToken();
		const csrf = randomToken();
		return this.sql.begin(async (tx) => {
			const [proof] = await tx<
				{
					id: string;
					user_id: string;
					auth_method: MerchantAuthMethod;
					auth_issuer: string;
					auth_subject: string;
					email_verified: boolean;
					terms_version: string | null;
					privacy_version: string | null;
				}[]
			>`SELECT s.*,u.email_verified,u.terms_version,u.privacy_version FROM platform_auth_sessions s JOIN platform_auth_users u ON u.id=s.user_id WHERE s.token=${authToken} AND s.expires_at>${now} AND s.proof_at>${new Date(now.getTime() - 5 * 60_000)} AND s.mcp_request_hash IS NULL FOR UPDATE OF s`;
			if (!proof?.auth_method || !proof.email_verified)
				throw new MerchantError(
					"AUTHENTICATION_INCOMPLETE",
					"Complete sign-in before continuing.",
					401,
				);
			const [principal] = await tx<
				{ id: string; status: string }[]
			>`INSERT INTO platform_principals(auth_user_id) VALUES(${proof.user_id}) ON CONFLICT(auth_user_id) DO UPDATE SET auth_user_id=EXCLUDED.auth_user_id RETURNING id,status`;
			if (principal?.status !== "active")
				throw new MerchantError("ACCESS_REMOVED", "Your access has been removed.", 403);
			const [identity] = await tx<
				{ principal_id: string }[]
			>`INSERT INTO platform_external_identities(principal_id,issuer,subject) VALUES(${principal.id},${proof.auth_issuer},${proof.auth_subject}) ON CONFLICT(issuer,subject) DO UPDATE SET issuer=EXCLUDED.issuer RETURNING principal_id`;
			if (identity?.principal_id !== principal.id)
				throw new MerchantError("IDENTITY_CONFLICT", "This identity cannot be linked.", 409);
			if (proof.terms_version && proof.privacy_version)
				await tx`INSERT INTO platform_policy_acceptances(principal_id,terms_version,privacy_version) VALUES(${principal.id},${proof.terms_version},${proof.privacy_version}) ON CONFLICT DO NOTHING`;
			if (previousToken)
				await tx`UPDATE platform_merchant_sessions SET revoked_at=${now} WHERE token_hash=${this.hash(previousToken)} AND revoked_at IS NULL`;
			await tx`INSERT INTO platform_merchant_sessions(principal_id,token_hash,csrf_hash,auth_method,issuer,subject,created_at,last_seen_at,absolute_expires_at) VALUES(${principal.id},${this.hash(token)},${this.hash(csrf)},${proof.auth_method},${proof.auth_issuer},${proof.auth_subject},${now},${now},${new Date(now.getTime() + ABSOLUTE_MS)})`;
			await tx`DELETE FROM platform_auth_sessions WHERE id=${proof.id}`;
			await tx`UPDATE platform_auth_accounts SET access_token=NULL,refresh_token=NULL,id_token=NULL WHERE user_id=${proof.user_id} AND provider_id='google'`;
			await this.audit(tx, principal.id, null, "session.created", null, {
				method: proof.auth_method,
			});
			return { token, csrf, principalId: principal.id };
		});
	}
	async memberships(principal: string): Promise<MerchantMembershipView[]> {
		const rows = await this.sql<
			{ id: string; organization_id: string; name: string; slug: string; role: MerchantRole }[]
		>`SELECT m.id,m.organization_id,o.name,o.slug,m.role FROM platform_memberships m JOIN platform_organizations o ON o.id=m.organization_id WHERE m.principal_id=${principal} AND m.status='active' AND o.status='active' ORDER BY o.name,m.id`;
		return rows.map((r) => ({
			id: r.id,
			organizationId: r.organization_id,
			organizationName: r.name,
			organizationSlug: r.slug,
			role: r.role,
			capabilities: capabilitiesFor(r.role),
		}));
	}
	async membership(
		executor: PlatformQueryExecutor,
		principal: string,
		slug: string,
		lock = false,
	): Promise<MembershipRecord> {
		// Organization locks serialize seat checks and member administration; membership locks enforce revocation.
		if (lock)
			await executor.query({
				text: "SELECT id FROM platform_organizations WHERE slug = $1 FOR UPDATE",
				values: [slug],
			});
		const rows = lock
			? await executor.query<MembershipRecord>({
					text: `
						SELECT m.*, o.name, o.slug, o.member_limit
						FROM platform_memberships m
						JOIN platform_organizations o ON o.id = m.organization_id
						WHERE m.principal_id = $1
							AND o.slug = $2
							AND m.status = 'active'
							AND o.status = 'active'
						FOR UPDATE OF m
					`,
					values: [principal, slug],
				})
			: await executor.query<MembershipRecord>({
					text: `
						SELECT m.*, o.name, o.slug, o.member_limit
						FROM platform_memberships m
						JOIN platform_organizations o ON o.id = m.organization_id
						WHERE m.principal_id = $1
							AND o.slug = $2
							AND m.status = 'active'
							AND o.status = 'active'
					`,
					values: [principal, slug],
				});
		if (!rows[0])
			throw new MerchantError("FORBIDDEN", "You no longer have access to this organization.", 403);
		return rows[0];
	}
	async membershipByOrganizationId(
		executor: PlatformQueryExecutor,
		principal: string,
		organizationId: string,
	): Promise<MembershipRecord> {
		await executor.query({
			text: "SELECT id FROM platform_organizations WHERE id = $1 FOR UPDATE",
			values: [organizationId],
		});
		const rows = await executor.query<MembershipRecord>({
			text: `
				SELECT m.*, o.name, o.slug, o.member_limit
				FROM platform_memberships m
				JOIN platform_organizations o ON o.id = m.organization_id
				WHERE m.principal_id = $1
					AND o.id = $2
					AND m.status = 'active'
					AND o.status = 'active'
				FOR UPDATE OF m
			`,
			values: [principal, organizationId],
		});
		if (!rows[0])
			throw new MerchantError("FORBIDDEN", "You no longer have access to this organization.", 403);
		return rows[0];
	}
	async draft(
		principal: string,
		executor: PlatformQueryExecutor = this.sql,
	): Promise<OnboardingDraftView | null> {
		const [row] = await executor.query<{
			id: string;
			organization_id: string | null;
			name: string | null;
			slug: string | null;
			project_name: string | null;
			project_key: string | null;
			revision: number;
			status: OnboardingDraftView["status"];
			operation_id: string | null;
		}>({
			text: `
				SELECT d.*, o.name, o.slug, p.id AS operation_id
				FROM platform_onboarding_drafts d
				LEFT JOIN platform_organizations o ON o.id = d.organization_id
				LEFT JOIN platform_provisioning_operations p ON p.draft_id = d.id
				WHERE d.principal_id = $1
			`,
			values: [principal],
		});
		if (!row) return null;
		return {
			id: row.id,
			organization:
				row.organization_id && row.name && row.slug
					? { id: row.organization_id, name: row.name, slug: row.slug }
					: null,
			project:
				row.project_name && row.project_key
					? { name: row.project_name, key: row.project_key }
					: null,
			revision: row.revision,
			status: row.status,
			operationId: row.operation_id,
		};
	}
	async view(
		identity: MerchantIdentity,
		csrf: string,
		context: MerchantScope | null = null,
	): Promise<MerchantSessionView> {
		const memberships = await this.memberships(identity.principalId);
		// One statement however many projects the principal sees; a query per project would fan out
		// over the connection pool the /v1 API shares.
		const projects = (await this.sql.instances.forPrincipal(identity.principalId)).map((p) => ({
			id: p.id,
			key: p.key,
			name: p.name,
			organizationSlug: p.organizationSlug,
			environments: p.instances
				.filter((i) => i.environment !== "internal")
				.map((i) => ({
					environment: i.environment as "sandbox" | "production",
					active: i.lifecycleStatus === "active",
				})),
		}));
		const validContext =
			context &&
			projects.some(
				(p) =>
					p.key === context.projectKey &&
					p.organizationSlug === context.organizationSlug &&
					p.environments.some((e) => e.environment === context.environment && e.active),
			)
				? context
				: null;
		return {
			pendingInvitation: false,
			principal: { id: identity.principalId, name: identity.name, email: identity.email },
			authMethod: identity.authMethod,
			idleExpiresAt: new Date(
				Math.min(identity.lastSeenAt.getTime() + IDLE_MS, identity.absoluteExpiresAt.getTime()),
			).toISOString(),
			absoluteExpiresAt: identity.absoluteExpiresAt.toISOString(),
			memberships,
			projects,
			context: validContext,
			onboarding: await this.draft(identity.principalId),
			csrfToken: csrf,
		};
	}
	async logout(identity: MerchantIdentity): Promise<void> {
		await this.sql.begin(async (tx) => {
			await tx`UPDATE platform_merchant_sessions SET revoked_at=${this.now()} WHERE id=${identity.sessionId}`;
			await this.audit(tx, identity.principalId, null, "session.revoked", identity.sessionId);
		});
	}
	async idempotent<T>(
		identity: MerchantIdentity,
		key: string,
		input: unknown,
		operation: (tx: MerchantSql) => Promise<T>,
	): Promise<T> {
		const requestHash = digest(JSON.stringify(input));
		return this.sql.begin(async (tx) => {
			// Check the session inside the same transaction as the mutation. Logout/revocation cannot race through.
			const sessions =
				await tx`SELECT id FROM platform_merchant_sessions WHERE id=${identity.sessionId} AND revoked_at IS NULL AND absolute_expires_at>${this.now()} AND last_seen_at>${new Date(this.now().getTime() - IDLE_MS)} FOR UPDATE`;
			if (!sessions.length)
				throw new MerchantError("SESSION_EXPIRED", "Sign in again to continue.", 401);
			await tx`INSERT INTO platform_idempotency(principal_id,key,request_hash) VALUES(${identity.principalId},${key},${requestHash}) ON CONFLICT DO NOTHING`;
			const [row] = await tx<
				{ request_hash: string; result: T | null }[]
			>`SELECT request_hash,result FROM platform_idempotency WHERE principal_id=${identity.principalId} AND key=${key} FOR UPDATE`;
			if (!row || row.request_hash !== requestHash)
				throw new MerchantError(
					"IDEMPOTENCY_CONFLICT",
					"Use a new idempotency key when the action changes.",
					409,
				);
			if (row.result !== null) return row.result;
			const result = await operation(tx);
			await tx`UPDATE platform_idempotency SET result=${JSON.stringify(result)}::text::jsonb WHERE principal_id=${identity.principalId} AND key=${key}`;
			return result;
		});
	}
	/**
	 * Idempotency for work that runs outside the platform transaction, such as a billing dispatch.
	 * The first request for a key runs `authorize` inside the claim transaction and commits a pending
	 * claim; `dispatch` then runs once and its response is stored. A repeat with the same principal,
	 * key and input gets the stored response without authorizing or dispatching again, and a repeat
	 * while the claim is pending gets 409 OPERATION_IN_PROGRESS. A dispatch that throws or answers
	 * 5xx releases the key, so a retry authorizes again, including a fresh step-up grant.
	 */
	async idempotentDispatch(
		identity: MerchantIdentity,
		key: string,
		input: unknown,
		authorize: (tx: MerchantSql) => Promise<void>,
		dispatch: () => Promise<StoredDispatchResponse>,
	): Promise<StoredDispatchResponse> {
		const requestHash = digest(JSON.stringify(input));
		const stored = await this.sql.begin(async (tx) => {
			const sessions =
				await tx`SELECT id FROM platform_merchant_sessions WHERE id=${identity.sessionId} AND revoked_at IS NULL AND absolute_expires_at>${this.now()} AND last_seen_at>${new Date(this.now().getTime() - IDLE_MS)} FOR UPDATE`;
			if (!sessions.length)
				throw new MerchantError("SESSION_EXPIRED", "Sign in again to continue.", 401);
			await tx`INSERT INTO platform_idempotency(principal_id,key,request_hash) VALUES(${identity.principalId},${key},${requestHash}) ON CONFLICT DO NOTHING`;
			const [row] = await tx<
				{ request_hash: string; result: StoredDispatch | null }[]
			>`SELECT request_hash,result FROM platform_idempotency WHERE principal_id=${identity.principalId} AND key=${key} FOR UPDATE`;
			if (!row || row.request_hash !== requestHash)
				throw new MerchantError(
					"IDEMPOTENCY_CONFLICT",
					"Use a new idempotency key when the action changes.",
					409,
				);
			if (row.result?.state === "completed") return row.result.response;
			if (row.result !== null)
				throw new MerchantError(
					"OPERATION_IN_PROGRESS",
					"This action is still running. Retry the same request shortly.",
					409,
				);
			await authorize(tx);
			const pending: StoredDispatch = { state: "pending" };
			await tx`UPDATE platform_idempotency SET result=${JSON.stringify(pending)}::text::jsonb WHERE principal_id=${identity.principalId} AND key=${key}`;
			return null;
		});
		if (stored !== null) return stored;
		let response: StoredDispatchResponse;
		try {
			response = await dispatch();
		} catch (error) {
			await this.releaseDispatch(identity, key, requestHash);
			throw error;
		}
		if (response.status >= 500) {
			await this.releaseDispatch(identity, key, requestHash);
			return response;
		}
		const completed: StoredDispatch = {
			state: "completed",
			response: { status: response.status, body: response.body },
		};
		await this
			.sql`UPDATE platform_idempotency SET result=${JSON.stringify(completed)}::text::jsonb WHERE principal_id=${identity.principalId} AND key=${key} AND request_hash=${requestHash} AND result->>'state'='pending'`;
		return response;
	}
	private async releaseDispatch(
		identity: MerchantIdentity,
		key: string,
		requestHash: string,
	): Promise<void> {
		await this
			.sql`DELETE FROM platform_idempotency WHERE principal_id=${identity.principalId} AND key=${key} AND request_hash=${requestHash} AND result->>'state'='pending'`;
	}
}
