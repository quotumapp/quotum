import type { MerchantSql } from "../database";
import { MerchantError } from "../security";
import type { ConnectionGate } from "./lifecycle";

/** The instance an operator command acts on, resolved by composition from its key. */
export interface OperatorConnectionTarget {
	organizationId: string;
	platformProjectId: string;
	instanceId: string;
	environment: "sandbox" | "production";
}

export interface OperatorGateOptions {
	/** A headless deployment has no merchants, so members never stand in an operator's way. */
	allowMemberOrganizations: boolean;
	/** Why the operator changes an organization its members manage; audited with each change. */
	memberOverrideReason?: string;
}

/**
 * The gate for operator commands, which hold database access already, so nothing is confirmed.
 * Every transaction re-reads the instance with the merchant gate's filters and requires an active
 * organization. While the merchant platform runs, an organization that has members is managed by
 * them: operators may read it, and change it only with a stated reason.
 */
export function operatorConnectionGate(
	operator: string,
	target: OperatorConnectionTarget,
	{ allowMemberOrganizations, memberOverrideReason }: OperatorGateOptions,
): ConnectionGate {
	const mayChangeMemberOrganizations =
		allowMemberOrganizations || memberOverrideReason !== undefined;
	return {
		actor: {
			kind: "operator",
			name: operator,
			...(memberOverrideReason === undefined ? {} : { memberOverrideReason }),
		},
		environment: target.environment,
		async instance(sql, write) {
			await assertOperableOrganization(sql, target.organizationId, {
				requireNoMembers: write && !mayChangeMemberOrganizations,
			});
			const instance = (await sql.instances.forProject(target.platformProjectId)).find(
				(candidate) =>
					candidate.id === target.instanceId &&
					candidate.environment === target.environment &&
					!candidate.internalProject &&
					(candidate.lifecycleStatus === "active" || candidate.lifecycleStatus === "inactive"),
			);
			if (!instance)
				throw new MerchantError("CONTEXT_UNAVAILABLE", "This environment is unavailable.", 404);
			return instance;
		},
		async lock(tx) {
			const rows =
				await tx`SELECT id FROM platform_organizations WHERE id=${target.organizationId} AND status='active' FOR UPDATE`;
			if (!rows.length)
				throw new MerchantError("CONTEXT_UNAVAILABLE", "This environment is unavailable.", 404);
			// Checked again under the lock: a membership accepted after instance() ran shows here, and
			// a new one waits for this transaction, because its foreign key locks the organization row.
			if (!mayChangeMemberOrganizations)
				await assertOperableOrganization(tx, target.organizationId, { requireNoMembers: true });
		},
		async confirm() {},
		async organizationId() {
			return target.organizationId;
		},
	};
}

/**
 * Requires an active organization and, when `requireNoMembers` is set, one nobody has joined.
 * Other operator commands that change what members manage use it with the same reason rule.
 */
export async function assertOperableOrganization(
	sql: MerchantSql,
	organizationId: string,
	{ requireNoMembers }: { requireNoMembers: boolean },
): Promise<void> {
	const [organization] = await sql<
		{ status: string; has_members: boolean }[]
	>`SELECT status, EXISTS (SELECT 1 FROM platform_memberships WHERE organization_id=${organizationId}) AS has_members FROM platform_organizations WHERE id=${organizationId}`;
	if (organization?.status !== "active")
		throw new MerchantError("CONTEXT_UNAVAILABLE", "This environment is unavailable.", 404);
	if (organization.has_members && requireNoMembers)
		throw new Error(
			"This organization has members, who manage its connections and credentials in the merchant application. Reads need no flag; to change it anyway pass --member-override-reason <why>.",
		);
}
