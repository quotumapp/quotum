import { sql as drizzleSql } from "drizzle-orm";
import { sha256Hex, stableJson } from "../../billing/decimal";
import {
	type PromotionDiscount,
	type PromotionProviderObjectStatus,
	type PromotionStripeSyncJob,
	promotionError,
} from "../../billing/promotions";
import type { BillingProvider } from "../../billing/types";
import type { ProjectInstanceContext } from "../../projects/context";
import { toIso } from "../../shared/date";
import { RepositoryModule } from "./base";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";

type Timestamp = Date | string;

interface ClaimedObjectRow {
	project_id: string;
	project_key: string;
	id: string;
	provider: BillingProvider;
	object_kind: "coupon" | "promotion_code";
	status: PromotionProviderObjectStatus;
	external_id: string | null;
	desired_active: boolean;
	desired_generation: number;
	provider_active: boolean | null;
	retire_requested: boolean;
	attempts: number;
	applies_to: { products?: string[] | null };
	promotion_key: string;
	promotion_name: string;
	discount_type: "percent" | "amount" | null;
	percent_off_bps: number | null;
	discount_duration: "once" | "repeating" | "forever" | null;
	duration_months: number | null;
	amounts: Array<{ currency: string; amountOffMinor: number | string }>;
	code: string | null;
	expires_at: Timestamp | null;
	max_redemptions: number | null;
	first_purchase_only: boolean | null;
	coupon_external_id: string | null;
}

export interface PromotionMaintenanceCounts {
	couponsCreated: number;
	couponsCurrent: number;
	promotionCodesCreated: number;
}

/**
 * Durable intent for the Stripe coupons and promotion codes that mirror Quotum promotions. Rows are
 * leased by one worker at a time; only the lease owner can record an outcome.
 */
export class PromotionProviderObjectRepository extends RepositoryModule {
	/**
	 * Makes sure every active web discount has a coupon for the products it currently targets. A
	 * changed product set creates a new coupon and retires hosted codes bound to the old one, because
	 * Stripe coupons cannot be edited.
	 */
	async reconcilePromotionCoupons(limit: number): Promise<PromotionMaintenanceCounts> {
		const candidates = await executeRows<{ project_id: string; id: string }>(
			this.database,
			drizzleSql`
				SELECT p.project_id, p.id
				FROM promotions p
				JOIN projects project ON project.id = p.project_id
				WHERE p.effect_kind = 'discount'
					AND p.status = 'active'
					AND 'web' = ANY (p.allowed_channels)
					AND NOT EXISTS (
						SELECT 1
						FROM promotion_provider_objects coupon
						WHERE coupon.project_id = p.project_id
							AND coupon.promotion_id = p.id
							AND coupon.object_kind = 'coupon'
							AND coupon.status <> 'retired'
							AND coupon.catalog_revision_id IS NOT DISTINCT FROM project.published_catalog_revision_id
					)
				ORDER BY p.updated_at, p.id
				LIMIT ${limit}
			`,
		);
		const counts: PromotionMaintenanceCounts = {
			couponsCreated: 0,
			couponsCurrent: 0,
			promotionCodesCreated: 0,
		};
		for (const candidate of candidates) {
			const outcome = await this.transaction((tx) =>
				reconcileCouponInTx(tx, candidate.project_id, candidate.id),
			);
			if (outcome === "created") counts.couponsCreated += 1;
			if (outcome === "current") counts.couponsCurrent += 1;
		}
		return counts;
	}

