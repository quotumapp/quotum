import { insertPlatformAuditEvent } from "./audit";
import type { MerchantSql } from "./database";
import { revokeMcpAuthorizationsForUser } from "./mcp/authorization";
import { UNENROLLED_SECRET } from "./second-factor";

export interface ResetSecondFactorInput {
	/** The address the person signed in to the merchant application with. */
	email: string;
	/** The operator the audit event names. */
	operator: string;
	/** Why the operator resets it; the audit event keeps it. */
	reason: string;
}

export interface ResetSecondFactorResult {
	email: string;
	/** False when the person had no authenticator, so only their sign-ins were ended. */
	hadAuthenticator: boolean;
	sessionsRevoked: number;
}

/**
 * Returns a person to the state of someone who has not set an authenticator up: the secret, the
 * recovery codes and the lockout are cleared, and every sign-in they hold ends, console sessions
 * and coding-client grants alike. They then sign in with their password and the emailed code that
 * proves the mailbox, and set a new authenticator up. This is the only way back for someone who
 * lost both their authenticator and their recovery codes, so the operator is expected to have
 * confirmed who is asking by a channel of their own; nothing here sends mail or opens a sign-in.
 */
export async function resetSecondFactor(
	sql: MerchantSql,
	input: ResetSecondFactorInput,
): Promise<ResetSecondFactorResult> {
	const email = input.email.trim();
	return await sql.begin(async (tx) => {
		const [person] = await tx<
			{ id: string; email: string }[]
		>`SELECT id,email FROM platform_auth_users WHERE lower(email)=lower(${email}) FOR UPDATE`;
		if (!person) throw new Error("No merchant user has that address.");
		const [factor] = await tx<
			{ verified: boolean | null }[]
		>`SELECT verified FROM platform_auth_two_factors WHERE user_id=${person.id} FOR UPDATE`;
		await tx`INSERT INTO platform_auth_two_factors(user_id,secret,backup_codes,verified) VALUES(${person.id},${UNENROLLED_SECRET},'[]',false) ON CONFLICT(user_id) DO UPDATE SET secret=${UNENROLLED_SECRET},backup_codes='[]',verified=false,pending_secret=NULL,last_used_step=NULL,enrolled_at=NULL,backup_codes_remaining=0,failed_verification_count=0,locked_until=NULL`;
		const revoked = await tx<
			{ id: string }[]
		>`UPDATE platform_merchant_sessions SET revoked_at=now() WHERE principal_id IN (SELECT id FROM platform_principals WHERE auth_user_id=${person.id}) AND revoked_at IS NULL RETURNING id`;
		// A sign-in in progress would otherwise carry on with the factor it started with. The library
		// stores identifiers hashed, but a pending challenge or reset token holds the person's id.
		await tx`DELETE FROM platform_auth_sessions WHERE user_id=${person.id}`;
		await tx`DELETE FROM platform_auth_verifications WHERE value=${person.id}`;
		await revokeMcpAuthorizationsForUser(tx, person.id, new Date(), "second_factor_reset");
		await insertPlatformAuditEvent(tx, {
			principalId: null,
			organizationId: null,
			action: "second_factor.operator_reset",
			target: person.id,
			metadata: {
				operator: input.operator,
				reason: input.reason,
				hadAuthenticator: factor?.verified === true,
				sessionsRevoked: revoked.length,
			},
		});
		return {
			email: person.email,
			hadAuthenticator: factor?.verified === true,
			sessionsRevoked: revoked.length,
		};
	});
}
