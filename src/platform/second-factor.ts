import { timingSafeEqual } from "node:crypto";
import { base32 } from "@better-auth/utils/base32";
import { createOTP } from "@better-auth/utils/otp";
import { generateRandomString } from "better-auth/crypto";
import type { MerchantSql } from "./database";
import { MerchantError } from "./security";
import type { MerchantStore } from "./store";

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
export const RECOVERY_CODE_COUNT = 10;
/** Consecutive failures that lock a person's second factor, and for how long. */
export const SECOND_FACTOR_MAX_FAILURES = 5;
export const SECOND_FACTOR_LOCK_SECONDS = 15 * 60;
const TOTP_SHAPE = /^[0-9]{6}$/;
const RECOVERY_SHAPE = /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/;
const ISSUER = "Quotum";
/** The unusable value every account carries until it enrols; never a ciphertext. */
export const UNENROLLED_SECRET = "email-otp-only";

/** Seals a value with the authentication library's current key, so rotation stays its concern. */
export interface SecretSealer {
	seal(plain: string): Promise<string>;
	open(sealed: string): Promise<string>;
}

interface FactorRow {
	id: string;
	secret: string;
	backup_codes: string;
	verified: boolean | null;
	failed_verification_count: number;
	locked_until: Date | null;
	pending_secret: string | null;
	last_used_step: string | number | null;
	backup_codes_remaining: number;
}

export type TotpClaim =
	| { status: "claimed"; step: number }
	| { status: "mismatch" }
	| { status: "replayed" }
	| { status: "locked"; until: Date }
	| { status: "unenrolled" };

export type CodeKind = "totp" | "recovery_code";

export function codeKind(input: string): CodeKind | null {
	if (TOTP_SHAPE.test(input)) return "totp";
	if (RECOVERY_SHAPE.test(input)) return "recovery_code";
	return null;
}

function equalText(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

export function generateRecoveryCodes(): string[] {
	return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
		const code = generateRandomString(10, "a-z", "0-9", "A-Z");
		return `${code.slice(0, 5)}-${code.slice(5)}`;
	});
}

/**
 * The counter a code was generated for within the verification window, or null. The window is the
 * library's own (one step either side), and every candidate is compared so timing does not say
 * which step matched.
 */
export async function matchTotpStep(
	secret: string,
	code: string,
	now: Date = new Date(),
): Promise<number | null> {
	if (!TOTP_SHAPE.test(code)) return null;
	const otp = createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS });
	const current = Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
	let matched: number | null = null;
	for (const step of [current - 1, current, current + 1]) {
		if (equalText(await otp.hotp(step), code)) matched = step;
	}
	return matched;
}

export class MerchantSecondFactor {
	constructor(
		private readonly store: MerchantStore,
		private readonly sealer: SecretSealer,
	) {}

	private async row(userId: string, executor: MerchantSql = this.store.sql) {
		const [row] = await executor<
			FactorRow[]
		>`SELECT id,secret,backup_codes,verified,failed_verification_count,locked_until,pending_secret,last_used_step,backup_codes_remaining FROM platform_auth_two_factors WHERE user_id=${userId}`;
		return row ?? null;
	}

	/** Every account owns exactly one row; this restores the placeholder if it is missing. */
	private async ensureRow(userId: string): Promise<FactorRow> {
		await this.store
			.sql`INSERT INTO platform_auth_two_factors(user_id,secret,backup_codes,verified) VALUES(${userId},${UNENROLLED_SECRET},'[]',false) ON CONFLICT(user_id) DO NOTHING`;
		const row = await this.row(userId);
		if (!row) throw new Error("Second factor row missing");
		return row;
	}

	async status(
		userId: string,
		executor: MerchantSql = this.store.sql,
	): Promise<{ enrolled: boolean; recoveryCodesRemaining: number }> {
		const row = await this.row(userId, executor);
		const enrolled = row?.verified === true;
		return { enrolled, recoveryCodesRemaining: enrolled ? (row?.backup_codes_remaining ?? 0) : 0 };
	}

	async isEnrolled(userId: string): Promise<boolean> {
		return (await this.status(userId)).enrolled;
	}

	/** A lock that has lapsed is cleared; one still running is reported. */
	private async lockedUntil(row: FactorRow, now: Date): Promise<Date | null> {
		if (!row.locked_until) return null;
		if (row.locked_until.getTime() > now.getTime()) return row.locked_until;
		await this.store
			.sql`UPDATE platform_auth_two_factors SET failed_verification_count=0,locked_until=NULL WHERE id=${row.id} AND locked_until<=${now}`;
		return null;
	}

