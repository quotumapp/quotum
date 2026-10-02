import { sql as drizzleSql } from "drizzle-orm";
import type { SubscriptionStatus } from "../../billing/types";
import { lifetimeItemSql, resetSplitsBillingPeriodSql } from "./cadence-sql";
import { carryOverAllowances } from "./carry-over";
import { keepNonConsumableLevels } from "./kept-levels";
import { supersedeBasePlanGrants } from "./plan-grants";
import { executeOne, executeRows, jsonb } from "./query";
import { cancelSupersededSubscriptionChanges } from "./recurring-pricing";
import { materializeSubscriptionResetAllocations } from "./subscription-allocation-periods";
import type { QueryExecutor } from "./types";

const allocationFundingStatuses = new Set<SubscriptionStatus>([
	"active",
	"grace_period",
	"billing_retry",
	"cancelled",
]);

/**
 * What the provider's snapshot says about the product the subscription is on, for providers whose
 * snapshot decides the plan version (Stripe). Other providers omit it and keep the rule that only
 * a product of another plan moves a subscription.
 */
export interface ProviderSnapshotContext {
	/** The store product the subscription held before this sync; null when it had none. */
	previousStoreProductId: string | null;
	/** When the provider created the snapshot; null for a snapshot read live from the provider. */
	createdAt: Date | null;
	/**
	 * The subscription change whose provider update last wrote the snapshot's metadata: null when
	 * the metadata names none, omitted when the snapshot carries no metadata to read.
	 */
	billingChangeId?: string | null;
}

/**
 * Resolves the plan version a synced subscription carries. Publishing a newer version of the same
 * plan retargets the provider binding, but that must not move existing subscriptions: they stay
 * grandfathered on their pinned version until an explicit subscription change or catalog migration
 * has been applied, or the provider reports a product that belongs to another version.
 *
 * The provider's snapshot wins. An applied change moves the version only when the snapshot shows
 * its target. A snapshot taken after the change reached the provider that shows anything else
 * settles it without effect; one taken before leaves it waiting for its own event
 * (`snapshotPredatesChange`).
 */