	/** Creates the pending Stripe promotion code for hosted codes that have no live object. */
	async ensureHostedPromotionCodeObjects(limit: number): Promise<number> {
		const inserted = await executeRows<{ id: string }>(
			this.database,
			drizzleSql`
				INSERT INTO promotion_provider_objects (
					project_id, promotion_id, promotion_code_id, parent_object_id, provider, object_kind,
					desired_active
				)
				SELECT
					c.project_id, c.promotion_id, c.id, coupon.id, 'stripe', 'promotion_code',
					c.max_redemptions IS NULL OR c.redeemed_count + c.reserved_count < c.max_redemptions
				FROM promotion_codes c
				JOIN promotions p ON p.project_id = c.project_id AND p.id = c.promotion_id
				JOIN LATERAL (
					SELECT candidate.id
					FROM promotion_provider_objects candidate
					WHERE candidate.project_id = c.project_id
						AND candidate.promotion_id = c.promotion_id
						AND candidate.object_kind = 'coupon'
						AND candidate.status <> 'retired'
					ORDER BY candidate.created_at DESC, candidate.id DESC
					LIMIT 1
				) coupon ON true
				WHERE c.hosted_checkout_enabled
					AND c.active
					AND p.status = 'active'
					AND (c.expires_at IS NULL OR c.expires_at > now())
					AND NOT EXISTS (
						SELECT 1
						FROM promotion_provider_objects live
						WHERE live.project_id = c.project_id
							AND live.promotion_code_id = c.id
							AND live.object_kind = 'promotion_code'
							AND live.status <> 'retired'
					)
				ORDER BY c.created_at, c.id
				LIMIT ${limit}
				ON CONFLICT DO NOTHING
				RETURNING id
			`,
		);
		return inserted.length;
	}

	async claimStripeObjects(
		workerId: string,
		limit: number,
		staleBefore: Date,
	): Promise<PromotionStripeSyncJob[]> {
		if (workerId.trim() === "") throw new Error("Promotion worker id is required");
		return await this.transaction(async (tx) => {
			const claimed = await executeRows<{ project_id: string; id: string }>(
				tx,
				drizzleSql`
					WITH due AS (
						SELECT o.project_id, o.id
						FROM promotion_provider_objects o
						LEFT JOIN promotion_provider_objects parent
							ON parent.project_id = o.project_id AND parent.id = o.parent_object_id
						LEFT JOIN promotion_codes c
							ON c.project_id = o.project_id AND c.id = o.promotion_code_id
						WHERE o.provider = 'stripe'
							AND o.next_attempt_at <= now()
							AND (o.locked_at IS NULL OR o.locked_at < ${staleBefore.toISOString()})
							AND (
								o.status = 'pending'
								OR (
									o.status = 'ready'
									AND (o.retire_requested OR o.provider_active IS DISTINCT FROM o.desired_active)
								)
							)
							AND (
								o.object_kind = 'coupon'
								OR (
									o.object_kind = 'promotion_code'
									AND parent.status = 'ready'
									AND (c.starts_at IS NULL OR c.starts_at <= now())
								)
							)
						ORDER BY o.next_attempt_at, o.id
						LIMIT ${limit}
						FOR UPDATE OF o SKIP LOCKED
					)
					UPDATE promotion_provider_objects o
					SET locked_at = now(), locked_by = ${workerId}, attempts = o.attempts + 1, updated_at = now()
					FROM due
					WHERE o.project_id = due.project_id AND o.id = due.id
					RETURNING o.project_id, o.id
				`,
			);
			const jobs: PromotionStripeSyncJob[] = [];
			for (const row of claimed) {
				const job = await loadSyncJob(tx, row.project_id, row.id);
				if (job !== null) jobs.push(job);
			}
			return jobs;
		});
	}

