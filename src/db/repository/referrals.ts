import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import { BillingError, NotFoundBillingError } from "../../billing/errors";
import { generateGiftCode } from "../../billing/gift-codes";
import { type PromotionEffectKind, promotionError } from "../../billing/promotions";
import {
	type AccountReferralRecord,
	type CreateReferralProgramInput,
	generateReferralCode,
	normalizeReferralCode,
	REFERRAL_DISCOUNT_HELD_REASON,
	REFERRAL_REWARD_ACTOR,
	type ReferralCodeRecord,
	type ReferralLedgerRecord,
	type ReferralPage,
	type ReferralProgramRecord,
	type ReferralProgramStatus,
	type ReferralRedemptionResult,
	type ReferralRewardJob,
	type ReferralRewardRecord,
	type ReferralRole,
	type ReferralServiceLike,
	type ReferralStatus,
	referralError,
	referralProgramTermsHash,
	type StoredReferralRewardStatus,
} from "../../billing/referrals";
import type { ProjectInstanceContext } from "../../projects/context";
import { toIso } from "../../shared/date";
import { RepositoryModule } from "./base";
import { customerHasPaid } from "./customer-payments";
import { recordBillingEvent } from "./domain-event-facts";
import { lockCustomerRow } from "./invalidations";
import type { PromotionRepository } from "./promotions";
import { executeOne, executeRows } from "./query";
import type { QueryExecutor } from "./types";

type Timestamp = Date | string;

/** A collision needs two draws of about 40 bits to meet, so a handful of attempts is generous. */
const CODE_ATTEMPTS = 5;

/** A refusal that says the account cannot take the plan now. The code stays usable for later. */
const HELD_REFUSALS: ReadonlySet<string> = new Set([
	"PROMOTION_BASE_PLAN_ACTIVE",
	"PROMOTION_PLAN_GRANT_ACTIVE",
]);

interface ProgramRow {
	id: string;
	key: string;
	name: string;
	status: ReferralProgramStatus;
	reward_promotion_key: string;
	trigger: ReferralProgramRecord["trigger"];
	recipient: ReferralProgramRecord["recipient"];
	max_rewards_per_referrer: number | null;
	terms_hash: string;
	created_by: string;
	created_at: Timestamp;
	archived_by: string | null;
	archived_at: Timestamp | null;
}

interface AccountRow {
	id: string;
	billing_account_id: string;
}

interface RewardRow {
	id: string;
	referral_id: string;
	recipient: ReferralRole;
	status: StoredReferralRewardStatus;
	reason: string | null;
	promotion_key: string;
	effect_kind: PromotionEffectKind;
	code: string | null;
	used: boolean;
	issued_at: Timestamp | null;
}

type RewardOutcome =
	| { status: "issued" }
	| { status: "held" | "skipped" | "failed"; reason: string };

/** The reward's terms once Step A has made sure its code exists. */
interface PreparedReward {
	rewardId: string;
	customerId: string;
	billingAccountId: string;
	recipient: ReferralRole;
	referralId: string;
	programKey: string;
	promotionKey: string;
	effectKind: PromotionEffectKind;
	code: string;
}

const PROGRAM_COLUMNS = drizzleSql`
	program.id, program.key, program.name, program.status,
	promotion.key AS reward_promotion_key, program.trigger, program.recipient,
	program.max_rewards_per_referrer, program.terms_hash, program.created_by, program.created_at,
	program.archived_by, program.archived_at
`;

export class ReferralRepository extends RepositoryModule implements ReferralServiceLike {
	constructor(
		database: ConstructorParameters<typeof RepositoryModule>[0],
		private readonly promotions: Pick<PromotionRepository, "redeemPromotionCode">,
	) {
		super(database);
	}

