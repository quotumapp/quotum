import { sql as drizzleSql } from "drizzle-orm";
import type { PurchaseKind, PurchaseStatus } from "../../billing/types";
import { assertUpdated, executeOne } from "./query";
import type {
	QueryExecutor,
	RecordGooglePurchaseProjectionInput,
	RecordStoreKitTransactionProjectionInput,
	StripeCreditReversalTargetRow,
} from "./types";

export interface InvalidationTargetRow {
	purchase_id: string | null;
	customer_id: string;
	billing_account_id: string;
	subscription_id: string | null;
	store_product_id: string;
	product_id: string;
	product_key: string;
	product_type: PurchaseKind;
	credit_amount: number;
}

export async function findAppleInvalidationTarget(
	executor: QueryExecutor,
	projectId: string,
	input: RecordStoreKitTransactionProjectionInput,
): Promise<InvalidationTargetRow | null> {
	const purchase = await executeOne<InvalidationTargetRow>(
		executor,
		drizzleSql`
		SELECT
			pu.id AS purchase_id,
			pu.customer_id,
			c.billing_account_id,
			pu.subscription_id,
			pu.store_product_id,
			pu.product_id,
			p.key AS product_key,
			p.type AS product_type,
			p.credit_amount
		FROM purchases pu
		JOIN customers c ON c.id = pu.customer_id AND c.project_id = pu.project_id
		JOIN products p ON p.id = pu.product_id AND p.project_id = pu.project_id
		WHERE pu.project_id = ${projectId}
			AND pu.provider = 'apple'
			AND (
				pu.transaction_id = ${input.transactionId}
				OR (
					${input.originalTransactionId}::text IS NOT NULL
					AND pu.original_transaction_id = ${input.originalTransactionId}
				)
			)
		ORDER BY CASE WHEN pu.transaction_id = ${input.transactionId} THEN 0 ELSE 1 END
		LIMIT 1
		FOR UPDATE OF c
	`,
	);
	if (purchase !== null) {
		return purchase;
	}
	if (input.originalTransactionId === null) {
		return null;
	}
	return await executeOne<InvalidationTargetRow>(
		executor,
		drizzleSql`
		SELECT
			NULL::uuid AS purchase_id,
			s.customer_id,
			c.billing_account_id,
			s.id AS subscription_id,
			s.store_product_id,
			s.product_id,
			p.key AS product_key,
			p.type AS product_type,
			p.credit_amount
		FROM subscriptions s
		JOIN customers c ON c.id = s.customer_id AND c.project_id = s.project_id
		JOIN products p ON p.id = s.product_id AND p.project_id = s.project_id
		WHERE s.project_id = ${projectId}
			AND s.provider = 'apple'
			AND s.external_subscription_id = ${input.originalTransactionId}
		LIMIT 1
		FOR UPDATE OF c
	`,
	);
}

export async function findGooglePurchaseInvalidationTarget(
	executor: QueryExecutor,
	projectId: string,
	input: RecordGooglePurchaseProjectionInput,
): Promise<InvalidationTargetRow | null> {
	const purchase = await executeOne<InvalidationTargetRow>(
		executor,
		drizzleSql`
		SELECT
			pu.id AS purchase_id,
			pu.customer_id,
			c.billing_account_id,
			pu.subscription_id,
			pu.store_product_id,
			pu.product_id,
			p.key AS product_key,
			p.type AS product_type,
			p.credit_amount
		FROM purchases pu
		JOIN customers c ON c.id = pu.customer_id AND c.project_id = pu.project_id
		JOIN products p ON p.id = pu.product_id AND p.project_id = pu.project_id
		WHERE pu.project_id = ${projectId}
			AND pu.provider = 'google'
			AND (
				pu.transaction_id = ${input.purchaseToken}
				OR (
					${input.orderId}::text IS NOT NULL
					AND (
						pu.raw_payload->>'orderId' = ${input.orderId}
						OR pu.raw_payload->>'latestOrderId' = ${input.orderId}
					)
				)
			)
		ORDER BY CASE WHEN pu.transaction_id = ${input.purchaseToken} THEN 0 ELSE 1 END
		LIMIT 1
		FOR UPDATE OF c
	`,
	);
	if (purchase !== null) {
		return purchase;
	}
	return await executeOne<InvalidationTargetRow>(
		executor,
		drizzleSql`
		SELECT
			NULL::uuid AS purchase_id,
			s.customer_id,
			c.billing_account_id,
			s.id AS subscription_id,
			s.store_product_id,
			s.product_id,
			p.key AS product_key,
			p.type AS product_type,
			p.credit_amount
		FROM subscriptions s
		JOIN customers c ON c.id = s.customer_id AND c.project_id = s.project_id
		JOIN products p ON p.id = s.product_id AND p.project_id = s.project_id
		WHERE s.project_id = ${projectId}
			AND s.provider = 'google'
			AND (
				s.external_subscription_id = ${input.purchaseToken}
				OR (
					${input.orderId}::text IS NOT NULL
					AND s.latest_transaction_id = ${input.orderId}
				)
			)
		ORDER BY CASE WHEN s.external_subscription_id = ${input.purchaseToken} THEN 0 ELSE 1 END
		LIMIT 1
		FOR UPDATE OF c
	`,
	);
}

