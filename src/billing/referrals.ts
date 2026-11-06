import type { ProjectInstanceContext } from "../projects/context";
import { sha256Hex, stableJson } from "./decimal";
import { BillingError } from "./errors";
import { drawCodeSymbols, type RandomBytes } from "./gift-codes";
import type { PromotionChannel, PromotionEffectKind, PromotionTarget } from "./promotions";

export const referralRecipients = ["referrer", "both"] as const;
export type ReferralRecipient = (typeof referralRecipients)[number];
/**
 * When a referral earns its rewards: `redemption` as soon as the code is entered, `first_payment`
 * when the new customer first pays for something the program targets.
 */
export const referralTriggers = ["redemption", "first_payment"] as const;
export type ReferralTrigger = (typeof referralTriggers)[number];
export type ReferralProgramStatus = "active" | "archived";
export type ReferralStatus = "pending" | "qualified";
export type ReferralRole = "referrer" | "referee";
export type StoredReferralRewardStatus = "pending" | "issued" | "held" | "skipped" | "failed";
/** `used` is a held code that was since spent; it is read from the redemption ledger, not stored. */
export type ReferralRewardStatus = StoredReferralRewardStatus | "used";

/** The actor on a reward code and its redemption. */
export const REFERRAL_REWARD_ACTOR = "system:referral";
/** Why a reward is held: a discount has nothing to apply to until a commercial action uses it. */
export const REFERRAL_DISCOUNT_HELD_REASON = "DISCOUNT_CODE";

/** Eight symbols carry about 40 bits. A code is meant to be shared, so rate limits guard entry. */
const REFERRAL_CODE_SYMBOLS = 8;
const REFERRAL_CODE_PATTERN = /^[2-9A-Z]{8}$/;

export interface CreateReferralProgramInput {
	key: string;
	name: string;
	rewardPromotionKey: string;
	trigger: ReferralTrigger;
	recipient: ReferralRecipient;
	/** How many times one referrer can be rewarded; null means no limit. */
	maxRewardsPerReferrer?: number | null;
	/** The plans and products whose payment counts for `first_payment`; empty means any. */
	targets?: PromotionTarget[];
	/** Whether a provider trial starting is not yet a payment. True unless set otherwise. */
	excludeTrial?: boolean;
	actor: string;
}

export interface ReferralProgramRecord {
	key: string;
	name: string;
	status: ReferralProgramStatus;
	rewardPromotionKey: string;
	trigger: ReferralTrigger;
	recipient: ReferralRecipient;
	maxRewardsPerReferrer: number | null;
	targets: PromotionTarget[];
	excludeTrial: boolean;
	createdBy: string;
	createdAt: string;
	archivedBy: string | null;
	archivedAt: string | null;
}

export interface ReferralCodeRecord {
	programKey: string;
	billingAccountId: string;
	code: string;
	createdAt: string;
}

export interface ReferralRewardRecord {
	id: string;
	recipient: ReferralRole;
	status: ReferralRewardStatus;
	/** Why it is held, skipped or failed. */
	reason: string | null;
	promotionKey: string;
	effectKind: PromotionEffectKind;
	/** The recipient's single-use code, while a held reward waits to be used. */
	code: string | null;
	issuedAt: string | null;
}

/** One referral as one of its two accounts sees it, with that account's own rewards. */
export interface AccountReferralRecord {
	id: string;
	programKey: string;
	role: ReferralRole;
	/** The other account; null once it was erased. */
	counterpartBillingAccountId: string | null;
	status: ReferralStatus;
	qualifiedAt: string | null;
	createdAt: string;
	rewards: ReferralRewardRecord[];
}

/** One referral as an operator sees it, with both sides' rewards. */
export interface ReferralLedgerRecord {
	id: string;
	/** Null once the account was erased. */
	referrerBillingAccountId: string | null;
	refereeBillingAccountId: string | null;
	status: ReferralStatus;
	qualifiedAt: string | null;
	createdAt: string;
	rewards: ReferralRewardRecord[];
}

export interface ReferralRedemptionResult {
	/** True when this account had already redeemed this code. */
	duplicate: boolean;
	referral: AccountReferralRecord;
}

/** A reward that is due an attempt, with what the sweep needs to resolve its project. */
export interface ReferralRewardJob {
	rewardId: string;
	projectId: string;
	projectKey: string;
	attempts: number;
}

/** A held discount with its reservation taken, ready to be added to a live subscription. */
export interface ReferralDiscountApplication {
	rewardId: string;
	customerId: string;
	recipient: ReferralRole;
	referralId: string;
	programKey: string;
	promotionId: string;
	promotionKey: string;
	externalSubscriptionId: string;
	redemptionId: string;
	/** True when an earlier attempt took this reservation, so the coupon may be attached already. */
	retry: boolean;
}

export interface ReferralPage<T> {
	items: T[];
	nextCursor: string | null;
}