	async createProgram(
		project: ProjectInstanceContext,
		input: CreateReferralProgramInput,
	): Promise<{ program: ReferralProgramRecord; created: boolean }> {
		const projectId = project.projectInstanceId;
		const termsHash = referralProgramTermsHash(input);
		return await this.transaction(async (tx) => {
			// The share lock waits for an archive of the promotion, which rechecks programs under its
			// own lock, so a program can never be left pointing at a promotion just archived.
			const promotion = await executeOne<{
				id: string;
				status: string;
				allowed_channels: string[];
				apple_offers: boolean;
			}>(
				tx,
				drizzleSql`
					SELECT promotion.id, promotion.status, promotion.allowed_channels, EXISTS (
						SELECT 1 FROM promotion_provider_objects object
						WHERE object.project_id = promotion.project_id
							AND object.promotion_id = promotion.id
							AND object.provider = 'apple'
					) AS apple_offers
					FROM promotions promotion
					WHERE promotion.project_id = ${projectId} AND promotion.key = ${input.rewardPromotionKey}
					FOR SHARE OF promotion
				`,
			);
			if (promotion === null) throw promotionError("PROMOTION_NOT_FOUND");
			const existing = await readProgram(tx, projectId, input.key);
			if (existing !== null) {
				if (existing.terms_hash !== termsHash) throw referralError("REFERRAL_PROGRAM_KEY_CONFLICT");
				return { program: toProgramRecord(existing), created: false };
			}
			if (promotion.status !== "active") throw promotionError("PROMOTION_ARCHIVED");
			// A reward is issued by the service rather than entered by a customer, and an Apple offer
			// can only be taken up through StoreKit, so neither path could deliver it.
			if (!promotion.allowed_channels.includes("web") || promotion.apple_offers) {
				throw referralError(
					"REFERRAL_PROGRAM_INVALID",
					"The reward promotion must allow web and have no Apple offers",
				);
			}
			await executeRows(
				tx,
				drizzleSql`
					INSERT INTO referral_programs (
						project_id, key, name, reward_promotion_id, trigger, recipient,
						max_rewards_per_referrer, terms_hash, created_by
					) VALUES (
						${projectId}, ${input.key}, ${input.name}, ${promotion.id}, ${input.trigger},
						${input.recipient}, ${input.maxRewardsPerReferrer ?? null}, ${termsHash}, ${input.actor}
					)
				`,
			);
			const created = await readProgram(tx, projectId, input.key);
			if (created === null) throw new Error("The referral program was not created");
			return { program: toProgramRecord(created), created: true };
		});
	}

	async getProgram(project: ProjectInstanceContext, key: string): Promise<ReferralProgramRecord> {
		return toProgramRecord(await requireProgram(this.database, project.projectInstanceId, key));
	}

	async listPrograms(
		project: ProjectInstanceContext,
		input: { limit: number; cursor: string | null; status: ReferralProgramStatus | null },
	): Promise<ReferralPage<ReferralProgramRecord>> {
		const rows = await executeRows<ProgramRow>(
			this.database,
			drizzleSql`
				SELECT ${PROGRAM_COLUMNS}
				FROM referral_programs program
				JOIN promotions promotion
					ON promotion.project_id = program.project_id
					AND promotion.id = program.reward_promotion_id
				WHERE program.project_id = ${project.projectInstanceId}
					${input.status === null ? drizzleSql`` : drizzleSql`AND program.status = ${input.status}`}
					${input.cursor === null ? drizzleSql`` : drizzleSql`AND program.id < ${input.cursor}::uuid`}
				ORDER BY program.id DESC
				LIMIT ${input.limit + 1}
			`,
		);
		return page(rows, input.limit, toProgramRecord);
	}

	async archiveProgram(
		project: ProjectInstanceContext,
		key: string,
		actor: string,
	): Promise<ReferralProgramRecord> {
		const projectId = project.projectInstanceId;
		await executeRows(
			this.database,
			drizzleSql`
				UPDATE referral_programs
				SET status = 'archived', archived_at = now(), archived_by = ${actor}, updated_at = now()
				WHERE project_id = ${projectId} AND key = ${key} AND status = 'active'
			`,
		);
		return toProgramRecord(await requireProgram(this.database, projectId, key));
	}