export interface GoogleVoidedTargetRow {
	purchase_id: string | null;
	subscription_id: string | null;
	customer_id: string;
	billing_account_id: string;
	store_product_id: string | null;
	purchase_kind: PurchaseKind | null;
	purchase_status: PurchaseStatus | null;
	product_key: string;
	credit_amount: number;
	reversed_amount: number | string | null;
	reversed_credit_amount: number | string | null;
}

export async function findGoogleVoidedTarget(
	executor: QueryExecutor,
	projectId: string,
	purchaseToken: string,
): Promise<GoogleVoidedTargetRow | null> {
	const purchase = await executeOne<GoogleVoidedTargetRow>(
		executor,
		drizzleSql`
		SELECT
			pu.id AS purchase_id,
			pu.subscription_id,
			pu.customer_id,
			c.billing_account_id,
			pu.store_product_id,
			pu.purchase_kind
			, pu.status AS purchase_status
			, p.key AS product_key
			, p.credit_amount
			, pu.reversed_amount
			, pu.reversed_credit_amount
		FROM purchases pu
		JOIN customers c ON c.id = pu.customer_id AND c.project_id = pu.project_id
		JOIN products p ON p.id = pu.product_id AND p.project_id = pu.project_id
		WHERE pu.project_id = ${projectId}
			AND pu.provider = 'google'
			AND pu.transaction_id = ${purchaseToken}
		LIMIT 1
		FOR UPDATE OF c
	`,
	);
	if (purchase !== null) {
		return purchase;
	}
	return await executeOne<GoogleVoidedTargetRow>(
		executor,
		drizzleSql`
		SELECT
			NULL::uuid AS purchase_id,
			s.id AS subscription_id,
			s.customer_id,
			c.billing_account_id,
			s.store_product_id,
			'subscription'::text AS purchase_kind,
			NULL::text AS purchase_status,
			p.key AS product_key,
			p.credit_amount,
			NULL::bigint AS reversed_amount,
			NULL::integer AS reversed_credit_amount
		FROM subscriptions s
		JOIN customers c ON c.id = s.customer_id AND c.project_id = s.project_id
		JOIN products p ON p.id = s.product_id AND p.project_id = s.project_id
		WHERE s.project_id = ${projectId}
			AND s.provider = 'google'
			AND s.external_subscription_id = ${purchaseToken}
		LIMIT 1
		FOR UPDATE OF c
	`,
	);
}

export async function findStripeCreditReversalTarget(
	executor: QueryExecutor,
	projectId: string,
	paymentIntentId: string,
): Promise<StripeCreditReversalTargetRow | null> {
	const identity = await executeOne<{ purchase_id: string; customer_id: string }>(
		executor,
		drizzleSql`
			SELECT pu.id AS purchase_id, pu.customer_id
			FROM purchases pu
			WHERE pu.project_id = ${projectId}
				AND pu.provider = 'stripe'
				AND pu.channel = 'web'
				AND pu.purchase_kind IN ('consumable', 'non_consumable')
				AND pu.transaction_id = ${paymentIntentId}
			LIMIT 1
		`,
	);
	if (identity === null) {
		return null;
	}

	await lockCustomerRow(executor, projectId, identity.customer_id);
	return await executeOne<StripeCreditReversalTargetRow>(
		executor,
		drizzleSql`
			SELECT
				pu.id AS purchase_id,
				pu.customer_id,
				c.billing_account_id,
				pu.store_product_id,
				p.key AS product_key,
				pu.purchase_kind,
				p.credit_amount,
				sp.price_amount,
				sp.currency,
				pu.reversed_amount,
				pu.reversed_credit_amount
			FROM purchases pu
			JOIN customers c ON c.id = pu.customer_id AND c.project_id = pu.project_id
			JOIN products p ON p.id = pu.product_id AND p.project_id = pu.project_id
			JOIN store_products sp ON sp.id = pu.store_product_id AND sp.project_id = pu.project_id
			WHERE pu.id = ${identity.purchase_id}
				AND pu.project_id = ${projectId}
				AND pu.customer_id = ${identity.customer_id}
			LIMIT 1
			FOR UPDATE OF pu
		`,
	);
}

export async function lockCustomerRow(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
): Promise<void> {
	await assertUpdated(
		executor,
		drizzleSql`
			SELECT c.id
			FROM customers c
			WHERE c.id = ${customerId}
				AND c.project_id = ${projectId}
			FOR UPDATE
		`,
		`customer ${customerId} was not found while acquiring a billing mutation lock`,
	);
}

export function minBigInt(left: bigint, right: bigint): bigint {
	return left < right ? left : right;
}

export function maxBigInt(left: bigint, right: bigint): bigint {
	return left > right ? left : right;
}

export function proratedReversedCreditAmount(
	totalCreditAmount: number,
	originalPriceAmount: bigint,
	reversedAmount: bigint,
): number {
	if (totalCreditAmount <= 0 || reversedAmount <= 0n) {
		return 0;
	}
	if (reversedAmount >= originalPriceAmount) {
		return totalCreditAmount;
	}

	return Number((BigInt(totalCreditAmount) * reversedAmount) / originalPriceAmount);
}

export function parseStripeAmountForComparison(value: number | string | null): bigint | null {
	if (typeof value === "number") {
		return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
	}

	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!/^\d+$/.test(trimmed)) {
			return null;
		}

		return BigInt(trimmed);
	}

	return null;
}