async function resolveSubscriptionPlanVersion(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		storeProductId: string;
		subscriptionId: string;
		snapshot?: ProviderSnapshotContext;
	},
): Promise<{
	planVersionId: string;
	catalogRevisionId: string;
	changed: boolean;
	changeId: string | null;
	/** The version the subscription held before this sync; null when it had none. */
	previousPlanVersionId: string | null;
	/** What the applied immediate change moving the version carries over; null otherwise. */
	carryOver: { balances: string[]; usages: string[] } | null;
	/** Whether the provider moved the subscription to another version without a local change. */
	providerSwitch: boolean;
} | null> {
	const row = await executeOne<{
		current_version_id: string | number | bigint | null;
		current_revision_id: string | number | bigint | null;
		current_plan_id: string | number | bigint | null;
		binding_version_id: string | number | bigint | null;
		binding_revision_id: string | number | bigint | null;
		binding_plan_id: string | number | bigint | null;
		change_id: string | null;
		change_synchronized_at: Date | string | null;
		change_version_id: string | number | bigint | null;
		change_revision_id: string | number | bigint | null;
		change_effective_mode: "immediate" | "period_end" | null;
		change_carry_over: { balances?: string[]; usages?: string[] } | null;
		change_applied_at: Date | string | null;
		change_target_shown: boolean;
		current_priced: boolean;
		current_shown: boolean;
		pending_change_id: string | null;
		pending_version_id: string | number | bigint | null;
		pending_revision_id: string | number | bigint | null;
		pending_effective_mode: "immediate" | "period_end" | null;
		pending_carry_over: { balances?: string[]; usages?: string[] } | null;
	}>(
		executor,
		drizzleSql`
			SELECT
				subscription.plan_version_id AS current_version_id,
				current_version.catalog_revision_id AS current_revision_id,
				current_version.plan_id AS current_plan_id,
				binding_version.id AS binding_version_id,
				binding_version.catalog_revision_id AS binding_revision_id,
				binding_version.plan_id AS binding_plan_id,
				applied_change.id AS change_id,
				applied_change.synchronized_at AS change_synchronized_at,
				change_version.id AS change_version_id,
				change_version.catalog_revision_id AS change_revision_id,
				applied_change.effective_mode AS change_effective_mode,
				applied_change.carry_over AS change_carry_over,
				applied_change.applied_at AS change_applied_at,
				-- Whether the snapshot's product is the applied change's target: the provider product
				-- is bound to it, or one of its prices is.
				(
					binding_version.id = change_version.id
					OR EXISTS (
						SELECT 1
						FROM price_components price
						JOIN provider_price_bindings price_binding
							ON price_binding.project_id = price.project_id
							AND price_binding.price_component_id = price.id
							AND price_binding.status = 'published'
						WHERE price.project_id = subscription.project_id
							AND price.plan_version_id = change_version.id
							AND price_binding.store_product_id = ${input.storeProductId}
					)
				) IS TRUE AS change_target_shown,
				-- Whether the pinned version sells through this provider's prices, and whether the
				-- snapshot's product is one of them.
				EXISTS (
					SELECT 1
					FROM price_components price
					JOIN provider_price_bindings price_binding
						ON price_binding.project_id = price.project_id
						AND price_binding.price_component_id = price.id
						AND price_binding.status = 'published'
					JOIN store_products snapshot_product
						ON snapshot_product.project_id = price_binding.project_id
						AND snapshot_product.id = ${input.storeProductId}
					WHERE price.project_id = subscription.project_id
						AND price.plan_version_id = subscription.plan_version_id
						AND price_binding.provider = snapshot_product.provider
						AND price_binding.channel = snapshot_product.channel
				) AS current_priced,
				EXISTS (
					SELECT 1
					FROM price_components price
					JOIN provider_price_bindings price_binding
						ON price_binding.project_id = price.project_id
						AND price_binding.price_component_id = price.id
						AND price_binding.status = 'published'
					WHERE price.project_id = subscription.project_id
						AND price.plan_version_id = subscription.plan_version_id
						AND price_binding.store_product_id = ${input.storeProductId}
				) AS current_shown,
				pending_change.id AS pending_change_id,
				pending_version.id AS pending_version_id,
				pending_version.catalog_revision_id AS pending_revision_id,
				pending_change.effective_mode AS pending_effective_mode,
				pending_change.carry_over AS pending_carry_over
			FROM subscriptions subscription
			LEFT JOIN plan_versions current_version
				ON current_version.project_id = subscription.project_id
				AND current_version.id = subscription.plan_version_id
			LEFT JOIN provider_plan_bindings binding
				ON binding.project_id = subscription.project_id
				AND binding.store_product_id = ${input.storeProductId}
				AND binding.status = 'published'
			LEFT JOIN plan_versions binding_version
				ON binding_version.project_id = binding.project_id
				AND binding_version.id = binding.plan_version_id
				AND binding_version.status = 'published'
			LEFT JOIN LATERAL (
				SELECT change.id, change.from_plan_version_id, change.to_plan_version_id,
					change.synchronized_at, change.effective_mode, change.carry_over, change.applied_at
				FROM subscription_changes change
				WHERE change.project_id = subscription.project_id
					AND change.subscription_id = subscription.id
					AND change.status = 'applied'
				ORDER BY change.applied_at DESC, change.id DESC
				LIMIT 1
			) applied_change ON subscription.plan_version_id IS NOT NULL
			LEFT JOIN plan_versions change_version
				ON change_version.project_id = subscription.project_id
				AND change_version.id = applied_change.to_plan_version_id
				AND applied_change.synchronized_at IS NULL
				AND applied_change.from_plan_version_id = subscription.plan_version_id
				AND applied_change.to_plan_version_id <> subscription.plan_version_id
				AND change_version.status = 'published'
			-- A change the provider already reports: its target is the version the snapshot's product
			-- is bound to, while the change is still pending or its worker has not recorded it.
			LEFT JOIN LATERAL (
				SELECT change.id, change.to_plan_version_id, change.effective_mode, change.carry_over
				FROM subscription_changes change
				WHERE change.project_id = subscription.project_id
					AND change.subscription_id = subscription.id
					AND change.status IN ('pending', 'processing')
					AND change.synchronized_at IS NULL
					AND change.from_plan_version_id = subscription.plan_version_id
					AND change.to_plan_version_id = binding_version.id
				ORDER BY change.created_at DESC, change.id DESC
				LIMIT 1
			) pending_change ON binding_version.id <> subscription.plan_version_id
			LEFT JOIN plan_versions pending_version
				ON pending_version.project_id = subscription.project_id
				AND pending_version.id = pending_change.to_plan_version_id
			WHERE subscription.project_id = ${input.projectId}
				AND subscription.customer_id = ${input.customerId}
				AND subscription.id = ${input.subscriptionId}
		`,
	);
	if (row === null) return null;
	let changeId = row.change_synchronized_at === null ? row.change_id : null;
	const current =
		row.current_version_id === null || row.current_revision_id === null
			? null
			: {
					planVersionId: String(row.current_version_id),
					catalogRevisionId: String(row.current_revision_id),
				};
	const binding =
		row.binding_version_id === null || row.binding_revision_id === null
			? null
			: {
					planVersionId: String(row.binding_version_id),
					catalogRevisionId: String(row.binding_revision_id),
				};
	// 1. A subscription without a version adopts what the purchased product is bound to.
	if (current === null) {
		return binding === null
			? null
			: {
					...binding,
					changed: true,
					changeId,
					previousPlanVersionId: null,
					carryOver: null,
					providerSwitch: false,
				};
	}
	const previousPlanVersionId = current.planVersionId;
	// 2. Only the latest applied change can move the pinned version. Filtering by its source
	// before selecting the latest would replay an old upgrade after a later downgrade returns
	// to that source, including when a newer quantity-only change supersedes the upgrade.
	if (row.change_version_id !== null && row.change_revision_id !== null) {
		if (row.change_target_shown || input.snapshot === undefined) {
			return {
				planVersionId: String(row.change_version_id),
				catalogRevisionId: String(row.change_revision_id),
				changed: true,
				changeId,
				previousPlanVersionId,
				carryOver:
					changeId !== null && row.change_effective_mode === "immediate"
						? appliedCarryOver(row.change_carry_over)
						: null,
				providerSwitch: false,
			};
		}
		// The snapshot shows something other than the change's target. One taken before the change
		// reached the provider leaves it waiting for its own event; a later one contradicts it, so
		// the change settles without effect (and without its carry-over) and the snapshot decides
		// the version below.
		if (
			row.change_id !== null &&
			snapshotPredatesChange(input.snapshot, {
				id: String(row.change_id),
				appliedAt: row.change_applied_at,
			})
		)
			changeId = null;
	}
	// 3. The provider reports the target of a change not yet recorded as applied: its worker updated
	// the provider and has not written it down, or the provider moved first. The change applies now,
	// with its carry-over. Once the subscription holds the target, neither this step nor step 2
	// matches the change again, so recording it as applied later only marks it synchronized.
	if (
		row.pending_change_id !== null &&
		row.pending_version_id !== null &&
		row.pending_revision_id !== null
	) {
		return {
			planVersionId: String(row.pending_version_id),
			catalogRevisionId: String(row.pending_revision_id),
			changed: true,
			changeId: row.pending_change_id,
			previousPlanVersionId,
			carryOver:
				row.pending_effective_mode === "immediate"
					? appliedCarryOver(row.pending_carry_over)
					: null,
			providerSwitch: false,
		};
	}
	// 4. A provider-side switch applies the version the reported product is bound to: a product of
	// another plan, or, where the provider's snapshot decides, a product the pinned version does
	// not sell. A retargeted binding alone keeps the subscription on its pinned version: its own
	// price is still one of that version's, or, for a version without prices, it has not changed.
	if (
		binding !== null &&
		binding.planVersionId !== current.planVersionId &&
		(String(row.binding_plan_id) !== String(row.current_plan_id) ||
			(input.snapshot !== undefined &&
				(row.current_priced
					? !row.current_shown
					: input.snapshot.previousStoreProductId !== null &&
						input.snapshot.previousStoreProductId !== input.storeProductId)))
	) {
		return {
			...binding,
			changed: true,
			changeId,
			previousPlanVersionId,
			carryOver: null,
			providerSwitch: true,
		};
	}
	// 5. Otherwise the subscription stays grandfathered on its pinned version.
	return {
		...current,
		changed: false,
		changeId,
		previousPlanVersionId,
		carryOver: null,
		providerSwitch: false,
	};
}