	/**
	 * Brings the promotion's coupon up to date with the catalog and returns it, so a commercial
	 * action can create it inline when the worker has not run yet.
	 */
	async prepareStripeCoupon(
		project: ProjectInstanceContext,
		promotionId: string,
	): Promise<{
		objectId: string;
		status: string;
		externalId: string | null;
		error: string | null;
	}> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			await reconcileCouponInTx(tx, projectId, promotionId);
			const coupon = await executeOne<{
				id: string;
				status: string;
				external_id: string | null;
				error: string | null;
			}>(
				tx,
				drizzleSql`
					SELECT id, status, external_id, error
					FROM promotion_provider_objects
					WHERE project_id = ${projectId}
						AND promotion_id = ${promotionId}
						AND object_kind = 'coupon'
						AND status <> 'retired'
					ORDER BY created_at DESC, id DESC
					LIMIT 1
				`,
			);
			if (coupon === null) throw promotionError("PROMOTION_PROVIDER_NOT_READY");
			return {
				objectId: coupon.id,
				status: coupon.status,
				externalId: coupon.external_id,
				error: coupon.error,
			};
		});
	}

	/** Leases one pending object for an inline sync; null when another process holds it. */
	async claimStripeObject(
		project: ProjectInstanceContext,
		objectId: string,
		workerId: string,
	): Promise<PromotionStripeSyncJob | null> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
			const claimed = await executeOne<{ project_id: string; id: string }>(
				tx,
				drizzleSql`
					UPDATE promotion_provider_objects
					SET locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1, updated_at = now()
					WHERE project_id = ${projectId}
						AND id = ${objectId}
						AND provider = 'stripe'
						AND status = 'pending'
						AND (locked_at IS NULL OR locked_at < ${staleBefore}::timestamptz)
					RETURNING project_id, id
				`,
			);
			return claimed === null ? null : await loadSyncJob(tx, claimed.project_id, claimed.id);
		});
	}

	async markStripeObjectOutcome(
		projectId: string,
		objectId: string,
		workerId: string,
		outcome:
			| { kind: "ready"; externalId: string; providerActive: boolean }
			| { kind: "retired"; externalId: string | null }
			| { kind: "failed"; error: string; nextAttemptAt: Date | null }
			| { kind: "deferred"; error: string; nextAttemptAt: Date },
	): Promise<void> {
		const updated = await executeOne<{ id: string }>(
			this.database,
			outcome.kind === "ready"
				? drizzleSql`
					UPDATE promotion_provider_objects
					SET status = 'ready', external_id = COALESCE(external_id, ${outcome.externalId}),
						provider_active = ${outcome.providerActive}, ready_at = COALESCE(ready_at, now()),
						error = NULL, attempts = 0, next_attempt_at = now(), locked_at = NULL,
						locked_by = NULL, updated_at = now()
					WHERE project_id = ${projectId} AND id = ${objectId} AND locked_by = ${workerId}
					RETURNING id
				`
				: outcome.kind === "retired"
					? drizzleSql`
						UPDATE promotion_provider_objects
						SET status = 'retired', external_id = COALESCE(external_id, ${outcome.externalId}),
							provider_active = false, retired_at = now(), error = NULL, locked_at = NULL,
							locked_by = NULL, updated_at = now()
						WHERE project_id = ${projectId} AND id = ${objectId} AND locked_by = ${workerId}
						RETURNING id
					`
					: outcome.kind === "deferred"
						? drizzleSql`
							UPDATE promotion_provider_objects
							SET attempts = GREATEST(attempts - 1, 0), error = ${outcome.error.slice(0, 2000)},
								next_attempt_at = ${outcome.nextAttemptAt.toISOString()}, locked_at = NULL,
								locked_by = NULL, updated_at = now()
							WHERE project_id = ${projectId} AND id = ${objectId} AND locked_by = ${workerId}
							RETURNING id
						`
						: drizzleSql`
							UPDATE promotion_provider_objects
							SET status = CASE WHEN ${outcome.nextAttemptAt === null} THEN 'failed' ELSE status END,
								error = ${outcome.error.slice(0, 2000)},
								next_attempt_at = COALESCE(${outcome.nextAttemptAt?.toISOString() ?? null}::timestamptz, next_attempt_at),
								locked_at = NULL, locked_by = NULL, updated_at = now()
							WHERE project_id = ${projectId} AND id = ${objectId} AND locked_by = ${workerId}
							RETURNING id
						`,
		);
		if (updated === null) {
			throw new Error(`Promotion provider object ${objectId} was not owned by worker ${workerId}`);
		}
	}

	/** Puts failed objects of one promotion back in the queue for the worker. */
	async requestPromotionProviderSync(
		project: ProjectInstanceContext,
		promotionKey: string,
		actor: string,
	): Promise<number> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const promotion = await executeOne<{ id: string }>(
				tx,
				drizzleSql`SELECT id FROM promotions WHERE project_id = ${projectId} AND key = ${promotionKey}`,
			);
			if (promotion === null) throw promotionError("PROMOTION_NOT_FOUND");
			const reset = await executeRows<{ id: string }>(
				tx,
				drizzleSql`
					UPDATE promotion_provider_objects
					SET status = CASE WHEN external_id IS NULL THEN 'pending' ELSE 'ready' END,
						ready_at = CASE WHEN external_id IS NULL THEN NULL ELSE COALESCE(ready_at, now()) END,
						error = NULL, attempts = 0, next_attempt_at = now(), locked_at = NULL,
						locked_by = NULL, updated_at = now()
					WHERE project_id = ${projectId}
						AND promotion_id = ${promotion.id}
						AND status = 'failed'
					RETURNING id
				`,
			);
			await executeOne(
				tx,
				drizzleSql`
					INSERT INTO promotion_audit_events (project_id, promotion_id, action, actor, details)
					VALUES (${projectId}, ${promotion.id}, 'provider_sync_requested', ${actor},
						${jsonb({ reset: reset.length })})
					RETURNING id
				`,
			);
			return reset.length;
		});
	}
}

