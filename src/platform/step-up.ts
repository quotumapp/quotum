import type { MerchantScope, StepUpChallengeView } from "./contracts";
import type { MerchantSql } from "./database";
import { type MerchantSecondFactor, notEnrolled } from "./second-factor";
import {
	digest,
	IDLE_MS,
	MerchantError,
	randomToken,
	requireCapability,
	STEP_UP_MS,
	safeReturnTo,
} from "./security";
import type { MerchantIdentity, MerchantStore } from "./store";

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object")
		return `{${Object.keys(value)
			.sort()
			.map(
				(key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
			)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
export function mutationTarget(method: string, pathname: string, body: unknown): string {
	return `${method} ${pathname} ${digest(canonicalJson(body))}`;
}
// Issuing, replacing and withdrawing a key share one capability; each stays its own action so a
// grant confirmed for one can never authorize another.
const credentialActions: ReadonlySet<string> = new Set([
	"credentials.rotate",
	"credentials.rotate_read_only",
	"credentials.revoke_read_only",
]);
export function actionCapability(action: string, environment: MerchantScope["environment"]) {
	// Webhook endpoints are managed like connections, but through the billing proxy, so their
	// grants bind a billing request rather than a saved setup operation.
	if (action === "connections.manage" || action === "webhooks.manage")
		return environment === "production" ? "production.connections.manage" : "sandbox.configure";
	if (credentialActions.has(action))
		return environment === "production"
			? "production.credentials.rotate"
			: "sandbox.credentials.rotate";
	if (action === "catalog.publish")
		return environment === "production" ? "catalog.publish.production" : "catalog.publish.sandbox";
	if (action === "operations.recover") return "operations.recover";
	if (action === "operations.write") return "operations.write";
	throw new MerchantError(
		"ACTION_REJECTED",
		"This action does not support step-up authentication.",
	);
}
interface ChallengeRow {
	id: string;
	session_id: string;
	scope: MerchantScope;
	action: string;
	target: string;
	return_to: string;
	request: StepUpChallengeView["request"] | null;
	expires_at: Date;
	created_at: Date;
	verified_at: Date | null;
	consumed_at: Date | null;
	failed_attempts: number;
}
/** Wrong codes one challenge takes before it is closed; the account lockout counts them too. */
const MAX_CHALLENGE_ATTEMPTS = 5;
export class MerchantStepUp {
	constructor(
		private readonly store: MerchantStore,
		private readonly secondFactor: MerchantSecondFactor,
	) {}
	async create(
		identity: MerchantIdentity,
		key: string,
		input: {
			scope: MerchantScope;
			action: string;
			target: string;
			returnTo: string;
			request?: StepUpChallengeView["request"];
		},
	): Promise<StepUpChallengeView> {
		const setupTarget =
			input.action === "connections.manage"
				? /^(?:[0-9a-f-]{36}|disable:(?:stripe|apple|google|paddle|projection):[0-9]+)$/
				: credentialActions.has(input.action)
					? /^[A-Za-z0-9._:-]{8,128}$/
					: /^(?:(POST|PUT|PATCH|DELETE) \/api\/billing\/[^ ]+|POST \/api\/platform\/mcp\/changes\/[0-9a-f-]{36}\/approve) [a-f0-9]{64}$/;
		if (!setupTarget.test(input.target))
			throw new MerchantError("ACTION_REJECTED", "Confirm a saved operation identifier.");
		if (
			input.request &&
			(input.action === "connections.manage" || credentialActions.has(input.action))
		)
			throw new MerchantError(
				"REQUEST_REJECTED",
				"Confirm the saved setup operation without including credentials.",
			);
		if (
			input.request &&
			mutationTarget(input.request.method, input.request.path, input.request.body) !== input.target
		)
			throw new MerchantError(
				"ACTION_MISMATCH",
				"The saved request must match the reviewed action.",
				409,
			);
		// A challenge is confirmed with a code from the person's authenticator, so one without an
		// authenticator is told to set it up now rather than after the challenge has been stored.
		if (!(await this.secondFactor.isEnrolled(identity.authUserId))) throw notEnrolled();
		return this.store.idempotent(identity, key, ["step-up.create", input], async (tx) => {
			const member = await this.store.membership(
				tx,
				identity.principalId,
				input.scope.organizationSlug,
				true,
			);
			requireCapability(member.role, actionCapability(input.action, input.scope.environment));
			const [logicalProject] = await tx<
				{ id: string }[]
			>`SELECT id FROM platform_projects WHERE organization_id=${member.organization_id} AND key=${input.scope.projectKey}`;
			const instances = logicalProject
				? (await tx.instances.forProject(logicalProject.id)).filter(
						(i) =>
							i.environment === input.scope.environment &&
							i.lifecycleStatus === "active" &&
							!i.internalProject,
					)
				: [];
			if (!instances.length)
				throw new MerchantError(
					"CONTEXT_UNAVAILABLE",
					"The selected environment is not active.",
					404,
				);
			// A challenge is a stored row, and a member could otherwise create them without bound.
			// Charged after the capability and scope checks, inside the transaction, so a replay or
			// a refused request spends nothing.
			await this.store.rateLimit(`step-up:principal:${identity.principalId}`, 30, 15 * 60_000, tx);
			const expires = new Date(this.store.now().getTime() + STEP_UP_MS);
			// Dated by the application clock, like the proof that must follow it: the column default
			// is the database clock, and a host clock behind it would reject every fresh proof.
			const [row] = await tx<
				{ id: string }[]
			>`INSERT INTO platform_step_up_grants(session_id,organization_id,scope,action,target,return_to,request,expires_at,created_at) VALUES(${identity.sessionId},${member.organization_id},${JSON.stringify(input.scope)}::text::jsonb,${input.action},${input.target},${safeReturnTo(input.returnTo)},${JSON.stringify(input.request ?? null)}::text::jsonb,${expires},${this.store.now()}) RETURNING id`;
			if (!row) throw new Error("Challenge insert failed");
			return {
				id: row.id,
				factor: "totp" as const,
				action: input.action,
				target: input.target,
				scope: input.scope,
				expiresAt: expires.toISOString(),
				returnTo: safeReturnTo(input.returnTo),
				...(input.request ? { request: input.request } : {}),
			};
		});
	}
	private async record(
		tx: MerchantSql,
		identity: MerchantIdentity,
		id: string,
	): Promise<ChallengeRow> {
		const [row] = await tx<
			ChallengeRow[]
		>`SELECT * FROM platform_step_up_grants WHERE id=${id} AND session_id=${identity.sessionId}`;
		if (
			!row ||
			row.expires_at <= this.store.now() ||
			row.consumed_at ||
			row.failed_attempts >= MAX_CHALLENGE_ATTEMPTS
		)
			throw new MerchantError(
				"STEP_UP_EXPIRED",
				"This confirmation has expired. Review the action and try again.",
				409,
			);
		return row;
	}
	async view(identity: MerchantIdentity, id: string): Promise<StepUpChallengeView> {
		const row = await this.record(this.store.sql, identity, id);
		return {
			id: row.id,
			factor: "totp" as const,
			action: row.action,
			target: row.target,
			scope: row.scope,
			expiresAt: row.expires_at.toISOString(),
			returnTo: row.return_to,
			...(row.request ? { request: row.request } : {}),
		};
	}
	async complete(
		identity: MerchantIdentity,
		id: string,
		code: string,
	): Promise<{ grant: string; token: string; csrf: string; expiresAt: string }> {
		const challenge = await this.record(this.store.sql, identity, id);
		if (challenge.verified_at)
			throw new MerchantError("STEP_UP_USED", "This confirmation has already been completed.", 409);
		try {
			await this.secondFactor.verifyCode(identity.authUserId, code);
		} catch (error) {
			// A wrong code is charged to this challenge on a statement of its own, so the charge
			// survives the refusal that follows.
			if (
				error instanceof MerchantError &&
				(error.code === "INVALID_CODE" || error.code === "CODE_ALREADY_USED")
			)
				await this.store
					.sql`UPDATE platform_step_up_grants SET failed_attempts=failed_attempts+1 WHERE id=${id} AND session_id=${identity.sessionId}`;
			throw error;
		}
		return this.store.sql.begin(async (tx) => {
			const sessions =
				await tx`SELECT id FROM platform_merchant_sessions WHERE id=${identity.sessionId} AND revoked_at IS NULL AND absolute_expires_at>${this.store.now()} AND last_seen_at>${new Date(this.store.now().getTime() - IDLE_MS)} FOR UPDATE`;
			if (!sessions.length)
				throw new MerchantError("SESSION_EXPIRED", "Your session expired. Sign in again.", 401);
			await tx`SELECT id FROM platform_step_up_grants WHERE id=${id} FOR UPDATE`;
			const locked = await this.record(tx, identity, id);
			if (locked.verified_at)
				throw new MerchantError(
					"STEP_UP_USED",
					"This confirmation has already been completed.",
					409,
				);
			const member = await this.store.membership(
				tx,
				identity.principalId,
				locked.scope.organizationSlug,
				true,
			);
			requireCapability(member.role, actionCapability(locked.action, locked.scope.environment));
			const token = randomToken();
			const csrf = randomToken();
			const grant = randomToken();
			const expires = new Date(this.store.now().getTime() + STEP_UP_MS);
			await tx`UPDATE platform_merchant_sessions SET token_hash=${this.store.hash(token)},csrf_hash=${this.store.hash(csrf)},last_seen_at=${this.store.now()} WHERE id=${identity.sessionId} AND revoked_at IS NULL`;
			await tx`UPDATE platform_step_up_grants SET token_hash=${this.store.hash(grant)},verified_at=${this.store.now()},expires_at=${expires} WHERE id=${id}`;
			await this.store.audit(
				tx,
				identity.principalId,
				member.organization_id,
				"step_up.completed",
				id,
				{ action: locked.action, environment: locked.scope.environment },
			);
			return { token, csrf, grant, expiresAt: expires.toISOString() };
		});
	}
}

/**
 * Spends a verified grant on the one action it was issued for. It runs inside the guarded work's
 * transaction, so a rollback gives the grant back.
 */
export async function consumeStepUpGrant(
	store: MerchantStore,
	tx: MerchantSql,
	identity: MerchantIdentity,
	scope: MerchantScope,
	action: string,
	target: string,
	token: string | null,
): Promise<void> {
	if (!token)
		throw new MerchantError(
			"STEP_UP_REQUIRED",
			"Confirm your identity before performing this action.",
			403,
		);
	const rows =
		await tx`UPDATE platform_step_up_grants SET consumed_at=${store.now()} WHERE token_hash=${store.hash(token)} AND session_id=${identity.sessionId} AND scope=${JSON.stringify(scope)}::text::jsonb AND action=${action} AND target=${target} AND verified_at IS NOT NULL AND consumed_at IS NULL AND expires_at>${store.now()} RETURNING id`;
	if (!rows.length)
		throw new MerchantError(
			"STEP_UP_EXPIRED",
			"This confirmation expired or does not match the action. Review it and confirm again.",
			409,
		);
}
