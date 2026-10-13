import { insertPlatformAuditEvent } from "./audit";
import { assertOperableOrganization } from "./connections/operator-gate";
import type { MerchantSql } from "./database";

/** Who changes the topology and why, as the audit event records it. */
export interface OperatorTopologyChange {
	/** The operator the audit event names. */
	operator: string;
	/** Why the operator changes an organization that already has members. */
	memberOverrideReason?: string;
}

/** The part of an audit event's metadata every operator change shares. */
function operatorMetadata(change: OperatorTopologyChange): Record<string, unknown> {
	return {
		operator: change.operator,
		...(change.memberOverrideReason === undefined
			? {}
			: { memberOverrideReason: change.memberOverrideReason }),
	};
}

export interface RenameOrganizationInput extends OperatorTopologyChange {
	organizationSlug: string;
	name: string;
}

export interface RenameOrganizationResult {
	organization: string;
	name: string;
	previousName: string;
	/** False when the organization already had this name, so nothing changed. */
	changed: boolean;
}

/**
 * Changes an organization's display name. The slug is its identity in URLs, bootstrap manifests and
 * commands, so it never changes. An organization that has members needs a stated reason, as the
 * connection and credential commands do.
 */
export async function renameOrganization(
	sql: MerchantSql,
	input: RenameOrganizationInput,
): Promise<RenameOrganizationResult> {
	return await sql.begin(async (tx) => {
		const [organization] = await tx<
			{ id: string; name: string; status: string }[]
		>`SELECT id,name,status FROM platform_organizations WHERE slug=${input.organizationSlug} FOR UPDATE`;
		if (!organization) throw new Error(`Organization ${input.organizationSlug} was not found`);
		if (organization.status !== "active")
			throw new Error(`Organization ${input.organizationSlug} is ${organization.status}`);
		const result = {
			organization: input.organizationSlug,
			name: input.name,
			previousName: organization.name,
		};
		// Nothing changes for the name it already has, so a repeated run needs no reason.
		if (organization.name === input.name) return { ...result, changed: false };
		await assertOperableOrganization(tx, organization.id, {
			requireNoMembers: input.memberOverrideReason === undefined,
		});
		await tx`UPDATE platform_organizations SET name=${input.name}, updated_at=now() WHERE id=${organization.id}`;
		await insertPlatformAuditEvent(tx, {
			principalId: null,
			organizationId: organization.id,
			action: "organization.renamed",
			target: organization.id,
			metadata: {
				...operatorMetadata(input),
				previousName: organization.name,
				name: input.name,
			},
		});
		return { ...result, changed: true };
	});
}

export interface RenameProjectInput extends OperatorTopologyChange {
	organizationSlug: string;
	projectKey: string;
	name: string;
}

export interface RenameProjectResult {
	organization: string;
	project: string;
	name: string;
	previousName: string;
	/** False when the project already had this name, so nothing changed. */
	changed: boolean;
}

/**
 * Changes a logical project's display name, on the project and on each of its environments. The
 * project key and the instance keys, which credentials and webhooks use, never change.
 */
export async function renameProject(
	sql: MerchantSql,
	input: RenameProjectInput,
): Promise<RenameProjectResult> {
	return await sql.begin(async (tx) => {
		const [organization] = await tx<
			{ id: string; status: string }[]
		>`SELECT id,status FROM platform_organizations WHERE slug=${input.organizationSlug} FOR UPDATE`;
		if (!organization) throw new Error(`Organization ${input.organizationSlug} was not found`);
		if (organization.status !== "active")
			throw new Error(`Organization ${input.organizationSlug} is ${organization.status}`);
		const [project] = await tx<
			{ id: string; name: string }[]
		>`SELECT id,name FROM platform_projects WHERE organization_id=${organization.id} AND key=${input.projectKey} FOR UPDATE`;
		if (!project)
			throw new Error(`Project ${input.projectKey} was not found in ${input.organizationSlug}`);
		const result = {
			organization: input.organizationSlug,
			project: input.projectKey,
			name: input.name,
			previousName: project.name,
		};
		if (project.name === input.name) return { ...result, changed: false };
		await assertOperableOrganization(tx, organization.id, {
			requireNoMembers: input.memberOverrideReason === undefined,
		});
		await tx`UPDATE platform_projects SET name=${input.name}, updated_at=now() WHERE id=${project.id}`;
		await tx.instances.renameForProject(project.id, organization.id, input.name);
		await insertPlatformAuditEvent(tx, {
			principalId: null,
			organizationId: organization.id,
			action: "project.renamed",
			target: project.id,
			metadata: {
				...operatorMetadata(input),
				project: input.projectKey,
				previousName: project.name,
				name: input.name,
			},
		});
		return { ...result, changed: true };
	});
}