/**
 * Keeps each live Stripe promotion code's desired `active` flag equal to what Quotum would allow:
 * the code and promotion are active and the global cap is not reached.
 */
export async function refreshHostedCodeDesiredStateInTx(
	executor: QueryExecutor,
	projectId: string,
	scope: { promotionCodeId: string } | { promotionId: string },
): Promise<void> {
	const codeId = "promotionCodeId" in scope ? scope.promotionCodeId : null;
	const promotionId = "promotionId" in scope ? scope.promotionId : null;
	await executeRows(
		executor,
		drizzleSql`
			UPDATE promotion_provider_objects o
			SET desired_active = wanted.active,
				desired_generation = o.desired_generation + 1,
				updated_at = now()
			FROM (
				SELECT
					c.id AS code_id,
					c.active
						AND p.status = 'active'
						AND (c.max_redemptions IS NULL OR c.redeemed_count + c.reserved_count < c.max_redemptions)
						AS active
				FROM promotion_codes c
				JOIN promotions p ON p.project_id = c.project_id AND p.id = c.promotion_id
				WHERE c.project_id = ${projectId}
					AND c.hosted_checkout_enabled
					AND (c.id = ${codeId}::uuid OR c.promotion_id = ${promotionId}::uuid)
			) wanted
			WHERE o.project_id = ${projectId}
				AND o.promotion_code_id = wanted.code_id
				AND o.object_kind = 'promotion_code'
				AND o.status <> 'retired'
				AND NOT o.retire_requested
				AND o.desired_active IS DISTINCT FROM wanted.active
			RETURNING o.id
		`,
	);
}

