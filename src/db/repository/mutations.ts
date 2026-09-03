import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import type {
	BillingChannel,
	BillingProvider,
	PurchaseKind,
	PurchaseStatus,
	SubscriptionStatus,
} from "../../billing/types";
import { executeOne, jsonb } from "./query";
import type { QueryExecutor } from "./types";

export async function upsertSubscription(
	executor: QueryExecutor,
	projectId: string,
	input: {
		customerId: string;
		productId: string;
		storeProductId: string;
		provider: BillingProvider;
		channel: BillingChannel;
		externalSubscriptionId: string;
		externalProductId: string;
		externalPriceId: string | null;
		status: SubscriptionStatus;
		startsAt: Date;
		expiresAt: Date | null;
		autoRenew: boolean;
		latestTransactionId: string | null;
		providerStatus?: string | null;
		currentPeriodStart?: Date | null;
		currentPeriodEnd?: Date | null;
		cancelAtPeriodEnd?: boolean;
		latestProviderObjectId?: string | null;
		lastProviderEventCreated?: number;
		enforceProviderEventOrder?: boolean;
		rawState: Record<string, unknown>;
		updateProduct: boolean;
		allowRestoration?: boolean;
		identityError: string;
	},
): Promise<string> {
	const lastProviderEventCreated = input.lastProviderEventCreated ?? 0;
	const updateIsMonotonic = input.enforceProviderEventOrder
		? drizzleSql`${lastProviderEventCreated}::bigint >= subscriptions.last_provider_event_created`
		: subscriptionUpdateIsMonotonicSql(input.allowRestoration ?? false);
	const row = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
		INSERT INTO subscriptions (
			project_id,
			customer_id,
			product_id,
			store_product_id,
			provider,
			channel,
			external_subscription_id,
			external_product_id,
			external_price_id,
			status,
			provider_status,
			starts_at,
			expires_at,
			current_period_start,
			current_period_end,
			cancel_at_period_end,
			auto_renew,
			latest_transaction_id,
			latest_provider_object_id,
			last_provider_event_created,
			raw_state
		)
		VALUES (
			${projectId},
			${input.customerId},
			${input.productId},
			${input.storeProductId},
			${input.provider},
			${input.channel},
			${input.externalSubscriptionId},
			${input.externalProductId},
			${input.externalPriceId},
			${input.status},
			${input.providerStatus ?? input.status},
			${input.startsAt.toISOString()},
			${input.expiresAt?.toISOString() ?? null},
			${input.currentPeriodStart?.toISOString() ?? null},
			${input.currentPeriodEnd?.toISOString() ?? null},
			${input.cancelAtPeriodEnd ?? false},
			${input.autoRenew},
			${input.latestTransactionId},
			${input.latestProviderObjectId ?? null},
			${lastProviderEventCreated},
			${jsonb(input.rawState)}
		)
		ON CONFLICT (project_id, provider, external_subscription_id) DO UPDATE SET
			product_id = CASE
				WHEN ${input.updateProduct} AND ${updateIsMonotonic} THEN EXCLUDED.product_id
				ELSE subscriptions.product_id
			END,
			store_product_id = CASE
				WHEN ${input.updateProduct} AND ${updateIsMonotonic} THEN EXCLUDED.store_product_id
				ELSE subscriptions.store_product_id
			END,
			external_product_id = CASE
				WHEN ${input.updateProduct} AND ${updateIsMonotonic} THEN EXCLUDED.external_product_id
				ELSE subscriptions.external_product_id
			END,
			external_price_id = CASE
				WHEN ${input.updateProduct} AND ${updateIsMonotonic} THEN EXCLUDED.external_price_id
				ELSE subscriptions.external_price_id
			END,
			status = CASE
				WHEN ${updateIsMonotonic} THEN EXCLUDED.status
				ELSE subscriptions.status
			END,
			provider_status = CASE
				WHEN ${updateIsMonotonic} THEN EXCLUDED.provider_status
				ELSE subscriptions.provider_status
			END,
			starts_at = CASE
				WHEN ${input.updateProduct} AND ${updateIsMonotonic} THEN LEAST(subscriptions.starts_at, EXCLUDED.starts_at)
				ELSE subscriptions.starts_at
			END,
			expires_at = CASE
				WHEN ${updateIsMonotonic} THEN ${greatestSubscriptionExpiresAtSql()}
				ELSE subscriptions.expires_at
			END,
			current_period_start = CASE
				WHEN ${updateIsMonotonic} THEN EXCLUDED.current_period_start
				ELSE subscriptions.current_period_start
			END,
			current_period_end = CASE
				WHEN ${updateIsMonotonic} THEN EXCLUDED.current_period_end
				ELSE subscriptions.current_period_end
			END,
			cancel_at_period_end = CASE
				WHEN ${updateIsMonotonic} THEN EXCLUDED.cancel_at_period_end
				ELSE subscriptions.cancel_at_period_end
			END,
			auto_renew = CASE
				WHEN ${updateIsMonotonic} THEN EXCLUDED.auto_renew
				ELSE subscriptions.auto_renew
			END,
			latest_transaction_id = CASE
				WHEN ${updateIsMonotonic} THEN EXCLUDED.latest_transaction_id
				ELSE subscriptions.latest_transaction_id
			END,
			latest_provider_object_id = CASE
				WHEN ${updateIsMonotonic} THEN EXCLUDED.latest_provider_object_id
				ELSE subscriptions.latest_provider_object_id
			END,
			last_provider_event_created = CASE
				WHEN ${updateIsMonotonic} THEN EXCLUDED.last_provider_event_created
				ELSE subscriptions.last_provider_event_created
			END,
			raw_state = CASE
				WHEN ${updateIsMonotonic} THEN EXCLUDED.raw_state
				ELSE subscriptions.raw_state
			END,
			updated_at = CASE
				WHEN ${updateIsMonotonic} THEN now()
				ELSE subscriptions.updated_at
			END
		WHERE subscriptions.customer_id = EXCLUDED.customer_id
			AND subscriptions.channel = EXCLUDED.channel
			AND (
				${input.updateProduct}
				OR (
					subscriptions.product_id = EXCLUDED.product_id
					AND subscriptions.store_product_id = EXCLUDED.store_product_id
				)
			)
		RETURNING id
	`,
	);
	if (row === null) {
		throw new Error(input.identityError);
	}
	return row.id;
}

export function subscriptionUpdateIsMonotonicSql(allowRestoration: boolean): DrizzleSQL {
	const incomingSortAt = drizzleSql`COALESCE(EXCLUDED.expires_at, EXCLUDED.starts_at)`;
	const currentSortAt = drizzleSql`COALESCE(subscriptions.expires_at, subscriptions.starts_at)`;
	return drizzleSql`(${allowRestoration} OR (
		${incomingSortAt} > ${currentSortAt}
		OR (
			${incomingSortAt} IS NOT DISTINCT FROM ${currentSortAt}
			AND ${subscriptionStatusRankSql(drizzleSql`EXCLUDED.status`)} >= ${subscriptionStatusRankSql(drizzleSql`subscriptions.status`)}
		)
	))`;
}

export function subscriptionStatusRankSql(status: DrizzleSQL): DrizzleSQL {
	return drizzleSql`CASE ${status}
		WHEN 'active' THEN 10
		WHEN 'grace_period' THEN 20
		WHEN 'billing_retry' THEN 30
		WHEN 'cancelled' THEN 40
		WHEN 'expired' THEN 50
		WHEN 'refunded' THEN 60
		WHEN 'revoked' THEN 70
		ELSE 0
	END`;
}

export function greatestSubscriptionExpiresAtSql(): DrizzleSQL {
	return drizzleSql`CASE
		WHEN subscriptions.expires_at IS NULL THEN EXCLUDED.expires_at
		WHEN EXCLUDED.expires_at IS NULL THEN subscriptions.expires_at
		ELSE GREATEST(subscriptions.expires_at, EXCLUDED.expires_at)
	END`;
}

export async function upsertPurchase(
	executor: QueryExecutor,
	projectId: string,
	input: {
		customerId: string;
		productId: string;
		storeProductId: string | null;
		subscriptionId: string | null;
		provider: BillingProvider;
		channel: BillingChannel;
		purchaseKind: PurchaseKind;
		transactionId: string;
		originalTransactionId: string | null;
		status: PurchaseStatus;
		purchasedAt: Date;
		invalidatedAt: Date | null;
		invalidationReason: string | null;
		rawPayload: Record<string, unknown>;
		identityError: string;
		updateProductOnConflict?: boolean;
		allowRestoration?: boolean;
	},
): Promise<string> {
	const allowRestoration = input.allowRestoration ?? false;
	const updateIsMonotonic = purchaseUpdateIsMonotonicSql(allowRestoration);
	const row = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
		INSERT INTO purchases (
			project_id,
			customer_id,
			product_id,
			store_product_id,
			subscription_id,
			provider,
			channel,
			purchase_kind,
			transaction_id,
			original_transaction_id,
			status,
			purchased_at,
			invalidated_at,
			invalidation_reason,
			raw_payload
		)
		VALUES (
			${projectId},
			${input.customerId},
			${input.productId},
			${input.storeProductId},
			${input.subscriptionId},
			${input.provider},
			${input.channel},
			${input.purchaseKind},
			${input.transactionId},
			${input.originalTransactionId},
			${input.status},
			${input.purchasedAt.toISOString()},
			${input.invalidatedAt?.toISOString() ?? null},
			${input.invalidationReason},
			${jsonb(input.rawPayload)}
		)
		ON CONFLICT (project_id, provider, transaction_id) DO UPDATE SET
			product_id = CASE
				WHEN ${input.updateProductOnConflict ?? false} AND ${updateIsMonotonic} THEN EXCLUDED.product_id
				ELSE purchases.product_id
			END,
			store_product_id = CASE
				WHEN ${input.updateProductOnConflict ?? false} AND ${updateIsMonotonic} THEN EXCLUDED.store_product_id
				ELSE purchases.store_product_id
			END,
			subscription_id = CASE
				WHEN ${updateIsMonotonic} THEN EXCLUDED.subscription_id
				ELSE purchases.subscription_id
			END,
			original_transaction_id = CASE
				WHEN ${updateIsMonotonic} THEN EXCLUDED.original_transaction_id
				ELSE purchases.original_transaction_id
			END,
			status = CASE
				WHEN ${updateIsMonotonic} THEN EXCLUDED.status
				ELSE purchases.status
			END,
			purchased_at = CASE
				WHEN ${updateIsMonotonic} THEN GREATEST(purchases.purchased_at, EXCLUDED.purchased_at)
				ELSE purchases.purchased_at
			END,
			invalidated_at = CASE
				WHEN ${allowRestoration} THEN EXCLUDED.invalidated_at
				WHEN ${updateIsMonotonic} THEN ${greatestPurchaseInvalidatedAtSql()}
				ELSE purchases.invalidated_at
			END,
			invalidation_reason = CASE
				WHEN ${updateIsMonotonic} THEN EXCLUDED.invalidation_reason
				ELSE purchases.invalidation_reason
			END,
			raw_payload = CASE
				WHEN ${updateIsMonotonic} THEN EXCLUDED.raw_payload
				ELSE purchases.raw_payload
			END,
			updated_at = CASE
				WHEN ${updateIsMonotonic} THEN now()
				ELSE purchases.updated_at
			END
		WHERE purchases.customer_id = EXCLUDED.customer_id
			AND purchases.channel = EXCLUDED.channel
			AND purchases.purchase_kind = EXCLUDED.purchase_kind
			AND (
				${input.updateProductOnConflict ?? false}
				OR (
					purchases.product_id = EXCLUDED.product_id
					AND purchases.store_product_id IS NOT DISTINCT FROM EXCLUDED.store_product_id
				)
			)
		RETURNING id
	`,
	);
	if (row === null) {
		throw new Error(input.identityError);
	}
	return row.id;
}

export function purchaseUpdateIsMonotonicSql(allowRestoration: boolean): DrizzleSQL {
	return drizzleSql`(${allowRestoration} OR (
		(purchases.status = 'completed' AND EXCLUDED.status <> 'completed')
		OR (
			EXCLUDED.status <> 'completed'
			AND purchases.status <> 'completed'
			AND COALESCE(EXCLUDED.invalidated_at, EXCLUDED.purchased_at) >= COALESCE(purchases.invalidated_at, purchases.purchased_at)
		)
		OR (
			EXCLUDED.status = 'completed'
			AND purchases.status = 'completed'
			AND EXCLUDED.purchased_at >= purchases.purchased_at
		)
	))`;
}

export function greatestPurchaseInvalidatedAtSql(): DrizzleSQL {
	return drizzleSql`CASE
		WHEN purchases.invalidated_at IS NULL THEN EXCLUDED.invalidated_at
		WHEN EXCLUDED.invalidated_at IS NULL THEN purchases.invalidated_at
		ELSE GREATEST(purchases.invalidated_at, EXCLUDED.invalidated_at)
	END`;
}
