import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import { decodeAdminCursor, encodeAdminCursor } from "../../admin/query";
import { databaseDecimal } from "../../billing/decimal";
import { PersistenceConflictError } from "../../billing/errors";
import {
	type CreatePromotionInput,
	type NormalizedPromotionCode,
	normalizeCreatePromotionInput,
	normalizePromotionCodes,
	type PromotionChannel,
	type PromotionCodeAvailability,
	type PromotionCodeInput,
	type PromotionCodeRecord,
	type PromotionEffect,
	type PromotionLimitViolation,
	type PromotionListResult,
	type PromotionRecord,
	type PromotionRedemptionProvider,
	type PromotionRedemptionRecord,
	type PromotionRedemptionSource,
	type PromotionRedemptionStatus,
	type PromotionStatus,
	type PromotionTarget,
	promotionCodeUnavailability,
	promotionError,
	promotionQuantity,
} from "../../billing/promotions";
import type { ProjectInstanceContext } from "../../projects/context";
import { toIso } from "../../shared/date";
import { RepositoryModule } from "./base";
import { lockCustomerRow } from "./invalidations";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";

type Timestamp = Date | string;

interface PromotionRow {
	id: string;
	key: string;
	name: string;
	status: PromotionStatus;
	effect_kind: PromotionEffect["kind"];
	allowed_channels: PromotionChannel[];
	discount_type: "percent" | "amount" | null;
	percent_off_bps: number | null;
	discount_duration: "once" | "repeating" | "forever" | null;
	duration_months: number | null;
	plan_key: string | null;
	grant_duration_unit: "day" | "month" | null;
	grant_duration_count: number | null;
	terms_hash: string;
	metadata: Record<string, unknown>;
	created_by: string;
	created_at: Timestamp;
	archived_by: string | null;
	archived_at: Timestamp | null;
	amounts: Array<{ currency: string; amountOffMinor: number | string }>;
	targets: Array<{ kind: "plan" | "product"; key: string }>;
	grant_items: Array<{
		featureKey: string;
		quantity: string;
		expiresAfterSeconds: number | string | null;
	}>;
	code_total: number;
	code_active: number;
	redemption_counts: Partial<Record<PromotionRedemptionStatus, number>> | null;
	cursor_created_at: string;
}

interface PromotionCodeRow {
	id: string;
	promotion_id: string;
	promotion_key: string;
	code: string;
	active: boolean;
	starts_at: Timestamp | null;
	expires_at: Timestamp | null;
	max_redemptions: number | null;
	max_redemptions_per_customer: number | null;
	first_purchase_only: boolean;
	billing_account_id: string | null;
	hosted_checkout_enabled: boolean;
	redeemed_count: number;
	reserved_count: number;
	created_by: string;
	created_at: Timestamp;
	deactivated_by: string | null;
	deactivated_at: Timestamp | null;
	cursor_created_at: string;
}

interface CodeAvailabilityRow {
	promotion_id: string;
	promotion_status: PromotionStatus;
	allowed_channels: PromotionChannel[];
	effect_kind: PromotionEffect["kind"];
	active: boolean;
	starts_at: Timestamp | null;
	expires_at: Timestamp | null;
	billing_account_id: string | null;
	max_redemptions: number | null;
	max_redemptions_per_customer: number | null;
	first_purchase_only: boolean;
	redeemed_count: number;
	reserved_count: number;
	now: Timestamp;
}

interface RedemptionRow {
	id: string;
	promotion_id: string;
	promotion_key: string;
	promotion_code_id: string | null;
	code: string | null;
	customer_id: string;
	billing_account_id: string;
	channel: PromotionChannel;
	status: PromotionRedemptionStatus;
	provider: PromotionRedemptionProvider;
	source: PromotionRedemptionSource;
	stripe_checkout_session_id: string | null;
	external_subscription_id: string | null;
	currency: string | null;
	amount_subtotal_minor: number | string | null;
	amount_discount_minor: number | string | null;
	amount_total_minor: number | string | null;
	limit_violation: PromotionLimitViolation | null;
	actor: string;
	reason: string | null;
	request_hash: string;
	result: Record<string, unknown> | null;
	reserved_until: Timestamp | null;
	applied_at: Timestamp | null;
	released_at: Timestamp | null;
	reversed_at: Timestamp | null;
	created_at: Timestamp;
	cursor_created_at: string;
}

export interface ResolvedPromotionCode {
	promotion: PromotionRecord;
	code: PromotionCodeRecord;
}

export interface StoredPromotionRedemption extends PromotionRedemptionRecord {
	promotionId: string;
	customerId: string;
	requestHash: string;
	result: Record<string, unknown> | null;
}

export interface ReservePromotionRedemptionInput {
	customerId: string;
	billingAccountId: string;
	promotionCodeId: string;
	channel: PromotionChannel;
	provider: PromotionRedemptionProvider;
	source: PromotionRedemptionSource;
	idempotencyKey: string;
	requestHash: string;
	/** `null` applies the redemption immediately instead of reserving it. */
	reservedUntil: Date | null;
	effectSnapshot: Record<string, unknown>;
	actor: string;
	reason?: string | null;
	commercialActionPreviewId?: string | null;
	subscriptionChangeId?: string | null;
	externalSubscriptionId?: string | null;
	stripeCouponId?: string | null;
	providerObjectId?: string | null;
}

export interface ApplyPromotionRedemptionInput {
	redemptionId: string;
	purchaseId?: string | null;
	stripeCheckoutSessionId?: string | null;
	stripeInvoiceId?: string | null;
	externalSubscriptionId?: string | null;
	currency?: string | null;
	amountSubtotalMinor?: number | null;
	amountDiscountMinor?: number | null;
	amountTotalMinor?: number | null;
}

export interface PromotionListInput {
	limit: number;
	cursor?: string | null;
}