	async listProgramReferrals(
		project: ProjectInstanceContext,
		key: string,
		input: { limit: number; cursor: string | null },
	): Promise<ReferralPage<ReferralLedgerRecord>> {
		const projectId = project.projectInstanceId;
		const program = await requireProgram(this.database, projectId, key);
		const rows = await executeRows<{
			id: string;
			status: ReferralStatus;
			qualified_at: Timestamp | null;
			created_at: Timestamp;
			referrer: string | null;
			referee: string | null;
		}>(
			this.database,
			drizzleSql`
				SELECT referral.id, referral.status, referral.qualified_at, referral.created_at,
					CASE WHEN referrer.erased_at IS NULL THEN referrer.billing_account_id END AS referrer,
					CASE WHEN referee.erased_at IS NULL THEN referee.billing_account_id END AS referee
				FROM referrals referral
				JOIN customers referrer
					ON referrer.project_id = referral.project_id
					AND referrer.id = referral.referrer_customer_id
				JOIN customers referee
					ON referee.project_id = referral.project_id AND referee.id = referral.customer_id
				WHERE referral.project_id = ${projectId}
					AND referral.program_id = ${program.id}
					${input.cursor === null ? drizzleSql`` : drizzleSql`AND referral.id < ${input.cursor}::uuid`}
				ORDER BY referral.id DESC
				LIMIT ${input.limit + 1}
			`,
		);
		const visible = rows.slice(0, input.limit);
		const rewards = await readRewards(
			this.database,
			projectId,
			visible.map((row) => row.id),
		);
		return page(rows, input.limit, (row) => ({
			id: row.id,
			referrerBillingAccountId: row.referrer,
			refereeBillingAccountId: row.referee,
			status: row.status,
			qualifiedAt: optionalIso(row.qualified_at),
			createdAt: toIso(row.created_at),
			rewards: (rewards.get(row.id) ?? []).map(toRewardRecord),
		}));
	}