/**
 * Whether a snapshot that does not show an applied change's target was taken before the change
 * reached the provider. The change's own provider update stamps its id in the subscription's
 * metadata (`billingChangeId`), and the provider keeps it on every later copy, portal updates and
 * deletions included. So a snapshot naming the change was taken after it; one naming another
 * change or none was taken before, or is a stale read. Only a snapshot without metadata falls back
 * to the clocks (`snapshotPredates`), which compare the provider's timestamp with the database's.
 */
export function snapshotPredatesChange(
	snapshot: ProviderSnapshotContext,
	change: { id: string; appliedAt: Date | string | null },
): boolean {
	if (snapshot.billingChangeId !== undefined) return snapshot.billingChangeId !== change.id;
	return snapshotPredates(snapshot.createdAt, change.appliedAt);
}

/**
 * Whether the provider created a snapshot before a change was recorded as applied. Stripe stamps
 * events in whole seconds, so a snapshot from the second the change was applied also counts as
 * earlier: waiting for the next event is safe, while settling the change early loses it.
 */
export function snapshotPredates(createdAt: Date | null, appliedAt: Date | string | null): boolean {
	if (createdAt === null || appliedAt === null) return false;
	return createdAt.getTime() < new Date(appliedAt).getTime();
}

function appliedCarryOver(
	stored: { balances?: string[]; usages?: string[] } | null,
): { balances: string[]; usages: string[] } | null {
	const balances = stored?.balances ?? [];
	const usages = stored?.usages ?? [];
	return balances.length === 0 && usages.length === 0 ? null : { balances, usages };
}

