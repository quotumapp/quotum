import type { InvitationView, MerchantRole, TeamView } from "./contracts";
import type { MerchantSql } from "./database";
import type { MerchantMailer } from "./email";
import { escapeHtml, linkMessage } from "./email";
import { MerchantRoleSchema } from "./schemas";
import {
	capabilitiesFor,
	INVITATION_MS,
	MerchantError,
	maskEmail,
	normalizeEmail,
	randomToken,
	requireCapability,
} from "./security";
import type { MerchantIdentity, MerchantStore } from "./store";

interface InviteRow {
	id: string;
	organization_id: string;
	name: string;
	slug: string;
	email: string;
	role: Exclude<MerchantRole, "Owner">;
	status: "valid" | "used" | "revoked" | "replaced" | "declined";
	expires_at: Date;
	inviter_membership_id: string;
	inviter_revision: number;
	accepted_by: string | null;
}
/** Invitations the inbox lists at once, newest first; each costs a few reads to judge. */
const INBOX_LIMIT = 10;
interface MembershipAccess {
	role: MerchantRole;
	status: string;
}
/** True when the member loses any capability they held: a demotion, suspension or removal. */
export function reducesAccess(before: MembershipAccess, after: MembershipAccess): boolean {
	const held = (access: MembershipAccess) =>
		access.status === "active" ? capabilitiesFor(access.role) : [];
	const kept = new Set(held(after));
	return held(before).some((capability) => !kept.has(capability));
}
export class MerchantTeam {
	constructor(
		private readonly store: MerchantStore,
		private readonly mailer: MerchantMailer,
	) {}
	private async byToken(
		token: string,
		tx: MerchantSql = this.store.sql,
		hashed = false,
	): Promise<InviteRow> {
		const [row] = await tx<
			InviteRow[]
		>`SELECT i.*,o.name,o.slug FROM platform_invitations i JOIN platform_organizations o ON o.id=i.organization_id WHERE i.token_hash=${hashed ? token : this.store.hash(token)}`;
		if (!row)
			throw new MerchantError(
				"INVITATION_NOT_FOUND",
				"This invitation is not available. Ask the organization administrator for a new link.",
				404,
			);
		return row;
	}
	/**
	 * The invitation a signed-in person answers from their inbox. The address in their session is
	 * the filter, so another person's invitation answers like an id that does not exist.
	 */
	private async byIdFor(
		identity: MerchantIdentity,
		id: string,
		tx: MerchantSql = this.store.sql,
	): Promise<InviteRow> {
		const [row] = await tx<
			InviteRow[]
		>`SELECT i.*,o.name,o.slug FROM platform_invitations i JOIN platform_organizations o ON o.id=i.organization_id WHERE i.id=${id} AND i.email=${normalizeEmail(identity.email)}`;
		if (!row)
			throw new MerchantError("INVITATION_NOT_FOUND", "This invitation is not available.", 404);
		return row;
	}
	private async state(
		row: InviteRow,
		identity: MerchantIdentity | null,
		tx: MerchantSql = this.store.sql,
	): Promise<InvitationView["status"]> {
		if (row.status !== "valid") return row.status;
		if (row.expires_at <= this.store.now()) return "expired";
		const [inviter] = await tx<
			{ role: MerchantRole; status: string; revision: number; organization_status: string }[]
		>`SELECT m.role,m.status,m.revision,o.status AS organization_status FROM platform_memberships m JOIN platform_organizations o ON o.id=m.organization_id WHERE m.id=${row.inviter_membership_id}`;
		if (
			inviter?.status !== "active" ||
			inviter.organization_status !== "active" ||
			!["Owner", "Admin"].includes(inviter.role) ||
			inviter.revision !== row.inviter_revision
		)
			return "inviter_authority_lost";
		if (identity && normalizeEmail(identity.email) !== row.email) return "wrong_email";
		if (identity) {
			const [member] = await tx<
				{ status: string }[]
			>`SELECT status FROM platform_memberships WHERE organization_id=${row.organization_id} AND principal_id=${identity.principalId}`;
			if (member?.status === "active") return "already_member";
			// A removed member rejoins through a new invitation; a suspended one is reactivated.
			if (member?.status === "suspended") return "revoked";
		}
		const [seats] = await tx<
			{ used: number; member_limit: number }[]
		>`SELECT (SELECT count(*)::int FROM platform_memberships WHERE organization_id=${row.organization_id} AND status='active') AS used,member_limit FROM platform_organizations WHERE id=${row.organization_id}`;
		if (seats && seats.used >= seats.member_limit) return "seat_limit";
		return "valid";
	}
	private async view(
		row: InviteRow,
		identity: MerchantIdentity | null,
		tx: MerchantSql = this.store.sql,
		management = false,
	): Promise<InvitationView> {
		return {
			id: row.id,
			organizationName: row.name,
			organizationSlug: row.slug,
			email:
				management || normalizeEmail(identity?.email ?? "") === row.email
					? row.email
					: maskEmail(row.email),
			role: row.role,
			expiresAt: row.expires_at.toISOString(),
			status: await this.state(row, management ? null : identity, tx),
		};
	}
	async preview(
		token: string,
		identity: MerchantIdentity | null,
		hashed = false,
	): Promise<InvitationView> {
		return this.view(await this.byToken(token, this.store.sql, hashed), identity);
	}
	async accept(
		identity: MerchantIdentity,
		key: string,
		token: string,
		hashed = false,
	): Promise<{ organizationSlug: string }> {
		return this.store.idempotent(
			identity,
			key,
			["invitation.accept", this.store.hash(token)],
			(tx) => this.accepting(tx, identity, () => this.byToken(token, tx, hashed)),
		);
	}
	/** Accepts an invitation listed in the person's inbox, by its id instead of its emailed link. */
	async acceptById(
		identity: MerchantIdentity,
		key: string,
		id: string,
	): Promise<{ organizationSlug: string }> {
		return this.store.idempotent(identity, key, ["invitation.accept", id], (tx) =>
			this.accepting(tx, identity, () => this.byIdFor(identity, id, tx)),
		);
	}
	/**
	 * Both ways of accepting come through here. The organization is locked before the invitation,
	 * the order every other writer uses, and the invitation is read again once both are held.
	 */
	private async accepting(
		tx: MerchantSql,
		identity: MerchantIdentity,
		find: () => Promise<InviteRow>,
	): Promise<{ organizationSlug: string }> {
		const initial = await find();
		await tx`SELECT id FROM platform_organizations WHERE id=${initial.organization_id} FOR UPDATE`;
		await tx`SELECT id FROM platform_invitations WHERE id=${initial.id} FOR UPDATE`;
		const row = await find();
		if (row.status === "used" && row.accepted_by === identity.principalId)
			return { organizationSlug: row.slug };
		const state = await this.state(row, identity, tx);
		if (state === "already_member") return { organizationSlug: row.slug };
		if (state !== "valid")
			throw new MerchantError(
				`INVITATION_${state.toUpperCase()}`,
				state === "wrong_email"
					? "Sign in with the invited email address."
					: "This invitation can no longer be accepted. Ask an administrator for a new invitation.",
				409,
			);
		// The removed membership, if any, comes back with the invited role; its revision bump
		// keeps invitations it issued before the removal retired.
		await tx`INSERT INTO platform_memberships(organization_id,principal_id,role) VALUES(${row.organization_id},${identity.principalId},${row.role}) ON CONFLICT(organization_id,principal_id) DO UPDATE SET role=EXCLUDED.role,status='active',revision=platform_memberships.revision+1 WHERE platform_memberships.status='removed'`;
		await tx`UPDATE platform_invitations SET status='used',accepted_by=${identity.principalId},accepted_at=${this.store.now()} WHERE id=${row.id}`;
		await this.store.audit(
			tx,
			identity.principalId,
			row.organization_id,
			"invitation.accepted",
			row.id,
			{ role: row.role },
		);
		return { organizationSlug: row.slug };
	}
	/**
	 * The invitations waiting for the signed-in person: addressed to the verified email of their
	 * session, still open and not expired, newest first. Nothing else selects them, so the list
	 * never discloses another address or organization. One connection is used for the reads in turn,
	 * because the pool is shared with the `/v1` API.
	 */
	async inbox(identity: MerchantIdentity): Promise<InvitationView[]> {
		const rows = await this.store.sql<
			InviteRow[]
		>`SELECT i.*,o.name,o.slug FROM platform_invitations i JOIN platform_organizations o ON o.id=i.organization_id WHERE i.email=${normalizeEmail(identity.email)} AND i.status='valid' AND i.expires_at>${this.store.now()} AND o.status='active' ORDER BY i.created_at DESC,i.id LIMIT ${INBOX_LIMIT}`;
		const views: InvitationView[] = [];
		for (const row of rows) views.push(await this.view(row, identity));
		// A person who joined another way has nothing left to answer.
		return views.filter((view) => view.status !== "already_member");
	}
	/**
	 * Declines an invitation from the inbox. The inviter's organization can invite the address
	 * again, which `resend` already does for any invitation that is not used.
	 */
	async decline(
		identity: MerchantIdentity,
		key: string,
		id: string,
	): Promise<{ status: "declined" }> {
		return this.store.idempotent(identity, key, ["invitation.decline", id], async (tx) => {
			const initial = await this.byIdFor(identity, id, tx);
			await tx`SELECT id FROM platform_organizations WHERE id=${initial.organization_id} FOR UPDATE`;
			await tx`SELECT id FROM platform_invitations WHERE id=${initial.id} FOR UPDATE`;
			const row = await this.byIdFor(identity, id, tx);
			// Declining what is already declined, revoked or replaced changes nothing, so it records
			// nothing; an invitation that was accepted cannot be taken back this way.
			if (row.status === "used")
				throw new MerchantError(
					"INVITATION_USED",
					"This invitation was already accepted. Ask an administrator to remove you instead.",
					409,
				);
			if (row.status !== "valid") return { status: "declined" };
			await tx`UPDATE platform_invitations SET status='declined' WHERE id=${row.id}`;
			await this.store.audit(
				tx,
				identity.principalId,
				row.organization_id,
				"invitation.declined",
				row.id,
				{ role: row.role },
			);
			return { status: "declined" };
		});
	}
	async list(identity: MerchantIdentity, slug: string): Promise<TeamView> {
		const member = await this.store.membership(this.store.sql, identity.principalId, slug);
		const members = await this.store.sql<
			TeamView["members"]
		>`SELECT m.id,u.name,u.email,m.role,m.status FROM platform_memberships m JOIN platform_principals p ON p.id=m.principal_id JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE m.organization_id=${member.organization_id} ORDER BY m.created_at,m.id`;
		const rows = await this.store.sql<
			InviteRow[]
		>`SELECT i.*,o.name,o.slug FROM platform_invitations i JOIN platform_organizations o ON o.id=i.organization_id WHERE i.organization_id=${member.organization_id} ORDER BY i.created_at DESC,i.id LIMIT 100`;
		return {
			organizationSlug: slug,
			roleDefinitions: MerchantRoleSchema.options.map((role) => ({
				role,
				capabilities: capabilitiesFor(role),
			})),
			canManage: member.role === "Owner" || member.role === "Admin",
			members: [...members],
			invitations: await Promise.all(rows.map((r) => this.view(r, identity, this.store.sql, true))),
		};
	}
	async invite(
		identity: MerchantIdentity,
		key: string,
		input: { organizationSlug: string; email: string; role: Exclude<MerchantRole, "Owner"> },
		replaceId?: string,
	): Promise<InvitationView> {
		const token = randomToken();
		let sendEmail = false;
		const result = await this.store.idempotent(
			identity,
			key,
			["invitation.create", input, replaceId],
			async (tx) => {
				const member = await this.store.membership(
					tx,
					identity.principalId,
					input.organizationSlug,
					true,
				);
				requireCapability(member.role, "team.manage");
				if (replaceId) {
					const [old] = await tx<
						{ email: string; status: string }[]
					>`SELECT email,status FROM platform_invitations WHERE id=${replaceId} AND organization_id=${member.organization_id} FOR UPDATE`;
					if (!old || old.email !== input.email || old.status === "used")
						throw new MerchantError(
							"INVITATION_NOT_FOUND",
							"This invitation cannot be replaced.",
							404,
						);
					await tx`UPDATE platform_invitations SET status='replaced' WHERE id=${replaceId}`;
				}
				const existing = await tx<
					{ status: string }[]
				>`SELECT m.status FROM platform_memberships m JOIN platform_principals p ON p.id=m.principal_id JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE m.organization_id=${member.organization_id} AND u.email=${input.email} AND m.status<>'removed'`;
				if (existing.some((m) => m.status === "active"))
					throw new MerchantError(
						"ALREADY_MEMBER",
						"This person is already an organization member.",
						409,
					);
				if (existing.length)
					throw new MerchantError(
						"MEMBER_SUSPENDED",
						"This person is a suspended member. Reactivate their membership instead of inviting them.",
						409,
					);
				await tx`UPDATE platform_invitations SET status='replaced' WHERE organization_id=${member.organization_id} AND email=${input.email} AND status='valid' AND expires_at<=${this.store.now()}`;
				const pending =
					await tx`SELECT id FROM platform_invitations WHERE organization_id=${member.organization_id} AND email=${input.email} AND status='valid'`;
				if (pending.length)
					throw new MerchantError(
						"INVITATION_EXISTS",
						"An invitation already exists. Resend it to issue a new link.",
						409,
					);
				// Each invitation, including a resend, mails an address the caller chose. Charged here, inside
				// the transaction and after every refusal, so a replay or a refused request spends nothing and
				// a limit hit leaves the invitation a resend would have replaced valid.
				await this.store.rateLimit(
					`invitation:principal:${identity.principalId}`,
					30,
					60 * 60_000,
					tx,
				);
				await this.store.rateLimit(
					`invitation:organization:${member.organization_id}`,
					100,
					24 * 60 * 60_000,
					tx,
				);
				const [created] = await tx<
					{ id: string }[]
				>`INSERT INTO platform_invitations(organization_id,inviter_membership_id,inviter_revision,email,role,token_hash,expires_at) VALUES(${member.organization_id},${member.id},${member.revision},${input.email},${input.role},${this.store.hash(token)},${new Date(this.store.now().getTime() + INVITATION_MS)}) RETURNING id`;
				if (!created) throw new Error("Invitation insert failed");
				await this.store.audit(
					tx,
					identity.principalId,
					member.organization_id,
					replaceId ? "invitation.replaced" : "invitation.created",
					created.id,
					{ role: input.role },
				);
				sendEmail = true;
				return this.view(await this.byToken(token, tx), identity, tx, true);
			},
		);
		if (sendEmail) {
			try {
				await this.mailer.send(
					linkMessage(
						input.email,
						"invitation",
						`Join ${result.organizationName} on Quotum`,
						`${this.store.config.origin}/invite#token=${encodeURIComponent(token)}`,
					),
				);
				await this.store
					.sql`UPDATE platform_invitations SET delivery_status='sent' WHERE id=${result.id}`;
			} catch {
				await this.store
					.sql`UPDATE platform_invitations SET delivery_status='failed' WHERE id=${result.id}`;
				throw new MerchantError(
					"EMAIL_DELIVERY_FAILED",
					"The invitation was saved, but email delivery failed. Use Resend invitation to try again.",
					503,
				);
			}
		}
		return result;
	}
	async resend(
		identity: MerchantIdentity,
		key: string,
		id: string,
		slug: string,
		role?: Exclude<MerchantRole, "Owner">,
	): Promise<InvitationView> {
		const member = await this.store.membership(this.store.sql, identity.principalId, slug);
		requireCapability(member.role, "team.manage");
		const [row] = await this.store.sql<
			{ email: string; role: Exclude<MerchantRole, "Owner"> }[]
		>`SELECT email,role FROM platform_invitations WHERE id=${id} AND organization_id=${member.organization_id}`;
		if (!row) throw new MerchantError("INVITATION_NOT_FOUND", "Invitation not found.", 404);
		return this.invite(
			identity,
			key,
			{ organizationSlug: slug, email: row.email, role: role ?? row.role },
			id,
		);
	}
	async revoke(
		identity: MerchantIdentity,
		key: string,
		id: string,
		slug: string,
	): Promise<{ status: "revoked" }> {
		return this.store.idempotent(identity, key, ["invitation.revoke", id, slug], async (tx) => {
			const member = await this.store.membership(tx, identity.principalId, slug, true);
			requireCapability(member.role, "team.manage");
			const [invitation] = await tx<
				{ status: string }[]
			>`SELECT status FROM platform_invitations WHERE id=${id} AND organization_id=${member.organization_id} FOR UPDATE`;
			if (!invitation || invitation.status === "used")
				throw new MerchantError("INVITATION_NOT_FOUND", "Invitation not found.", 404);
			// Revoking again changes nothing, so it records nothing; nor does revoking what the invitee
			// already declined, which is no longer open and keeps its own status.
			if (invitation.status === "revoked" || invitation.status === "declined")
				return { status: "revoked" };
			await tx`UPDATE platform_invitations SET status='revoked' WHERE id=${id}`;
			await this.store.audit(
				tx,
				identity.principalId,
				member.organization_id,
				"invitation.revoked",
				id,
			);
			return { status: "revoked" };
		});
	}
	async updateMember(
		identity: MerchantIdentity,
		key: string,
		id: string,
		input: {
			organizationSlug: string;
			role?: Exclude<MerchantRole, "Owner">;
			status?: "active" | "suspended" | "removed";
		},
	): Promise<{ status: "updated" }> {
		return this.store.idempotent(identity, key, ["membership.update", id, input], async (tx) => {
			const actor = await this.store.membership(
				tx,
				identity.principalId,
				input.organizationSlug,
				true,
			);
			requireCapability(actor.role, "team.manage");
			const [target] = await tx<
				{ principal_id: string; role: MerchantRole; status: string }[]
			>`SELECT principal_id,role,status FROM platform_memberships WHERE id=${id} AND organization_id=${actor.organization_id} FOR UPDATE`;
			if (!target) throw new MerchantError("NOT_FOUND", "Member not found.", 404);
			if (target.status === "removed")
				throw new MerchantError(
					"MEMBER_REMOVED",
					"This person was removed. Invite them again to restore their access.",
					409,
				);
			if (target.role === "Owner")
				throw new MerchantError(
					"OWNER_PROTECTED",
					"Owner changes require an ownership transfer.",
					403,
				);
			const nextRole = input.role ?? target.role;
			const nextStatus = input.status ?? target.status;
			if (nextRole === target.role && nextStatus === target.status) return { status: "updated" };
			if (nextStatus === "active" && target.status !== "active") {
				const [seats] = await tx<
					{ used: number }[]
				>`SELECT count(*)::int AS used FROM platform_memberships WHERE organization_id=${actor.organization_id} AND status='active'`;
				if (seats && seats.used >= actor.member_limit)
					throw new MerchantError(
						"SEAT_LIMIT",
						"The organization has reached its member limit.",
						409,
					);
			}
			// The revision stamps invitations this member issued, so any change retires them.
			await tx`UPDATE platform_memberships SET role=${nextRole},status=${nextStatus},revision=revision+1 WHERE id=${id}`;
			// Sessions belong to the person, not to one organization, and every request re-reads the
			// membership, so reduced access takes effect without signing them out elsewhere. What
			// this organization issued under the old access ends here; the status trigger revokes
			// its MCP authorizations.
			if (reducesAccess(target, { role: nextRole, status: nextStatus })) {
				await tx`UPDATE platform_invitations SET status='revoked' WHERE inviter_membership_id=${id} AND status='valid'`;
				await tx`UPDATE platform_step_up_grants SET expires_at=${this.store.now()} WHERE organization_id=${actor.organization_id} AND consumed_at IS NULL AND expires_at>${this.store.now()} AND session_id IN (SELECT id FROM platform_merchant_sessions WHERE principal_id=${target.principal_id})`;
			}
			await this.store.audit(
				tx,
				identity.principalId,
				actor.organization_id,
				"membership.updated",
				id,
				{ role: nextRole, status: nextStatus },
			);
			return { status: "updated" };
		});
	}
	async requestReplacement(token: string, hashed = false): Promise<{ status: "requested" }> {
		await this.store.rateLimit(
			`invite-request:${hashed ? token : this.store.hash(token)}`,
			3,
			24 * 60 * 60_000,
		);
		let invite: InviteRow;
		try {
			invite = await this.byToken(token, this.store.sql, hashed);
		} catch {
			return { status: "requested" };
		}
		if (invite.status !== "valid" || invite.expires_at > this.store.now())
			return { status: "requested" };
		const [inviter] = await this.store.sql<
			{ email: string }[]
		>`SELECT u.email FROM platform_memberships m JOIN platform_principals p ON p.id=m.principal_id JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE m.id=${invite.inviter_membership_id} AND m.status='active' AND m.role IN ('Owner','Admin') AND m.revision=${invite.inviter_revision}`;
		if (inviter) {
			const text =
				"Someone requested a replacement for an expired Quotum invitation. Review invitations in your organization's Team page.";
			await this.mailer.send({
				to: inviter.email,
				kind: "invite_request",
				subject: "Invitation replacement requested",
				text,
				html: `<p>${escapeHtml(text)}</p>`,
			});
		}
		return { status: "requested" };
	}
}
