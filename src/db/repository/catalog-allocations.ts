import { sql as drizzleSql } from "drizzle-orm";
import type { SubscriptionStatus } from "../../billing/types";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";

const allocationFundingStatuses = new Set<SubscriptionStatus>([
	"active",
	"grace_period",
	"billing_retry",
	"cancelled",
]);

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
	const binding = await executeOne<{
		plan_version_id: string | number | bigint;
		catalog_revision_id: string | number | bigint;
	}>(
		executor,
		drizzleSql`
			SELECT ppb.plan_version_id, pv.catalog_revision_id
			FROM provider_plan_bindings ppb
			JOIN plan_versions pv
				ON pv.project_id = ppb.project_id
				AND pv.id = ppb.plan_version_id
			WHERE ppb.project_id = ${input.projectId}
				AND ppb.store_product_id = ${input.storeProductId}
				AND ppb.status = 'published'
				AND pv.status = 'published'
			LIMIT 1
		`,
	);
	if (binding === null) return 0;

	await executeOne(
		executor,
		drizzleSql`
			UPDATE subscriptions
			SET
				plan_version_id = ${String(binding.plan_version_id)}::bigint,
				catalog_revision_id = ${String(binding.catalog_revision_id)}::bigint,
				updated_at = now()
			WHERE project_id = ${input.projectId}
				AND customer_id = ${input.customerId}
				AND id = ${input.subscriptionId}
			RETURNING id
		`,
	);

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
				AND pi.plan_version_id = ${String(binding.plan_version_id)}::bigint
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
		const row = await executeOne<{ price_component_id: string | number | bigint }>(
			executor,
			drizzleSql`
				INSERT INTO subscription_items (
					project_id, subscription_id, price_component_id,
					provider_subscription_item_id, quantity, unit_amount_minor,
					currency, active, starts_at, ends_at
				)
				SELECT
					${input.projectId}, ${input.subscriptionId}, pc.id,
					${item.providerSubscriptionItemId}, ${item.quantity}, pc.unit_amount_minor,
					pc.currency, true, ${input.periodStartAt.toISOString()}, NULL
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
				ON CONFLICT (project_id, subscription_id, price_component_id) DO UPDATE SET
					provider_subscription_item_id = EXCLUDED.provider_subscription_item_id,
					quantity = EXCLUDED.quantity,
					unit_amount_minor = EXCLUDED.unit_amount_minor,
					currency = EXCLUDED.currency,
					active = true,
					ends_at = NULL,
					updated_at = now()
				RETURNING price_component_id
			`,
		);
		if (row === null) {
			throw new Error(
				`Stripe subscription item ${item.providerSubscriptionItemId} has no published price binding`,
			);
		}
		activeComponentIds.push(String(row.price_component_id));
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
