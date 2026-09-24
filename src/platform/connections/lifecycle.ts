import { randomUUID } from "node:crypto";
import type { CredentialAccess } from "../../shared/credential-access";
import type { PlatformProjectInstanceRecord } from "../application/ports";
import { insertPlatformAuditEvent } from "../audit";
import type { MerchantCapability } from "../contracts";
import { generateProjectApiCredential } from "../credentials/project-api-token";
import type { MerchantSql } from "../database";
import { MerchantError, randomToken } from "../security";
import { canonicalJson } from "../step-up";
import type { StripeOAuthPort } from "./oauth-port";
import { resolveStripeOAuth } from "./oauth-runtime";
import type { ConnectionInput, ConnectionValidationPort } from "./ports";
import { type ConnectionKind, ConnectionRepository, type ConnectionVersion } from "./repository";

/** How long a validation stays fresh enough to commit a version or activate an environment. */
export const validationWindowMs = 900_000;

/** Who changes a connection or credential: a merchant member, or a named operator command. */
export type ConnectionActor =
	| { kind: "principal"; principalId: string }
	| { kind: "operator"; name: string };

/**
 * Access control for one target environment. The lifecycle calls each hook at a fixed point of
 * every transaction; the merchant gate checks membership, capabilities and production step-up there,
 * and an operator gate, holding direct database access already, only resolves and locks.
 */
export interface ConnectionGate {
	readonly actor: ConnectionActor;
	readonly environment: "sandbox" | "production";
	/** Resolves and authorizes the target instance. Every transaction calls it first. */
	instance(sql: MerchantSql, write: boolean): Promise<PlatformProjectInstanceRecord>;
	/** Serializes changes within the organization, optionally requiring a capability. */
	lock(tx: MerchantSql, capability?: MerchantCapability): Promise<void>;
	/** Confirms a change bound to `target` before it is written, e.g. with a production step-up. */
	confirm(tx: MerchantSql, action: string, target: string): Promise<void>;
	/** The organization that audit events record. */
	organizationId(tx: MerchantSql): Promise<string>;
}

export interface ConnectionLifecycleDependencies {
	readonly sql: MerchantSql;
	readonly repository: ConnectionRepository;
	readonly validator: ConnectionValidationPort;
	readonly oauth?: StripeOAuthPort | null;
	/** Keyed HMAC for request fingerprints and receipts. */
	hash(value: string): string;
	now(): Date;
}

/**
 * Connection and credential state changes without identity: drafts, validation, commits, disabling
 * and credential rotation. The data invariants live here (live drafts, validation freshness,
 * provider event verification for active production, decryptable secrets, Stripe account binding,
 * one live credential per access level); who may act is the gate's decision.
 */
export class ConnectionLifecycle {
	constructor(private readonly deps: ConnectionLifecycleDependencies) {}

	async list(gate: ConnectionGate) {
		const instance = await gate.instance(this.deps.sql, false);
		return { connections: await this.deps.repository.list(instance.id) };
	}

	async draft(
		gate: ConnectionGate,
		kind: ConnectionKind,
		key: string,
		input: ConnectionInput & { expectedRevision: number },
	) {
		const normalized = this.deps.validator.normalize(kind, gate.environment, input);
		const fingerprint = this.deps.hash(canonicalJson({ kind, ...input }));
		return this.deps.sql.begin(async (tx) => {
			const instance = await gate.instance(tx, true);
			await tx`INSERT INTO platform_connections(project_instance_id,kind) VALUES(${instance.id},${kind}) ON CONFLICT(project_instance_id,kind) DO NOTHING`;
			const [connection] = await tx<
				{ id: string; revision: number }[]
			>`SELECT id,revision FROM platform_connections WHERE project_instance_id=${instance.id} AND kind=${kind} FOR UPDATE`;
			if (!connection) throw new Error("Connection insert failed");
			const [existing] = await tx<
				{ id: string; request_fingerprint: string }[]
			>`SELECT id,request_fingerprint FROM platform_connection_versions WHERE connection_id=${connection.id} AND request_key=${key}`;
			if (existing) {
				if (existing.request_fingerprint !== fingerprint)
					throw new MerchantError(
						"IDEMPOTENCY_CONFLICT",
						"Use a new idempotency key for a different request.",
						409,
					);
				return { draftId: existing.id, secretDisclosed: false };
			}
			if (connection.revision !== input.expectedRevision)
				throw new MerchantError(
					"CONNECTION_CHANGED",
					"Refresh this connection before editing.",
					409,
				);
			const id = randomUUID();
			const generated = kind === "projection" ? randomToken() : undefined;
			if (generated) normalized.secrets.projectionSecret = generated;
			await tx`INSERT INTO platform_connection_versions(id,connection_id,project_instance_id,expected_revision,settings,request_key,request_fingerprint) VALUES(${id},${connection.id},${instance.id},${input.expectedRevision},${JSON.stringify(normalized.settings)}::text::jsonb,${key},${fingerprint})`;
			await this.deps.repository.saveSecrets(
				tx,
				{ id, connection_id: connection.id, project_instance_id: instance.id },
				normalized.secrets,
			);
			await this.audit(tx, gate, "connection.draft_created", id, { kind });
			return {
				draftId: id,
				secretDisclosed: generated !== undefined,
				...(generated ? { projectionSecret: generated } : {}),
			};
		});
	}

