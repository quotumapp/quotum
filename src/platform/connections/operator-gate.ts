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

/**
 * The gate for operator commands, which hold database access already, so nothing is confirmed.
 * Every transaction re-reads the instance with the merchant gate's filters and requires an active
 * organization. While the merchant platform runs, an organization that has members is managed by
 * them, so operators may act only on organizations nobody has joined.
 */
export function operatorConnectionGate(
	operator: string,
	target: OperatorConnectionTarget,
	{ allowMemberOrganizations }: { allowMemberOrganizations: boolean },
): ConnectionGate {
	return {
		actor: { kind: "operator", name: operator },
		environment: target.environment,
		async instance(sql) {
			await assertOperableOrganization(sql, target.organizationId, allowMemberOrganizations);
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
			if (!allowMemberOrganizations)
				await assertOperableOrganization(tx, target.organizationId, false);
		},
		async confirm() {},
		async organizationId() {
			return target.organizationId;
		},
	};
}

async function assertOperableOrganization(
	sql: MerchantSql,
	organizationId: string,
	allowMemberOrganizations: boolean,
): Promise<void> {
	const [organization] = await sql<
		{ status: string; has_members: boolean }[]
	>`SELECT status, EXISTS (SELECT 1 FROM platform_memberships WHERE organization_id=${organizationId}) AS has_members FROM platform_organizations WHERE id=${organizationId}`;
	if (organization?.status !== "active")
		throw new MerchantError("CONTEXT_UNAVAILABLE", "This environment is unavailable.", 404);
	if (organization.has_members && !allowMemberOrganizations)
		throw new Error(
			"This organization has members, who manage its connections and credentials in the merchant application",
		);
}