	/**
	 * Counts one failed verification and locks the factor once the budget is spent. It is a single
	 * statement on its own connection, so a caller that throws afterwards cannot roll it back.
	 */
	async recordFailure(userId: string, now: Date = new Date()): Promise<void> {
		const until = new Date(now.getTime() + SECOND_FACTOR_LOCK_SECONDS * 1000);
		await this.store
			.sql`UPDATE platform_auth_two_factors SET failed_verification_count=failed_verification_count+1,locked_until=CASE WHEN failed_verification_count+1>=${SECOND_FACTOR_MAX_FAILURES} THEN ${until} ELSE locked_until END WHERE user_id=${userId}`;
	}

	/**
	 * Matches a TOTP against the active secret and consumes its step in one compare-and-set, so a
	 * code works once (RFC 6238 section 5.2). It never throws for a wrong code: the caller decides
	 * whether a mismatch is its own failure or the sign-in library's to count.
	 */
	async claimTotp(userId: string, code: string, now: Date = new Date()): Promise<TotpClaim> {
		const row = await this.row(userId);
		if (row?.verified !== true) return { status: "unenrolled" };
		const locked = await this.lockedUntil(row, now);
		if (locked) return { status: "locked", until: locked };
		const secret = await this.sealer.open(row.secret);
		const step = await matchTotpStep(secret, code, now);
		if (step === null) return { status: "mismatch" };
		const claimed = await this.store.sql<
			{ id: string }[]
		>`UPDATE platform_auth_two_factors SET last_used_step=${step},failed_verification_count=0,locked_until=NULL WHERE id=${row.id} AND verified=true AND (last_used_step IS NULL OR last_used_step<${step}) RETURNING id`;
		return claimed.length ? { status: "claimed", step } : { status: "replayed" };
	}

	/**
	 * Removes a recovery code if it is one of the account's. Concurrent uses of the same code race on
	 * the stored value, so only one of them wins.
	 */
	async claimRecoveryCode(userId: string, code: string): Promise<boolean> {
		const row = await this.row(userId);
		if (row?.verified !== true) return false;
		let codes: unknown;
		try {
			codes = JSON.parse(await this.sealer.open(row.backup_codes));
		} catch {
			return false;
		}
		if (!Array.isArray(codes)) return false;
		let found = false;
		const remaining: string[] = [];
		for (const candidate of codes) {
			if (typeof candidate !== "string") continue;
			if (!found && equalText(candidate, code)) found = true;
			else remaining.push(candidate);
		}
		if (!found) return false;
		const updated = await this.store.sql<
			{ id: string }[]
		>`UPDATE platform_auth_two_factors SET backup_codes=${await this.sealer.seal(JSON.stringify(remaining))},backup_codes_remaining=${remaining.length},failed_verification_count=0,locked_until=NULL WHERE id=${row.id} AND backup_codes=${row.backup_codes} RETURNING id`;
		return updated.length > 0;
	}

	/** Brings the stored count back in step after the sign-in library spent a recovery code. */
	async syncRecoveryCount(userId: string): Promise<void> {
		const row = await this.row(userId);
		if (row?.verified !== true) return;
		try {
			const codes = JSON.parse(await this.sealer.open(row.backup_codes));
			if (Array.isArray(codes))
				await this.store
					.sql`UPDATE platform_auth_two_factors SET backup_codes_remaining=${codes.length} WHERE id=${row.id}`;
		} catch {
			// An unreadable value stays as it is; the next verification reports the problem.
		}
	}

	/** Verifies a TOTP or a recovery code for an action in the merchant API. */
	async verifyCode(userId: string, input: string, now: Date = new Date()): Promise<CodeKind> {
		const kind = codeKind(input);
		if (!kind)
			throw new MerchantError(
				"INVALID_CODE",
				"Enter the 6-digit code shown in your authenticator app, or a recovery code.",
			);
		await this.store.rateLimit(`second-factor:verify:${userId}`, 30, 15 * 60_000);
		if (kind === "recovery_code") {
			const row = await this.row(userId);
			if (row?.verified !== true) throw notEnrolled();
			const locked = await this.lockedUntil(row, now);
			if (locked) throw lockedError(locked, now);
			if (await this.claimRecoveryCode(userId, input)) return kind;
			await this.recordFailure(userId, now);
			throw invalidCode();
		}
		const claim = await this.claimTotp(userId, input, now);
		if (claim.status === "claimed") return kind;
		if (claim.status === "unenrolled") throw notEnrolled();
		if (claim.status === "locked") throw lockedError(claim.until, now);
		await this.recordFailure(userId, now);
		throw claim.status === "replayed" ? replayedCode() : invalidCode();
	}

