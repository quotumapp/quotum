import { sql as drizzleSql } from "drizzle-orm";
import type { SubscriptionStatus } from "../../billing/types";
import { supersedeBasePlanGrants } from "./plan-grants";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";

const allocationFundingStatuses = new Set<SubscriptionStatus>([
	"active",
	"grace_period",
	"billing_retry",
	"cancelled",
]);

/**
 * Resolves the plan version a synced subscription carries. Publishing a newer version of the same
 * plan retargets the provider binding, but that must not move existing subscriptions: they stay
 * grandfathered on their pinned version until an explicit subscription change or catalog migration
 * has been applied, or the provider reports a product that belongs to another plan.
 */
async function resolveSubscriptionPlanVersion(
	executor: QueryExecutor,
	input: { projectId: string; customerId: string; storeProductId: string; subscriptionId: string },
): Promise<{
	planVersionId: string;
	catalogRevisionId: string;
	changed: boolean;
	changeId: string | null;
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
				change_version.catalog_revision_id AS change_revision_id
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
					change.synchronized_at
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
			WHERE subscription.project_id = ${input.projectId}
				AND subscription.customer_id = ${input.customerId}
				AND subscription.id = ${input.subscriptionId}
		`,
	);
	if (row === null) return null;
	const changeId = row.change_synchronized_at === null ? row.change_id : null;
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
		return binding === null ? null : { ...binding, changed: true, changeId };
	}
	// 2. Only the latest applied change can move the pinned version. Filtering by its source
	// before selecting the latest would replay an old upgrade after a later downgrade returns
	// to that source, including when a newer quantity-only change supersedes the upgrade.
	if (row.change_version_id !== null && row.change_revision_id !== null) {
		return {
			planVersionId: String(row.change_version_id),
			catalogRevisionId: String(row.change_revision_id),
			changed: true,
			changeId,
		};
	}
	// 3. A product of another plan is a provider-side switch, so its bound version applies.
	if (
		binding !== null &&
		row.binding_plan_id !== null &&
		String(row.binding_plan_id) !== String(row.current_plan_id)
	) {
		return { ...binding, changed: binding.planVersionId !== current.planVersionId, changeId };
	}
	// 4. Otherwise the subscription stays grandfathered on its pinned version.
	return { ...current, changed: false, changeId };
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
	},
): Promise<number> {
	const version = await resolveSubscriptionPlanVersion(executor, input);
	if (version === null) return 0;

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
				concat(
					'subscription:',
					${input.subscriptionId}::text,
					':',
					pi.id::text,
					':',
					${input.periodStartAt.toISOString()}::text,
					':',
					COALESCE(${input.periodEndAt?.toISOString() ?? null}::text, 'open')
				),
				pi.quantity,
				${input.periodStartAt.toISOString()},
				${input.periodEndAt?.toISOString() ?? null},
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
			ON CONFLICT (project_id, feature_id, source_kind, source_key) DO NOTHING
			RETURNING id
		`,
	);
	return inserted.length;
}

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
): Promise<void> {
	if (input.items.length === 0) return;
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
	if (phaseTwoPricing?.configured !== true) return;
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
			throw new Error(
				`Stripe subscription item ${item.providerSubscriptionItemId} has no published price binding`,
			);
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
