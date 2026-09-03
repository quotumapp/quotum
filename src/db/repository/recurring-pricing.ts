import { sql as drizzleSql } from "drizzle-orm";
import { sha256Hex, stableJson } from "../../billing/decimal";
import {
	InvalidRequestError,
	NotFoundBillingError,
	PersistenceConflictError,
} from "../../billing/errors";
import {
	calculateTieredUsageCharge,
	calculateUsageCharge,
	classifySubscriptionChange,
	defaultChangeTiming,
	stripeProrationForChange,
} from "../../billing/pricing";
import type {
	SubscriptionChangeInput,
	SubscriptionChangeOperation,
	SubscriptionChangePreview,
	UsageInvoiceJob,
} from "../../billing/recurring";
import type { ProjectContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import { resolveProjectId } from "./identities";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";

interface ChangeContextRow {
	project_key: string;
	project_id: string;
	customer_id: string;
	subscription_id: string;
	external_subscription_id: string;
	from_plan_version_id: string | number | bigint;
	from_tier_rank: number;
	to_plan_version_id: string | number | bigint;
	to_tier_rank: number;
	current_period_end: Date | string | null;
	upgrade_proration_behavior: "always_invoice" | "create_prorations" | "none";
	downgrade_proration_behavior: "always_invoice" | "create_prorations" | "none";
	subscription_status: string;
	subscription_updated_at: Date | string;
}

interface ChangePriceRow {
	price_key: string;
	component_kind: "base" | "licensed";
	feature_key: string | null;
	external_price_id: string;
	minimum_quantity: number;
	maximum_quantity: number | null;
	unit_amount_minor: string | number;
	currency: string;
	billing_interval: "month" | "year";
	pricing_model: "flat" | "graduated" | "volume";
}

interface ResolvedSubscriptionChange {
	context: ChangeContextRow;
	quantities: Record<string, number>;
	changeKind: "upgrade" | "downgrade" | "quantity";
	effectiveMode: "immediate" | "period_end";
	effectiveAt: Date;
	prorationBehavior: "always_invoice" | "create_prorations" | "none";
	stateFingerprint: string;
	prices: ChangePriceRow[];
}

interface ChangeRow {
	id: string;
	project_key: string;
	status: "pending" | "processing" | "applied" | "failed" | "cancelled";
	change_kind: "upgrade" | "downgrade" | "quantity";
	effective_mode: "immediate" | "period_end";
	effective_at: Date | string;
	proration_behavior: "always_invoice" | "create_prorations" | "none";
	external_subscription_id: string;
	to_plan_version_id: string | number | bigint;
	requested_quantities: Record<string, number>;
}

export class RecurringPricingRepository extends RepositoryModule {
	async previewSubscriptionChange(
		project: ProjectContext,
		input: Omit<SubscriptionChangeInput, "idempotencyKey" | "expectedStateFingerprint">,
	): Promise<SubscriptionChangePreview> {
		return await this.transaction(async (tx) => {
			const projectId = await resolveProjectId(tx, project);
			const resolved = await resolveSubscriptionChange(tx, projectId, input);
			return subscriptionChangePreview(resolved);
		});
	}

	async prepareSubscriptionChange(
		project: ProjectContext,
		input: SubscriptionChangeInput,
	): Promise<SubscriptionChangeOperation> {
		return await this.transaction(async (tx) => {
			const projectId = await resolveProjectId(tx, project);
			const resolved = await resolveSubscriptionChange(tx, projectId, input);
			const { context, quantities, changeKind, effectiveMode, effectiveAt, prorationBehavior } =
				resolved;
			if (
				input.expectedStateFingerprint !== undefined &&
				input.expectedStateFingerprint !== resolved.stateFingerprint
			) {
				throw new PersistenceConflictError(
					"Customer or catalog state changed after preview",
					"COMMERCIAL_PREVIEW_STALE",
				);
			}
			const requestHash = sha256Hex(
				stableJson({
					billingAccountId: input.billingAccountId,
					externalSubscriptionId: input.externalSubscriptionId,
					targetPlanKey: input.targetPlanKey,
					quantities,
					effectiveMode,
					prorationBehavior,
				}),
			);
			const existing = await executeOne<{ id: string; request_hash: string }>(
				tx,
				drizzleSql`
					SELECT id, request_hash
					FROM subscription_changes
					WHERE project_id = ${projectId}
						AND customer_id = ${context.customer_id}
						AND idempotency_key = ${input.idempotencyKey}
				`,
			);
			if (existing !== null) {
				if (existing.request_hash !== requestHash) {
					throw new PersistenceConflictError(
						"Idempotency key was reused with a different subscription change",
						"IDEMPOTENCY_CONFLICT",
					);
				}
				return await buildChangeOperation(tx, existing.id, false);
			}
			const pending = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					SELECT id
					FROM subscription_changes
					WHERE project_id = ${projectId}
						AND subscription_id = ${context.subscription_id}
						AND status IN ('pending', 'processing')
					LIMIT 1
				`,
			);
			if (pending !== null) {
				throw new PersistenceConflictError(
					"Another subscription change is already pending",
					"SUBSCRIPTION_CHANGE_PENDING",
				);
			}
			await executeRows(
				tx,
				drizzleSql`
					INSERT INTO subscription_changes (
						project_id, customer_id, subscription_id, from_plan_version_id,
						to_plan_version_id, requested_quantities, change_kind, effective_mode,
						effective_at, proration_behavior, idempotency_key, request_hash
					)
					VALUES (
						${projectId}, ${context.customer_id}, ${context.subscription_id},
						${String(context.from_plan_version_id)}::bigint,
						${String(context.to_plan_version_id)}::bigint, ${jsonb(quantities)},
						${changeKind}, ${effectiveMode}, ${effectiveAt.toISOString()},
						${prorationBehavior}, ${input.idempotencyKey}, ${requestHash}
					)
					ON CONFLICT (project_id, customer_id, idempotency_key) DO NOTHING
				`,
			);
			const row = await executeOne<{ id: string; request_hash: string }>(
				tx,
				drizzleSql`
					SELECT id, request_hash
					FROM subscription_changes
					WHERE project_id = ${projectId}
						AND customer_id = ${context.customer_id}
						AND idempotency_key = ${input.idempotencyKey}
				`,
			);
			if (row === null || row.request_hash !== requestHash) {
				throw new PersistenceConflictError(
					"Idempotency key was reused with a different subscription change",
					"IDEMPOTENCY_CONFLICT",
				);
			}
			return await buildChangeOperation(tx, row.id, false);
		});
	}

	async claimSubscriptionChanges(
		workerId: string,
		limit: number,
	): Promise<SubscriptionChangeOperation[]> {
		return await this.transaction(async (tx) => {
			await stageCatalogMigrationChanges(tx, workerId, limit);
			const rows = await executeRows<{ id: string }>(
				tx,
				drizzleSql`
					WITH due AS (
						SELECT id
						FROM subscription_changes
						WHERE (status = 'pending' AND effective_at <= now())
							OR (status = 'processing' AND locked_at < now() - interval '5 minutes')
						ORDER BY effective_at, created_at
						LIMIT ${limit}
						FOR UPDATE SKIP LOCKED
					)
					UPDATE subscription_changes changes
					SET status = 'processing', locked_at = now(), locked_by = ${workerId},
						attempts = attempts + 1, updated_at = now()
					FROM due
					WHERE changes.id = due.id
					RETURNING changes.id
				`,
			);
			const operations: SubscriptionChangeOperation[] = [];
			for (const row of rows) operations.push(await buildChangeOperation(tx, row.id, true));
			return operations;
		});
	}

	async markSubscriptionChangeApplied(
		project: ProjectContext,
		changeId: string,
		providerRequestId: string,
	): Promise<void> {
		await this.transaction(async (tx) => {
			const projectId = await resolveProjectId(tx, project);
			const row = await executeOne(
				tx,
				drizzleSql`
					UPDATE subscription_changes changes
					SET status = 'applied', provider_request_id = ${providerRequestId}, applied_at = now(),
						last_error = NULL, locked_at = NULL, locked_by = NULL, updated_at = now()
					FROM subscriptions subscriptions
					WHERE changes.project_id = ${projectId} AND changes.id = ${changeId}
						AND changes.subscription_id = subscriptions.id
						AND changes.status = 'processing'
					RETURNING changes.id
				`,
			);
			if (row === null) throw new Error(`Subscription change ${changeId} was not processing`);
			await executeRows(
				tx,
				drizzleSql`
					UPDATE catalog_migration_jobs
					SET status = 'applied', applied_at = now(), last_error = NULL,
						locked_at = NULL, locked_by = NULL, updated_at = now()
					WHERE project_id = ${projectId}
						AND subscription_change_id = ${changeId}
						AND status = 'waiting_provider'
				`,
			);
		});
	}

	async markSubscriptionChangeFailed(changeId: string, error: string): Promise<void> {
		await this.transaction(async (tx) => {
			const row = await executeOne<{ status: "pending" | "failed" }>(
				tx,
				drizzleSql`
					UPDATE subscription_changes
					SET status = CASE WHEN attempts >= 8 THEN 'failed' ELSE 'pending' END,
						last_error = CASE WHEN attempts >= 8 THEN ${error} ELSE NULL END,
						locked_at = NULL, locked_by = NULL, updated_at = now()
					WHERE id = ${changeId} AND status = 'processing'
					RETURNING status
				`,
			);
			if (row?.status === "failed") {
				await executeRows(
					tx,
					drizzleSql`
						UPDATE catalog_migration_jobs
						SET status = 'failed', last_error = ${error}, locked_at = NULL,
							locked_by = NULL, updated_at = now()
						WHERE subscription_change_id = ${changeId}
							AND status = 'waiting_provider'
					`,
				);
			}
		});
	}

	async materializeAndClaimUsageInvoicePeriods(
		workerId: string,
		limit: number,
	): Promise<{ materialized: number; jobs: UsageInvoiceJob[] }> {
		return await this.transaction(async (tx) => {
			const candidates = await executeRows<{
				project_id: string;
				customer_id: string;
				subscription_id: string;
				plan_item_id: string | number | bigint;
				price_component_id: string | number | bigint;
				period_start_at: Date | string;
				period_end_at: Date | string;
				usage_quantity: unknown;
				included_quantity: unknown;
				billing_units: unknown;
				unit_amount_minor: string | number;
				currency: string;
				pricing_model: "flat" | "graduated" | "volume";
			}>(
				tx,
				drizzleSql`
					SELECT
						uw.project_id, uw.customer_id, uw.subscription_id, uw.anchor_plan_item_id AS plan_item_id,
						pc.id AS price_component_id, uw.window_start_at AS period_start_at,
						uw.window_end_at AS period_end_at, sum(uw.usage)::text AS usage_quantity,
						pi.quantity::text AS included_quantity, pc.billing_units::text AS billing_units,
						pc.unit_amount_minor, pc.currency, pc.pricing_model
					FROM usage_windows uw
					JOIN plan_items pi
						ON pi.project_id = uw.project_id AND pi.id = uw.anchor_plan_item_id
					JOIN price_components pc
						ON pc.project_id = pi.project_id AND pc.plan_item_id = pi.id
						AND pc.component_kind = 'metered_overage'
					WHERE uw.window_end_at <= now()
						AND uw.subscription_id IS NOT NULL
						AND pi.overage_policy = 'allowed'
						AND NOT EXISTS (
							SELECT 1 FROM usage_invoice_periods period
							WHERE period.project_id = uw.project_id
								AND period.subscription_id = uw.subscription_id
								AND period.plan_item_id = uw.anchor_plan_item_id
								AND period.period_start_at = uw.window_start_at
								AND period.period_end_at = uw.window_end_at
						)
					GROUP BY uw.project_id, uw.customer_id, uw.subscription_id, uw.anchor_plan_item_id,
						pc.id, uw.window_start_at, uw.window_end_at, pi.quantity, pc.billing_units,
						pc.unit_amount_minor, pc.currency, pc.pricing_model
					ORDER BY uw.window_end_at
					LIMIT ${limit}
				`,
			);
			let materialized = 0;
			for (const candidate of candidates) {
				const commonCharge = {
					usageQuantity: String(candidate.usage_quantity),
					includedQuantity: String(candidate.included_quantity),
					billingUnits: String(candidate.billing_units),
				};
				const charge =
					candidate.pricing_model === "flat"
						? calculateUsageCharge({
								...commonCharge,
								unitAmountMinor: BigInt(candidate.unit_amount_minor),
							})
						: calculateTieredUsageCharge({
								...commonCharge,
								pricingModel: candidate.pricing_model,
								tiers: await readPriceTiers(
									tx,
									candidate.project_id,
									String(candidate.price_component_id),
								),
							});
				const inserted = await executeOne(
					tx,
					drizzleSql`
						INSERT INTO usage_invoice_periods (
							project_id, customer_id, subscription_id, plan_item_id, price_component_id,
							period_start_at, period_end_at, usage_quantity, included_quantity,
							billable_quantity, billing_units, unit_amount_minor, amount_minor, currency,
							status, invoiced_at
						)
						VALUES (
							${candidate.project_id}, ${candidate.customer_id}, ${candidate.subscription_id},
							${String(candidate.plan_item_id)}::bigint, ${String(candidate.price_component_id)}::bigint,
							${new Date(candidate.period_start_at).toISOString()},
							${new Date(candidate.period_end_at).toISOString()}, ${charge.usageQuantity}::numeric,
							${charge.includedQuantity}::numeric, ${charge.billableQuantity}::numeric,
							${String(candidate.billing_units)}::numeric, ${candidate.unit_amount_minor},
							${charge.amountMinor.toString()}, ${candidate.currency},
							${charge.amountMinor === 0n ? "credited" : "pending"},
							${charge.amountMinor === 0n ? new Date().toISOString() : null}
						)
						ON CONFLICT (project_id, subscription_id, plan_item_id, period_start_at, period_end_at)
						DO NOTHING
						RETURNING id
					`,
				);
				if (inserted !== null) materialized += 1;
			}
			const claimed = await executeRows<{ id: string }>(
				tx,
				drizzleSql`
					WITH due AS (
						SELECT id FROM usage_invoice_periods
						WHERE status = 'pending'
							OR (status = 'processing' AND locked_at < now() - interval '5 minutes')
						ORDER BY period_end_at, created_at
						LIMIT ${limit}
						FOR UPDATE SKIP LOCKED
					)
					UPDATE usage_invoice_periods periods
					SET status = 'processing', locked_at = now(), locked_by = ${workerId},
						attempts = attempts + 1, updated_at = now()
					FROM due WHERE periods.id = due.id
					RETURNING periods.id
				`,
			);
			const jobs: UsageInvoiceJob[] = [];
			for (const row of claimed) jobs.push(await usageInvoicePeriodJob(tx, row.id));
			const adjustmentClaims = await executeRows<{ id: string | number | bigint }>(
				tx,
				drizzleSql`
					WITH due AS (
						SELECT adjustment.id
						FROM usage_invoice_adjustments adjustment
						JOIN usage_invoice_periods period
							ON period.project_id = adjustment.project_id
							AND period.id = adjustment.closed_period_id
						WHERE (
							adjustment.status = 'pending'
							OR (
								adjustment.status = 'processing'
								AND adjustment.locked_at < now() - interval '5 minutes'
							)
						)
							AND period.status IN ('invoiced', 'credited')
						ORDER BY adjustment.created_at, adjustment.id
						LIMIT ${limit}
						FOR UPDATE OF adjustment SKIP LOCKED
					)
					UPDATE usage_invoice_adjustments adjustment
					SET status = 'processing', locked_at = now(), locked_by = ${workerId},
						attempts = attempts + 1, updated_at = now()
					FROM due WHERE adjustment.id = due.id
					RETURNING adjustment.id
				`,
			);
			for (const row of adjustmentClaims) {
				jobs.push(await usageInvoiceAdjustmentJob(tx, String(row.id)));
			}
			return { materialized, jobs };
		});
	}

	async markUsageInvoiceSucceeded(
		jobKind: UsageInvoiceJob["jobKind"],
		jobId: string,
		externalInvoiceId: string,
	): Promise<void> {
		const row = await executeOne(
			this.database,
			jobKind === "period"
				? drizzleSql`
					UPDATE usage_invoice_periods
					SET status = 'invoiced', external_invoice_id = ${externalInvoiceId}, invoiced_at = now(),
						last_error = NULL, locked_at = NULL, locked_by = NULL, updated_at = now()
					WHERE id = ${jobId}::uuid AND status = 'processing'
					RETURNING id
				`
				: drizzleSql`
					UPDATE usage_invoice_adjustments
					SET status = 'invoiced', external_invoice_id = ${externalInvoiceId}, invoiced_at = now(),
						last_error = NULL, locked_at = NULL, locked_by = NULL, updated_at = now()
					WHERE id = ${jobId}::bigint AND status = 'processing'
					RETURNING id
				`,
		);
		if (row === null) throw new Error(`Usage invoice ${jobKind} ${jobId} was not processing`);
	}

	async markUsageInvoiceFailed(
		jobKind: UsageInvoiceJob["jobKind"],
		jobId: string,
		error: string,
	): Promise<void> {
		await executeRows(
			this.database,
			jobKind === "period"
				? drizzleSql`
					UPDATE usage_invoice_periods
					SET status = CASE WHEN attempts >= 8 THEN 'failed' ELSE 'pending' END,
						last_error = CASE WHEN attempts >= 8 THEN ${error} ELSE NULL END,
						locked_at = NULL, locked_by = NULL, updated_at = now()
					WHERE id = ${jobId}::uuid AND status = 'processing'
				`
				: drizzleSql`
					UPDATE usage_invoice_adjustments
					SET status = CASE WHEN attempts >= 8 THEN 'failed' ELSE 'pending' END,
						last_error = CASE WHEN attempts >= 8 THEN ${error} ELSE NULL END,
						locked_at = NULL, locked_by = NULL, updated_at = now()
					WHERE id = ${jobId}::bigint AND status = 'processing'
				`,
		);
	}
}

interface CatalogMigrationJobContext {
	id: string | number | bigint;
	project_id: string;
	customer_id: string;
	subscription_id: string;
	provider: "apple" | "google" | "stripe";
	subscription_status: string;
	current_plan_version_id: string | number | bigint;
	from_plan_version_id: string | number | bigint;
	to_plan_version_id: string | number | bigint;
	from_tier_rank: number;
	to_tier_rank: number;
	current_period_end: Date | string | null;
	effective_mode: "immediate" | "period_end";
	upgrade_proration_behavior: "always_invoice" | "create_prorations" | "none";
	downgrade_proration_behavior: "always_invoice" | "create_prorations" | "none";
}

async function stageCatalogMigrationChanges(
	executor: QueryExecutor,
	workerId: string,
	limit: number,
): Promise<void> {
	const claimed = await executeRows<{ id: string | number | bigint }>(
		executor,
		drizzleSql`
			WITH due AS (
				SELECT job.id
				FROM catalog_migration_jobs job
				JOIN subscriptions subscription
					ON subscription.project_id = job.project_id
					AND subscription.id = job.subscription_id
				WHERE (
					job.status = 'pending'
					AND job.next_attempt_at <= now()
					AND (
						job.effective_mode = 'immediate'
						OR subscription.current_period_end IS NULL
						OR subscription.current_period_end <= now()
					)
				) OR (
					job.status = 'processing'
					AND job.locked_at < now() - interval '5 minutes'
				)
				ORDER BY job.subscription_id, job.created_at, job.id
				LIMIT ${limit}
				FOR UPDATE OF job SKIP LOCKED
			)
			UPDATE catalog_migration_jobs job
			SET status = 'processing', attempts = attempts + 1, locked_at = now(),
				locked_by = ${workerId}, last_error = NULL, updated_at = now()
			FROM due
			WHERE job.id = due.id
			RETURNING job.id
		`,
	);

	for (const claimedJob of claimed) {
		const job = await executeOne<CatalogMigrationJobContext>(
			executor,
			drizzleSql`
				SELECT job.id, job.project_id, subscription.customer_id, job.subscription_id,
					subscription.provider, subscription.status AS subscription_status,
					subscription.plan_version_id AS current_plan_version_id,
					draft.from_plan_version_id, draft.to_plan_version_id,
					current_version.tier_rank AS from_tier_rank,
					target_version.tier_rank AS to_tier_rank,
					subscription.current_period_end, job.effective_mode,
					target_version.upgrade_proration_behavior,
					target_version.downgrade_proration_behavior
				FROM catalog_migration_jobs job
				JOIN catalog_migration_drafts draft
					ON draft.project_id = job.project_id AND draft.id = job.draft_id
				JOIN subscriptions subscription
					ON subscription.project_id = job.project_id AND subscription.id = job.subscription_id
				JOIN plan_versions current_version
					ON current_version.project_id = subscription.project_id
					AND current_version.id = subscription.plan_version_id
				JOIN plan_versions target_version
					ON target_version.project_id = draft.project_id
					AND target_version.id = draft.to_plan_version_id
				WHERE job.id = ${String(claimedJob.id)}::bigint
					AND job.status = 'processing' AND job.locked_by = ${workerId}
				FOR UPDATE OF subscription
			`,
		);
		if (job === null) continue;
		const jobId = String(job.id);
		const currentPlanVersionId = String(job.current_plan_version_id);
		const fromPlanVersionId = String(job.from_plan_version_id);
		const toPlanVersionId = String(job.to_plan_version_id);
		if (currentPlanVersionId === toPlanVersionId) {
			await finishCatalogMigrationJob(executor, jobId, workerId, "applied", null);
			continue;
		}
		if (currentPlanVersionId !== fromPlanVersionId) {
			await finishCatalogMigrationJob(
				executor,
				jobId,
				workerId,
				"skipped",
				"Subscription no longer uses the previewed source plan version",
			);
			continue;
		}
		if (job.effective_mode === "period_end" && job.current_period_end === null) {
			await finishCatalogMigrationJob(
				executor,
				jobId,
				workerId,
				"failed",
				"Period-end migration requires a current subscription period end",
			);
			continue;
		}
		if (job.provider !== "stripe") {
			await finishCatalogMigrationJob(
				executor,
				jobId,
				workerId,
				"skipped",
				`Provider action required: ${job.provider} subscriptions cannot be silently migrated`,
			);
			continue;
		}
		if (
			!["active", "grace_period", "billing_retry", "cancelled"].includes(job.subscription_status)
		) {
			await finishCatalogMigrationJob(
				executor,
				jobId,
				workerId,
				"skipped",
				`Subscription status ${job.subscription_status} is not migratable`,
			);
			continue;
		}

		const recurring = await executeOne<{ total: string; published: string }>(
			executor,
			drizzleSql`
				SELECT count(*)::text AS total, count(binding.id)::text AS published
				FROM price_components price
				LEFT JOIN provider_price_bindings binding
					ON binding.project_id = price.project_id
					AND binding.price_component_id = price.id
					AND binding.provider = 'stripe' AND binding.channel = 'web'
					AND binding.status = 'published'
				WHERE price.project_id = ${job.project_id}
					AND price.plan_version_id = ${toPlanVersionId}::bigint
					AND price.component_kind IN ('base', 'licensed')
			`,
		);
		if (
			recurring === null ||
			Number(recurring.total) === 0 ||
			Number(recurring.published) !== Number(recurring.total)
		) {
			await finishCatalogMigrationJob(
				executor,
				jobId,
				workerId,
				"failed",
				"Target plan does not have a complete published Stripe recurring-price mapping",
			);
			continue;
		}

		const currentQuantities = await executeRows<{ feature_key: string; quantity: number }>(
			executor,
			drizzleSql`
				SELECT feature.key AS feature_key, item.quantity
				FROM subscription_items item
				JOIN price_components price
					ON price.project_id = item.project_id AND price.id = item.price_component_id
				JOIN plan_items plan_item
					ON plan_item.project_id = price.project_id AND plan_item.id = price.plan_item_id
				JOIN features feature
					ON feature.project_id = plan_item.project_id AND feature.id = plan_item.feature_id
				WHERE item.project_id = ${job.project_id}
					AND item.subscription_id = ${job.subscription_id}
					AND item.active = true AND price.component_kind = 'licensed'
			`,
		);
		const currentByFeature = new Map(
			currentQuantities.map((quantity) => [quantity.feature_key, quantity.quantity]),
		);
		const targetLicensed = await executeRows<{
			feature_key: string;
			minimum_quantity: number;
			maximum_quantity: number | null;
		}>(
			executor,
			drizzleSql`
				SELECT feature.key AS feature_key, price.minimum_quantity, price.maximum_quantity
				FROM price_components price
				JOIN plan_items plan_item
					ON plan_item.project_id = price.project_id AND plan_item.id = price.plan_item_id
				JOIN features feature
					ON feature.project_id = plan_item.project_id AND feature.id = plan_item.feature_id
				WHERE price.project_id = ${job.project_id}
					AND price.plan_version_id = ${toPlanVersionId}::bigint
					AND price.component_kind = 'licensed'
				ORDER BY feature.key
			`,
		);
		const quantities: Record<string, number> = {};
		let invalidQuantity: string | null = null;
		for (const target of targetLicensed) {
			const quantity = currentByFeature.get(target.feature_key) ?? target.minimum_quantity;
			if (
				!Number.isSafeInteger(quantity) ||
				quantity < target.minimum_quantity ||
				(target.maximum_quantity !== null && quantity > target.maximum_quantity)
			) {
				invalidQuantity = target.feature_key;
				break;
			}
			quantities[target.feature_key] = quantity;
		}
		if (invalidQuantity !== null) {
			await finishCatalogMigrationJob(
				executor,
				jobId,
				workerId,
				"failed",
				`Current quantity is outside the target range for ${invalidQuantity}`,
			);
			continue;
		}

		const changeKind = classifySubscriptionChange({
			fromPlanVersionId,
			toPlanVersionId,
			fromTierRank: job.from_tier_rank,
			toTierRank: job.to_tier_rank,
			quantitiesChanged: true,
		});
		const prorationBehavior =
			job.effective_mode === "period_end"
				? "none"
				: stripeProrationForChange({
						kind: changeKind,
						upgrade: job.upgrade_proration_behavior,
						downgrade: job.downgrade_proration_behavior,
					});
		const idempotencyKey = `catalog-migration:${jobId}`;
		const requestHash = sha256Hex(
			stableJson({
				catalogMigrationJobId: jobId,
				fromPlanVersionId,
				toPlanVersionId,
				quantities,
				effectiveMode: job.effective_mode,
				prorationBehavior,
			}),
		);
		await executeRows(
			executor,
			drizzleSql`
				INSERT INTO subscription_changes (
					project_id, customer_id, subscription_id, from_plan_version_id,
					to_plan_version_id, requested_quantities, change_kind, effective_mode,
					effective_at, proration_behavior, idempotency_key, request_hash
				) VALUES (
					${job.project_id}, ${job.customer_id}, ${job.subscription_id},
					${fromPlanVersionId}::bigint, ${toPlanVersionId}::bigint, ${jsonb(quantities)},
					${changeKind}, ${job.effective_mode}, now(), ${prorationBehavior},
					${idempotencyKey}, ${requestHash}
				)
				ON CONFLICT DO NOTHING
			`,
		);
		const change = await executeOne<{
			id: string;
			status: "pending" | "processing" | "applied" | "failed" | "cancelled";
			request_hash: string;
			last_error: string | null;
		}>(
			executor,
			drizzleSql`
				SELECT id, status, request_hash, last_error
				FROM subscription_changes
				WHERE project_id = ${job.project_id} AND customer_id = ${job.customer_id}
					AND idempotency_key = ${idempotencyKey}
			`,
		);
		if (change === null) {
			await executeRows(
				executor,
				drizzleSql`
					UPDATE catalog_migration_jobs
					SET status = 'pending', next_attempt_at = now() + interval '1 minute',
						locked_at = NULL, locked_by = NULL,
						last_error = 'Another subscription change is pending', updated_at = now()
					WHERE id = ${jobId}::bigint AND status = 'processing' AND locked_by = ${workerId}
				`,
			);
			continue;
		}
		if (change.request_hash !== requestHash) {
			await finishCatalogMigrationJob(
				executor,
				jobId,
				workerId,
				"failed",
				"Catalog migration idempotency identity has conflicting intent",
			);
			continue;
		}
		if (change.status === "applied") {
			await finishCatalogMigrationJob(executor, jobId, workerId, "applied", null);
			continue;
		}
		if (change.status === "failed" || change.status === "cancelled") {
			await finishCatalogMigrationJob(
				executor,
				jobId,
				workerId,
				"failed",
				change.last_error ?? `Subscription change is ${change.status}`,
			);
			continue;
		}
		await executeRows(
			executor,
			drizzleSql`
				UPDATE catalog_migration_jobs
				SET status = 'waiting_provider', subscription_change_id = ${change.id},
					last_error = NULL, locked_at = NULL, locked_by = NULL, updated_at = now()
				WHERE id = ${jobId}::bigint AND status = 'processing' AND locked_by = ${workerId}
			`,
		);
	}
}

async function finishCatalogMigrationJob(
	executor: QueryExecutor,
	jobId: string,
	workerId: string,
	status: "applied" | "failed" | "skipped",
	error: string | null,
): Promise<void> {
	await executeRows(
		executor,
		drizzleSql`
			UPDATE catalog_migration_jobs
			SET status = ${status}, applied_at = ${status === "applied" ? new Date().toISOString() : null},
				last_error = ${error}, locked_at = NULL, locked_by = NULL, updated_at = now()
			WHERE id = ${jobId}::bigint AND status = 'processing' AND locked_by = ${workerId}
		`,
	);
}

async function changeContext(
	executor: QueryExecutor,
	projectId: string,
	input: SubscriptionChangeInput,
): Promise<ChangeContextRow> {
	const row = await executeOne<ChangeContextRow>(
		executor,
		drizzleSql`
			SELECT
				project.key AS project_key, project.id AS project_id, customer.id AS customer_id,
				subscription.id AS subscription_id,
				subscription.external_subscription_id,
				current_version.id AS from_plan_version_id,
				current_version.tier_rank AS from_tier_rank,
				target_version.id AS to_plan_version_id,
				target_version.tier_rank AS to_tier_rank,
				subscription.current_period_end,
				subscription.status AS subscription_status,
				subscription.updated_at AS subscription_updated_at,
				target_version.upgrade_proration_behavior,
				target_version.downgrade_proration_behavior
			FROM projects project
			JOIN customers customer ON customer.project_id = project.id
			JOIN subscriptions subscription
				ON subscription.project_id = customer.project_id AND subscription.customer_id = customer.id
			JOIN plan_versions current_version
				ON current_version.project_id = subscription.project_id
				AND current_version.id = subscription.plan_version_id
			JOIN plans target ON target.project_id = project.id AND target.key = ${input.targetPlanKey}
			JOIN plan_versions target_version
				ON target_version.project_id = target.project_id
				AND target_version.id = target.active_version_id
			WHERE project.id = ${projectId}
				AND customer.billing_account_id = ${input.billingAccountId}
				AND subscription.external_subscription_id = ${input.externalSubscriptionId}
				AND subscription.provider = 'stripe'
				AND subscription.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
				AND (
					subscription.status <> 'cancelled'
					OR COALESCE(subscription.expires_at, subscription.current_period_end) > now()
				)
				AND target.active = true AND target_version.status = 'published'
				AND current_version.plan_kind = target_version.plan_kind
			LIMIT 1
			FOR UPDATE OF subscription
		`,
	);
	if (row === null) {
		throw new NotFoundBillingError(
			"Stripe subscription or target plan was not found",
			"SUBSCRIPTION_CHANGE_TARGET_NOT_FOUND",
		);
	}
	return row;
}

async function resolveSubscriptionChange(
	executor: QueryExecutor,
	projectId: string,
	input: Omit<SubscriptionChangeInput, "idempotencyKey" | "expectedStateFingerprint">,
): Promise<ResolvedSubscriptionChange> {
	const context = await changeContext(executor, projectId, input as SubscriptionChangeInput);
	const quantities = normalizeQuantities(input.quantities);
	const currentQuantities = await currentLicensedQuantities(executor, context.subscription_id);
	const changeKind = classifySubscriptionChange({
		fromPlanVersionId: String(context.from_plan_version_id),
		toPlanVersionId: String(context.to_plan_version_id),
		fromTierRank: context.from_tier_rank,
		toTierRank: context.to_tier_rank,
		quantitiesChanged: stableJson(currentQuantities) !== stableJson(quantities),
	});
	const effectiveMode = input.effectiveMode ?? defaultChangeTiming(changeKind);
	const effectiveAt =
		effectiveMode === "immediate"
			? new Date()
			: context.current_period_end === null
				? null
				: new Date(context.current_period_end);
	if (effectiveAt === null) {
		throw new PersistenceConflictError(
			"Period-end changes require a current subscription period end",
			"SUBSCRIPTION_PERIOD_MISSING",
		);
	}
	const prorationBehavior =
		input.prorationBehavior ??
		stripeProrationForChange({
			kind: changeKind,
			upgrade: context.upgrade_proration_behavior,
			downgrade: context.downgrade_proration_behavior,
		});
	const prices = await changePrices(executor, context.to_plan_version_id, quantities);
	const stateFingerprint = sha256Hex(
		stableJson({
			subscriptionId: context.subscription_id,
			subscriptionStatus: context.subscription_status,
			subscriptionUpdatedAt: new Date(context.subscription_updated_at).toISOString(),
			currentPeriodEnd:
				context.current_period_end === null
					? null
					: new Date(context.current_period_end).toISOString(),
			fromPlanVersionId: String(context.from_plan_version_id),
			toPlanVersionId: String(context.to_plan_version_id),
			currentQuantities,
			prices,
		}),
	);
	return {
		context,
		quantities,
		changeKind,
		effectiveMode,
		effectiveAt,
		prorationBehavior,
		stateFingerprint,
		prices,
	};
}

function normalizeQuantities(value: Record<string, number>): Record<string, number> {
	const normalized: Record<string, number> = {};
	for (const [key, quantity] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
		if (key.trim() === "" || !Number.isSafeInteger(quantity) || quantity < 1) {
			throw new InvalidRequestError("Licensed quantities must be positive integers");
		}
		normalized[key.trim()] = quantity;
	}
	return normalized;
}

async function currentLicensedQuantities(
	executor: QueryExecutor,
	subscriptionId: string,
): Promise<Record<string, number>> {
	const rows = await executeRows<{ feature_key: string; quantity: number }>(
		executor,
		drizzleSql`
			SELECT feature.key AS feature_key, item.quantity
			FROM subscription_items item
			JOIN price_components price ON price.project_id = item.project_id AND price.id = item.price_component_id
			JOIN plan_items plan_item ON plan_item.project_id = price.project_id AND plan_item.id = price.plan_item_id
			JOIN features feature ON feature.project_id = plan_item.project_id AND feature.id = plan_item.feature_id
			WHERE item.subscription_id = ${subscriptionId} AND item.active = true
				AND price.component_kind = 'licensed'
		`,
	);
	return Object.fromEntries(rows.map((row) => [row.feature_key, row.quantity]));
}

async function changePrices(
	executor: QueryExecutor,
	toPlanVersionId: string | number | bigint,
	quantities: Record<string, number>,
): Promise<ChangePriceRow[]> {
	const rows = await executeRows<ChangePriceRow>(
		executor,
		drizzleSql`
			SELECT price.key AS price_key, price.component_kind, feature.key AS feature_key,
				store.external_price_id, price.minimum_quantity, price.maximum_quantity,
				price.unit_amount_minor, price.currency, price.billing_interval, price.pricing_model
			FROM price_components price
			JOIN provider_price_bindings binding
				ON binding.project_id = price.project_id AND binding.price_component_id = price.id
				AND binding.provider = 'stripe' AND binding.channel = 'web'
				AND binding.status = 'published'
			JOIN store_products store
				ON store.project_id = binding.project_id AND store.id = binding.store_product_id
			LEFT JOIN plan_items plan_item
				ON plan_item.project_id = price.project_id AND plan_item.id = price.plan_item_id
			LEFT JOIN features feature
				ON feature.project_id = plan_item.project_id AND feature.id = plan_item.feature_id
			WHERE price.plan_version_id = ${String(toPlanVersionId)}::bigint
				AND price.component_kind IN ('base', 'licensed')
			ORDER BY CASE price.component_kind WHEN 'base' THEN 0 ELSE 1 END, price.id
		`,
	);
	if (rows.length === 0) throw new Error("Target plan has no Stripe recurring prices");
	for (const row of rows) {
		const quantity = row.component_kind === "base" ? 1 : quantities[row.feature_key ?? ""];
		if (
			quantity === undefined ||
			quantity < row.minimum_quantity ||
			(row.maximum_quantity !== null && quantity > row.maximum_quantity)
		) {
			throw new InvalidRequestError(
				`Explicit licensed quantity is missing or outside range for ${row.feature_key ?? "base"}`,
			);
		}
	}
	return rows;
}

function subscriptionChangePreview(
	resolved: ResolvedSubscriptionChange,
): SubscriptionChangePreview {
	return {
		stateFingerprint: resolved.stateFingerprint,
		changeKind: resolved.changeKind,
		effectiveMode: resolved.effectiveMode,
		effectiveAt: resolved.effectiveAt.toISOString(),
		prorationBehavior: resolved.prorationBehavior,
		fromPlanVersionId: String(resolved.context.from_plan_version_id),
		toPlanVersionId: String(resolved.context.to_plan_version_id),
		lineItems: resolved.prices.map((price) => ({
			key: price.price_key,
			label: price.feature_key ?? "Base plan",
			quantity:
				price.component_kind === "base" ? 1 : (resolved.quantities[price.feature_key ?? ""] ?? 0),
			unitAmountMinor: Number(price.unit_amount_minor),
			currency: price.currency,
			interval: price.billing_interval,
			pricingModel: price.pricing_model,
		})),
	};
}

async function buildChangeOperation(
	executor: QueryExecutor,
	changeId: string,
	requireProcessing: boolean,
): Promise<SubscriptionChangeOperation> {
	const change = await executeOne<ChangeRow>(
		executor,
		drizzleSql`
			SELECT
				changes.id, project.key AS project_key, changes.status, changes.change_kind,
				changes.effective_mode, changes.effective_at, changes.proration_behavior,
				subscription.external_subscription_id, changes.to_plan_version_id,
				changes.requested_quantities
			FROM subscription_changes changes
			JOIN projects project ON project.id = changes.project_id
			JOIN subscriptions subscription
				ON subscription.project_id = changes.project_id AND subscription.id = changes.subscription_id
			WHERE changes.id = ${changeId}
				${requireProcessing ? drizzleSql`AND changes.status = 'processing'` : drizzleSql``}
		`,
	);
	if (change === null) throw new Error(`Subscription change ${changeId} was not found`);
	const current = await executeRows<{
		provider_subscription_item_id: string;
		component_kind: "base" | "licensed";
		feature_key: string | null;
	}>(
		executor,
		drizzleSql`
			SELECT item.provider_subscription_item_id, price.component_kind, feature.key AS feature_key
			FROM subscription_changes changes
			JOIN subscription_items item
				ON item.project_id = changes.project_id AND item.subscription_id = changes.subscription_id
			JOIN price_components price ON price.project_id = item.project_id AND price.id = item.price_component_id
			LEFT JOIN plan_items plan_item ON plan_item.project_id = price.project_id AND plan_item.id = price.plan_item_id
			LEFT JOIN features feature ON feature.project_id = plan_item.project_id AND feature.id = plan_item.feature_id
			WHERE changes.id = ${changeId} AND item.active = true
				AND item.provider_subscription_item_id IS NOT NULL
				AND price.component_kind IN ('base', 'licensed')
		`,
	);
	const target = await executeRows<{
		external_price_id: string;
		component_kind: "base" | "licensed";
		feature_key: string | null;
		minimum_quantity: number;
		maximum_quantity: number | null;
	}>(
		executor,
		drizzleSql`
			SELECT sp.external_price_id, price.component_kind, feature.key AS feature_key,
				price.minimum_quantity, price.maximum_quantity
			FROM price_components price
			JOIN provider_price_bindings binding
				ON binding.project_id = price.project_id AND binding.price_component_id = price.id
				AND binding.provider = 'stripe' AND binding.channel = 'web' AND binding.status = 'published'
			JOIN store_products sp ON sp.project_id = binding.project_id AND sp.id = binding.store_product_id
			LEFT JOIN plan_items plan_item ON plan_item.project_id = price.project_id AND plan_item.id = price.plan_item_id
			LEFT JOIN features feature ON feature.project_id = plan_item.project_id AND feature.id = plan_item.feature_id
			WHERE price.plan_version_id = ${String(change.to_plan_version_id)}::bigint
				AND price.component_kind IN ('base', 'licensed')
			ORDER BY CASE price.component_kind WHEN 'base' THEN 0 ELSE 1 END, price.id
		`,
	);
	if (target.length === 0) throw new Error("Target plan has no Stripe recurring prices");
	const usedProviderItems = new Set<string>();
	const items: SubscriptionChangeOperation["items"] = target.map((targetItem) => {
		const slot = current.find(
			(item) =>
				item.component_kind === targetItem.component_kind &&
				item.feature_key === targetItem.feature_key,
		);
		if (slot !== undefined) usedProviderItems.add(slot.provider_subscription_item_id);
		const quantity =
			targetItem.component_kind === "base"
				? 1
				: targetItem.feature_key === null
					? undefined
					: change.requested_quantities[targetItem.feature_key];
		if (
			quantity === undefined ||
			quantity < targetItem.minimum_quantity ||
			(targetItem.maximum_quantity !== null && quantity > targetItem.maximum_quantity)
		) {
			throw new InvalidRequestError(
				`Explicit licensed quantity is missing or outside range for ${targetItem.feature_key ?? "base"}`,
			);
		}
		return {
			providerSubscriptionItemId: slot?.provider_subscription_item_id,
			externalPriceId: targetItem.external_price_id,
			quantity,
		};
	});
	for (const item of current) {
		if (!usedProviderItems.has(item.provider_subscription_item_id)) {
			items.push({ providerSubscriptionItemId: item.provider_subscription_item_id, deleted: true });
		}
	}
	return {
		changeId: change.id,
		projectKey: change.project_key,
		status: change.status,
		changeKind: change.change_kind,
		effectiveMode: change.effective_mode,
		effectiveAt: new Date(change.effective_at).toISOString(),
		prorationBehavior: change.proration_behavior,
		externalSubscriptionId: change.external_subscription_id,
		targetPlanVersionId: String(change.to_plan_version_id),
		items,
	};
}

async function usageInvoicePeriodJob(
	executor: QueryExecutor,
	periodId: string,
): Promise<UsageInvoiceJob> {
	const row = await executeOne<{
		period_id: string;
		project_key: string;
		billing_account_id: string;
		external_customer_id: string;
		external_subscription_id: string;
		external_product_id: string;
		feature_key: string;
		period_start_at: Date | string;
		period_end_at: Date | string;
		usage_quantity: unknown;
		included_quantity: unknown;
		billable_quantity: unknown;
		amount_minor: number | string;
		currency: string;
	}>(
		executor,
		drizzleSql`
			SELECT
				period.id AS period_id, project.key AS project_key,
				customer.billing_account_id, provider_customer.external_customer_id,
				subscription.external_subscription_id, store.external_product_id,
				feature.key AS feature_key, period.period_start_at, period.period_end_at,
				period.usage_quantity, period.included_quantity, period.billable_quantity,
				period.amount_minor, period.currency
			FROM usage_invoice_periods period
			JOIN projects project ON project.id = period.project_id
			JOIN customers customer ON customer.project_id = period.project_id AND customer.id = period.customer_id
			JOIN provider_customers provider_customer
				ON provider_customer.project_id = customer.project_id
				AND provider_customer.customer_id = customer.id AND provider_customer.provider = 'stripe'
			JOIN subscriptions subscription
				ON subscription.project_id = period.project_id AND subscription.id = period.subscription_id
			JOIN plan_items plan_item ON plan_item.project_id = period.project_id AND plan_item.id = period.plan_item_id
			JOIN features feature ON feature.project_id = plan_item.project_id AND feature.id = plan_item.feature_id
			JOIN provider_price_bindings binding
				ON binding.project_id = period.project_id AND binding.price_component_id = period.price_component_id
				AND binding.provider = 'stripe' AND binding.channel = 'web' AND binding.status = 'published'
			JOIN store_products store ON store.project_id = binding.project_id AND store.id = binding.store_product_id
			WHERE period.id = ${periodId} AND period.status = 'processing'
			LIMIT 1
		`,
	);
	if (row === null) throw new Error(`Usage invoice period ${periodId} cannot be invoiced`);
	const amountMinor = Number(row.amount_minor);
	if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
		throw new Error(`Usage invoice period ${periodId} has an invalid amount`);
	}
	return {
		jobKind: "period",
		jobId: row.period_id,
		periodId: row.period_id,
		adjustmentId: null,
		projectKey: row.project_key,
		billingAccountId: row.billing_account_id,
		externalCustomerId: row.external_customer_id,
		externalSubscriptionId: row.external_subscription_id,
		externalProductId: row.external_product_id,
		featureKey: row.feature_key,
		periodStartAt: new Date(row.period_start_at).toISOString(),
		periodEndAt: new Date(row.period_end_at).toISOString(),
		usageQuantity: String(row.usage_quantity),
		adjustmentQuantity: null,
		includedQuantity: String(row.included_quantity),
		billableQuantity: String(row.billable_quantity),
		amountMinor,
		currency: row.currency.toLowerCase(),
	};
}

async function readPriceTiers(
	executor: QueryExecutor,
	projectId: string,
	priceComponentId: string,
): Promise<
	Array<{ upToQuantity: string | null; unitAmountMinor: bigint; flatAmountMinor: bigint }>
> {
	const rows = await executeRows<{
		up_to_quantity: unknown;
		unit_amount_minor: string | number;
		flat_amount_minor: string | number;
	}>(
		executor,
		drizzleSql`
			SELECT up_to_quantity::text AS up_to_quantity, unit_amount_minor, flat_amount_minor
			FROM price_tiers
			WHERE project_id = ${projectId} AND price_component_id = ${priceComponentId}::bigint
			ORDER BY ordinal
		`,
	);
	return rows.map((row) => ({
		upToQuantity: row.up_to_quantity === null ? null : String(row.up_to_quantity),
		unitAmountMinor: BigInt(row.unit_amount_minor),
		flatAmountMinor: BigInt(row.flat_amount_minor),
	}));
}

async function usageInvoiceAdjustmentJob(
	executor: QueryExecutor,
	adjustmentId: string,
): Promise<UsageInvoiceJob> {
	const row = await executeOne<{
		job_id: string | number | bigint;
		period_id: string;
		project_key: string;
		billing_account_id: string;
		external_customer_id: string;
		external_subscription_id: string;
		external_product_id: string;
		feature_key: string;
		period_start_at: Date | string;
		period_end_at: Date | string;
		usage_quantity: unknown;
		adjustment_quantity: unknown;
		included_quantity: unknown;
		billable_quantity: unknown;
		amount_minor: number | string;
		currency: string;
	}>(
		executor,
		drizzleSql`
			SELECT
				adjustment.id AS job_id, period.id AS period_id, project.key AS project_key,
				customer.billing_account_id, provider_customer.external_customer_id,
				subscription.external_subscription_id, store.external_product_id,
				feature.key AS feature_key, period.period_start_at, period.period_end_at,
				period.usage_quantity, adjustment.quantity AS adjustment_quantity,
				period.included_quantity, period.billable_quantity,
				adjustment.amount_minor, adjustment.currency
			FROM usage_invoice_adjustments adjustment
			JOIN usage_invoice_periods period
				ON period.project_id = adjustment.project_id AND period.id = adjustment.closed_period_id
			JOIN projects project ON project.id = adjustment.project_id
			JOIN customers customer
				ON customer.project_id = adjustment.project_id AND customer.id = period.customer_id
			JOIN provider_customers provider_customer
				ON provider_customer.project_id = customer.project_id
				AND provider_customer.customer_id = customer.id AND provider_customer.provider = 'stripe'
			JOIN subscriptions subscription
				ON subscription.project_id = period.project_id AND subscription.id = period.subscription_id
			JOIN plan_items plan_item
				ON plan_item.project_id = period.project_id AND plan_item.id = period.plan_item_id
			JOIN features feature
				ON feature.project_id = plan_item.project_id AND feature.id = plan_item.feature_id
			JOIN provider_price_bindings binding
				ON binding.project_id = period.project_id AND binding.price_component_id = period.price_component_id
				AND binding.provider = 'stripe' AND binding.channel = 'web' AND binding.status = 'published'
			JOIN store_products store
				ON store.project_id = binding.project_id AND store.id = binding.store_product_id
			WHERE adjustment.id = ${adjustmentId}::bigint AND adjustment.status = 'processing'
			LIMIT 1
		`,
	);
	if (row === null) throw new Error(`Usage invoice adjustment ${adjustmentId} cannot be invoiced`);
	const amountMinor = Number(row.amount_minor);
	if (!Number.isSafeInteger(amountMinor) || amountMinor >= 0) {
		throw new Error(`Usage invoice adjustment ${adjustmentId} has an invalid amount`);
	}
	return {
		jobKind: "adjustment",
		jobId: String(row.job_id),
		periodId: row.period_id,
		adjustmentId: String(row.job_id),
		projectKey: row.project_key,
		billingAccountId: row.billing_account_id,
		externalCustomerId: row.external_customer_id,
		externalSubscriptionId: row.external_subscription_id,
		externalProductId: row.external_product_id,
		featureKey: row.feature_key,
		periodStartAt: new Date(row.period_start_at).toISOString(),
		periodEndAt: new Date(row.period_end_at).toISOString(),
		usageQuantity: String(row.usage_quantity),
		adjustmentQuantity: String(row.adjustment_quantity),
		includedQuantity: String(row.included_quantity),
		billableQuantity: String(row.billable_quantity),
		amountMinor,
		currency: row.currency.toLowerCase(),
	};
}