export async function materializeSubscriptionAllocations(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		storeProductId: string;
		subscriptionId: string;
		status: SubscriptionStatus;
		periodStartAt: Date;
		periodEndAt: Date | null;
		snapshot?: ProviderSnapshotContext;
	},
): Promise<number> {
	const version = await resolveSubscriptionPlanVersion(executor, input);
	if (version === null) return 0;

	if (version.providerSwitch) {
		// A change queued from the version the provider moved away from can no longer apply.
		await cancelSupersededSubscriptionChanges(executor, {
			projectId: input.projectId,
			subscriptionId: input.subscriptionId,
			planVersionId: version.planVersionId,
			reason: "The subscription moved to another plan version at the provider",
		});
	}

	if (version.changeId !== null) {
		// The provider snapshot has settled the latest applied change, even if another provider
		// switch already superseded its source. Record that once, atomically with allocations and
		// price items, so returning to the source later cannot replay this historical change.
		await executeRows(
			executor,
			drizzleSql`
				UPDATE subscription_changes SET synchronized_at = now(), updated_at = now()
				WHERE project_id = ${input.projectId} AND subscription_id = ${input.subscriptionId}
					AND id = ${version.changeId} AND status = 'applied' AND synchronized_at IS NULL
			`,
		);
	}

	if (version.changed) {
		await executeOne(
			executor,
			drizzleSql`
				UPDATE subscriptions
				SET
					plan_version_id = ${version.planVersionId}::bigint,
					catalog_revision_id = ${version.catalogRevisionId}::bigint,
					updated_at = now()
				WHERE project_id = ${input.projectId}
					AND customer_id = ${input.customerId}
					AND id = ${input.subscriptionId}
				RETURNING id
			`,
		);
	}
	const outgoingPlanVersionId =
		version.changed &&
		version.previousPlanVersionId !== null &&
		version.previousPlanVersionId !== version.planVersionId
			? version.previousPlanVersionId
			: null;

	if (!allocationFundingStatuses.has(input.status)) {
		if (input.status === "refunded" || input.status === "revoked") {
			await executeRows(
				executor,
				drizzleSql`
					UPDATE balance_allocations
					SET reversed_at = COALESCE(reversed_at, now()), updated_at = now()
					WHERE project_id = ${input.projectId}
						AND subscription_id = ${input.subscriptionId}
				`,
			);
		}
		if (outgoingPlanVersionId !== null) {
			await endOutgoingPlanAllowances(
				executor,
				input.projectId,
				input.subscriptionId,
				outgoingPlanVersionId,
			);
		}
		return 0;
	}
	// A paid base plan replaces the account's trial or other base plan grant from now on.
	await supersedeBasePlanGrants(executor, {
		projectId: input.projectId,
		customerId: input.customerId,
		subscriptionId: input.subscriptionId,
		planVersionId: version.planVersionId,
	});
	const invalidEntityScope = await executeOne<{ invalid: boolean }>(
		executor,
		drizzleSql`
			SELECT EXISTS (
				SELECT 1
				FROM subscriptions subscription
				JOIN plan_items item
					ON item.project_id = subscription.project_id
					AND item.plan_version_id = subscription.plan_version_id
				WHERE subscription.project_id = ${input.projectId}
					AND subscription.id = ${input.subscriptionId}
					AND item.item_kind = 'allocation'
					AND item.allocation_scope = 'entity'
					AND subscription.entity_id IS NULL
			) AS invalid
		`,
	);
	if (invalidEntityScope?.invalid === true) {
		throw new Error("Entity-scoped plan allocations require an entity-scoped subscription");
	}
	if (outgoingPlanVersionId !== null) {
		// A non-consumable level moves to the incoming version before its allowances are granted.
		await keepNonConsumableLevels(executor, {
			projectId: input.projectId,
			subscriptionId: input.subscriptionId,
			outgoingPlanVersionId,
			incomingPlanVersionId: version.planVersionId,
			periodStartAt: input.periodStartAt,
			periodEndAt: input.periodEndAt,
		});
	}

	const inserted = await executeRows<{ id: string | number | bigint }>(
		executor,
		drizzleSql`
			INSERT INTO balance_allocations (
				project_id,
				customer_id,
				entity_id,
				feature_id,
				plan_item_id,
				subscription_id,
				source_kind,
				source_key,
				quantity,
				period_start_at,
				period_end_at,
				expires_at
			)
			SELECT
				${input.projectId},
				${input.customerId},
				CASE WHEN pi.allocation_scope = 'entity' THEN subscription.entity_id ELSE NULL END,
				pi.feature_id,
				pi.id,
				${input.subscriptionId},
				'subscription',
				-- An item without a reset or an expiry grants a lifetime allowance, once per
				-- subscription: renewals find its key taken. Every other item grants per period.
				CASE
					WHEN ${lifetimeItemSql("pi")}
						THEN concat('subscription:', ${input.subscriptionId}::text, ':', pi.id::text, ':lifetime')
					ELSE concat(
						'subscription:',
						${input.subscriptionId}::text,
						':',
						pi.id::text,
						':',
						${input.periodStartAt.toISOString()}::text,
						':',
						COALESCE(${input.periodEndAt?.toISOString() ?? null}::text, 'open')
					)
				END,
				pi.quantity,
				${input.periodStartAt.toISOString()},
				CASE
					WHEN ${lifetimeItemSql("pi")} THEN NULL
					ELSE ${input.periodEndAt?.toISOString() ?? null}::timestamptz
				END,
				CASE
					WHEN pi.expires_after_seconds IS NOT NULL AND ${input.periodEndAt?.toISOString() ?? null}::timestamptz IS NOT NULL
						THEN LEAST(
							${input.periodEndAt?.toISOString() ?? null}::timestamptz,
							${input.periodStartAt.toISOString()}::timestamptz
								+ pi.expires_after_seconds * interval '1 second'
						)
					WHEN pi.expires_after_seconds IS NOT NULL
						THEN ${input.periodStartAt.toISOString()}::timestamptz
							+ pi.expires_after_seconds * interval '1 second'
					WHEN pi.reset_interval IS NOT NULL
						THEN ${input.periodEndAt?.toISOString() ?? null}::timestamptz
					ELSE NULL
				END
			FROM subscriptions subscription
			JOIN plan_items pi
				ON pi.project_id = subscription.project_id
				AND pi.plan_version_id = subscription.plan_version_id
			WHERE pi.project_id = ${input.projectId}
				AND subscription.id = ${input.subscriptionId}
				AND pi.plan_version_id = ${version.planVersionId}::bigint
				AND pi.item_kind = 'allocation'
				-- Items that reset more often than the plan bills get one grant per reset window below.
				AND NOT EXISTS (
					SELECT 1 FROM plan_versions pv WHERE pv.project_id = pi.project_id
						AND pv.id = pi.plan_version_id AND ${resetSplitsBillingPeriodSql("pi", "pv", { start: drizzleSql`${input.periodStartAt.toISOString()}::timestamptz`, end: drizzleSql`${input.periodEndAt?.toISOString() ?? null}::timestamptz` })}
				)
				-- A lifetime item the subscription already holds a live allowance of, granted per
				-- period before lifetime keys existed, is not granted again.
				AND NOT (
					${lifetimeItemSql("pi")}
					AND EXISTS (
						SELECT 1 FROM balance_allocations held
						WHERE held.project_id = pi.project_id
							AND held.subscription_id = subscription.id
							AND held.plan_item_id = pi.id
							AND held.source_kind = 'subscription'
							AND held.reversed_at IS NULL
							AND (held.expires_at IS NULL OR held.expires_at > now())
					)
				)
				-- Nor is a non-consumable item whose allowance for this period already holds a level
				-- a switch moved onto it: that allowance keeps its own source key.
				AND NOT EXISTS (
					SELECT 1 FROM balance_allocations kept
					JOIN features kept_feature
						ON kept_feature.project_id = kept.project_id AND kept_feature.id = kept.feature_id
					WHERE kept.project_id = pi.project_id
						AND kept.subscription_id = subscription.id
						AND kept.plan_item_id = pi.id
						AND kept.source_kind = 'subscription'
						AND kept.reversed_at IS NULL
						AND (kept.expires_at IS NULL OR kept.expires_at > now())
						AND kept_feature.meter_kind = 'non_consumable'
						AND kept.period_start_at = ${input.periodStartAt.toISOString()}::timestamptz
				)
			ON CONFLICT (project_id, feature_id, source_kind, source_key) DO NOTHING
			RETURNING id
		`,
	);
	const resetWindows = await materializeSubscriptionResetAllocations(
		executor,
		input.projectId,
		input.subscriptionId,
	);
	if (outgoingPlanVersionId !== null) {
		// A return to a version held earlier in this period resumes what that version granted.
		await resumeReturningAllowances(executor, {
			projectId: input.projectId,
			subscriptionId: input.subscriptionId,
			incomingPlanVersionId: version.planVersionId,
		});
		// Carry needs the incoming allowances granted and the outgoing ones still live.
		if (version.carryOver !== null && version.changeId !== null) {
			await carryOverAllowances(executor, {
				projectId: input.projectId,
				customerId: input.customerId,
				subscriptionId: input.subscriptionId,
				changeId: version.changeId,
				outgoingPlanVersionId,
				incomingPlanVersionId: version.planVersionId,
				balances: version.carryOver.balances,
				usages: version.carryOver.usages,
				periodStartAt: input.periodStartAt,
				periodEndAt: input.periodEndAt,
			});
		}
		await endOutgoingPlanAllowances(
			executor,
			input.projectId,
			input.subscriptionId,
			outgoingPlanVersionId,
		);
	}
	return inserted.length + resetWindows.granted;
}

