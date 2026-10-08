import { insertPlatformAuditEvent } from "./audit";
import { assertOperableOrganization } from "./connections/operator-gate";
import type { MerchantSql } from "./database";

export interface AddOrganizationOwnerInput {
	organizationSlug: string;
	/** The address the person signed in to the merchant application with. */
	email: string;
	/** The operator the audit event names. */
	operator: string;
	/** Why the operator adds an owner to an organization that already has members. */
	memberOverrideReason?: string;
}

export interface AddOrganizationOwnerResult {
	organization: string;
	email: string;
	role: "Owner";
	membershipId: string;
	/** False when the person was already an active owner, so nothing changed. */
	added: boolean;
}

/**
 * Makes a person who has signed in to the merchant application an owner of an organization. This is
 * how a bootstrap-created organization, which has no members and cannot send an invitation, reaches
 * a human: invitations need a member as inviter and cannot carry the Owner role. The person must
 * already exist, because creating a sign-in belongs to the person. An organization that already has
 * members needs a stated reason, as the connection and credential commands do. Existing memberships
 * are never changed; the merchant application owns role and status changes.
 */
export async function addOrganizationOwner(
	sql: MerchantSql,
	input: AddOrganizationOwnerInput,
): Promise<AddOrganizationOwnerResult> {
	const email = input.email.trim();
	return await sql.begin(async (tx) => {
		// The lock serializes this with invitations accepted into the same organization.
		const [organization] = await tx<
			{ id: string; status: string; member_limit: number }[]
		>`SELECT id,status,member_limit FROM platform_organizations WHERE slug=${input.organizationSlug} FOR UPDATE`;
		if (!organization) throw new Error(`Organization ${input.organizationSlug} was not found`);
		if (organization.status !== "active")
			throw new Error(`Organization ${input.organizationSlug} is ${organization.status}`);
		const [person] = await tx<
			{ id: string; status: string; email_verified: boolean }[]
		>`SELECT p.id,p.status,u.email_verified FROM platform_principals p JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE lower(u.email)=lower(${email})`;
		if (!person)
			throw new Error(
				"No merchant user has signed in with that address. Ask them to sign in once, then run this again.",
			);
		if (person.status !== "active" || !person.email_verified)
			throw new Error("That merchant user is not active or has not verified their email address");
		const [existing] = await tx<
			{ id: string; role: string; status: string }[]
		>`SELECT id,role,status FROM platform_memberships WHERE organization_id=${organization.id} AND principal_id=${person.id} FOR UPDATE`;
		const result = { organization: input.organizationSlug, email, role: "Owner" as const };
		// Nothing changes for an owner already in place, so a repeated run needs no reason.
		if (existing?.role === "Owner" && existing.status === "active")
			return { ...result, membershipId: existing.id, added: false };
		await assertOperableOrganization(tx, organization.id, {
			requireNoMembers: input.memberOverrideReason === undefined,
		});
		if (existing)
			throw new Error(
				`That person already has a membership here (${existing.role}, ${existing.status}); change it in the merchant application`,
			);
		const [seats] = await tx<
			{ used: number }[]
		>`SELECT count(*)::int AS used FROM platform_memberships WHERE organization_id=${organization.id} AND status='active'`;
		if (seats && seats.used >= organization.member_limit)
			throw new Error(
				`The organization has reached its member limit of ${organization.member_limit}`,
			);
		const [membership] = await tx<
			{ id: string }[]
		>`INSERT INTO platform_memberships(organization_id,principal_id,role) VALUES(${organization.id},${person.id},'Owner') RETURNING id`;
		if (!membership) throw new Error("The owner membership was not created");
		await insertPlatformAuditEvent(tx, {
			principalId: null,
			organizationId: organization.id,
			action: "membership.operator_owner_added",
			target: membership.id,
			metadata: {
				operator: input.operator,
				...(input.memberOverrideReason === undefined
					? {}
					: { memberOverrideReason: input.memberOverrideReason }),
			},
		});
		return { ...result, membershipId: membership.id, added: true };
	});
}
