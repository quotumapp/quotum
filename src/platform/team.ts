import type { InvitationView, MerchantRole, TeamView } from "./contracts";
import type { MerchantSql } from "./database";
import type { MerchantMailer } from "./email";
import { escapeHtml, linkMessage } from "./email";
import {
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
	status: "valid" | "used" | "revoked" | "replaced";
	expires_at: Date;
	inviter_membership_id: string;
	inviter_revision: number;
	accepted_by: string | null;
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
			if (member) return "revoked";
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
			async (tx) => {
				const initial = await this.byToken(token, tx, hashed);
				await tx`SELECT id FROM platform_organizations WHERE id=${initial.organization_id} FOR UPDATE`;
				await tx`SELECT id FROM platform_invitations WHERE id=${initial.id} FOR UPDATE`;
				const row = await this.byToken(token, tx, hashed);
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
				await tx`INSERT INTO platform_memberships(organization_id,principal_id,role) VALUES(${row.organization_id},${identity.principalId},${row.role})`;
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
			},
		);
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
				const existing =
					await tx`SELECT m.id FROM platform_memberships m JOIN platform_principals p ON p.id=m.principal_id JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE m.organization_id=${member.organization_id} AND u.email=${input.email} AND m.status='active'`;
				if (existing.length)
					throw new MerchantError(
						"ALREADY_MEMBER",
						"This person is already an organization member.",
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
			const rows =
				await tx`UPDATE platform_invitations SET status='revoked' WHERE id=${id} AND organization_id=${member.organization_id} AND status<>'used' RETURNING id`;
			if (!rows.length)
				throw new MerchantError("INVITATION_NOT_FOUND", "Invitation not found.", 404);
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
			if (target.role === "Owner")
				throw new MerchantError(
					"OWNER_PROTECTED",
					"Owner changes require an ownership transfer.",
					403,
				);
			const nextStatus = input.status ?? target.status;
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
			await tx`UPDATE platform_memberships SET role=${input.role ?? target.role},status=${nextStatus},revision=revision+1 WHERE id=${id}`;
			// Reauthentication is required after every membership change, including demotion.
			await tx`UPDATE platform_merchant_sessions SET revoked_at=${this.store.now()} WHERE principal_id=${target.principal_id} AND revoked_at IS NULL`;
			await tx`UPDATE platform_invitations SET status='revoked' WHERE inviter_membership_id=${id} AND status='valid'`;
			await this.store.audit(
				tx,
				identity.principalId,
				actor.organization_id,
				"membership.updated",
				id,
				{ role: input.role ?? target.role, status: nextStatus },
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