/** The instance an operator suspends or resumes, resolved by composition from its key. */
export interface OperatorInstanceTarget {
	instanceKey: string;
	organizationId: string;
	platformProjectId: string;
	instanceId: string;
}

export interface SetEnvironmentSuspensionInput extends OperatorTopologyChange {
	target: OperatorInstanceTarget;
	suspended: boolean;
	/** Why the environment is suspended or resumed; audited. */
	reason?: string;
	/** Whether resuming a production instance counts against the organization's production limit. */
	enforceProductionLimit: boolean;
}

export interface SetEnvironmentSuspensionResult {
	instance: string;
	environment: string;
	lifecycleStatus: "active" | "suspended";
	/** False when the environment was already in the requested state, so nothing changed. */
	changed: boolean;
}

/**
 * Suspends an active environment or resumes a suspended one. Suspension is the immediate,
 * reversible stop the lifecycle specification describes: `/v1` refuses the project's keys while
 * provider webhooks, reconciliation and workers continue, so financial state stays correct.
 * Deactivation, which drains obligations and revokes keys, is a different and slower workflow.
 */
export async function setEnvironmentSuspension(
	sql: MerchantSql,
	input: SetEnvironmentSuspensionInput,
): Promise<SetEnvironmentSuspensionResult> {
	const { target } = input;
	return await sql.begin(async (tx) => {
		const [organization] = await tx<
			{ id: string }[]
		>`SELECT id FROM platform_organizations WHERE id=${target.organizationId} AND status='active' FOR UPDATE`;
		if (!organization) throw new Error(`Environment ${target.instanceKey} is unavailable`);
		const instance = (await tx.instances.forProject(target.platformProjectId)).find(
			(candidate) => candidate.id === target.instanceId && !candidate.internalProject,
		);
		if (!instance) throw new Error(`Environment ${target.instanceKey} is unavailable`);
		const result = {
			instance: target.instanceKey,
			environment: instance.environment,
		};
		const wanted = input.suspended ? "suspended" : "active";
		// Nothing changes for an environment already there, so a repeated run needs no reason.
		if (instance.lifecycleStatus === wanted)
			return { ...result, lifecycleStatus: wanted, changed: false };
		const from = input.suspended ? "active" : "suspended";
		if (instance.lifecycleStatus !== from)
			throw new Error(
				`Environment ${target.instanceKey} is ${instance.lifecycleStatus}; only ${from} environments can be ${input.suspended ? "suspended" : "resumed"}`,
			);
		await assertOperableOrganization(tx, organization.id, {
			requireNoMembers: input.memberOverrideReason === undefined,
		});
		const moved = input.suspended
			? await tx.instances.suspend(instance.id, organization.id)
			: await tx.instances.resume(instance.id, organization.id, {
					enforceProductionLimit: input.enforceProductionLimit,
				});
		if (!moved)
			throw new Error(
				input.suspended
					? `Environment ${target.instanceKey} could not be suspended`
					: `Environment ${target.instanceKey} could not be resumed: the organization's production limit is reached`,
			);
		await insertPlatformAuditEvent(tx, {
			principalId: null,
			organizationId: organization.id,
			action: input.suspended ? "environment.suspended" : "environment.resumed",
			target: instance.id,
			metadata: {
				...operatorMetadata(input),
				instance: target.instanceKey,
				environment: instance.environment,
				...(input.reason === undefined ? {} : { reason: input.reason }),
			},
		});
		return { ...result, lifecycleStatus: wanted, changed: true };
	});
}