/**
 * A version grants its allowance at most once per period or reset window. When the subscription
 * returns to a version whose allowance a switch ended earlier in the same period or window, that
 * allowance is reopened as it was left: its use stays, its natural expiry is restored, and it rolls
 * over again. The period's source key already exists, so the grant above adds nothing for it.
 *
 * A carry taken from a reopened allowance ends, and its quantity returns to the origin instead of
 * counting twice: whatever the carry spent, holds or had debited is taken from the origin.
 */
async function resumeReturningAllowances(
	executor: QueryExecutor,
	input: { projectId: string; subscriptionId: string; incomingPlanVersionId: string },
): Promise<void> {
	const reopened = await executeRows<{ id: string | number | bigint }>(
		executor,
		drizzleSql`
			WITH ended AS (
				SELECT allocation.id,
					CASE
						WHEN item.expires_after_seconds IS NOT NULL
							THEN LEAST(
								allocation.period_end_at,
								allocation.period_start_at + item.expires_after_seconds * interval '1 second'
							)
						WHEN item.reset_interval IS NOT NULL THEN allocation.period_end_at
						ELSE NULL
					END AS natural_expires_at
				FROM balance_allocations allocation
				JOIN plan_items item
					ON item.project_id = allocation.project_id AND item.id = allocation.plan_item_id
				WHERE allocation.project_id = ${input.projectId}
					AND allocation.subscription_id = ${input.subscriptionId}
					AND allocation.source_kind = 'subscription'
					AND allocation.reversed_at IS NULL
					AND item.plan_version_id = ${input.incomingPlanVersionId}::bigint
					-- A non-consumable level the switch kept on a live allowance of this item is the
					-- item's allowance; an older ended one is not reopened beside it.
					AND NOT EXISTS (
						SELECT 1 FROM balance_allocations kept
						JOIN features kept_feature
							ON kept_feature.project_id = kept.project_id AND kept_feature.id = kept.feature_id
						WHERE kept.project_id = allocation.project_id
							AND kept.subscription_id = allocation.subscription_id
							AND kept.plan_item_id = allocation.plan_item_id
							AND kept.id <> allocation.id
							AND kept.source_kind = 'subscription'
							AND kept.reversed_at IS NULL
							AND (kept.expires_at IS NULL OR kept.expires_at > now())
							AND kept_feature.meter_kind = 'non_consumable'
					)
					AND allocation.expires_at <= now()
					AND allocation.rollover_processed_at IS NOT NULL
					AND allocation.period_start_at <= now()
					AND (allocation.period_end_at IS NULL OR allocation.period_end_at > now())
			)
			UPDATE balance_allocations allocation
			SET expires_at = ended.natural_expires_at, rollover_processed_at = NULL, updated_at = now()
			FROM ended
			WHERE allocation.project_id = ${input.projectId} AND allocation.id = ended.id
				AND (ended.natural_expires_at IS NULL OR ended.natural_expires_at > now())
			RETURNING allocation.id
		`,
	);
	if (reopened.length === 0) return;
	const origins = drizzleSql.join(
		reopened.map((row) => drizzleSql`${String(row.id)}::bigint`),
		drizzleSql`, `,
	);
	await executeRows(
		executor,
		drizzleSql`
			WITH carries AS (
				UPDATE balance_allocations carry
				SET expires_at = now(),
					rollover_processed_at = COALESCE(carry.rollover_processed_at, now()),
					updated_at = now()
				WHERE carry.project_id = ${input.projectId}
					AND carry.source_kind = 'carry_over'
					AND carry.reversed_at IS NULL
					AND (carry.expires_at IS NULL OR carry.expires_at > now())
					AND carry.carry_over_origin_allocation_id IN (${origins})
				RETURNING carry.carry_over_origin_allocation_id AS origin_id,
					carry.consumed_quantity + carry.held_quantity + carry.reversed_quantity AS taken
			)
			UPDATE balance_allocations origin
			SET reversed_quantity = LEAST(origin.quantity, origin.reversed_quantity + carries.taken),
				updated_at = now()
			FROM carries
			WHERE origin.project_id = ${input.projectId} AND origin.id = carries.origin_id
		`,
	);
}