async function reconcileCouponInTx(
	tx: QueryExecutor,
	projectId: string,
	promotionId: string,
): Promise<"created" | "current" | "skipped"> {
	const promotion = await executeOne<{
		status: string;
		published_catalog_revision_id: string | number | null;
	}>(
		tx,
		drizzleSql`
			SELECT p.status, project.published_catalog_revision_id
			FROM promotions p
			JOIN projects project ON project.id = p.project_id
			WHERE p.project_id = ${projectId} AND p.id = ${promotionId}
			FOR UPDATE OF p
		`,
	);
	if (promotion === null || promotion.status !== "active") return "skipped";
	const revisionId =
		promotion.published_catalog_revision_id === null
			? null
			: String(promotion.published_catalog_revision_id);
	const appliesTo = { products: await stripeProductsForPromotion(tx, projectId, promotionId) };
	const appliesToHash = sha256Hex(stableJson(appliesTo));
	const latest = await executeOne<{ id: string; applies_to_hash: string }>(
		tx,
		drizzleSql`
			SELECT id, applies_to_hash
			FROM promotion_provider_objects
			WHERE project_id = ${projectId}
				AND promotion_id = ${promotionId}
				AND object_kind = 'coupon'
				AND status <> 'retired'
			ORDER BY created_at DESC, id DESC
			LIMIT 1
		`,
	);
	if (latest !== null && latest.applies_to_hash === appliesToHash) {
		await executeOne(
			tx,
			drizzleSql`
				UPDATE promotion_provider_objects
				SET catalog_revision_id = ${revisionId}::bigint, updated_at = now()
				WHERE project_id = ${projectId} AND id = ${latest.id}
				RETURNING id
			`,
		);
		return "current";
	}
	await executeOne(
		tx,
		drizzleSql`
			INSERT INTO promotion_provider_objects (
				project_id, promotion_id, provider, object_kind, applies_to, applies_to_hash,
				catalog_revision_id
			)
			VALUES (
				${projectId}, ${promotionId}, 'stripe', 'coupon', ${jsonb(appliesTo)}, ${appliesToHash},
				${revisionId}::bigint
			)
			ON CONFLICT DO NOTHING
			RETURNING id
		`,
	);
	if (latest !== null) {
		// Hosted codes point at the superseded coupon; deactivate and retire them so a replacement
		// bound to the new coupon can take the same customer-facing code.
		await executeRows(
			tx,
			drizzleSql`
				UPDATE promotion_provider_objects
				SET retire_requested = true, desired_active = false,
					desired_generation = desired_generation + 1, updated_at = now()
				WHERE project_id = ${projectId}
					AND parent_object_id = ${latest.id}
					AND object_kind = 'promotion_code'
					AND status <> 'retired'
				RETURNING id
			`,
		);
		await executeRows(
			tx,
			drizzleSql`
				UPDATE promotion_provider_objects
				SET status = 'retired', retired_at = now(), updated_at = now()
				WHERE project_id = ${projectId}
					AND parent_object_id = ${latest.id}
					AND object_kind = 'promotion_code'
					AND status = 'pending'
					AND external_id IS NULL
				RETURNING id
			`,
		);
	}
	return "created";
}

/**
 * The Stripe products a discount applies to, or null for every product. Plan targets resolve through
 * the plan's active version bindings, so a new plan version can change the set.
 */
async function stripeProductsForPromotion(
	executor: QueryExecutor,
	projectId: string,
	promotionId: string,
): Promise<string[] | null> {
	const targets = await executeOne<{ count: number }>(
		executor,
		drizzleSql`
			SELECT count(*)::integer AS count
			FROM promotion_targets
			WHERE project_id = ${projectId} AND promotion_id = ${promotionId}
		`,
	);
	if ((targets?.count ?? 0) === 0) return null;
	const rows = await executeRows<{ external_product_id: string }>(
		executor,
		drizzleSql`
			SELECT DISTINCT sp.external_product_id
			FROM promotion_targets t
			JOIN plans plan ON plan.project_id = t.project_id AND plan.id = t.plan_id
			JOIN price_components pc
				ON pc.project_id = plan.project_id
				AND pc.plan_version_id = plan.active_version_id
				AND pc.component_kind <> 'metered_overage'
			JOIN provider_price_bindings binding
				ON binding.project_id = pc.project_id
				AND binding.price_component_id = pc.id
				AND binding.provider = 'stripe'
				AND binding.channel = 'web'
				AND binding.status = 'published'
			JOIN store_products sp ON sp.project_id = binding.project_id AND sp.id = binding.store_product_id
			WHERE t.project_id = ${projectId} AND t.promotion_id = ${promotionId}
			UNION
			SELECT DISTINCT sp.external_product_id
			FROM promotion_targets t
			JOIN plans plan ON plan.project_id = t.project_id AND plan.id = t.plan_id
			JOIN provider_plan_bindings binding
				ON binding.project_id = plan.project_id
				AND binding.plan_version_id = plan.active_version_id
				AND binding.provider = 'stripe'
				AND binding.channel = 'web'
			JOIN store_products sp ON sp.project_id = binding.project_id AND sp.id = binding.store_product_id
			WHERE t.project_id = ${projectId} AND t.promotion_id = ${promotionId}
			UNION
			SELECT DISTINCT sp.external_product_id
			FROM promotion_targets t
			JOIN store_products sp
				ON sp.project_id = t.project_id
				AND sp.product_id = t.product_id
				AND sp.provider = 'stripe'
				AND sp.channel = 'web'
				AND sp.active
			WHERE t.project_id = ${projectId} AND t.promotion_id = ${promotionId}
		`,
	);
	return rows.map((row) => row.external_product_id).sort();
}