	async validate(gate: ConnectionGate, kind: ConnectionKind, id: string) {
		const instance = await gate.instance(this.deps.sql, true);
		const version = await this.deps.repository.version(instance.id, id);
		await this.assertKind(version, kind);
		if (version.status !== "active") this.assertDraft(version);
		const resolvedSecrets =
			version.settings.authMethod === "oauth" && this.deps.oauth
				? await resolveStripeOAuth(
						this.deps.repository,
						version,
						gate.environment,
						this.deps.oauth,
						this.deps.sql,
					)
				: await this.deps.repository.secrets(version);
		const result = await this.deps.validator.validate(
			kind,
			gate.environment,
			{ settings: version.settings, secrets: resolvedSecrets },
			{ instanceId: instance.id, instanceKey: instance.key, versionId: id },
		);
		if (kind === "stripe" && version.settings.authMethod === "oauth") {
			const evidence = await this.deps
				.sql`SELECT e.event_id FROM platform_stripe_app_events e JOIN platform_connection_versions v ON v.id=${id} WHERE e.account_id=${result.identity} AND e.livemode=${gate.environment === "production"} AND e.created_at>=v.created_at AND e.payload->>'type'<>'account.application.deauthorized' LIMIT 1`;
			result.eventVerified = evidence.length > 0;
		}
		if (result.checks.some((check) => !check.passed))
			throw new MerchantError(
				"CONNECTION_VALIDATION_FAILED",
				"Resolve the connection checks before continuing.",
				409,
			);
		return this.deps.sql.begin(async (tx) => {
			await gate.instance(tx, true);
			const updated =
				await tx`UPDATE platform_connection_versions SET status=CASE WHEN status='active' THEN 'active' ELSE 'validated' END,validation=${JSON.stringify(result)}::text::jsonb,validated_at=${this.deps.now()},external_identity=${result.identity},event_verified_at=CASE WHEN ${result.eventVerified} THEN ${this.deps.now()} WHEN external_identity IS NOT NULL AND external_identity<>${result.identity} THEN NULL ELSE event_verified_at END WHERE id=${id} AND project_instance_id=${instance.id} AND (status='active' OR (status IN ('draft','validated') AND expires_at>${this.deps.now()})) RETURNING id`;
			if (!updated.length)
				throw new MerchantError("CONNECTION_CHANGED", "Create a fresh connection draft.", 409);
			return { draftId: id, ...result };
		});
	}