export class PromotionRepository extends RepositoryModule {
	async createPromotion(
		project: ProjectInstanceContext,
		input: CreatePromotionInput,
	): Promise<{ promotion: PromotionRecord; created: boolean }> {
		const normalized = normalizeCreatePromotionInput(input);
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const references = await resolvePromotionReferences(tx, projectId, normalized.effect, {
				targets: normalized.targets,
			});
			const discount = normalized.effect.kind === "discount" ? normalized.effect.discount : null;
			const planGrant = normalized.effect.kind === "plan_grant" ? normalized.effect : null;
			const inserted = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					INSERT INTO promotions (
						project_id, key, name, effect_kind, allowed_channels, discount_type,
						percent_off_bps, discount_duration, duration_months, plan_id,
						grant_duration_unit, grant_duration_count, terms_hash, metadata, created_by
					)
					VALUES (
						${projectId}, ${normalized.key}, ${normalized.name}, ${normalized.effect.kind},
						${textArray(normalized.allowedChannels)}, ${discount?.type ?? null},
						${discount?.type === "percent" ? discount.percentOffBps : null},
						${discount?.duration ?? null}, ${discount?.durationMonths ?? null},
						${references.planId}::bigint, ${planGrant?.durationUnit ?? null},
						${planGrant?.durationCount ?? null}, ${normalized.termsHash},
						${jsonb(normalized.metadata)}, ${normalized.actor}
					)
					ON CONFLICT (project_id, key) DO NOTHING
					RETURNING id
				`,
			);
			let promotionId: string;
			if (inserted === null) {
				const existing = await executeOne<{ id: string; terms_hash: string }>(
					tx,
					drizzleSql`
						SELECT id, terms_hash
						FROM promotions
						WHERE project_id = ${projectId} AND key = ${normalized.key}
						FOR UPDATE
					`,
				);
				if (existing === null) {
					throw new Error(`Promotion ${normalized.key} could not be created`);
				}
				if (existing.terms_hash !== normalized.termsHash) {
					throw promotionError("PROMOTION_KEY_CONFLICT");
				}
				promotionId = existing.id;
			} else {
				promotionId = inserted.id;
				await insertPromotionTerms(tx, projectId, promotionId, normalized.effect, references);
				await insertAudit(tx, projectId, {
					promotionId,
					action: "promotion_created",
					actor: normalized.actor,
					details: { key: normalized.key, termsHash: normalized.termsHash },
				});
			}
			if (normalized.codes.length > 0) {
				await insertCodes(tx, projectId, promotionId, normalized.codes, normalized.actor, {
					requireActive: inserted === null,
				});
			}
			return {
				promotion: await requirePromotion(tx, projectId, drizzleSql`p.id = ${promotionId}`),
				created: inserted !== null,
			};
		});
	}

	async getPromotion(project: ProjectInstanceContext, key: string): Promise<PromotionRecord> {
		return await requirePromotion(
			this.database,
			project.projectInstanceId,
			drizzleSql`p.key = ${key}`,
		);
	}

	async listPromotions(
		project: ProjectInstanceContext,
		input: PromotionListInput & { status?: PromotionStatus | null },
	): Promise<PromotionListResult<PromotionRecord>> {
		const conditions: DrizzleSQL[] = [];
		if (input.status !== undefined && input.status !== null) {
			conditions.push(drizzleSql`p.status = ${input.status}`);
		}
		const cursor = keysetCondition(input.cursor, "p");
		if (cursor !== null) {
			conditions.push(cursor);
		}
		const rows = await promotionRows(
			this.database,
			project.projectInstanceId,
			conditions.length === 0 ? drizzleSql`true` : drizzleSql.join(conditions, drizzleSql` AND `),
			input.limit + 1,
		);
		return paginate(rows, input.limit, toPromotionRecord);
	}

	async archivePromotion(
		project: ProjectInstanceContext,
		key: string,
		actor: string,
	): Promise<PromotionRecord> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const archived = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					UPDATE promotions
					SET status = 'archived', archived_at = now(), archived_by = ${actor}, updated_at = now()
					WHERE project_id = ${projectId} AND key = ${key} AND status = 'active'
					RETURNING id
				`,
			);
			if (archived !== null) {
				await insertAudit(tx, projectId, {
					promotionId: archived.id,
					action: "promotion_archived",
					actor,
					details: { key },
				});
			}
			return await requirePromotion(tx, projectId, drizzleSql`p.key = ${key}`);
		});
	}

	async addPromotionCodes(
		project: ProjectInstanceContext,
		key: string,
		codes: readonly PromotionCodeInput[],
		actor: string,
	): Promise<{ codes: PromotionCodeRecord[]; created: number }> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const promotion = await requirePromotion(tx, projectId, drizzleSql`p.key = ${key}`, true);
			const normalized = normalizePromotionCodes(codes, promotion);
			const created = await insertCodes(tx, projectId, promotion.id, normalized, actor, {
				requireActive: true,
			});
			const rows = await codeRows(
				tx,
				projectId,
				drizzleSql`c.promotion_id = ${promotion.id} AND c.normalized_code IN (${drizzleSql.join(
					normalized.map((code) => drizzleSql`${code.normalizedCode}`),
					drizzleSql`, `,
				)})`,
				normalized.length,
			);
			const byCode = new Map(rows.map((row) => [row.code.toUpperCase(), toCodeRecord(row)]));
			return {
				codes: normalized.flatMap((code) => byCode.get(code.normalizedCode) ?? []),
				created,
			};
		});
	}

	async listPromotionCodes(
		project: ProjectInstanceContext,
		key: string,
		input: PromotionListInput & { active?: boolean | null },
	): Promise<PromotionListResult<PromotionCodeRecord>> {
		const projectId = project.projectInstanceId;
		const promotion = await requirePromotion(this.database, projectId, drizzleSql`p.key = ${key}`);
		const conditions = [drizzleSql`c.promotion_id = ${promotion.id}`];
		if (input.active !== undefined && input.active !== null) {
			conditions.push(drizzleSql`c.active = ${input.active}`);
		}
		const cursor = keysetCondition(input.cursor, "c");
		if (cursor !== null) {
			conditions.push(cursor);
		}
		const rows = await codeRows(
			this.database,
			projectId,
			drizzleSql.join(conditions, drizzleSql` AND `),
			input.limit + 1,
		);
		return paginate(rows, input.limit, toCodeRecord);
	}

	async deactivatePromotionCode(
		project: ProjectInstanceContext,
		key: string,
		codeId: string,
		actor: string,
	): Promise<PromotionCodeRecord> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const promotion = await requirePromotion(tx, projectId, drizzleSql`p.key = ${key}`);
			const deactivated = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					UPDATE promotion_codes
					SET active = false, deactivated_at = now(), deactivated_by = ${actor}, updated_at = now()
					WHERE project_id = ${projectId}
						AND promotion_id = ${promotion.id}
						AND id = ${codeId}
						AND active
					RETURNING id
				`,
			);
			if (deactivated !== null) {
				await insertAudit(tx, projectId, {
					promotionId: promotion.id,
					promotionCodeId: codeId,
					action: "code_deactivated",
					actor,
					details: {},
				});
			}
			const [row] = await codeRows(
				tx,
				projectId,
				drizzleSql`c.promotion_id = ${promotion.id} AND c.id = ${codeId}`,
				1,
			);
			if (row === undefined) {
				throw promotionError("PROMOTION_CODE_NOT_FOUND");
			}
			return toCodeRecord(row);
		});
	}

	async listPromotionRedemptions(
		project: ProjectInstanceContext,
		key: string,
		input: PromotionListInput & {
			status?: PromotionRedemptionStatus | null;
			billingAccountId?: string | null;
		},
	): Promise<PromotionListResult<PromotionRedemptionRecord>> {
		const projectId = project.projectInstanceId;
		const promotion = await requirePromotion(this.database, projectId, drizzleSql`p.key = ${key}`);
		const conditions = [drizzleSql`r.promotion_id = ${promotion.id}`];
		if (input.status !== undefined && input.status !== null) {
			conditions.push(drizzleSql`r.status = ${input.status}`);
		}
		if (input.billingAccountId !== undefined && input.billingAccountId !== null) {
			conditions.push(drizzleSql`cu.billing_account_id = ${input.billingAccountId}`);
		}
		const cursor = keysetCondition(input.cursor, "r");
		if (cursor !== null) {
			conditions.push(cursor);
		}
		const rows = await redemptionRows(
			this.database,
			projectId,
			drizzleSql.join(conditions, drizzleSql` AND `),
			input.limit + 1,
		);
		return paginate(rows, input.limit, toRedemptionRecord);
	}

	/** Reads a code and its promotion by the code a customer typed. Never creates a customer. */
	async resolvePromotionCode(
		project: ProjectInstanceContext,
		code: string,
	): Promise<ResolvedPromotionCode | null> {
		return await resolvePromotionCodeInTx(this.database, project.projectInstanceId, code);
	}

	async reservePromotionRedemption(
		project: ProjectInstanceContext,
		input: ReservePromotionRedemptionInput,
	): Promise<{ redemption: StoredPromotionRedemption; duplicate: boolean }> {
		return await this.transaction((tx) =>
			reservePromotionRedemptionInTx(tx, project.projectInstanceId, input),
		);
	}

	async applyPromotionRedemption(
		project: ProjectInstanceContext,
		input: ApplyPromotionRedemptionInput,
	): Promise<StoredPromotionRedemption> {
		return await this.transaction((tx) =>
			applyPromotionRedemptionInTx(tx, project.projectInstanceId, input),
		);
	}

	async releasePromotionRedemption(
		project: ProjectInstanceContext,
		redemptionId: string,
	): Promise<StoredPromotionRedemption> {
		return await this.transaction((tx) =>
			releasePromotionRedemptionInTx(tx, project.projectInstanceId, redemptionId),
		);
	}

	/** Worker sweep: releases reservations whose deadline passed, across every project. */
	async releaseExpiredPromotionReservations(limit: number): Promise<number> {
		return await this.transaction(async (tx) => {
			const released = await executeRows<{ project_id: string; promotion_code_id: string }>(
				tx,
				drizzleSql`
					WITH expired AS (
						SELECT r.id, r.project_id
						FROM promotion_redemptions r
						WHERE r.status = 'reserved'
							AND r.reserved_until <= now()
							AND NOT EXISTS (
								SELECT 1
								FROM subscription_changes sc
								WHERE sc.project_id = r.project_id
									AND sc.id = r.subscription_change_id
									AND sc.status IN ('pending', 'processing')
							)
						ORDER BY r.reserved_until, r.id
						LIMIT ${limit}
						FOR UPDATE OF r SKIP LOCKED
					)
					UPDATE promotion_redemptions r
					SET status = 'released', released_at = now(), updated_at = now()
					FROM expired
					WHERE r.project_id = expired.project_id AND r.id = expired.id
					RETURNING r.project_id, r.promotion_code_id
				`,
			);
			const byCode = new Map<string, { projectId: string; codeId: string; count: number }>();
			for (const row of released) {
				const key = `${row.project_id}:${row.promotion_code_id}`;
				const entry = byCode.get(key) ?? {
					projectId: row.project_id,
					codeId: row.promotion_code_id,
					count: 0,
				};
				entry.count += 1;
				byCode.set(key, entry);
			}
			for (const entry of [...byCode.values()].sort((left, right) =>
				`${left.projectId}:${left.codeId}`.localeCompare(`${right.projectId}:${right.codeId}`),
			)) {
				await executeOne(
					tx,
					drizzleSql`
						UPDATE promotion_codes
						SET reserved_count = GREATEST(reserved_count - ${entry.count}, 0), updated_at = now()
						WHERE project_id = ${entry.projectId} AND id = ${entry.codeId}
						RETURNING id
					`,
				);
			}
			return released.length;
		});
	}
}

export async function resolvePromotionCodeInTx(
	executor: QueryExecutor,
	projectId: string,
	code: string,
): Promise<ResolvedPromotionCode | null> {
	const normalizedCode = code.trim().toUpperCase();
	const [row] = await codeRows(
		executor,
		projectId,
		drizzleSql`c.normalized_code = ${normalizedCode}`,
		1,
	);
	if (row === undefined) {
		return null;
	}
	return {
		promotion: await requirePromotion(executor, projectId, drizzleSql`p.id = ${row.promotion_id}`),
		code: toCodeRecord(row),
	};
}

/**
 * Takes one use of a code for a customer. The customer row lock serializes each customer's
 * redemptions; the conditional counter update is the only global limit check, so concurrent
 * customers can never exceed `max_redemptions`. Lock order: customer, redemption, code.
 */
export async function reservePromotionRedemptionInTx(
	tx: QueryExecutor,
	projectId: string,
	input: ReservePromotionRedemptionInput,
): Promise<{ redemption: StoredPromotionRedemption; duplicate: boolean }> {
	await lockCustomerRow(tx, projectId, input.customerId);
	const existing = await executeOne<{
		id: string;
		status: PromotionRedemptionStatus;
		request_hash: string;
	}>(
		tx,
		drizzleSql`
			SELECT id, status, request_hash
			FROM promotion_redemptions
			WHERE project_id = ${projectId}
				AND customer_id = ${input.customerId}
				AND idempotency_key = ${input.idempotencyKey}
			FOR UPDATE
		`,
	);
	if (existing !== null) {
		if (existing.request_hash !== input.requestHash) {
			throw new PersistenceConflictError(
				"Idempotency key was reused with a different promotion redemption",
				"IDEMPOTENCY_CONFLICT",
			);
		}
		if (existing.status !== "released") {
			return {
				redemption: await requireRedemption(tx, projectId, existing.id),
				duplicate: true,
			};
		}
	}

	await releaseCustomerExpiredReservations(tx, projectId, input.customerId, input.promotionCodeId);
	const state = await readCodeAvailability(tx, projectId, input.promotionCodeId);
	const unavailable = promotionCodeUnavailability(availabilityFromRow(state), {
		now: new Date(toIso(state.now)),
		billingAccountId: input.billingAccountId,
		channel: input.channel,
	});
	if (unavailable !== null) {
		throw promotionError(unavailable);
	}
	if (state.max_redemptions_per_customer !== null) {
		const used = await executeOne<{ count: number }>(
			tx,
			drizzleSql`
				SELECT count(*)::integer AS count
				FROM promotion_redemptions
				WHERE project_id = ${projectId}
					AND promotion_code_id = ${input.promotionCodeId}
					AND customer_id = ${input.customerId}
					AND status IN ('reserved', 'applied', 'reversed')
			`,
		);
		if ((used?.count ?? 0) >= state.max_redemptions_per_customer) {
			throw promotionError("PROMOTION_CODE_ALREADY_REDEEMED");
		}
	}
	if (state.first_purchase_only && (await customerHasPurchased(tx, projectId, input.customerId))) {
		throw promotionError("PROMOTION_CODE_FIRST_PURCHASE_ONLY");
	}

	const reserve = input.reservedUntil !== null;
	const taken = await executeOne<{ id: string }>(
		tx,
		drizzleSql`
			UPDATE promotion_codes c
			SET reserved_count = c.reserved_count + ${reserve ? 1 : 0},
				redeemed_count = c.redeemed_count + ${reserve ? 0 : 1},
				updated_at = now()
			FROM promotions p
			WHERE c.project_id = ${projectId}
				AND c.id = ${input.promotionCodeId}
				AND p.project_id = c.project_id
				AND p.id = c.promotion_id
				AND p.status = 'active'
				AND c.active
				AND (c.starts_at IS NULL OR c.starts_at <= now())
				AND (c.expires_at IS NULL OR c.expires_at > now())
				AND (c.max_redemptions IS NULL OR c.redeemed_count + c.reserved_count < c.max_redemptions)
			RETURNING c.id
		`,
	);
	if (taken === null) {
		const current = await readCodeAvailability(tx, projectId, input.promotionCodeId);
		throw promotionError(
			promotionCodeUnavailability(availabilityFromRow(current), {
				now: new Date(toIso(current.now)),
				billingAccountId: input.billingAccountId,
				channel: input.channel,
			}) ?? "PROMOTION_CODE_EXHAUSTED",
		);
	}

	const reservedUntil = input.reservedUntil?.toISOString() ?? null;
	const row =
		existing === null
			? await executeOne<{ id: string }>(
					tx,
					drizzleSql`
						INSERT INTO promotion_redemptions (
							project_id, promotion_id, promotion_code_id, customer_id, channel, status,
							provider, source, commercial_action_preview_id, subscription_change_id,
							external_subscription_id, stripe_coupon_id, provider_object_id,
							effect_snapshot, actor, reason, idempotency_key, request_hash,
							reserved_until, applied_at
						)
						VALUES (
							${projectId}, ${state.promotion_id}, ${input.promotionCodeId}, ${input.customerId},
							${input.channel}, ${reserve ? "reserved" : "applied"}, ${input.provider},
							${input.source}, ${input.commercialActionPreviewId ?? null},
							${input.subscriptionChangeId ?? null}, ${input.externalSubscriptionId ?? null},
							${input.stripeCouponId ?? null}, ${input.providerObjectId ?? null},
							${jsonb(input.effectSnapshot)}, ${input.actor}, ${input.reason ?? null},
							${input.idempotencyKey}, ${input.requestHash}, ${reservedUntil},
							${reserve ? null : drizzleSql`now()`}
						)
						RETURNING id
					`,
				)
			: await executeOne<{ id: string }>(
					tx,
					drizzleSql`
						UPDATE promotion_redemptions
						SET status = ${reserve ? "reserved" : "applied"},
							reserved_until = ${reservedUntil},
							applied_at = ${reserve ? null : drizzleSql`now()`},
							released_at = NULL,
							updated_at = now()
						WHERE project_id = ${projectId} AND id = ${existing.id} AND status = 'released'
						RETURNING id
					`,
				);
	if (row === null) {
		throw new Error("Promotion redemption could not be persisted");
	}
	return { redemption: await requireRedemption(tx, projectId, row.id), duplicate: false };
}

/**
 * Marks a redemption applied once the provider confirms it. A reservation that was already
 * released still becomes applied, because the provider executed it; the use is counted and a cap
 * overrun is recorded rather than silently dropped.
 */
export async function applyPromotionRedemptionInTx(
	tx: QueryExecutor,
	projectId: string,
	input: ApplyPromotionRedemptionInput,
): Promise<StoredPromotionRedemption> {
	const current = await lockRedemption(tx, projectId, input.redemptionId);
	if (current.status === "applied" || current.status === "reversed") {
		return await requireRedemption(tx, projectId, current.id);
	}
	let violation: PromotionLimitViolation | null = null;
	if (current.promotion_code_id !== null) {
		const counters = await executeOne<{ over_cap: boolean }>(
			tx,
			drizzleSql`
				UPDATE promotion_codes
				SET reserved_count = CASE
						WHEN ${current.status} = 'reserved' THEN GREATEST(reserved_count - 1, 0)
						ELSE reserved_count
					END,
					redeemed_count = redeemed_count + 1,
					updated_at = now()
				WHERE project_id = ${projectId} AND id = ${current.promotion_code_id}
				RETURNING max_redemptions IS NOT NULL
					AND redeemed_count + reserved_count > max_redemptions AS over_cap
			`,
		);
		violation = current.status === "released" && counters?.over_cap === true ? "global" : null;
	}
	await executeOne(
		tx,
		drizzleSql`
			UPDATE promotion_redemptions
			SET status = 'applied',
				applied_at = now(),
				limit_violation = COALESCE(limit_violation, ${violation}),
				purchase_id = COALESCE(${input.purchaseId ?? null}, purchase_id),
				stripe_checkout_session_id = COALESCE(${input.stripeCheckoutSessionId ?? null}, stripe_checkout_session_id),
				stripe_invoice_id = COALESCE(${input.stripeInvoiceId ?? null}, stripe_invoice_id),
				external_subscription_id = COALESCE(${input.externalSubscriptionId ?? null}, external_subscription_id),
				currency = COALESCE(${input.currency?.toUpperCase() ?? null}, currency),
				amount_subtotal_minor = COALESCE(${input.amountSubtotalMinor ?? null}, amount_subtotal_minor),
				amount_discount_minor = COALESCE(${input.amountDiscountMinor ?? null}, amount_discount_minor),
				amount_total_minor = COALESCE(${input.amountTotalMinor ?? null}, amount_total_minor),
				updated_at = now()
			WHERE project_id = ${projectId} AND id = ${current.id}
			RETURNING id
		`,
	);
	return await requireRedemption(tx, projectId, current.id);
}

export async function releasePromotionRedemptionInTx(
	tx: QueryExecutor,
	projectId: string,
	redemptionId: string,
): Promise<StoredPromotionRedemption> {
	const current = await lockRedemption(tx, projectId, redemptionId);
	if (current.status !== "reserved") {
		return await requireRedemption(tx, projectId, current.id);
	}
	await executeOne(
		tx,
		drizzleSql`
			UPDATE promotion_redemptions
			SET status = 'released', released_at = now(), updated_at = now()
			WHERE project_id = ${projectId} AND id = ${current.id}
			RETURNING id
		`,
	);
	if (current.promotion_code_id !== null) {
		await executeOne(
			tx,
			drizzleSql`
				UPDATE promotion_codes
				SET reserved_count = GREATEST(reserved_count - 1, 0), updated_at = now()
				WHERE project_id = ${projectId} AND id = ${current.promotion_code_id}
				RETURNING id
			`,
		);
	}
	return await requireRedemption(tx, projectId, current.id);
}

async function lockRedemption(
	tx: QueryExecutor,
	projectId: string,
	redemptionId: string,
): Promise<{ id: string; status: PromotionRedemptionStatus; promotion_code_id: string | null }> {
	const owner = await executeOne<{ customer_id: string }>(
		tx,
		drizzleSql`
			SELECT customer_id
			FROM promotion_redemptions
			WHERE project_id = ${projectId} AND id = ${redemptionId}
		`,
	);
	if (owner === null) {
		throw promotionError("PROMOTION_REDEMPTION_NOT_FOUND");
	}
	await lockCustomerRow(tx, projectId, owner.customer_id);
	const locked = await executeOne<{
		id: string;
		status: PromotionRedemptionStatus;
		promotion_code_id: string | null;
	}>(
		tx,
		drizzleSql`
			SELECT id, status, promotion_code_id
			FROM promotion_redemptions
			WHERE project_id = ${projectId} AND id = ${redemptionId}
			FOR UPDATE
		`,
	);
	if (locked === null) {
		throw promotionError("PROMOTION_REDEMPTION_NOT_FOUND");
	}
	return locked;
}

async function releaseCustomerExpiredReservations(
	tx: QueryExecutor,
	projectId: string,
	customerId: string,
	promotionCodeId: string,
): Promise<void> {
	const released = await executeRows<{ id: string }>(
		tx,
		drizzleSql`
			UPDATE promotion_redemptions r
			SET status = 'released', released_at = now(), updated_at = now()
			WHERE r.project_id = ${projectId}
				AND r.customer_id = ${customerId}
				AND r.promotion_code_id = ${promotionCodeId}
				AND r.status = 'reserved'
				AND r.reserved_until <= now()
				AND NOT EXISTS (
					SELECT 1
					FROM subscription_changes sc
					WHERE sc.project_id = r.project_id
						AND sc.id = r.subscription_change_id
						AND sc.status IN ('pending', 'processing')
				)
			RETURNING r.id
		`,
	);
	if (released.length > 0) {
		await executeOne(
			tx,
			drizzleSql`
				UPDATE promotion_codes
				SET reserved_count = GREATEST(reserved_count - ${released.length}, 0), updated_at = now()
				WHERE project_id = ${projectId} AND id = ${promotionCodeId}
				RETURNING id
			`,
		);
	}
}

async function readCodeAvailability(
	executor: QueryExecutor,
	projectId: string,
	promotionCodeId: string,
): Promise<CodeAvailabilityRow> {
	const row = await executeOne<CodeAvailabilityRow>(
		executor,
		drizzleSql`
			SELECT
				p.id AS promotion_id,
				p.status AS promotion_status,
				to_jsonb(p.allowed_channels) AS allowed_channels,
				p.effect_kind,
				c.active,
				c.starts_at,
				c.expires_at,
				c.billing_account_id,
				c.max_redemptions,
				c.max_redemptions_per_customer,
				c.first_purchase_only,
				c.redeemed_count,
				c.reserved_count,
				now() AS now
			FROM promotion_codes c
			JOIN promotions p ON p.project_id = c.project_id AND p.id = c.promotion_id
			WHERE c.project_id = ${projectId} AND c.id = ${promotionCodeId}
		`,
	);
	if (row === null) {
		throw promotionError("PROMOTION_CODE_NOT_FOUND");
	}
	return row;
}

function availabilityFromRow(row: CodeAvailabilityRow): PromotionCodeAvailability {
	return {
		promotionStatus: row.promotion_status,
		allowedChannels: row.allowed_channels,
		active: row.active,
		startsAt: row.starts_at === null ? null : new Date(toIso(row.starts_at)),
		expiresAt: row.expires_at === null ? null : new Date(toIso(row.expires_at)),
		billingAccountId: row.billing_account_id,
		maxRedemptions: row.max_redemptions,
		redeemedCount: row.redeemed_count,
		reservedCount: row.reserved_count,
	};
}

async function customerHasPurchased(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
): Promise<boolean> {
	const row = await executeOne<{ purchased: boolean }>(
		executor,
		drizzleSql`
			SELECT
				EXISTS (
					SELECT 1 FROM purchases WHERE project_id = ${projectId} AND customer_id = ${customerId}
				)
				OR EXISTS (
					SELECT 1 FROM subscriptions WHERE project_id = ${projectId} AND customer_id = ${customerId}
				) AS purchased
		`,
	);
	return row?.purchased === true;
}

interface PromotionReferences {
	planId: string | null;
	targets: Array<{ kind: "plan" | "product"; id: string }>;
	grantItems: Array<{ featureId: string; quantity: string; expiresAfterSeconds: number | null }>;
}

async function resolvePromotionReferences(
	executor: QueryExecutor,
	projectId: string,
	effect: PromotionEffect,
	input: { targets: readonly PromotionTarget[] },
): Promise<PromotionReferences> {
	const targets: PromotionReferences["targets"] = [];
	for (const target of input.targets) {
		const row =
			target.kind === "plan"
				? await executeOne<{ id: string | number }>(
						executor,
						drizzleSql`SELECT id FROM plans WHERE project_id = ${projectId} AND key = ${target.key}`,
					)
				: await executeOne<{ id: string }>(
						executor,
						drizzleSql`SELECT id FROM products WHERE project_id = ${projectId} AND key = ${target.key}`,
					);
		if (row === null) {
			throw promotionError(
				"PROMOTION_TARGET_NOT_FOUND",
				`Promotion target ${target.kind} ${target.key} was not found`,
			);
		}
		targets.push({ kind: target.kind, id: String(row.id) });
	}
	let planId: string | null = null;
	if (effect.kind === "plan_grant") {
		const plan = await executeOne<{ id: string | number }>(
			executor,
			drizzleSql`SELECT id FROM plans WHERE project_id = ${projectId} AND key = ${effect.planKey}`,
		);
		if (plan === null) {
			throw promotionError(
				"PROMOTION_TARGET_NOT_FOUND",
				`Promotion plan ${effect.planKey} was not found`,
			);
		}
		planId = String(plan.id);
	}
	const grantItems: PromotionReferences["grantItems"] = [];
	if (effect.kind === "feature_grant") {
		for (const item of effect.items) {
			const feature = await executeOne<{
				id: string | number;
				kind: string;
				meter_kind: string | null;
				credit_scale: number;
			}>(
				executor,
				drizzleSql`
					SELECT id, kind, meter_kind, credit_scale
					FROM features
					WHERE project_id = ${projectId} AND key = ${item.featureKey} AND active
				`,
			);
			if (feature === null) {
				throw promotionError(
					"PROMOTION_TARGET_NOT_FOUND",
					`Promotion feature ${item.featureKey} was not found`,
				);
			}
			if (feature.kind !== "metered" || feature.meter_kind !== "consumable") {
				throw promotionError(
					"PROMOTION_TERMS_INVALID",
					`Promotion terms are invalid: feature ${item.featureKey} is not a consumable meter`,
				);
			}
			const fraction = item.quantity.split(".")[1] ?? "";
			if (fraction.length > feature.credit_scale) {
				throw promotionError(
					"PROMOTION_TERMS_INVALID",
					`Promotion terms are invalid: feature ${item.featureKey} supports ${feature.credit_scale} decimal places`,
				);
			}
			grantItems.push({
				featureId: String(feature.id),
				quantity: item.quantity,
				expiresAfterSeconds: item.expiresAfterSeconds,
			});
		}
	}
	return { planId, targets, grantItems };
}

async function insertPromotionTerms(
	tx: QueryExecutor,
	projectId: string,
	promotionId: string,
	effect: PromotionEffect,
	references: PromotionReferences,
): Promise<void> {
	if (effect.kind === "discount" && effect.discount.type === "amount") {
		for (const amount of effect.discount.amounts) {
			await executeOne(
				tx,
				drizzleSql`
					INSERT INTO promotion_discount_amounts (project_id, promotion_id, currency, amount_off_minor)
					VALUES (${projectId}, ${promotionId}, ${amount.currency}, ${amount.amountOffMinor})
					RETURNING promotion_id
				`,
			);
		}
	}
	for (const target of references.targets) {
		await executeOne(
			tx,
			drizzleSql`
				INSERT INTO promotion_targets (project_id, promotion_id, target_kind, plan_id, product_id)
				VALUES (
					${projectId}, ${promotionId}, ${target.kind},
					${target.kind === "plan" ? target.id : null}::bigint,
					${target.kind === "product" ? target.id : null}::uuid
				)
				RETURNING id
			`,
		);
	}
	for (const item of references.grantItems) {
		await executeOne(
			tx,
			drizzleSql`
				INSERT INTO promotion_grant_items (
					project_id, promotion_id, feature_id, quantity, expires_after_seconds
				)
				VALUES (
					${projectId}, ${promotionId}, ${item.featureId}::bigint, ${item.quantity}::numeric,
					${item.expiresAfterSeconds}::bigint
				)
				RETURNING id
			`,
		);
	}
}

async function insertCodes(
	tx: QueryExecutor,
	projectId: string,
	promotionId: string,
	codes: readonly NormalizedPromotionCode[],
	actor: string,
	options: { requireActive: boolean },
): Promise<number> {
	if (options.requireActive) {
		const promotion = await executeOne<{ status: PromotionStatus }>(
			tx,
			drizzleSql`SELECT status FROM promotions WHERE project_id = ${projectId} AND id = ${promotionId}`,
		);
		if (promotion?.status !== "active") {
			const replay = await existingCodesMatch(tx, projectId, promotionId, codes);
			if (!replay) {
				throw promotionError("PROMOTION_ARCHIVED");
			}
			return 0;
		}
	}
	const created: string[] = [];
	for (const code of codes) {
		const inserted = await executeOne<{ id: string }>(
			tx,
			drizzleSql`
				INSERT INTO promotion_codes (
					project_id, promotion_id, code, normalized_code, starts_at, expires_at,
					max_redemptions, max_redemptions_per_customer, first_purchase_only,
					billing_account_id, hosted_checkout_enabled, created_by
				)
				VALUES (
					${projectId}, ${promotionId}, ${code.code}, ${code.normalizedCode}, ${code.startsAt},
					${code.expiresAt}, ${code.maxRedemptions}, ${code.maxRedemptionsPerCustomer},
					${code.firstPurchaseOnly}, ${code.billingAccountId}, ${code.hostedCheckoutEnabled},
					${actor}
				)
				ON CONFLICT (project_id, normalized_code) DO NOTHING
				RETURNING id
			`,
		);
		if (inserted !== null) {
			created.push(code.normalizedCode);
			continue;
		}
		if (!(await existingCodesMatch(tx, projectId, promotionId, [code]))) {
			throw promotionError(
				"PROMOTION_CODE_CONFLICT",
				`Promotion code ${code.code} already exists with different settings`,
			);
		}
	}
	if (created.length > 0) {
		await insertAudit(tx, projectId, {
			promotionId,
			action: "codes_added",
			actor,
			details: { count: created.length },
		});
	}
	return created.length;
}

async function existingCodesMatch(
	executor: QueryExecutor,
	projectId: string,
	promotionId: string,
	codes: readonly NormalizedPromotionCode[],
): Promise<boolean> {
	for (const code of codes) {
		const row = await executeOne<{ matches: boolean }>(
			executor,
			drizzleSql`
				SELECT (
					promotion_id = ${promotionId}
					AND code = ${code.code}
					AND starts_at IS NOT DISTINCT FROM ${code.startsAt}::timestamptz
					AND expires_at IS NOT DISTINCT FROM ${code.expiresAt}::timestamptz
					AND max_redemptions IS NOT DISTINCT FROM ${code.maxRedemptions}::integer
					AND max_redemptions_per_customer IS NOT DISTINCT FROM ${code.maxRedemptionsPerCustomer}::integer
					AND first_purchase_only = ${code.firstPurchaseOnly}
					AND billing_account_id IS NOT DISTINCT FROM ${code.billingAccountId}::text
					AND hosted_checkout_enabled = ${code.hostedCheckoutEnabled}
				) AS matches
				FROM promotion_codes
				WHERE project_id = ${projectId} AND normalized_code = ${code.normalizedCode}
			`,
		);
		if (row?.matches !== true) {
			return false;
		}
	}
	return true;
}

async function insertAudit(
	executor: QueryExecutor,
	projectId: string,
	input: {
		promotionId: string;
		promotionCodeId?: string | null;
		action: "promotion_created" | "promotion_archived" | "codes_added" | "code_deactivated";
		actor: string;
		details: Record<string, unknown>;
	},
): Promise<void> {
	await executeOne(
		executor,
		drizzleSql`
			INSERT INTO promotion_audit_events (
				project_id, promotion_id, promotion_code_id, action, actor, details
			)
			VALUES (
				${projectId}, ${input.promotionId}, ${input.promotionCodeId ?? null}, ${input.action},
				${input.actor}, ${jsonb(input.details)}
			)
			RETURNING id
		`,
	);
}

async function requirePromotion(
	executor: QueryExecutor,
	projectId: string,
	condition: DrizzleSQL,
	lock = false,
): Promise<PromotionRecord> {
	if (lock) {
		await executeOne(
			executor,
			drizzleSql`SELECT p.id FROM promotions p WHERE p.project_id = ${projectId} AND ${condition} FOR UPDATE`,
		);
	}
	const [row] = await promotionRows(executor, projectId, condition, 1);
	if (row === undefined) {
		throw promotionError("PROMOTION_NOT_FOUND");
	}
	return toPromotionRecord(row);
}

async function promotionRows(
	executor: QueryExecutor,
	projectId: string,
	condition: DrizzleSQL,
	limit: number,
): Promise<PromotionRow[]> {
	return await executeRows<PromotionRow>(
		executor,
		drizzleSql`
			SELECT
				p.id, p.key, p.name, p.status, p.effect_kind,
				to_jsonb(p.allowed_channels) AS allowed_channels,
				p.discount_type, p.percent_off_bps, p.discount_duration, p.duration_months,
				plan.key AS plan_key, p.grant_duration_unit, p.grant_duration_count,
				p.terms_hash, p.metadata, p.created_by, p.created_at, p.archived_by, p.archived_at,
				${cursorTimestamp("p")} AS cursor_created_at,
				COALESCE((
					SELECT jsonb_agg(
						jsonb_build_object('currency', a.currency, 'amountOffMinor', a.amount_off_minor)
						ORDER BY a.currency
					)
					FROM promotion_discount_amounts a
					WHERE a.project_id = p.project_id AND a.promotion_id = p.id
				), '[]'::jsonb) AS amounts,
				COALESCE((
					SELECT jsonb_agg(
						jsonb_build_object('kind', t.target_kind, 'key', COALESCE(tp.key, tr.key))
						ORDER BY t.target_kind, COALESCE(tp.key, tr.key)
					)
					FROM promotion_targets t
					LEFT JOIN plans tp ON tp.project_id = t.project_id AND tp.id = t.plan_id
					LEFT JOIN products tr ON tr.project_id = t.project_id AND tr.id = t.product_id
					WHERE t.project_id = p.project_id AND t.promotion_id = p.id
				), '[]'::jsonb) AS targets,
				COALESCE((
					SELECT jsonb_agg(
						jsonb_build_object(
							'featureKey', f.key,
							'quantity', i.quantity::text,
							'expiresAfterSeconds', i.expires_after_seconds
						)
						ORDER BY f.key
					)
					FROM promotion_grant_items i
					JOIN features f ON f.project_id = i.project_id AND f.id = i.feature_id
					WHERE i.project_id = p.project_id AND i.promotion_id = p.id
				), '[]'::jsonb) AS grant_items,
				(
					SELECT count(*)::integer
					FROM promotion_codes c
					WHERE c.project_id = p.project_id AND c.promotion_id = p.id
				) AS code_total,
				(
					SELECT count(*)::integer
					FROM promotion_codes c
					WHERE c.project_id = p.project_id AND c.promotion_id = p.id AND c.active
				) AS code_active,
				(
					SELECT jsonb_object_agg(counts.status, counts.total)
					FROM (
						SELECT r.status, count(*)::integer AS total
						FROM promotion_redemptions r
						WHERE r.project_id = p.project_id AND r.promotion_id = p.id
						GROUP BY r.status
					) counts
				) AS redemption_counts
			FROM promotions p
			LEFT JOIN plans plan ON plan.project_id = p.project_id AND plan.id = p.plan_id
			WHERE p.project_id = ${projectId} AND ${condition}
			ORDER BY p.created_at DESC, p.id DESC
			LIMIT ${limit}
		`,
	);
}

async function codeRows(
	executor: QueryExecutor,
	projectId: string,
	condition: DrizzleSQL,
	limit: number,
): Promise<PromotionCodeRow[]> {
	return await executeRows<PromotionCodeRow>(
		executor,
		drizzleSql`
			SELECT
				c.id, c.promotion_id, p.key AS promotion_key, c.code, c.active, c.starts_at,
				c.expires_at, c.max_redemptions, c.max_redemptions_per_customer,
				c.first_purchase_only, c.billing_account_id, c.hosted_checkout_enabled,
				c.redeemed_count, c.reserved_count, c.created_by, c.created_at, c.deactivated_by,
				c.deactivated_at, ${cursorTimestamp("c")} AS cursor_created_at
			FROM promotion_codes c
			JOIN promotions p ON p.project_id = c.project_id AND p.id = c.promotion_id
			WHERE c.project_id = ${projectId} AND ${condition}
			ORDER BY c.created_at DESC, c.id DESC
			LIMIT ${limit}
		`,
	);
}

async function requireRedemption(
	executor: QueryExecutor,
	projectId: string,
	redemptionId: string,
): Promise<StoredPromotionRedemption> {
	const [row] = await redemptionRows(executor, projectId, drizzleSql`r.id = ${redemptionId}`, 1);
	if (row === undefined) {
		throw promotionError("PROMOTION_REDEMPTION_NOT_FOUND");
	}
	return {
		...toRedemptionRecord(row),
		promotionId: row.promotion_id,
		customerId: row.customer_id,
		requestHash: row.request_hash,
		result: row.result,
	};
}

async function redemptionRows(
	executor: QueryExecutor,
	projectId: string,
	condition: DrizzleSQL,
	limit: number,
): Promise<RedemptionRow[]> {
	return await executeRows<RedemptionRow>(
		executor,
		drizzleSql`
			SELECT
				r.id, r.promotion_id, p.key AS promotion_key, r.promotion_code_id, c.code,
				r.customer_id, cu.billing_account_id, r.channel, r.status, r.provider, r.source,
				r.stripe_checkout_session_id, r.external_subscription_id, r.currency,
				r.amount_subtotal_minor, r.amount_discount_minor, r.amount_total_minor,
				r.limit_violation, r.actor, r.reason, r.request_hash, r.result, r.reserved_until,
				r.applied_at, r.released_at, r.reversed_at, r.created_at,
				${cursorTimestamp("r")} AS cursor_created_at
			FROM promotion_redemptions r
			JOIN promotions p ON p.project_id = r.project_id AND p.id = r.promotion_id
			JOIN customers cu ON cu.project_id = r.project_id AND cu.id = r.customer_id
			LEFT JOIN promotion_codes c ON c.project_id = r.project_id AND c.id = r.promotion_code_id
			WHERE r.project_id = ${projectId} AND ${condition}
			ORDER BY r.created_at DESC, r.id DESC
			LIMIT ${limit}
		`,
	);
}

function toPromotionRecord(row: PromotionRow): PromotionRecord {
	return {
		id: row.id,
		key: row.key,
		name: row.name,
		status: row.status,
		effect: effectFromRow(row),
		targets: row.targets,
		allowedChannels: row.allowed_channels,
		metadata: row.metadata,
		termsHash: row.terms_hash,
		createdBy: row.created_by,
		createdAt: toIso(row.created_at),
		archivedBy: row.archived_by,
		archivedAt: row.archived_at === null ? null : toIso(row.archived_at),
		codeCounts: { total: row.code_total, active: row.code_active },
		redemptionCounts: {
			reserved: row.redemption_counts?.reserved ?? 0,
			applied: row.redemption_counts?.applied ?? 0,
			released: row.redemption_counts?.released ?? 0,
			reversed: row.redemption_counts?.reversed ?? 0,
		},
	};
}

function effectFromRow(row: PromotionRow): PromotionEffect {
	switch (row.effect_kind) {
		case "discount": {
			const duration = row.discount_duration ?? "once";
			return row.discount_type === "percent"
				? {
						kind: "discount",
						discount: {
							type: "percent",
							percentOffBps: row.percent_off_bps ?? 0,
							duration,
							durationMonths: row.duration_months,
						},
					}
				: {
						kind: "discount",
						discount: {
							type: "amount",
							amounts: row.amounts.map((amount) => ({
								currency: amount.currency,
								amountOffMinor: Number(amount.amountOffMinor),
							})),
							duration,
							durationMonths: row.duration_months,
						},
					};
		}
		case "feature_grant":
			return {
				kind: "feature_grant",
				items: row.grant_items.map((item) => ({
					featureKey: item.featureKey,
					quantity: promotionQuantity(databaseDecimal(item.quantity, "quantity")),
					expiresAfterSeconds:
						item.expiresAfterSeconds === null ? null : Number(item.expiresAfterSeconds),
				})),
			};
		case "plan_grant":
			return {
				kind: "plan_grant",
				planKey: row.plan_key ?? "",
				durationUnit: row.grant_duration_unit ?? "day",
				durationCount: row.grant_duration_count ?? 0,
			};
	}
}

function toCodeRecord(row: PromotionCodeRow): PromotionCodeRecord {
	return {
		id: row.id,
		promotionKey: row.promotion_key,
		code: row.code,
		active: row.active,
		startsAt: row.starts_at === null ? null : toIso(row.starts_at),
		expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
		maxRedemptions: row.max_redemptions,
		maxRedemptionsPerCustomer: row.max_redemptions_per_customer,
		firstPurchaseOnly: row.first_purchase_only,
		billingAccountId: row.billing_account_id,
		hostedCheckoutEnabled: row.hosted_checkout_enabled,
		redeemedCount: row.redeemed_count,
		reservedCount: row.reserved_count,
		createdBy: row.created_by,
		createdAt: toIso(row.created_at),
		deactivatedBy: row.deactivated_by,
		deactivatedAt: row.deactivated_at === null ? null : toIso(row.deactivated_at),
	};
}

function toRedemptionRecord(row: RedemptionRow): PromotionRedemptionRecord {
	return {
		id: row.id,
		promotionKey: row.promotion_key,
		promotionCodeId: row.promotion_code_id,
		code: row.code,
		billingAccountId: row.billing_account_id,
		channel: row.channel,
		status: row.status,
		provider: row.provider,
		source: row.source,
		stripeCheckoutSessionId: row.stripe_checkout_session_id,
		externalSubscriptionId: row.external_subscription_id,
		currency: row.currency,
		amountSubtotalMinor: optionalNumber(row.amount_subtotal_minor),
		amountDiscountMinor: optionalNumber(row.amount_discount_minor),
		amountTotalMinor: optionalNumber(row.amount_total_minor),
		limitViolation: row.limit_violation,
		actor: row.actor,
		reason: row.reason,
		reservedUntil: row.reserved_until === null ? null : toIso(row.reserved_until),
		appliedAt: row.applied_at === null ? null : toIso(row.applied_at),
		releasedAt: row.released_at === null ? null : toIso(row.released_at),
		reversedAt: row.reversed_at === null ? null : toIso(row.reversed_at),
		createdAt: toIso(row.created_at),
	};
}

function optionalNumber(value: number | string | null): number | null {
	return value === null ? null : Number(value);
}

function textArray(values: readonly string[]): DrizzleSQL {
	return drizzleSql`ARRAY[${drizzleSql.join(
		values.map((value) => drizzleSql`${value}`),
		drizzleSql`, `,
	)}]::text[]`;
}

function cursorTimestamp(alias: string): DrizzleSQL {
	const table = drizzleSql.identifier(alias);
	return drizzleSql`to_char(${table}.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

function keysetCondition(cursor: string | null | undefined, alias: string): DrizzleSQL | null {
	if (cursor === undefined || cursor === null) {
		return null;
	}
	const decoded = decodeAdminCursor(cursor);
	const table = drizzleSql.identifier(alias);
	return drizzleSql`(${table}.created_at, ${table}.id) < (${decoded.createdAt}::timestamptz, ${decoded.id}::uuid)`;
}

function paginate<Row extends { id: string; cursor_created_at: string }, Item>(
	rows: Row[],
	limit: number,
	mapper: (row: Row) => Item,
): PromotionListResult<Item> {
	const last = rows[limit - 1];
	return {
		items: rows.slice(0, limit).map(mapper),
		nextCursor:
			rows.length > limit && last !== undefined
				? encodeAdminCursor({ createdAt: last.cursor_created_at, id: last.id })
				: null,
	};
}