	async getOrCreateCode(
		project: ProjectInstanceContext,
		input: { billingAccountId: string; programKey: string },
	): Promise<ReferralCodeRecord> {
		const projectId = project.projectInstanceId;
		return await this.transaction(async (tx) => {
			const account = await lockAccount(tx, projectId, input.billingAccountId);
			const program = await requireProgram(tx, projectId, input.programKey);
			const readCode = () =>
				executeOne<{ code: string; created_at: Timestamp }>(
					tx,
					drizzleSql`
						SELECT code, created_at
						FROM referral_codes
						WHERE project_id = ${projectId}
							AND program_id = ${program.id}
							AND customer_id = ${account.id}
					`,
				);
			const record = (row: { code: string; created_at: Timestamp }): ReferralCodeRecord => ({
				programKey: program.key,
				billingAccountId: account.billing_account_id,
				code: row.code,
				createdAt: toIso(row.created_at),
			});
			const existing = await readCode();
			if (existing !== null) return record(existing);
			if (program.status !== "active") throw referralError("REFERRAL_PROGRAM_ARCHIVED");
			for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
				await executeRows(
					tx,
					drizzleSql`
						INSERT INTO referral_codes (project_id, program_id, customer_id, code)
						VALUES (${projectId}, ${program.id}, ${account.id}, ${generateReferralCode()})
						ON CONFLICT DO NOTHING
					`,
				);
				const created = await readCode();
				if (created !== null) return record(created);
			}
			throw new Error("A referral code could not be created without a collision");
		});
	}

	async redeemCode(
		project: ProjectInstanceContext,
		input: { billingAccountId: string; code: string; channel: "web" | "ios" | "android" },
	): Promise<ReferralRedemptionResult> {
		const projectId = project.projectInstanceId;
		const code = normalizeReferralCode(input.code);
		if (code === null) throw referralError("REFERRAL_CODE_NOT_FOUND");
		const redeemed = await this.transaction(async (tx) => {
			const account = await lockAccount(tx, projectId, input.billingAccountId);
			const resolved = await executeOne<{
				program_id: string;
				status: ReferralProgramStatus;
				recipient: ReferralProgramRecord["recipient"];
				referrer_customer_id: string;
			}>(
				tx,
				drizzleSql`
					SELECT program.id AS program_id, program.status, program.recipient,
						code.customer_id AS referrer_customer_id
					FROM referral_codes code
					JOIN referral_programs program
						ON program.project_id = code.project_id AND program.id = code.program_id
					WHERE code.project_id = ${projectId} AND code.code = ${code}
				`,
			);
			if (resolved === null) throw referralError("REFERRAL_CODE_NOT_FOUND");
			const earlier = await executeOne<{ id: string; referrer_customer_id: string }>(
				tx,
				drizzleSql`
					SELECT id, referrer_customer_id
					FROM referrals
					WHERE project_id = ${projectId}
						AND program_id = ${resolved.program_id}
						AND customer_id = ${account.id}
				`,
			);
			if (earlier !== null) {
				if (earlier.referrer_customer_id !== resolved.referrer_customer_id) {
					throw referralError("REFERRAL_ALREADY_REDEEMED");
				}
				return { referralId: earlier.id, duplicate: true };
			}
			if (resolved.referrer_customer_id === account.id) throw referralError("REFERRAL_SELF");
			if (resolved.status !== "active") throw referralError("REFERRAL_PROGRAM_ARCHIVED");
			// Apple does not allow a code entered in the app to unlock paid features, which is why
			// direct iOS grants are refused. A reward that goes only to the referrer unlocks nothing.
			if (input.channel === "ios" && resolved.recipient === "both") {
				throw promotionError("PROMOTION_CODE_CHANNEL_NOT_SUPPORTED");
			}
			const cycle = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					SELECT id
					FROM referrals
					WHERE project_id = ${projectId}
						AND program_id = ${resolved.program_id}
						AND customer_id = ${resolved.referrer_customer_id}
						AND referrer_customer_id = ${account.id}
				`,
			);
			if (cycle !== null) throw referralError("REFERRAL_CYCLE");
			if (await customerHasPaid(tx, projectId, account.id)) {
				throw referralError("REFERRAL_NOT_NEW_CUSTOMER");
			}
			const referral = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					INSERT INTO referrals (
						project_id, program_id, referrer_customer_id, customer_id, status, qualified_at
					) VALUES (
						${projectId}, ${resolved.program_id}, ${resolved.referrer_customer_id}, ${account.id},
						'qualified', now()
					)
					RETURNING id
				`,
			);
			if (referral === null) throw new Error("The referral was not recorded");
			await createRewards(tx, projectId, {
				referralId: referral.id,
				referrerCustomerId: resolved.referrer_customer_id,
				refereeCustomerId: resolved.recipient === "both" ? account.id : null,
			});
			return { referralId: referral.id, duplicate: false };
		});
		await this.issueReferralRewards(project, redeemed.referralId);
		const referral = await readAccountReferral(
			this.database,
			projectId,
			input.billingAccountId,
			redeemed.referralId,
		);
		return { duplicate: redeemed.duplicate, referral };
	}

	async listAccountReferrals(
		project: ProjectInstanceContext,
		billingAccountId: string,
		input: { limit: number; cursor: string | null; role: ReferralRole | null },
	): Promise<ReferralPage<AccountReferralRecord>> {
		const projectId = project.projectInstanceId;
		const account = await requireAccount(this.database, projectId, billingAccountId);
		const asReferee = drizzleSql`referral.customer_id = ${account.id}`;
		const asReferrer = drizzleSql`referral.referrer_customer_id = ${account.id}`;
		const role =
			input.role === "referee"
				? asReferee
				: input.role === "referrer"
					? asReferrer
					: drizzleSql`(${asReferee} OR ${asReferrer})`;
		const rows = await readAccountReferralRows(
			this.database,
			projectId,
			account.id,
			drizzleSql`${role} ${input.cursor === null ? drizzleSql`` : drizzleSql`AND referral.id < ${input.cursor}::uuid`}`,
			input.limit + 1,
		);
		const visible = rows.slice(0, input.limit);
		const rewards = await readRewards(
			this.database,
			projectId,
			visible.map((row) => row.id),
			account.id,
		);
		return page(rows, input.limit, (row) => toAccountReferral(row, rewards.get(row.id) ?? []));
	}

	/**
	 * Tries every pending reward of a referral once, right after it qualified. Anything that does not
	 * finish here stays pending, and the promotion maintenance sweep retries it.
	 */
	private async issueReferralRewards(
		project: ProjectInstanceContext,
		referralId: string,
	): Promise<void> {
		const rewards = await executeRows<{ id: string }>(
			this.database,
			drizzleSql`
				SELECT id FROM referral_rewards
				WHERE project_id = ${project.projectInstanceId}
					AND referral_id = ${referralId}
					AND status = 'pending'
				ORDER BY id
			`,
		);
		for (const reward of rewards) {
			try {
				await this.issueReward(project, reward.id);
			} catch {
				// The referral is recorded, so the sweep owns this reward from here.
			}
		}
	}

	/** Rewards due an attempt, across projects, oldest first. */
	async listDueRewards(limit: number): Promise<ReferralRewardJob[]> {
		const rows = await executeRows<{
			id: string;
			project_id: string;
			project_key: string;
			attempts: number;
		}>(
			this.database,
			drizzleSql`
				SELECT reward.id, reward.project_id, project.key AS project_key, reward.attempts
				FROM referral_rewards reward
				JOIN projects project ON project.id = reward.project_id
				WHERE reward.status = 'pending' AND reward.next_attempt_at <= now()
				ORDER BY reward.next_attempt_at, reward.id
				LIMIT ${limit}
			`,
		);
		return rows.map((row) => ({
			rewardId: row.id,
			projectId: row.project_id,
			projectKey: row.project_key,
			attempts: Number(row.attempts),
		}));
	}

	/** Puts a reward off after an unexpected failure; a null delay gives up on it. */
	async deferReward(
		projectId: string,
		rewardId: string,
		input: { error: string; retryDelayMs: number | null },
	): Promise<void> {
		await executeRows(
			this.database,
			drizzleSql`
				UPDATE referral_rewards
				SET attempts = attempts + 1,
					status = CASE WHEN ${input.retryDelayMs === null} THEN 'failed' ELSE status END,
					reason = ${input.error.slice(0, 500)},
					next_attempt_at = now() + ${input.retryDelayMs ?? 0} * interval '1 millisecond',
					updated_at = now()
				WHERE project_id = ${projectId} AND id = ${rewardId} AND status = 'pending'
			`,
		);
	}

	/**
	 * Issues one reward: mint the recipient's code, then redeem it the way any code is redeemed, so
	 * a grant lands in the ordinary redemption ledger. Each step locks only the recipient, so the two
	 * accounts of a referral are never locked together, and a refused reward cannot touch the
	 * referral. Repeating it is safe: the code is minted once and redeemed under a key of its own.
	 */
	async issueReward(project: ProjectInstanceContext, rewardId: string): Promise<void> {
		const prepared = await this.transaction((tx) => prepareReward(tx, project, rewardId));
		if (prepared === null) return;
		const outcome = await this.redeemReward(project, prepared);
		await this.transaction((tx) => settleReward(tx, project.projectInstanceId, prepared, outcome));
	}

	private async redeemReward(
		project: ProjectInstanceContext,
		reward: PreparedReward,
	): Promise<RewardOutcome> {
		// Redeeming a discount only reads: it has nothing to grant until a commercial action uses it.
		if (reward.effectKind === "discount") {
			return { status: "held", reason: REFERRAL_DISCOUNT_HELD_REASON };
		}
		try {
			await this.promotions.redeemPromotionCode(project, {
				billingAccountId: reward.billingAccountId,
				code: reward.code,
				channel: "web",
				idempotencyKey: `referral_reward:${reward.rewardId}`,
				actor: REFERRAL_REWARD_ACTOR,
			});
			return { status: "issued" };
		} catch (error) {
			if (!(error instanceof BillingError)) throw error;
			return HELD_REFUSALS.has(error.code)
				? { status: "held", reason: error.code }
				: { status: "failed", reason: error.code };
		}
	}
}