	async commit(gate: ConnectionGate, kind: ConnectionKind, id: string, key: string) {
		return this.deps.sql.begin(async (tx) => {
			const instance = await gate.instance(tx, true);
			await gate.lock(tx);
			const receipt = await this.receipt(tx, instance.id, key, `commit:${id}`);
			if (receipt) return receipt;
			const version = await this.deps.repository.version(instance.id, id, tx);
			await this.assertKind(version, kind, tx);
			this.assertDraft(version);
			if (
				!version.validated_at ||
				version.validated_at.getTime() < this.deps.now().getTime() - validationWindowMs
			)
				throw new MerchantError(
					"CONNECTION_VALIDATION_REQUIRED",
					"Verify this connection again.",
					409,
				);
			if (
				gate.environment === "production" &&
				instance.lifecycleStatus === "active" &&
				kind !== "projection" &&
				!version.event_verified_at
			)
				throw new MerchantError(
					"PROVIDER_EVENT_REQUIRED",
					"Verify provider event delivery before enabling this production connection.",
					409,
				);
			await new ConnectionRepository(tx, this.deps.repository.cipher).secrets(version);
			if (kind === "stripe") {
				if (!version.external_identity)
					throw new MerchantError(
						"CONNECTION_VALIDATION_REQUIRED",
						"Verify the Stripe account first.",
						409,
					);
				await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${version.external_identity}:${gate.environment}`},0))`;
				const existing =
					await tx`SELECT id FROM platform_connections WHERE stripe_account_id=${version.external_identity} AND stripe_livemode=${gate.environment === "production"} AND id<>${version.connection_id}`;
				const changed =
					await tx`SELECT id FROM platform_connections WHERE id=${version.connection_id} AND stripe_account_id IS NOT NULL AND stripe_account_id<>${version.external_identity}`;
				if (existing.length || changed.length)
					throw new MerchantError(
						"STRIPE_ACCOUNT_CONFLICT",
						"This account is already assigned, or does not match the environment's existing account.",
						409,
					);
				await tx`UPDATE platform_connections SET stripe_account_id=${version.external_identity},stripe_livemode=${gate.environment === "production"} WHERE id=${version.connection_id}`;
			}
			await gate.confirm(tx, "connections.manage", id);
			const rows =
				await tx`UPDATE platform_connections SET active_version_id=${id},enabled=true,revision=revision+1,updated_at=${this.deps.now()} WHERE id=${version.connection_id} AND project_instance_id=${instance.id} AND revision=${version.expected_revision} RETURNING revision`;
			if (!rows.length)
				throw new MerchantError(
					"CONNECTION_CHANGED",
					"Refresh this connection before committing.",
					409,
				);
			await tx`UPDATE platform_connection_versions SET status='retired' WHERE connection_id=${version.connection_id} AND status='active' AND id<>${id}`;
			await tx`UPDATE platform_connection_versions SET status='active' WHERE id=${id}`;
			const result = {
				connectionId: version.connection_id,
				revision: Number(rows[0]?.revision),
				enabled: true,
			};
			await this.saveReceipt(tx, instance.id, key, `commit:${id}`, result);
			await this.audit(tx, gate, "connection.committed", version.connection_id, {
				kind,
				versionId: id,
			});
			return result;
		});
	}

	async disable(gate: ConnectionGate, kind: ConnectionKind, key: string, revision: number) {
		return this.deps.sql.begin(async (tx) => {
			const instance = await gate.instance(tx, true);
			await gate.lock(tx);
			const action = `disable:${kind}:${revision}`;
			const previous = await this.receipt(tx, instance.id, key, action);
			if (previous) return previous;
			await gate.confirm(tx, "connections.manage", action);
			const rows =
				await tx`UPDATE platform_connections SET enabled=false,revision=revision+1,updated_at=${this.deps.now()} WHERE project_instance_id=${instance.id} AND kind=${kind} AND revision=${revision} RETURNING id,revision`;
			if (!rows.length)
				throw new MerchantError("CONNECTION_CHANGED", "Refresh this connection.", 409);
			const result = { enabled: false, revision: Number(rows[0]?.revision) };
			await this.saveReceipt(tx, instance.id, key, action, result);
			await this.audit(tx, gate, "connection.disabled", String(rows[0]?.id), { kind, revision });
			return result;
		});
	}

	/**
	 * Replaces the instance's live credential of one kind, or issues the first read-only one. The two
	 * kinds never revoke each other. The receipt and the confirmation are bound to the kind, so a
	 * confirmation given for a read-only key cannot replace the backend's full key.
	 */
	async rotateCredential(gate: ConnectionGate, key: string, access: CredentialAccess = "full") {
		const receiptAction = access === "full" ? "credential.rotate" : `credential.rotate:${access}`;
		const confirmAction = access === "full" ? "credentials.rotate" : "credentials.rotate_read_only";
		let credential: string | null = null;
		const result = await this.deps.sql.begin(async (tx) => {
			const instance = await gate.instance(tx, true);
			await gate.lock(
				tx,
				gate.environment === "production"
					? "production.credentials.rotate"
					: "sandbox.credentials.rotate",
			);
			const saved = await this.receipt(tx, instance.id, key, receiptAction);
			if (saved) return saved;
			if (instance.lifecycleStatus !== "active")
				throw new MerchantError("ENVIRONMENT_INACTIVE", "Activate the environment first.", 409);
			await gate.confirm(tx, confirmAction, key);
			const generated = generateProjectApiCredential(gate.environment, access);
			const replaced = await tx<
				{ id: string }[]
			>`UPDATE platform_project_api_credentials SET revoked_at=${this.deps.now()} WHERE project_instance_id=${instance.id} AND access=${access} AND revoked_at IS NULL RETURNING id`;
			await tx`INSERT INTO platform_project_api_credentials(id,project_instance_id,audience,access,secret_verifier) VALUES(${generated.credentialId},${instance.id},'billing_api',${generated.access},${generated.secretVerifier})`;
			await this.audit(
				tx,
				gate,
				replaced.length === 0 ? "credential.issued" : "credential.rotated",
				instance.id,
				{ access },
			);
			const result = { access, credentialDisclosed: false };
			await this.saveReceipt(tx, instance.id, key, receiptAction, result);
			credential = generated.token;
			return result;
		});
		return {
			...result,
			credentialDisclosed: credential !== null,
			...(credential ? { credential } : {}),
		};
	}

