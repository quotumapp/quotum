import type { CredentialAccess } from "../../shared/credential-access";
import type { PlatformProjectInstanceRecord } from "../application/ports";
import type { MerchantCapability, MerchantScope } from "../contracts";
import type { MerchantSql } from "../database";
import { MerchantError, requireCapability } from "../security";
import { MerchantStepUp } from "../step-up";
import type { MerchantIdentity, MerchantStore } from "../store";
import { type ConnectionGate, ConnectionLifecycle } from "./lifecycle";
import type { StripeOAuthPort } from "./oauth-port";
import type { ConnectionInput, ConnectionValidationPort, EnvironmentBillingPort } from "./ports";
import type { ConnectionKind, ConnectionRepository } from "./repository";

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
			enforcesProductionLimit: true,
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
		return this.lifecycle.readiness(this.gate(identity, scope), this.billing);
	}
	async activate(
		identity: MerchantIdentity,
		scope: MerchantScope,
		key: string,
		fingerprint: string,
		grant: string | null,
	) {
		return this.lifecycle.activate(this.gate(identity, scope, grant), this.billing, key, {
			fingerprint,
		});
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