async function loadSyncJob(
	tx: QueryExecutor,
	projectId: string,
	objectId: string,
): Promise<PromotionStripeSyncJob | null> {
	const detail = await executeOne<ClaimedObjectRow>(
		tx,
		drizzleSql`
			SELECT
				o.project_id, project.key AS project_key, o.id, o.provider, o.object_kind, o.status,
				o.external_id, o.desired_active, o.desired_generation, o.provider_active,
				o.retire_requested, o.attempts, o.applies_to,
				p.key AS promotion_key, p.name AS promotion_name, p.discount_type,
				p.percent_off_bps, p.discount_duration, p.duration_months,
				COALESCE((
					SELECT jsonb_agg(
						jsonb_build_object('currency', a.currency, 'amountOffMinor', a.amount_off_minor)
						ORDER BY a.currency
					)
					FROM promotion_discount_amounts a
					WHERE a.project_id = p.project_id AND a.promotion_id = p.id
				), '[]'::jsonb) AS amounts,
				c.code, c.expires_at, c.max_redemptions, c.first_purchase_only,
				parent.external_id AS coupon_external_id
			FROM promotion_provider_objects o
			JOIN projects project ON project.id = o.project_id
			JOIN promotions p ON p.project_id = o.project_id AND p.id = o.promotion_id
			LEFT JOIN promotion_codes c
				ON c.project_id = o.project_id AND c.id = o.promotion_code_id
			LEFT JOIN promotion_provider_objects parent
				ON parent.project_id = o.project_id AND parent.id = o.parent_object_id
			WHERE o.project_id = ${projectId} AND o.id = ${objectId}
		`,
	);
	return detail === null ? null : toSyncJob(detail);
}

function toSyncJob(row: ClaimedObjectRow): PromotionStripeSyncJob {
	const base = {
		projectId: row.project_id,
		projectKey: row.project_key,
		provider: row.provider,
		objectId: row.id,
		promotionKey: row.promotion_key,
		promotionName: row.promotion_name,
		status: row.status,
		externalId: row.external_id,
		desiredActive: row.desired_active,
		desiredGeneration: row.desired_generation,
		providerActive: row.provider_active,
		retireRequested: row.retire_requested,
		attempts: row.attempts,
	};
	if (row.object_kind === "coupon") {
		const duration = row.discount_duration ?? "once";
		const discount: PromotionDiscount =
			row.discount_type === "percent"
				? {
						type: "percent",
						percentOffBps: row.percent_off_bps ?? 0,
						duration,
						durationMonths: row.duration_months,
					}
				: {
						type: "amount",
						amounts: row.amounts.map((amount) => ({
							currency: amount.currency,
							amountOffMinor: Number(amount.amountOffMinor),
						})),
						duration,
						durationMonths: row.duration_months,
					};
		return {
			...base,
			objectKind: "coupon",
			discount,
			appliesToProducts: row.applies_to.products ?? null,
		};
	}
	return {
		...base,
		objectKind: "promotion_code",
		code: row.code ?? "",
		couponExternalId: row.coupon_external_id ?? "",
		expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
		maxRedemptions: row.max_redemptions,
		firstPurchaseOnly: row.first_purchase_only === true,
	};
}