	/**
	 * Starts enrolling an authenticator, or replacing one. The new secret waits in its own column so
	 * the active factor keeps working until the new one proves itself.
	 */
	async beginEnrolment(user: {
		id: string;
		email: string;
	}): Promise<{ otpauthUri: string; secret: string }> {
		await this.store.rateLimit(`second-factor:enrol:${user.id}`, 10, 15 * 60_000);
		await this.ensureRow(user.id);
		const secret = generateRandomString(32);
		await this.store
			.sql`UPDATE platform_auth_two_factors SET pending_secret=${await this.sealer.seal(secret)} WHERE user_id=${user.id}`;
		const otp = createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS });
		return {
			otpauthUri: otp.url(ISSUER, user.email),
			secret: base32.encode(secret, { padding: false }),
		};
	}

	/**
	 * Promotes the pending authenticator once it produces a valid code, and issues a fresh set of
	 * recovery codes. `within` runs in the same transaction, for the caller's own state.
	 */
	async confirmEnrolment(
		userId: string,
		code: string,
		within?: (tx: MerchantSql, info: { replaced: boolean }) => Promise<void>,
		now: Date = new Date(),
	): Promise<{ recoveryCodes: string[]; replaced: boolean }> {
		if (!TOTP_SHAPE.test(code)) throw invalidCode();
		await this.store.rateLimit(`second-factor:confirm:${userId}`, 10, 15 * 60_000);
		const row = await this.row(userId);
		if (!row?.pending_secret)
			throw new MerchantError(
				"ENROLMENT_NOT_STARTED",
				"Start setting up your authenticator again.",
				409,
			);
		const locked = await this.lockedUntil(row, now);
		if (locked) throw lockedError(locked, now);
		const step = await matchTotpStep(await this.sealer.open(row.pending_secret), code, now);
		if (step === null) {
			await this.recordFailure(userId, now);
			throw invalidCode();
		}
		const recoveryCodes = generateRecoveryCodes();
		const sealedCodes = await this.sealer.seal(JSON.stringify(recoveryCodes));
		const replaced = row.verified === true;
		await this.store.sql.begin(async (tx) => {
			const promoted = await tx<
				{ id: string }[]
			>`UPDATE platform_auth_two_factors SET secret=pending_secret,pending_secret=NULL,verified=true,last_used_step=${step},enrolled_at=COALESCE(enrolled_at,${now}),failed_verification_count=0,locked_until=NULL,backup_codes=${sealedCodes},backup_codes_remaining=${recoveryCodes.length} WHERE id=${row.id} AND pending_secret=${row.pending_secret} RETURNING id`;
			if (!promoted.length)
				throw new MerchantError(
					"ENROLMENT_NOT_STARTED",
					"Start setting up your authenticator again.",
					409,
				);
			await within?.(tx, { replaced });
		});
		return { recoveryCodes, replaced };
	}

	/** Replaces every recovery code; the caller has already verified a current code. */
	async regenerateRecoveryCodes(userId: string): Promise<string[]> {
		const recoveryCodes = generateRecoveryCodes();
		const updated = await this.store.sql<
			{ id: string }[]
		>`UPDATE platform_auth_two_factors SET backup_codes=${await this.sealer.seal(JSON.stringify(recoveryCodes))},backup_codes_remaining=${recoveryCodes.length} WHERE user_id=${userId} AND verified=true RETURNING id`;
		if (!updated.length) throw notEnrolled();
		return recoveryCodes;
	}
}

export function invalidCode(): MerchantError {
	return new MerchantError(
		"INVALID_CODE",
		"That code is not valid. Enter the current code shown in your authenticator app.",
	);
}
export function replayedCode(): MerchantError {
	return new MerchantError(
		"CODE_ALREADY_USED",
		"That code was already used. Wait for the next code shown in your authenticator app.",
		409,
	);
}
export function notEnrolled(): MerchantError {
	return new MerchantError(
		"SECOND_FACTOR_REQUIRED",
		"Set up an authenticator app before continuing.",
		409,
	);
}
export function lockedError(until: Date, now: Date = new Date()): MerchantError {
	return new MerchantError(
		"ACCOUNT_TEMPORARILY_LOCKED",
		"Too many failed verification attempts. Your account is temporarily locked. Please try again later.",
		429,
		Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000)),
	);
}