/**
 * Step A, under the recipient's lock: decides whether the reward can be given and mints its code.
 * Null means there is nothing left to do. The cap counts rewards with a code, so a reward another
 * attempt has minted but not yet settled is counted too.
 */
async function prepareReward(
	tx: QueryExecutor,
	project: ProjectInstanceContext,
	rewardId: string,
): Promise<PreparedReward | null> {
	const projectId = project.projectInstanceId;
	const target = await executeOne<{ customer_id: string }>(
		tx,
		drizzleSql`
			SELECT customer_id FROM referral_rewards
			WHERE project_id = ${projectId} AND id = ${rewardId}
		`,
	);
	if (target === null) return null;
	await lockCustomerRow(tx, projectId, target.customer_id);
	const reward = await executeOne<{
		status: StoredReferralRewardStatus;
		recipient: ReferralRole;
		referral_id: string;
		program_id: string;
		program_key: string;
		max_rewards_per_referrer: number | null;
		promotion_id: string;
		promotion_key: string;
		promotion_status: string;
		effect_kind: PromotionEffectKind;
		code: string | null;
		billing_account_id: string;
		erased_at: Timestamp | null;
	}>(
		tx,
		drizzleSql`
			SELECT reward.status, reward.recipient, reward.referral_id, referral.program_id,
				program.key AS program_key, program.max_rewards_per_referrer,
				promotion.id AS promotion_id, promotion.key AS promotion_key,
				promotion.status AS promotion_status, promotion.effect_kind, code.code,
				customer.billing_account_id, customer.erased_at
			FROM referral_rewards reward
			JOIN referrals referral
				ON referral.project_id = reward.project_id AND referral.id = reward.referral_id
			JOIN referral_programs program
				ON program.project_id = referral.project_id AND program.id = referral.program_id
			JOIN promotions promotion
				ON promotion.project_id = program.project_id
				AND promotion.id = program.reward_promotion_id
			JOIN customers customer
				ON customer.project_id = reward.project_id AND customer.id = reward.customer_id
			LEFT JOIN promotion_codes code
				ON code.project_id = reward.project_id AND code.id = reward.promotion_code_id
			WHERE reward.project_id = ${projectId} AND reward.id = ${rewardId}
			FOR UPDATE OF reward
		`,
	);
	if (reward === null || reward.status !== "pending") return null;
	const stop = async (status: "skipped" | "failed", reason: string) => {
		await writeRewardOutcome(tx, projectId, rewardId, { status, reason });
		return null;
	};
	if (reward.erased_at !== null) return await stop("skipped", "RECIPIENT_ERASED");
	const prepared = {
		rewardId,
		customerId: target.customer_id,
		billingAccountId: reward.billing_account_id,
		recipient: reward.recipient,
		referralId: reward.referral_id,
		programKey: reward.program_key,
		promotionKey: reward.promotion_key,
		effectKind: reward.effect_kind,
	};
	if (reward.code !== null) return { ...prepared, code: reward.code };
	if (reward.promotion_status !== "active") return await stop("failed", "PROMOTION_ARCHIVED");
	if (reward.recipient === "referrer" && reward.max_rewards_per_referrer !== null) {
		const given = await executeOne<{ count: number }>(
			tx,
			drizzleSql`
				SELECT count(*)::integer AS count
				FROM referral_rewards earlier
				JOIN referrals referral
					ON referral.project_id = earlier.project_id AND referral.id = earlier.referral_id
				WHERE earlier.project_id = ${projectId}
					AND earlier.customer_id = ${target.customer_id}
					AND earlier.recipient = 'referrer'
					AND earlier.promotion_code_id IS NOT NULL
					AND referral.program_id = ${reward.program_id}
			`,
		);
		if ((given?.count ?? 0) >= reward.max_rewards_per_referrer) {
			return await stop("skipped", "REFERRER_LIMIT_REACHED");
		}
	}
	const code = await mintRewardCode(tx, projectId, {
		rewardId,
		promotionId: reward.promotion_id,
		billingAccountId: reward.billing_account_id,
	});
	return { ...prepared, code };
}