/**
 * Quantity the outgoing plan version granted ends with it, and the incoming version grants afresh
 * (DEC-08). Its live allowances end now and are never rolled over: rolling them over would carry
 * them into the new plan. Allowances that already ended at a period boundary are left to the
 * rollover worker as before, and top-ups, rewards, grants and rollovers are not plan-granted.
 * Open reservations still settle from their holds on the ended rows.
 */
async function endOutgoingPlanAllowances(
	executor: QueryExecutor,
	projectId: string,
	subscriptionId: string,
	outgoingPlanVersionId: string,
): Promise<void> {
	await executeRows(
		executor,
		drizzleSql`
			UPDATE balance_allocations allocation
			SET expires_at = now(),
				rollover_processed_at = COALESCE(allocation.rollover_processed_at, now()),
				updated_at = now()
			FROM plan_items item
			WHERE allocation.project_id = ${projectId}
				AND allocation.subscription_id = ${subscriptionId}
				AND allocation.source_kind = 'subscription'
				AND allocation.reversed_at IS NULL
				AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
				AND item.project_id = allocation.project_id
				AND item.id = allocation.plan_item_id
				AND item.plan_version_id = ${outgoingPlanVersionId}::bigint
		`,
	);
}

/**
 * Records the provider's subscription items against the pinned version's price components. A
 * price the version does not bind is left out rather than failing the sync, because the provider
 * has already charged it and every later event would fail the same way: its item keeps the
 * component it was tracked under, if any, so a later change still addresses it. The unbound
 * prices are returned for the caller to record.
 */
