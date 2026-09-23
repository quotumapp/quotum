import type { CredentialAccess } from "../../shared/credential-access";
import { isBillingProvider } from "../../shared/provider-capabilities";
import type { PlatformProjectInstanceRecord } from "../application/ports";
import type { MerchantCapability, MerchantScope, ReadinessBlockerDetail } from "../contracts";
import { generateProjectApiCredential } from "../credentials/project-api-token";
import type { MerchantSql } from "../database";
import { MerchantError, requireCapability } from "../security";
import { canonicalJson, MerchantStepUp } from "../step-up";
import type { MerchantIdentity, MerchantStore } from "../store";
import { type ConnectionGate, ConnectionLifecycle, validationWindowMs } from "./lifecycle";
import type { StripeOAuthPort } from "./oauth-port";
import type { ConnectionInput, ConnectionValidationPort, EnvironmentBillingPort } from "./ports";
import { type ConnectionKind, ConnectionRepository } from "./repository";

/** Merchant access to connections and credentials: membership, capabilities and step-up. */
export class MerchantConnections {
	readonly repository: ConnectionRepository;
	readonly lifecycle: ConnectionLifecycle;
	constructor(
		readonly store: MerchantStore,
		repository: ConnectionRepository,
		readonly validator: ConnectionValidationPort,
		readonly billing: EnvironmentBillingPort,
		readonly oauth?: StripeOAuthPort | null,
	) {
		this.repository = repository;
		this.lifecycle = new ConnectionLifecycle({
			sql: store.sql,
			repository,
			validator,
			oauth,
			hash: (value) => store.hash(value),
			now: () => store.now(),
		});
	}
	/** The merchant's hooks into the lifecycle, bound to one member, scope and step-up grant. */
	private gate(
		identity: MerchantIdentity,
		scope: MerchantScope,
		grant: string | null = null,
	): ConnectionGate {
		return {
			actor: { kind: "principal", principalId: identity.principalId },
			environment: scope.environment,
			instance: (sql, write) => this.scope(identity, scope, write, sql),
			lock: (tx, capability) => this.lock(tx, identity, scope, capability),
			confirm: (tx, action, target) => this.confirm(tx, identity, scope, action, target, grant),
			organizationId: async (tx) =>
				(await this.store.membership(tx, identity.principalId, scope.organizationSlug))
					.organization_id,
		};
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
		return this.lifecycle.list(this.gate(identity, scope));
	}
	async draft(
		identity: MerchantIdentity,
		scope: MerchantScope,
		kind: ConnectionKind,
		key: string,
		input: ConnectionInput & { expectedRevision: number },
	) {
		return this.lifecycle.draft(this.gate(identity, scope), kind, key, input);
	}
	async validate(
		identity: MerchantIdentity,
		scope: MerchantScope,
		kind: ConnectionKind,
		id: string,
	) {
		return this.lifecycle.validate(this.gate(identity, scope), kind, id);
	}
	async commit(
		identity: MerchantIdentity,
		scope: MerchantScope,
		kind: ConnectionKind,
		id: string,
		key: string,
		grant: string | null,
	) {
		return this.lifecycle.commit(this.gate(identity, scope, grant), kind, id, key);
	}
	async disable(
		identity: MerchantIdentity,
		scope: MerchantScope,
		kind: ConnectionKind,
		key: string,
		revision: number,
		grant: string | null,
	) {
		return this.lifecycle.disable(this.gate(identity, scope, grant), kind, key, revision);
	}
	async readiness(identity: MerchantIdentity, scope: MerchantScope) {
		const instance = await this.scope(identity, scope);
		const connections = await this.repository.list(instance.id);
		const catalog = await this.billing.catalogReadiness(instance.id, connections);
		// quotum-ui parses `blockers` by their KIND_ prefix; the gating details mirror them in order.
		const blockers: string[] = [];
		const blockerDetails: ReadinessBlockerDetail[] = [];
		const block = (code: string, extra: Omit<ReadinessBlockerDetail, "code" | "gating"> = {}) => {
			blockers.push(code);
			blockerDetails.push({ code, gating: true, ...extra });
		};
		const providers = connections.filter((c) => c.enabled && c.kind !== "projection");
		if (!providers.length) block("PROVIDER_REQUIRED");
		const kinds: ConnectionKind[] = ["projection", ...providers.map((c) => c.kind)];
		for (const kind of kinds) {
			const subject = {
				connectionKind: kind,
				...(isBillingProvider(kind) ? { provider: kind } : {}),
			};
			const row = connections.find((c) => c.kind === kind && c.enabled);
			if (
				!row?.validated_at ||
				row.validated_at.getTime() < this.store.now().getTime() - validationWindowMs
			)
				block(`${kind.toUpperCase()}_VALIDATION_REQUIRED`, {
					...subject,
					observed: {
						validatedAt: row?.validated_at?.toISOString() ?? null,
						maxAgeSeconds: validationWindowMs / 1000,
					},
				});
			if (kind !== "projection" && !row?.event_verified_at)
				block(`${kind.toUpperCase()}_EVENT_REQUIRED`, subject);
			if (row?.active_version_id) {
				try {
					await this.repository.active(instance.id, kind);
				} catch {
					block(`${kind.toUpperCase()}_SECRET_UNAVAILABLE`, subject);
				}
			}
			if (kind !== "projection" && !catalog.providers.includes(kind))
				block(`${kind.toUpperCase()}_CATALOG_REQUIRED`, subject);
		}
		if (!catalog.ready) block("PUBLISHED_CATALOG_REQUIRED");
		for (const detail of catalog.capabilityDetails ?? [])
			blockerDetails.push({ ...detail, gating: false });
		return {
			instanceId: instance.id,
			instanceKey: instance.key,
			lifecycleStatus: instance.lifecycleStatus,
			ready: blockers.length === 0,
			blockers,
			blockerDetails,
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
					row.validated_at.getTime() < this.store.now().getTime() - validationWindowMs ||
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
			const generated = generateProjectApiCredential("production", "full");
			// A first activation finds nothing to revoke. One live key of a kind per instance is a
			// database invariant, so a repeated activation replaces the key instead of failing.
			await tx`UPDATE platform_project_api_credentials SET revoked_at=clock_timestamp() WHERE project_instance_id=${instance.id} AND access=${generated.access} AND revoked_at IS NULL`;
			await tx`INSERT INTO platform_project_api_credentials(id,project_instance_id,audience,access,secret_verifier) VALUES(${generated.credentialId},${instance.id},'billing_api',${generated.access},${generated.secretVerifier})`;
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
	/**
	 * Replaces the instance's live credential of one kind, or issues the first read-only one. The
	 * production step-up grant is bound to the kind; see `ConnectionLifecycle.rotateCredential`.
	 */
	async rotateCredential(
		identity: MerchantIdentity,
		scope: MerchantScope,
		key: string,
		grant: string | null,
		access: CredentialAccess = "full",
	) {
		return this.lifecycle.rotateCredential(this.gate(identity, scope, grant), key, access);
	}
	/** Whether the environment holds a live key of each kind, and since when. Never any key material. */
	async credentialStatus(identity: MerchantIdentity, scope: MerchantScope) {
		return this.lifecycle.credentialStatus(this.gate(identity, scope));
	}
	/** Withdraws the read-only key without minting a replacement. */
	async revokeCredential(
		identity: MerchantIdentity,
		scope: MerchantScope,
		key: string,
		grant: string | null,
	) {
		return this.lifecycle.revokeCredential(this.gate(identity, scope, grant), key);
	}
	private async lock(
		tx: MerchantSql,
		identity: MerchantIdentity,
		scope: MerchantScope,
		capability?: MerchantCapability,
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
	receipt(
		tx: MerchantSql,
		instanceId: string,
		key: string,
		action: string,
	): Promise<Record<string, unknown> | null> {
		return this.lifecycle.receipt(tx, instanceId, key, action);
	}
	saveReceipt(
		tx: MerchantSql,
		instanceId: string,
		key: string,
		action: string,
		result: Record<string, unknown>,
	) {
		return this.lifecycle.saveReceipt(tx, instanceId, key, action, result);
	}
}
