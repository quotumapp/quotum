import type { OnboardingDraftView, ProvisioningOperationView } from "./contracts";
import { generateProjectApiCredential } from "./credentials/project-api-token";
import type { MerchantSql } from "./database";
import { MerchantError, requireCapability } from "./security";
import type { MerchantIdentity, MerchantStore } from "./store";

interface OperationRow {
	id: string;
	draft_id: string;
	logical_project_id: string;
	status: ProvisioningOperationView["status"];
	error_code: string | null;
	credential_delivery: ProvisioningOperationView["credentialDelivery"];
	project_key: string;
	project_name: string;
	slug: string;
	organization_id: string;
}
export class MerchantOnboarding {
	constructor(
		private readonly store: MerchantStore,
		private readonly beforeProvision?: (environment: "sandbox" | "production") => Promise<void>,
	) {}
	async organization(
		identity: MerchantIdentity,
		key: string,
		input: { name: string; slug: string; revision?: number },
	): Promise<OnboardingDraftView> {
		return this.store.idempotent(identity, key, ["onboarding.organization", input], async (tx) => {
			const draft = await this.store.draft(identity.principalId, tx);
			if (draft?.organization)
				throw new MerchantError(
					"DRAFT_CHANGED",
					"An organization already exists. Continue your saved onboarding.",
					409,
				);
			const existing = await tx`SELECT id FROM platform_organizations WHERE slug=${input.slug}`;
			if (existing.length)
				throw new MerchantError(
					"SLUG_UNAVAILABLE",
					"Choose a different organization address.",
					409,
				);
			const [org] = await tx<
				{ id: string }[]
			>`INSERT INTO platform_organizations(name,slug) VALUES(${input.name},${input.slug}) RETURNING id`;
			if (!org) throw new Error("Organization insert failed");
			await tx`INSERT INTO platform_memberships(organization_id,principal_id,role) VALUES(${org.id},${identity.principalId},'Owner')`;
			await tx`INSERT INTO platform_onboarding_drafts(principal_id,organization_id,status) VALUES(${identity.principalId},${org.id},'project') ON CONFLICT(principal_id) DO UPDATE SET organization_id=EXCLUDED.organization_id,status='project',revision=platform_onboarding_drafts.revision+1`;
			await this.store.audit(tx, identity.principalId, org.id, "organization.created", org.id);
			const result = await this.store.draft(identity.principalId, tx);
			if (!result) throw new Error("Draft insert failed");
			return result;
		});
	}
	async project(
		identity: MerchantIdentity,
		key: string,
		input: { name: string; key: string; revision: number },
	): Promise<OnboardingDraftView> {
		return this.store.idempotent(identity, key, ["onboarding.project", input], async (tx) => {
			const draft = await this.store.draft(identity.principalId, tx);
			if (!draft?.organization)
				throw new MerchantError("ORGANIZATION_REQUIRED", "Create an organization first.");
			const member = await this.store.membership(
				tx,
				identity.principalId,
				draft.organization.slug,
				true,
			);
			requireCapability(member.role, "project.create");
			if (draft.revision !== input.revision || draft.operationId)
				throw new MerchantError(
					"DRAFT_CHANGED",
					"Your draft changed. Refresh it before continuing.",
					409,
				);
			await tx`UPDATE platform_onboarding_drafts SET project_name=${input.name},project_key=${input.key},revision=revision+1,updated_at=${this.store.now()} WHERE id=${draft.id}`;
			const result = await this.store.draft(identity.principalId, tx);
			if (!result) throw new Error("Draft disappeared");
			return result;
		});
	}
	async start(
		identity: MerchantIdentity,
		key: string,
		revision: number,
	): Promise<ProvisioningOperationView> {
		const { id } = await this.store.idempotent(
			identity,
			key,
			["onboarding.provision", revision],
			async (tx) => {
				const draft = await this.store.draft(identity.principalId, tx);
				if (!draft?.organization || !draft.project)
					throw new MerchantError("PROJECT_REQUIRED", "Complete the project details first.");
				const member = await this.store.membership(
					tx,
					identity.principalId,
					draft.organization.slug,
					true,
				);
				requireCapability(member.role, "project.create");
				if (draft.operationId) return { id: draft.operationId };
				if (draft.revision !== revision)
					throw new MerchantError(
						"DRAFT_CHANGED",
						"Review the latest draft before provisioning.",
						409,
					);
				const [project] = await tx<
					{ id: string }[]
				>`INSERT INTO platform_projects(organization_id,name,key) VALUES(${member.organization_id},${draft.project.name},${draft.project.key}) RETURNING id`;
				if (!project) throw new Error("Project insert failed");
				const [operation] = await tx<
					{ id: string }[]
				>`INSERT INTO platform_provisioning_operations(draft_id,logical_project_id) VALUES(${draft.id},${project.id}) RETURNING id`;
				if (!operation) throw new Error("Operation insert failed");
				await tx`INSERT INTO platform_provisioning_steps(operation_id,environment) VALUES(${operation.id},'sandbox'),(${operation.id},'production')`;
				await tx`UPDATE platform_onboarding_drafts SET status='provisioning',revision=revision+1 WHERE id=${draft.id}`;
				await this.store.audit(
					tx,
					identity.principalId,
					member.organization_id,
					"project.provisioning_started",
					project.id,
				);
				return { id: operation.id };
			},
		);
		return this.resume(identity, id);
	}
	private async record(
		identity: MerchantIdentity,
		id: string,
		tx: MerchantSql = this.store.sql,
	): Promise<OperationRow> {
		const [row] = await tx<
			OperationRow[]
		>`SELECT op.*,p.key AS project_key,p.name AS project_name,o.slug,o.id AS organization_id FROM platform_provisioning_operations op JOIN platform_projects p ON p.id=op.logical_project_id JOIN platform_organizations o ON o.id=p.organization_id WHERE op.id=${id}`;
		if (!row) throw new MerchantError("NOT_FOUND", "Provisioning operation not found.", 404);
		await this.store.membership(tx, identity.principalId, row.slug);
		return row;
	}
	async view(identity: MerchantIdentity, id: string): Promise<ProvisioningOperationView> {
		const op = await this.record(identity, id);
		const steps = await this.store.sql<
			ProvisioningOperationView["steps"]
		>`SELECT environment,status FROM platform_provisioning_steps WHERE operation_id=${id} ORDER BY environment DESC`;
		return {
			id,
			status: op.status,
			projectKey: op.project_key,
			organizationSlug: op.slug,
			steps: [...steps],
			retryable: op.status === "failed" || op.status === "partially_provisioned",
			credentialDelivery: op.credential_delivery,
			error: op.error_code
				? "We could not finish provisioning. Your completed steps are saved."
				: null,
		};
	}
	async resume(identity: MerchantIdentity, id: string): Promise<ProvisioningOperationView> {
		const op = await this.record(identity, id);
		const member = await this.store.membership(this.store.sql, identity.principalId, op.slug);
		requireCapability(member.role, "project.create");
		if (op.status === "succeeded") return this.view(identity, id);
		for (const environment of ["sandbox", "production"] as const) {
			const [current] = await this.store.sql<
				{ status: string }[]
			>`SELECT status FROM platform_provisioning_steps WHERE operation_id=${id} AND environment=${environment}`;
			if (current?.status === "succeeded") continue;
			try {
				// External adapter work is outside the transaction; its durable idempotency identity is op/environment.
				await this.beforeProvision?.(environment);
				await this.store.sql.begin(async (tx) => {
					const membership = await this.store.membership(tx, identity.principalId, op.slug, true);
					requireCapability(membership.role, "project.create");
					await tx`SELECT id FROM platform_provisioning_operations WHERE id=${id} FOR UPDATE`;
					const [step] = await tx<
						{ status: string }[]
					>`SELECT status FROM platform_provisioning_steps WHERE operation_id=${id} AND environment=${environment}`;
					if (step?.status === "succeeded") return;
					const runtimeKey = `merchant_${op.logical_project_id.replaceAll("-", "")}_${environment}`;
					const instance = await tx.instances.create({
						platformProjectId: op.logical_project_id,
						key: runtimeKey,
						name: op.project_name,
						environment,
						lifecycleStatus: environment === "sandbox" ? "active" : "inactive",
						internalProject: false,
					});
					await tx`INSERT INTO platform_project_runtime_modes(project_instance_id,mode) VALUES(${instance.id},'unconfigured')`;
					await tx`UPDATE platform_provisioning_steps SET status='succeeded' WHERE operation_id=${id} AND environment=${environment}`;
					await tx`UPDATE platform_provisioning_operations SET status='provisioning',error_code=NULL,updated_at=${this.store.now()} WHERE id=${id}`;
					await this.store.audit(
						tx,
						identity.principalId,
						op.organization_id,
						"project.instance_created",
						op.logical_project_id,
						{ environment },
					);
				});
			} catch (error) {
				if (error instanceof MerchantError && error.status === 403) throw error;
				await this.store.sql.begin(async (tx) => {
					await tx`SELECT id FROM platform_provisioning_operations WHERE id=${id} FOR UPDATE`;
					await tx`UPDATE platform_provisioning_steps SET status='failed' WHERE operation_id=${id} AND environment=${environment} AND status<>'succeeded'`;
					await tx`UPDATE platform_provisioning_operations SET status=CASE WHEN EXISTS(SELECT 1 FROM platform_provisioning_steps WHERE operation_id=${id} AND environment='production' AND status='succeeded') THEN 'succeeded' WHEN EXISTS(SELECT 1 FROM platform_provisioning_steps WHERE operation_id=${id} AND environment='sandbox' AND status='succeeded') THEN 'partially_provisioned' ELSE 'failed' END,error_code='PROVISIONING_FAILED',updated_at=${this.store.now()} WHERE id=${id}`;
				});
				return this.view(identity, id);
			}
		}
		await this.store.sql.begin(async (tx) => {
			await tx`UPDATE platform_provisioning_operations SET status='succeeded',error_code=NULL,updated_at=${this.store.now()} WHERE id=${id}`;
			await tx`UPDATE platform_onboarding_drafts SET status='ready',revision=revision+1 WHERE id=${op.draft_id} AND status<>'ready'`;
		});
		return this.view(identity, id);
	}
	async credential(
		identity: MerchantIdentity,
		id: string,
		rotate = false,
		key: string = crypto.randomUUID(),
	): Promise<{ credential: string | null; state: "delivered" | "unavailable" }> {
		// Never store a credential in an idempotency response. A lost response requires explicit rotation.
		let delivered: string | null = null;
		await this.store.idempotent(identity, key, ["credential.issue", id, rotate], async (tx) => {
			const op = await this.record(identity, id, tx);
			const member = await this.store.membership(tx, identity.principalId, op.slug, true);
			requireCapability(member.role, "sandbox.credentials.rotate");
			const [locked] = await tx<
				{ credential_delivery: string }[]
			>`SELECT credential_delivery FROM platform_provisioning_operations WHERE id=${id} FOR UPDATE`;
			if (!rotate && locked?.credential_delivery !== "available") return { state: "unavailable" };
			const instance = (await tx.instances.forProject(op.logical_project_id)).find(
				(row) => row.environment === "sandbox" && row.lifecycleStatus === "active",
			);
			if (!instance)
				throw new MerchantError("SANDBOX_NOT_READY", "Finish sandbox provisioning first.", 409);
			const credential = generateProjectApiCredential();
			await tx`UPDATE platform_project_api_credentials SET revoked_at=${this.store.now()} WHERE project_instance_id=${instance.id} AND revoked_at IS NULL`;
			await tx`INSERT INTO platform_project_api_credentials(id,project_instance_id,audience,secret_verifier) VALUES(${credential.credentialId},${instance.id},'billing_api',${credential.secretVerifier})`;
			await tx`UPDATE platform_provisioning_operations SET credential_delivery='delivered' WHERE id=${id}`;
			await this.store.audit(
				tx,
				identity.principalId,
				op.organization_id,
				rotate ? "credential.rotated" : "credential.issued",
				instance.id,
				{ environment: "sandbox" },
			);
			delivered = credential.token;
			return { state: "delivered" };
		});
		return { credential: delivered, state: delivered ? "delivered" : "unavailable" };
	}
}