export async function syncSubscriptionPriceItems(
	executor: QueryExecutor,
	input: {
		projectId: string;
		subscriptionId: string;
		periodStartAt: Date;
		items: Array<{
			providerSubscriptionItemId: string;
			externalProductId: string;
			externalPriceId: string;
			quantity: number;
		}>;
	},
): Promise<string[]> {
	const unboundPrices: string[] = [];
	if (input.items.length === 0) return unboundPrices;
	const phaseTwoPricing = await executeOne<{ configured: boolean }>(
		executor,
		drizzleSql`
			SELECT EXISTS (
				SELECT 1
				FROM subscriptions subscription
				JOIN price_components price
					ON price.project_id = subscription.project_id
					AND price.plan_version_id = subscription.plan_version_id
				WHERE subscription.project_id = ${input.projectId}
					AND subscription.id = ${input.subscriptionId}
			) AS configured
		`,
	);
	if (phaseTwoPricing?.configured !== true) return unboundPrices;
	const activeComponentIds: string[] = [];
	for (const item of input.items) {
		const price = await executeOne<{
			id: string | number | bigint;
			unit_amount_minor: string | number | bigint;
			currency: string;
		}>(
			executor,
			drizzleSql`
				SELECT pc.id, pc.unit_amount_minor, pc.currency
				FROM subscriptions s
				JOIN price_components pc
					ON pc.project_id = s.project_id AND pc.plan_version_id = s.plan_version_id
				JOIN provider_price_bindings ppb
					ON ppb.project_id = pc.project_id
					AND ppb.price_component_id = pc.id
					AND ppb.provider = 'stripe'
					AND ppb.channel = 'web'
					AND ppb.status = 'published'
				JOIN store_products sp
					ON sp.project_id = ppb.project_id AND sp.id = ppb.store_product_id
				WHERE s.project_id = ${input.projectId}
					AND s.id = ${input.subscriptionId}
					AND sp.external_product_id = ${item.externalProductId}
					AND sp.external_price_id = ${item.externalPriceId}
			`,
		);
		if (price === null) {
			unboundPrices.push(item.externalPriceId);
			const tracked = await executeOne<{ price_component_id: string | number | bigint }>(
				executor,
				drizzleSql`
					SELECT price_component_id FROM subscription_items
					WHERE project_id = ${input.projectId}
						AND subscription_id = ${input.subscriptionId}
						AND provider_subscription_item_id = ${item.providerSubscriptionItemId}
						AND active = true
				`,
			);
			if (tracked !== null) activeComponentIds.push(String(tracked.price_component_id));
			continue;
		}
		// Stripe keeps an item's id when its price changes. Keep the former component row for
		// history, but release its live provider identity before attaching it to the new component.
		// Restrict the transfer to this subscription: an id owned by another subscription must
		// still fail its unique constraint rather than silently taking over that subscription.
		await executeRows(
			executor,
			drizzleSql`
				UPDATE subscription_items
				SET provider_subscription_item_id = NULL, active = false,
					ends_at = COALESCE(ends_at, now()), updated_at = now()
				WHERE project_id = ${input.projectId}
					AND subscription_id = ${input.subscriptionId}
					AND provider_subscription_item_id = ${item.providerSubscriptionItemId}
					AND price_component_id <> ${String(price.id)}::bigint
			`,
		);
		await executeRows(
			executor,
			drizzleSql`
				INSERT INTO subscription_items (
					project_id, subscription_id, price_component_id,
					provider_subscription_item_id, quantity, unit_amount_minor,
					currency, active, starts_at, ends_at
				)
				VALUES (
					${input.projectId}, ${input.subscriptionId}, ${String(price.id)}::bigint,
					${item.providerSubscriptionItemId}, ${item.quantity}, ${String(price.unit_amount_minor)}::bigint,
					${price.currency}, true, ${input.periodStartAt.toISOString()}, NULL
				)
				ON CONFLICT (project_id, subscription_id, price_component_id) DO UPDATE SET
					provider_subscription_item_id = EXCLUDED.provider_subscription_item_id,
					quantity = EXCLUDED.quantity,
					unit_amount_minor = EXCLUDED.unit_amount_minor,
					currency = EXCLUDED.currency,
					active = true,
					ends_at = NULL,
					updated_at = now()
			`,
		);
		activeComponentIds.push(String(price.id));
	}
	await executeRows(
		executor,
		drizzleSql`
			UPDATE subscription_items
			SET active = false, ends_at = COALESCE(ends_at, now()), updated_at = now()
			WHERE project_id = ${input.projectId}
				AND subscription_id = ${input.subscriptionId}
				AND active = true
				AND price_component_id NOT IN (
					SELECT jsonb_array_elements_text(${jsonb(activeComponentIds)})::bigint
				)
		`,
	);
	return unboundPrices;
}

