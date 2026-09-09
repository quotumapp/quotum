import { randomUUID } from "node:crypto";
import type { PlatformProjectInstanceRecord } from "../application/ports";
import type { MerchantScope } from "../contracts";
import { generateProjectApiCredential } from "../credentials/project-api-token";
import type { MerchantSql } from "../database";
import { MerchantError, randomToken, requireCapability } from "../security";
import { canonicalJson, MerchantStepUp } from "../step-up";
import type { MerchantIdentity, MerchantStore } from "../store";
import type { StripeOAuthPort } from "./oauth-port";
import { resolveStripeOAuth } from "./oauth-runtime";
import type { ConnectionInput, ConnectionValidationPort, EnvironmentBillingPort } from "./ports";
import { type ConnectionKind, ConnectionRepository, type ConnectionVersion } from "./repository";

export class MerchantConnections {
	readonly repository: ConnectionRepository;
	constructor(
		readonly store: MerchantStore,
		repository: ConnectionRepository,
		readonly validator: ConnectionValidationPort,
		readonly billing: EnvironmentBillingPort,
		readonly oauth?: StripeOAuthPort | null,
	) {
		this.repository = repository;
	}
	async scope(
		identity: MerchantIdentity,
		scope: MerchantScope,
		write = false,
		sql = this.store.sql,
	): Promise<PlatformProjectInstanceRecord> {
		const member = await this.store.membership(
			sql,
			identity.principalId,
			scope.organizationSlug,
			write,
		);
		requireCapability(
			member.role,
			write
				? scope.environment === "production"
					? "production.connections.manage"
					: "sandbox.configure"
				: "billing.read",
		);
		const [project] = await sql<
			{ id: string }[]
		>`SELECT id FROM platform_projects WHERE organization_id=${member.organization_id} AND key=${scope.projectKey}`;
		const instance = project
			? (await sql.instances.forProject(project.id)).find(
					(i) =>
						i.environment === scope.environment &&
						!i.internalProject &&
						(i.lifecycleStatus === "active" || i.lifecycleStatus === "inactive"),
				)
			: null;
		if (!instance)
			throw new MerchantError("CONTEXT_UNAVAILABLE", "This environment is unavailable.", 404);
		return instance;
	}
	async preparePromotion(identity: MerchantIdentity, scope: MerchantScope) {
		if (scope.environment !== "production")
			throw new MerchantError("INVALID_PROMOTION", "Select the production environment.");
		const member = await this.store.membership(
			this.store.sql,
			identity.principalId,
			scope.organizationSlug,
		);
		requireCapability(member.role, "catalog.author");
		const target = await this.scope(identity, scope),
			source = await this.scope(identity, { ...scope, environment: "sandbox" });
		return this.billing.promote({
			sourceInstanceId: source.id,
			targetInstanceId: target.id,
			actor: identity.principalId,
		});
	}
	async list(identity: MerchantIdentity, scope: MerchantScope) {
		const instance = await this.scope(identity, scope);
		return { connections: await this.repository.list(instance.id) };
	}
	async draft(
		identity: MerchantIdentity,
		scope: MerchantScope,
		kind: ConnectionKind,
		key: string,
		input: ConnectionInput & { expectedRevision: number },
	) {
		const normalized = this.validator.normalize(kind, scope.environment, input);
		const fingerprint = this.store.hash(canonicalJson({ kind, ...input }));
		return this.store.sql.begin(async (tx) => {
			const instance = await this.scope(identity, scope, true, tx);
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
			await this.repository.saveSecrets(
				tx,
				{ id, connection_id: connection.id, project_instance_id: instance.id },
				normalized.secrets,
			);
			const member = await this.store.membership(tx, identity.principalId, scope.organizationSlug);
			await this.store.audit(
				tx,
				identity.principalId,
				member.organization_id,
				"connection.draft_created",
				id,
				{ kind },
			);
			return {
				draftId: id,
				secretDisclosed: generated !== undefined,
				...(generated ? { projectionSecret: generated } : {}),
			};
		});
	}
	async validate(
		identity: MerchantIdentity,
		scope: MerchantScope,
		kind: ConnectionKind,
		id: string,
	) {
		const instance = await this.scope(identity, scope, true);
		const version = await this.repository.version(instance.id, id);
		await this.assertKind(version, kind);
		if (version.status !== "active") this.assertDraft(version);
		const resolvedSecrets =
			version.settings.authMethod === "oauth" && this.oauth
				? await resolveStripeOAuth(this.repository, version, scope.environment, this.oauth)
				: await this.repository.secrets(version);
		const result = await this.validator.validate(
			kind,
			scope.environment,
			{ settings: version.settings, secrets: resolvedSecrets },
			{ instanceId: instance.id, instanceKey: instance.key, versionId: id },
		);
		if (kind === "stripe" && version.settings.authMethod === "oauth") {
			const evidence = await this.store
				.sql`SELECT e.event_id FROM platform_stripe_app_events e JOIN platform_connection_versions v ON v.id=${id} WHERE e.account_id=${result.identity} AND e.livemode=${scope.environment === "production"} AND e.created_at>=v.created_at AND e.payload->>'type'<>'account.application.deauthorized' LIMIT 1`;
			result.eventVerified = evidence.length > 0;
		}
		if (result.checks.some((check) => !check.passed))
			throw new MerchantError(
				"CONNECTION_VALIDATION_FAILED",
				"Resolve the connection checks before continuing.",
				409,
			);
		return this.store.sql.begin(async (tx) => {
			await this.scope(identity, scope, true, tx);
			const updated =
				await tx`UPDATE platform_connection_versions SET status=CASE WHEN status='active' THEN 'active' ELSE 'validated' END,validation=${JSON.stringify(result)}::text::jsonb,validated_at=${this.store.now()},external_identity=${result.identity},event_verified_at=CASE WHEN ${result.eventVerified} THEN ${this.store.now()} WHEN external_identity IS NOT NULL AND external_identity<>${result.identity} THEN NULL ELSE event_verified_at END WHERE id=${id} AND project_instance_id=${instance.id} AND (status='active' OR (status IN ('draft','validated') AND expires_at>${this.store.now()})) RETURNING id`;
			if (!updated.length)
				throw new MerchantError("CONNECTION_CHANGED", "Create a fresh connection draft.", 409);
			return { draftId: id, ...result };
		});
	}
	async commit(
		identity: MerchantIdentity,
		scope: MerchantScope,
		kind: ConnectionKind,
		id: string,
		key: string,
		grant: string | null,
	) {
		return this.store.sql.begin(async (tx) => {
			const instance = await this.scope(identity, scope, true, tx);
			await this.lock(tx, identity, scope);
			const receipt = await this.receipt(tx, instance.id, key, `commit:${id}`);
			if (receipt) return receipt;
			const version = await this.repository.version(instance.id, id, tx);
			await this.assertKind(version, kind, tx);
			this.assertDraft(version);
			if (
				!version.validated_at ||
				version.validated_at.getTime() < this.store.now().getTime() - 900_000
			)
				throw new MerchantError(
					"CONNECTION_VALIDATION_REQUIRED",
					"Verify this connection again.",
					409,
				);
			if (
				scope.environment === "production" &&
				instance.lifecycleStatus === "active" &&
				kind !== "projection" &&
				!version.event_verified_at
			)
				throw new MerchantError(
					"PROVIDER_EVENT_REQUIRED",
					"Verify provider event delivery before enabling this production connection.",
					409,
				);
			await new ConnectionRepository(tx, this.repository.cipher).secrets(version);
			if (kind === "stripe") {
				if (!version.external_identity)
					throw new MerchantError(
						"CONNECTION_VALIDATION_REQUIRED",
						"Verify the Stripe account first.",
						409,
					);
				await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`${version.external_identity}:${scope.environment}`},0))`;
				const existing =
					await tx`SELECT id FROM platform_connections WHERE stripe_account_id=${version.external_identity} AND stripe_livemode=${scope.environment === "production"} AND id<>${version.connection_id}`;
				const changed =
					await tx`SELECT id FROM platform_connections WHERE id=${version.connection_id} AND stripe_account_id IS NOT NULL AND stripe_account_id<>${version.external_identity}`;
				if (existing.length || changed.length)
					throw new MerchantError(
						"STRIPE_ACCOUNT_CONFLICT",
						"This account is already assigned, or does not match the environment's existing account.",
						409,
					);
				await tx`UPDATE platform_connections SET stripe_account_id=${version.external_identity},stripe_livemode=${scope.environment === "production"} WHERE id=${version.connection_id}`;
			}
			await this.confirm(tx, identity, scope, "connections.manage", id, grant);
			const rows =
				await tx`UPDATE platform_connections SET active_version_id=${id},enabled=true,revision=revision+1,updated_at=${this.store.now()} WHERE id=${version.connection_id} AND project_instance_id=${instance.id} AND revision=${version.expected_revision} RETURNING revision`;
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
			const member = await this.store.membership(tx, identity.principalId, scope.organizationSlug);
			await this.store.audit(
				tx,
				identity.principalId,
				member.organization_id,
				"connection.committed",
				version.connection_id,
				{ kind, versionId: id },
			);
			return result;
		});
	}
	async disable(
		identity: MerchantIdentity,
		scope: MerchantScope,
		kind: ConnectionKind,
		key: string,
		revision: number,
		grant: string | null,
	) {
		return this.store.sql.begin(async (tx) => {
			const instance = await this.scope(identity, scope, true, tx);
			await this.lock(tx, identity, scope);
			const action = `disable:${kind}:${revision}`;
			const previous = await this.receipt(tx, instance.id, key, action);
			if (previous) return previous;
			await this.confirm(tx, identity, scope, "connections.manage", action, grant);
			const rows =
				await tx`UPDATE platform_connections SET enabled=false,revision=revision+1,updated_at=${this.store.now()} WHERE project_instance_id=${instance.id} AND kind=${kind} AND revision=${revision} RETURNING id,revision`;
			if (!rows.length)
				throw new MerchantError("CONNECTION_CHANGED", "Refresh this connection.", 409);
			const result = { enabled: false, revision: Number(rows[0]?.revision) };
			await this.saveReceipt(tx, instance.id, key, action, result);
			const member = await this.store.membership(tx, identity.principalId, scope.organizationSlug);
			await this.store.audit(
				tx,
				identity.principalId,
				member.organization_id,
				"connection.disabled",
				String(rows[0]?.id),
				{ kind, revision },
			);
			return result;
		});
	}
	async readiness(identity: MerchantIdentity, scope: MerchantScope) {
		const instance = await this.scope(identity, scope);
		const connections = await this.repository.list(instance.id);
		const catalog = await this.billing.catalogReadiness(instance.id);
		const blockers: string[] = [];
		const providers = connections.filter((c) => c.enabled && c.kind !== "projection");
		if (!providers.length) blockers.push("PROVIDER_REQUIRED");
		for (const kind of ["projection", ...providers.map((c) => c.kind)]) {
			const row = connections.find((c) => c.kind === kind && c.enabled);
			if (!row?.validated_at || row.validated_at.getTime() < this.store.now().getTime() - 900_000)
				blockers.push(`${kind.toUpperCase()}_VALIDATION_REQUIRED`);
			if (kind !== "projection" && !row?.event_verified_at)
				blockers.push(`${kind.toUpperCase()}_EVENT_REQUIRED`);
			if (row?.active_version_id) {
				try {
					await this.repository.active(instance.id, kind as ConnectionKind);
				} catch {
					blockers.push(`${kind.toUpperCase()}_SECRET_UNAVAILABLE`);
				}
			}
			if (kind !== "projection" && !catalog.providers.includes(kind))
				blockers.push(`${kind.toUpperCase()}_CATALOG_REQUIRED`);
		}
		if (!catalog.ready) blockers.push("PUBLISHED_CATALOG_REQUIRED");
		return {
			instanceId: instance.id,
			instanceKey: instance.key,
			lifecycleStatus: instance.lifecycleStatus,
			ready: blockers.length === 0,
			blockers,
			catalogRevisionId: catalog.revisionId,
			connections,
			fingerprint: this.store.hash(
				canonicalJson({
					catalog: catalog.revisionId,
					connections: connections.map((c) => [c.id, c.revision, c.active_version_id]),
				}),
			),
		};
	}
	async activate(
		identity: MerchantIdentity,
		scope: MerchantScope,
		key: string,
		fingerprint: string,
		grant: string | null,
	) {
		if (scope.environment !== "production")
			throw new MerchantError("INVALID_REQUEST", "Sandbox is activated during onboarding.");
		const readiness = await this.readiness(identity, scope);
		let credential: string | null = null;
		const result = await this.store.sql.begin(async (tx) => {
			const instance = await this.scope(identity, scope, true, tx);
			await this.lock(tx, identity, scope, "production.activate");
			const previous = await this.receipt(tx, instance.id, key, `activate:${fingerprint}`);
			if (previous) return previous;
			if (instance.lifecycleStatus === "active")
				return { active: true, credentialDisclosed: false };
			if (!readiness.ready || !readiness.catalogRevisionId || fingerprint !== readiness.fingerprint)
				throw new MerchantError(
					"ENVIRONMENT_NOT_READY",
					"Review and resolve the current production readiness checks.",
					409,
				);
			const member = await this.store.membership(
				tx,
				identity.principalId,
				scope.organizationSlug,
				true,
			);
			await tx`SELECT id FROM platform_organizations WHERE id=${member.organization_id} FOR UPDATE`;
			await tx`SELECT id FROM platform_connections WHERE project_instance_id=${instance.id} ORDER BY id FOR UPDATE`;
			const current = await new ConnectionRepository(tx, this.repository.cipher).list(instance.id);
			if (
				canonicalJson(current.map((c) => [c.id, c.revision, c.active_version_id])) !==
				canonicalJson(readiness.connections.map((c) => [c.id, c.revision, c.active_version_id]))
			)
				throw new MerchantError("CONNECTION_CHANGED", "Review production readiness again.", 409);
			for (const row of current.filter((c) => c.enabled)) {
				if (
					!row.validated_at ||
					row.validated_at.getTime() < this.store.now().getTime() - 900_000 ||
					(row.kind !== "projection" && !row.event_verified_at)
				)
					throw new MerchantError(
						"ENVIRONMENT_NOT_READY",
						"Refresh connection verification before activating production.",
						409,
					);
				await new ConnectionRepository(tx, this.repository.cipher).active(instance.id, row.kind);
			}
			await this.confirm(tx, identity, scope, "environment.activate", fingerprint, grant);
			if (
				!(await tx.instances.activateProduction(
					instance.id,
					member.organization_id,
					readiness.catalogRevisionId,
				))
			)
				throw new MerchantError(
					"ACTIVATION_CONFLICT",
					"Production capacity or catalog state changed. Refresh readiness.",
					409,
				);
			const generated = generateProjectApiCredential();
			await tx`INSERT INTO platform_project_api_credentials(id,project_instance_id,audience,secret_verifier) VALUES(${generated.credentialId},${instance.id},'billing_api',${generated.secretVerifier})`;
			await this.store.audit(
				tx,
				identity.principalId,
				member.organization_id,
				"environment.activated",
				instance.id,
				{ catalogRevisionId: readiness.catalogRevisionId },
			);
			const saved = { active: true, credentialDisclosed: false };
			await this.saveReceipt(tx, instance.id, key, `activate:${fingerprint}`, saved);
			credential = generated.token;
			return saved;
		});
		return {
			...result,
			credentialDisclosed: credential !== null,
			...(credential ? { credential } : {}),
		};
	}
	async rotateCredential(
		identity: MerchantIdentity,
		scope: MerchantScope,
		key: string,
		grant: string | null,
	) {
		let credential: string | null = null;
		const result = await this.store.sql.begin(async (tx) => {
			const instance = await this.scope(identity, scope, true, tx);
			await this.lock(
				tx,
				identity,
				scope,
				scope.environment === "production"
					? "production.credentials.rotate"
					: "sandbox.credentials.rotate",
			);
			const saved = await this.receipt(tx, instance.id, key, "credential.rotate");
			if (saved) return saved;
			if (instance.lifecycleStatus !== "active")
				throw new MerchantError("ENVIRONMENT_INACTIVE", "Activate the environment first.", 409);
			await this.confirm(tx, identity, scope, "credentials.rotate", key, grant);
			const generated = generateProjectApiCredential();
			await tx`UPDATE platform_project_api_credentials SET revoked_at=${this.store.now()} WHERE project_instance_id=${instance.id} AND revoked_at IS NULL`;
			await tx`INSERT INTO platform_project_api_credentials(id,project_instance_id,audience,secret_verifier) VALUES(${generated.credentialId},${instance.id},'billing_api',${generated.secretVerifier})`;
			const member = await this.store.membership(tx, identity.principalId, scope.organizationSlug);
			await this.store.audit(
				tx,
				identity.principalId,
				member.organization_id,
				"credential.rotated",
				instance.id,
				{},
			);
			const result = { credentialDisclosed: false };
			await this.saveReceipt(tx, instance.id, key, "credential.rotate", result);
			credential = generated.token;
			return result;
		});
		return {
			...result,
			credentialDisclosed: credential !== null,
			...(credential ? { credential } : {}),
		};
	}
	private async lock(
		tx: MerchantSql,
		identity: MerchantIdentity,
		scope: MerchantScope,
		capability?: import("../contracts").MerchantCapability,
	) {
		const member = await this.store.membership(
			tx,
			identity.principalId,
			scope.organizationSlug,
			true,
		);
		if (capability) requireCapability(member.role, capability);
		await tx`SELECT id FROM platform_organizations WHERE id=${member.organization_id} FOR UPDATE`;
	}
	private assertDraft(version: ConnectionVersion) {
		if (!["draft", "validated"].includes(version.status) || version.expires_at <= this.store.now())
			throw new MerchantError("CONNECTION_DRAFT_EXPIRED", "Create a fresh connection draft.", 409);
	}
	private async assertKind(version: ConnectionVersion, kind: ConnectionKind, sql = this.store.sql) {
		const rows =
			await sql`SELECT id FROM platform_connections WHERE id=${version.connection_id} AND kind=${kind}`;
		if (!rows.length)
			throw new MerchantError("CONNECTION_NOT_FOUND", "Connection is unavailable.", 404);
	}
	async confirm(
		tx: MerchantSql,
		identity: MerchantIdentity,
		scope: MerchantScope,
		action: string,
		target: string,
		grant: string | null,
	) {
		if (scope.environment === "production")
			await new MerchantStepUp(this.store).consume(tx, identity, scope, action, target, grant);
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
		await tx`INSERT INTO platform_connection_operations(project_instance_id,request_key,action,request_fingerprint,result) VALUES(${instanceId},${key},${action},${this.store.hash(action)},${JSON.stringify(result)}::text::jsonb)`;
	}
}