/**
 * Mints the single-use code that carries a reward. It skips the operator path as gift minting does:
 * that path treats a matching text as a replay, which could hand two accounts one code.
 */
async function mintRewardCode(
	tx: QueryExecutor,
	projectId: string,
	input: { rewardId: string; promotionId: string; billingAccountId: string },
): Promise<string> {
	for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt += 1) {
		const code = generateGiftCode();
		const minted = await executeOne<{ id: string }>(
			tx,
			drizzleSql`
				INSERT INTO promotion_codes (
					project_id, promotion_id, code, normalized_code, max_redemptions,
					max_redemptions_per_customer, billing_account_id, created_by
				) VALUES (
					${projectId}, ${input.promotionId}, ${code}, upper(${code}), 1, 1,
					${input.billingAccountId}, ${REFERRAL_REWARD_ACTOR}
				)
				ON CONFLICT DO NOTHING
				RETURNING id
			`,
		);
		if (minted === null) continue;
		await executeRows(
			tx,
			drizzleSql`
				UPDATE referral_rewards
				SET promotion_code_id = ${minted.id}, updated_at = now()
				WHERE project_id = ${projectId} AND id = ${input.rewardId}
			`,
		);
		return code;
	}
	throw new Error("A reward code could not be minted without a collision");
}

/** Step B's result, recorded with its event. Only the first settlement of a reward counts. */
async function settleReward(
	tx: QueryExecutor,
	projectId: string,
	reward: PreparedReward,
	outcome: RewardOutcome,
): Promise<void> {
	await lockCustomerRow(tx, projectId, reward.customerId);
	const settled = await writeRewardOutcome(tx, projectId, reward.rewardId, outcome);
	if (!settled || outcome.status === "failed" || outcome.status === "skipped") return;
	await recordBillingEvent(tx, projectId, {
		type: "referral.reward_issued",
		sourceKey: `referral_reward:${reward.rewardId}:${outcome.status}`,
		customerId: reward.customerId,
		occurredAt: new Date(),
		data: {
			reward: {
				id: reward.rewardId,
				referralId: reward.referralId,
				programKey: reward.programKey,
				recipient: reward.recipient,
				status: outcome.status,
				promotionKey: reward.promotionKey,
				effectKind: reward.effectKind,
			},
		},
	});
}