export async function materializeTopupAllocation(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		storeProductId: string;
		purchaseId: string;
		purchasedAt: Date;
		quantityMultiplier?: number;
		/** The entity an entity-scoped automatic top-up credits; otherwise the shared pool. */
		entityId?: string | null;
	},
): Promise<boolean> {
	const multiplier = input.quantityMultiplier ?? 1;
	if (!Number.isSafeInteger(multiplier) || multiplier < 1) {
		throw new Error("Top-up purchase quantity multiplier must be a positive safe integer");
	}
	const row = await executeOne<{ id: string | number | bigint }>(
		executor,
		drizzleSql`
			INSERT INTO balance_allocations (
				project_id,
				customer_id,
				entity_id,
				feature_id,
				purchase_id,
				source_kind,
				source_key,
				quantity,
				expires_at
			)
			SELECT
				${input.projectId},
				${input.customerId},
				${input.entityId ?? null}::bigint,
				options.feature_id,
				${input.purchaseId},
				'topup',
				concat('topup:', options.id::text, ':purchase:', ${input.purchaseId}::text),
				options.quantity * ${multiplier}::numeric,
				CASE
					WHEN options.expires_after_seconds IS NULL THEN NULL
					ELSE ${input.purchasedAt.toISOString()}::timestamptz
						+ options.expires_after_seconds * interval '1 second'
				END
			FROM provider_topup_bindings bindings
			JOIN topup_options options
				ON options.project_id = bindings.project_id
				AND options.id = bindings.topup_option_id
			WHERE bindings.project_id = ${input.projectId}
				AND bindings.store_product_id = ${input.storeProductId}
				AND bindings.status = 'published'
			ON CONFLICT (project_id, feature_id, source_kind, source_key) DO NOTHING
			RETURNING id
		`,
	);
	return row !== null;
}

export async function reversePurchaseAllocations(
	executor: QueryExecutor,
	projectId: string,
	purchaseId: string,
	reversedAt: Date,
): Promise<void> {
	await executeRows(
		executor,
		drizzleSql`
			UPDATE balance_allocations
			SET
				reversed_quantity = quantity,
				reversed_at = COALESCE(reversed_at, ${reversedAt.toISOString()}),
				updated_at = now()
			WHERE project_id = ${projectId}
				AND purchase_id = ${purchaseId}
		`,
	);
}

export async function setPurchaseAllocationReversal(
	executor: QueryExecutor,
	input: {
		projectId: string;
		purchaseId: string;
		reversedCreditAmount: number;
		totalCreditAmount: number;
		reversedAt: Date;
	},
): Promise<void> {
	if (
		!Number.isSafeInteger(input.reversedCreditAmount) ||
		!Number.isSafeInteger(input.totalCreditAmount) ||
		input.reversedCreditAmount < 0 ||
		input.totalCreditAmount < 1 ||
		input.reversedCreditAmount > input.totalCreditAmount
	) {
		throw new Error("Purchase allocation reversal ratio is invalid");
	}
	await executeRows(
		executor,
		drizzleSql`
			UPDATE balance_allocations allocations
			SET
				reversed_quantity = round(
					allocations.quantity * ${input.reversedCreditAmount}::numeric
						/ ${input.totalCreditAmount}::numeric,
					features.credit_scale
				),
				reversed_at = CASE
					WHEN ${input.reversedCreditAmount} = ${input.totalCreditAmount}
						THEN COALESCE(allocations.reversed_at, ${input.reversedAt.toISOString()})
					ELSE NULL
				END,
				updated_at = now()
			FROM features
			WHERE allocations.project_id = ${input.projectId}
				AND allocations.purchase_id = ${input.purchaseId}
				AND features.project_id = allocations.project_id
				AND features.id = allocations.feature_id
		`,
	);
}