/** Program administration and the calls a product backend makes. */
export interface ReferralServiceLike {
	createProgram(
		project: ProjectInstanceContext,
		input: CreateReferralProgramInput,
	): Promise<{ program: ReferralProgramRecord; created: boolean }>;
	getProgram(project: ProjectInstanceContext, key: string): Promise<ReferralProgramRecord>;
	listPrograms(
		project: ProjectInstanceContext,
		input: { limit: number; cursor: string | null; status: ReferralProgramStatus | null },
	): Promise<ReferralPage<ReferralProgramRecord>>;
	archiveProgram(
		project: ProjectInstanceContext,
		key: string,
		actor: string,
	): Promise<ReferralProgramRecord>;
	listProgramReferrals(
		project: ProjectInstanceContext,
		key: string,
		input: { limit: number; cursor: string | null },
	): Promise<ReferralPage<ReferralLedgerRecord>>;
	getOrCreateCode(
		project: ProjectInstanceContext,
		input: { billingAccountId: string; programKey: string },
	): Promise<ReferralCodeRecord>;
	redeemCode(
		project: ProjectInstanceContext,
		input: { billingAccountId: string; code: string; channel: PromotionChannel },
	): Promise<ReferralRedemptionResult>;
	listAccountReferrals(
		project: ProjectInstanceContext,
		billingAccountId: string,
		input: { limit: number; cursor: string | null; role: ReferralRole | null },
	): Promise<ReferralPage<AccountReferralRecord>>;
}

// Each entry declares `code` literally so the wire error registry inventories it.
const referralErrorDefinitions = [
	{ code: "REFERRAL_PROGRAM_NOT_FOUND", status: 404, message: "Referral program was not found" },
	{
		code: "REFERRAL_PROGRAM_KEY_CONFLICT",
		status: 409,
		message: "A referral program with this key already exists with different terms",
	},
	{ code: "REFERRAL_PROGRAM_ARCHIVED", status: 409, message: "Referral program is archived" },
	{ code: "REFERRAL_PROGRAM_INVALID", status: 400, message: "Referral program is invalid" },
	{ code: "REFERRAL_CODE_NOT_FOUND", status: 404, message: "Referral code was not found" },
	{
		code: "REFERRAL_SELF",
		status: 409,
		message: "A billing account cannot redeem its own referral code",
	},
	{
		code: "REFERRAL_ALREADY_REDEEMED",
		status: 409,
		message: "This billing account already redeemed a referral code of this program",
	},
	{
		code: "REFERRAL_CYCLE",
		status: 409,
		message: "This billing account referred the owner of this code",
	},
	{
		code: "REFERRAL_NOT_NEW_CUSTOMER",
		status: 409,
		message: "This billing account has already paid, so it is not a new customer",
	},
] as const;

export type ReferralErrorCode = (typeof referralErrorDefinitions)[number]["code"];

export function referralError(code: ReferralErrorCode, message?: string): BillingError {
	const definition = referralErrorDefinitions.find((candidate) => candidate.code === code);
	return new BillingError(
		message ?? definition?.message ?? "Referral request failed",
		code,
		definition?.status ?? 400,
	);
}

export function generateReferralCode(randomBytes?: RandomBytes): string {
	return drawCodeSymbols(REFERRAL_CODE_SYMBOLS, randomBytes).join("");
}

/** A code as it is stored, or null when no generated code could look like this. */
export function normalizeReferralCode(value: string): string | null {
	const code = value.trim().toUpperCase();
	return REFERRAL_CODE_PATTERN.test(code) ? code : null;
}

/** The identity of a program's terms: a replayed create answers 200 only when it hashes the same. */
export function referralProgramTermsHash(input: CreateReferralProgramInput): string {
	const { key, name, rewardPromotionKey, trigger, recipient, maxRewardsPerReferrer } = input;
	return sha256Hex(
		stableJson({
			key,
			name,
			rewardPromotionKey,
			trigger,
			recipient,
			maxRewardsPerReferrer: maxRewardsPerReferrer ?? null,
			targets: sortedTargets(input.targets ?? []),
			excludeTrial: input.excludeTrial ?? true,
		}),
	);
}

/** One order for a program's targets, so sending them in another order is the same terms. */
export function sortedTargets(targets: readonly PromotionTarget[]): PromotionTarget[] {
	return [...targets].sort(
		(left, right) =>
			left.kind.localeCompare(right.kind) ||
			(left.key < right.key ? -1 : left.key > right.key ? 1 : 0),
	);
}

/** Refuses terms that say something the trigger cannot do. */
export function assertReferralProgramTerms(input: CreateReferralProgramInput): void {
	if (input.trigger === "first_payment") return;
	if ((input.targets?.length ?? 0) > 0 || input.excludeTrial === false) {
		throw referralError(
			"REFERRAL_PROGRAM_INVALID",
			"targets and excludeTrial apply only to the first_payment trigger",
		);
	}
}