	/** Whether the environment holds a live key of each kind, and since when. Never any key material. */
	async credentialStatus(gate: ConnectionGate) {
		const instance = await gate.instance(this.deps.sql, false);
		const rows = await this.deps.sql<
			{ access: CredentialAccess; created_at: Date }[]
		>`SELECT access, created_at FROM platform_project_api_credentials WHERE project_instance_id=${instance.id} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>${this.deps.now()})`;
		const kind = (access: CredentialAccess) => {
			const row = rows.find((candidate) => candidate.access === access);
			return { live: row !== undefined, issuedAt: row?.created_at.toISOString() ?? null };
		};
		return { full: kind("full"), readOnly: kind("read_only") };
	}

	/**
	 * Withdraws the read-only key without minting a replacement. The full key has no such operation:
	 * a backend without a key is an outage, so it is only ever replaced by `rotateCredential`.
	 */
	async revokeCredential(gate: ConnectionGate, key: string) {
		const access: CredentialAccess = "read_only";
		const receiptAction = `credential.revoke:${access}`;
		return await this.deps.sql.begin(async (tx) => {
			const instance = await gate.instance(tx, true);
			await gate.lock(
				tx,
				gate.environment === "production"
					? "production.credentials.rotate"
					: "sandbox.credentials.rotate",
			);
			const saved = await this.receipt(tx, instance.id, key, receiptAction);
			if (saved) return saved;
			if (instance.lifecycleStatus !== "active")
				throw new MerchantError("ENVIRONMENT_INACTIVE", "Activate the environment first.", 409);
			await gate.confirm(tx, "credentials.revoke_read_only", key);
			// The same liveness test as `credentialStatus`: an expired key is already dead, so withdrawing
			// it is neither reported nor audited. The next issue revokes that row whatever its expiry.
			const revoked = await tx<
				{ id: string }[]
			>`UPDATE platform_project_api_credentials SET revoked_at=${this.deps.now()} WHERE project_instance_id=${instance.id} AND access=${access} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>${this.deps.now()}) RETURNING id`;
			if (revoked.length > 0)
				await this.audit(tx, gate, "credential.revoked", instance.id, { access });
			// Receipted even when nothing was live: a replay of this key never revokes a later key.
			const result = { access, revoked: revoked.length > 0 };
			await this.saveReceipt(tx, instance.id, key, receiptAction, result);
			return result;
		});
	}

	private assertDraft(version: ConnectionVersion) {
		if (!["draft", "validated"].includes(version.status) || version.expires_at <= this.deps.now())
			throw new MerchantError("CONNECTION_DRAFT_EXPIRED", "Create a fresh connection draft.", 409);
	}

	private async assertKind(version: ConnectionVersion, kind: ConnectionKind, sql = this.deps.sql) {
		const rows =
			await sql`SELECT id FROM platform_connections WHERE id=${version.connection_id} AND kind=${kind}`;
		if (!rows.length)
			throw new MerchantError("CONNECTION_NOT_FOUND", "Connection is unavailable.", 404);
	}

	async receipt(
		tx: MerchantSql,
		instanceId: string,
		key: string,
		action: string,
	): Promise<Record<string, unknown> | null> {
		const [row] = await tx<
			{ action: string; result: Record<string, unknown> }[]
		>`SELECT action,result FROM platform_connection_operations WHERE project_instance_id=${instanceId} AND request_key=${key}`;
		if (row && row.action !== action)
			throw new MerchantError("IDEMPOTENCY_CONFLICT", "Use a new idempotency key.", 409);
		return row?.result ?? null;
	}

	async saveReceipt(
		tx: MerchantSql,
		instanceId: string,
		key: string,
		action: string,
		result: Record<string, unknown>,
	) {
		await tx`INSERT INTO platform_connection_operations(project_instance_id,request_key,action,request_fingerprint,result) VALUES(${instanceId},${key},${action},${this.deps.hash(action)},${JSON.stringify(result)}::text::jsonb)`;
	}

	/** Principals are recorded as such; operator commands record their name instead. */
	private async audit(
		tx: MerchantSql,
		gate: ConnectionGate,
		action: string,
		target: string,
		metadata: Record<string, unknown>,
	) {
		const actor = gate.actor;
		await insertPlatformAuditEvent(tx, {
			principalId: actor.kind === "principal" ? actor.principalId : null,
			organizationId: await gate.organizationId(tx),
			action,
			target,
			metadata: actor.kind === "principal" ? metadata : { ...metadata, operator: actor.name },
		});
	}
}