async function writeRewardOutcome(
	tx: QueryExecutor,
	projectId: string,
	rewardId: string,
	outcome: RewardOutcome,
): Promise<boolean> {
	const reason = outcome.status === "issued" ? null : outcome.reason;
	const row = await executeOne<{ id: string }>(
		tx,
		drizzleSql`
			UPDATE referral_rewards
			SET status = ${outcome.status}, reason = ${reason},
				issued_at = CASE WHEN ${outcome.status === "issued"} THEN now() END, updated_at = now()
			WHERE project_id = ${projectId} AND id = ${rewardId} AND status = 'pending'
			RETURNING id
		`,
	);
	return row !== null;
}

async function createRewards(
	tx: QueryExecutor,
	projectId: string,
	input: { referralId: string; referrerCustomerId: string; refereeCustomerId: string | null },
): Promise<void> {
	await executeRows(
		tx,
		drizzleSql`
			INSERT INTO referral_rewards (project_id, referral_id, recipient, customer_id)
			VALUES (${projectId}, ${input.referralId}, 'referrer', ${input.referrerCustomerId})
		`,
	);
	if (input.refereeCustomerId === null) return;
	await executeRows(
		tx,
		drizzleSql`
			INSERT INTO referral_rewards (project_id, referral_id, recipient, customer_id)
			VALUES (${projectId}, ${input.referralId}, 'referee', ${input.refereeCustomerId})
		`,
	);
}

async function lockAccount(
	tx: QueryExecutor,
	projectId: string,
	billingAccountId: string,
): Promise<AccountRow> {
	const account = await executeOne<AccountRow>(
		tx,
		drizzleSql`
			SELECT id, billing_account_id
			FROM customers
			WHERE project_id = ${projectId} AND billing_account_id = ${billingAccountId}
			FOR NO KEY UPDATE
		`,
	);
	if (account === null) throw accountNotFound();
	return account;
}

async function requireAccount(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
): Promise<AccountRow> {
	const account = await executeOne<AccountRow>(
		executor,
		drizzleSql`
			SELECT id, billing_account_id
			FROM customers
			WHERE project_id = ${projectId} AND billing_account_id = ${billingAccountId}
		`,
	);
	if (account === null) throw accountNotFound();
	return account;
}

function accountNotFound(): NotFoundBillingError {
	return new NotFoundBillingError("Billing account was not found", "BILLING_ACCOUNT_NOT_FOUND");
}

async function readProgram(
	executor: QueryExecutor,
	projectId: string,
	key: string,
): Promise<ProgramRow | null> {
	return await executeOne<ProgramRow>(
		executor,
		drizzleSql`
			SELECT ${PROGRAM_COLUMNS}
			FROM referral_programs program
			JOIN promotions promotion
				ON promotion.project_id = program.project_id
				AND promotion.id = program.reward_promotion_id
			WHERE program.project_id = ${projectId} AND program.key = ${key}
		`,
	);
}

async function requireProgram(
	executor: QueryExecutor,
	projectId: string,
	key: string,
): Promise<ProgramRow> {
	const program = await readProgram(executor, projectId, key);
	if (program === null) throw referralError("REFERRAL_PROGRAM_NOT_FOUND");
	return program;
}

interface AccountReferralRow {
	id: string;
	program_key: string;
	role: ReferralRole;
	counterpart: string | null;
	status: ReferralStatus;
	qualified_at: Timestamp | null;
	created_at: Timestamp;
}

async function readAccountReferralRows(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	condition: DrizzleSQL,
	limit: number,
): Promise<AccountReferralRow[]> {
	return await executeRows<AccountReferralRow>(
		executor,
		drizzleSql`
			SELECT referral.id, program.key AS program_key, referral.status, referral.qualified_at,
				referral.created_at,
				CASE WHEN referral.customer_id = ${customerId} THEN 'referee' ELSE 'referrer' END AS role,
				CASE WHEN counterpart.erased_at IS NULL THEN counterpart.billing_account_id END
					AS counterpart
			FROM referrals referral
			JOIN referral_programs program
				ON program.project_id = referral.project_id AND program.id = referral.program_id
			JOIN customers counterpart
				ON counterpart.project_id = referral.project_id
				AND counterpart.id = CASE WHEN referral.customer_id = ${customerId}
					THEN referral.referrer_customer_id ELSE referral.customer_id END
			WHERE referral.project_id = ${projectId} AND ${condition}
			ORDER BY referral.id DESC
			LIMIT ${limit}
		`,
	);
}

async function readAccountReferral(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
	referralId: string,
): Promise<AccountReferralRecord> {
	const account = await requireAccount(executor, projectId, billingAccountId);
	const [row] = await readAccountReferralRows(
		executor,
		projectId,
		account.id,
		drizzleSql`referral.id = ${referralId}`,
		1,
	);
	if (row === undefined) throw new Error("The referral could not be read back");
	const rewards = await readRewards(executor, projectId, [referralId], account.id);
	return toAccountReferral(row, rewards.get(referralId) ?? []);
}

/** The rewards of some referrals, by referral; with `customerId`, only that account's own. */
async function readRewards(
	executor: QueryExecutor,
	projectId: string,
	referralIds: readonly string[],
	customerId?: string,
): Promise<Map<string, RewardRow[]>> {
	const rewards = new Map<string, RewardRow[]>();
	if (referralIds.length === 0) return rewards;
	const ids = drizzleSql.join(
		referralIds.map((id) => drizzleSql`${id}::uuid`),
		drizzleSql`, `,
	);
	const rows = await executeRows<RewardRow>(
		executor,
		drizzleSql`
			SELECT reward.id, reward.referral_id, reward.recipient, reward.status, reward.reason,
				promotion.key AS promotion_key, promotion.effect_kind, code.code, reward.issued_at,
				EXISTS (
					SELECT 1 FROM promotion_redemptions redemption
					WHERE redemption.project_id = reward.project_id
						AND redemption.promotion_code_id = reward.promotion_code_id
						AND redemption.status IN ('reserved', 'applied', 'reversed')
				) AS used
			FROM referral_rewards reward
			JOIN referrals referral
				ON referral.project_id = reward.project_id AND referral.id = reward.referral_id
			JOIN referral_programs program
				ON program.project_id = referral.project_id AND program.id = referral.program_id
			JOIN promotions promotion
				ON promotion.project_id = program.project_id
				AND promotion.id = program.reward_promotion_id
			LEFT JOIN promotion_codes code
				ON code.project_id = reward.project_id AND code.id = reward.promotion_code_id
			WHERE reward.project_id = ${projectId}
				AND reward.referral_id IN (${ids})
				${customerId === undefined ? drizzleSql`` : drizzleSql`AND reward.customer_id = ${customerId}`}
			ORDER BY reward.id
		`,
	);
	for (const row of rows) {
		rewards.set(row.referral_id, [...(rewards.get(row.referral_id) ?? []), row]);
	}
	return rewards;
}

function page<Row extends { id: string }, Item>(
	rows: readonly Row[],
	limit: number,
	map: (row: Row) => Item,
): ReferralPage<Item> {
	const visible = rows.slice(0, limit);
	return {
		items: visible.map(map),
		nextCursor: rows.length > limit ? (visible.at(-1)?.id ?? null) : null,
	};
}

function toProgramRecord(row: ProgramRow): ReferralProgramRecord {
	return {
		key: row.key,
		name: row.name,
		status: row.status,
		rewardPromotionKey: row.reward_promotion_key,
		trigger: row.trigger,
		recipient: row.recipient,
		maxRewardsPerReferrer: row.max_rewards_per_referrer,
		createdBy: row.created_by,
		createdAt: toIso(row.created_at),
		archivedBy: row.archived_by,
		archivedAt: optionalIso(row.archived_at),
	};
}

function toAccountReferral(
	row: AccountReferralRow,
	rewards: readonly RewardRow[],
): AccountReferralRecord {
	return {
		id: row.id,
		programKey: row.program_key,
		role: row.role,
		counterpartBillingAccountId: row.counterpart,
		status: row.status,
		qualifiedAt: optionalIso(row.qualified_at),
		createdAt: toIso(row.created_at),
		rewards: rewards.map(toRewardRecord),
	};
}

function toRewardRecord(row: RewardRow): ReferralRewardRecord {
	const held = row.status === "held";
	return {
		id: row.id,
		recipient: row.recipient,
		status: held && row.used ? "used" : row.status,
		reason: row.reason,
		promotionKey: row.promotion_key,
		effectKind: row.effect_kind,
		code: held && !row.used ? row.code : null,
		issuedAt: optionalIso(row.issued_at),
	};
}

function optionalIso(value: Timestamp | null): string | null {
	return value === null ? null : toIso(value);
}
