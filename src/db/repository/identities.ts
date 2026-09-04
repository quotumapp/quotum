import { sql as drizzleSql } from "drizzle-orm";
import { NotFoundBillingError } from "../../billing/errors";
import type { BillingChannel, BillingProvider } from "../../billing/types";
import { executeOne } from "./query";
import type { CustomerIdentityRow, QueryExecutor, StoreProductIdentityRow } from "./types";
import { requireNonBlank, requireStripeCustomerId } from "./validation";

export async function ensureCustomer(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
	email: string | null = null,
): Promise<CustomerIdentityRow> {
	requireNonBlank(billingAccountId, "p_billing_account_id");
	const row = await executeOne<CustomerIdentityRow>(
		executor,
		drizzleSql`
		INSERT INTO customers (project_id, billing_account_id, email)
		VALUES (${projectId}, ${billingAccountId}, ${email})
		ON CONFLICT (project_id, billing_account_id) DO UPDATE SET
			email = COALESCE(${email}, customers.email),
			updated_at = now()
		RETURNING id, billing_account_id
	`,
	);
	if (row === null) {
		throw new Error(`customer ${billingAccountId} could not be created`);
	}
	return row;
}

export async function findCustomerByProviderCustomer(
	executor: QueryExecutor,
	projectId: string,
	provider: BillingProvider,
	externalCustomerId: string,
): Promise<CustomerIdentityRow | null> {
	return await executeOne<CustomerIdentityRow>(
		executor,
		drizzleSql`
		SELECT c.id, c.billing_account_id
		FROM provider_customers pc
		JOIN customers c ON c.id = pc.customer_id AND c.project_id = pc.project_id
		WHERE pc.project_id = ${projectId}
			AND pc.provider = ${provider}
			AND pc.external_customer_id = ${externalCustomerId}
		LIMIT 1
		FOR UPDATE OF c
	`,
	);
}

export async function findCustomerBySubscription(
	executor: QueryExecutor,
	projectId: string,
	provider: BillingProvider,
	externalSubscriptionId: string,
): Promise<CustomerIdentityRow | null> {
	return await executeOne<CustomerIdentityRow>(
		executor,
		drizzleSql`
		SELECT c.id, c.billing_account_id
		FROM subscriptions s
		JOIN customers c ON c.id = s.customer_id AND c.project_id = s.project_id
		WHERE s.project_id = ${projectId}
			AND s.provider = ${provider}
			AND s.external_subscription_id = ${externalSubscriptionId}
		LIMIT 1
		FOR UPDATE OF c
	`,
	);
}

export async function findGoogleCustomerBySubscriptionTokens(
	executor: QueryExecutor,
	projectId: string,
	tokens: Array<string | null>,
): Promise<CustomerIdentityRow | null> {
	const [token, linkedToken] = tokens;
	return await executeOne<CustomerIdentityRow>(
		executor,
		drizzleSql`
		SELECT c.id, c.billing_account_id
		FROM subscriptions s
		JOIN customers c ON c.id = s.customer_id AND c.project_id = s.project_id
		WHERE s.project_id = ${projectId}
			AND s.provider = 'google'
			AND s.external_subscription_id IN (${token}, ${linkedToken})
		ORDER BY CASE WHEN s.external_subscription_id = ${token} THEN 0 ELSE 1 END
		LIMIT 1
		FOR UPDATE OF c
	`,
	);
}

export async function findGoogleCustomerByPurchaseTokens(
	executor: QueryExecutor,
	projectId: string,
	tokens: Array<string | null>,
): Promise<CustomerIdentityRow | null> {
	const [token, linkedToken] = tokens;
	return await executeOne<CustomerIdentityRow>(
		executor,
		drizzleSql`
		SELECT c.id, c.billing_account_id
		FROM purchases pu
		JOIN customers c ON c.id = pu.customer_id AND c.project_id = pu.project_id
		WHERE pu.project_id = ${projectId}
			AND pu.provider = 'google'
			AND pu.transaction_id IN (${token}, ${linkedToken})
		ORDER BY CASE WHEN pu.transaction_id = ${token} THEN 0 ELSE 1 END
		LIMIT 1
		FOR UPDATE OF c
	`,
	);
}

export async function resolveStripeCustomer(
	executor: QueryExecutor,
	projectId: string,
	input: { billingAccountId: string | null; stripeCustomerId: string | null },
): Promise<CustomerIdentityRow | null> {
	if (input.stripeCustomerId !== null) {
		requireStripeCustomerId(input.stripeCustomerId);
	}
	if (input.billingAccountId !== null) {
		return await ensureCustomer(executor, projectId, input.billingAccountId);
	}
	if (input.stripeCustomerId !== null) {
		return await findCustomerByProviderCustomer(
			executor,
			projectId,
			"stripe",
			input.stripeCustomerId,
		);
	}
	return null;
}

export async function upsertProviderCustomer(
	executor: QueryExecutor,
	projectId: string,
	input: {
		customerId: string;
		provider: BillingProvider;
		externalCustomerId: string;
		identityError: string;
	},
): Promise<void> {
	const row = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
		INSERT INTO provider_customers (
			project_id,
			customer_id,
			provider,
			external_customer_id
		)
		VALUES (
			${projectId},
			${input.customerId},
			${input.provider},
			${input.externalCustomerId}
		)
		ON CONFLICT (project_id, provider, external_customer_id) DO UPDATE SET
			updated_at = now()
		WHERE provider_customers.customer_id = EXCLUDED.customer_id
		RETURNING id
	`,
	);
	if (row === null) {
		throw new Error(input.identityError);
	}
}

export async function getStoreProductById(
	executor: QueryExecutor,
	projectId: string,
	input: { storeProductId: string; provider: BillingProvider; channel: BillingChannel },
): Promise<StoreProductIdentityRow> {
	const row = await executeOne<StoreProductIdentityRow>(
		executor,
		drizzleSql`
		SELECT
			sp.id,
			sp.product_id,
			p.key AS product_key,
			p.type AS product_type,
			p.credit_amount
		FROM store_products sp
		JOIN products p ON p.id = sp.product_id AND p.project_id = sp.project_id
		WHERE sp.project_id = ${projectId}
			AND sp.id = ${input.storeProductId}
			AND sp.provider = ${input.provider}
			AND sp.channel = ${input.channel}
			AND sp.active = true
			AND p.active = true
	`,
	);
	if (row === null) {
		throw new NotFoundBillingError(
			`active store product ${input.storeProductId} for provider ${input.provider} channel ${input.channel} was not found`,
			"BILLING_PRODUCT_NOT_FOUND",
		);
	}
	return row;
}

export async function getAppleStoreProduct(
	executor: QueryExecutor,
	projectId: string,
	channel: BillingChannel,
	externalProductId: string,
): Promise<StoreProductIdentityRow | null> {
	return await executeOne<StoreProductIdentityRow>(
		executor,
		drizzleSql`
		SELECT
			sp.id,
			sp.product_id,
			p.key AS product_key,
			p.type AS product_type,
			p.credit_amount
		FROM store_products sp
		JOIN products p ON p.id = sp.product_id AND p.project_id = sp.project_id
		WHERE sp.project_id = ${projectId}
			AND sp.provider = 'apple'
			AND sp.channel = ${channel}
			AND sp.external_product_id = ${externalProductId}
			AND sp.active = true
			AND p.active = true
		LIMIT 1
	`,
	);
}

export async function getGoogleStoreProduct(
	executor: QueryExecutor,
	projectId: string,
	input: { externalProductId: string; externalPriceId: string | null },
): Promise<StoreProductIdentityRow | null> {
	return await executeOne<StoreProductIdentityRow>(
		executor,
		drizzleSql`
		SELECT
			sp.id,
			sp.product_id,
			p.key AS product_key,
			p.type AS product_type,
			p.credit_amount
		FROM store_products sp
		JOIN products p ON p.id = sp.product_id AND p.project_id = sp.project_id
		WHERE sp.project_id = ${projectId}
			AND sp.provider = 'google'
			AND sp.channel = 'android'
			AND sp.external_product_id = ${input.externalProductId}
			AND (
				(${input.externalPriceId}::text IS NOT NULL AND sp.external_price_id = ${input.externalPriceId})
				OR sp.external_price_id IS NULL
			)
			AND sp.active = true
			AND p.active = true
		ORDER BY CASE
			WHEN ${input.externalPriceId}::text IS NOT NULL AND sp.external_price_id = ${input.externalPriceId} THEN 0
			ELSE 1
		END
		LIMIT 1
	`,
	);
}

export async function getStripeStoreProduct(
	executor: QueryExecutor,
	projectId: string,
	input: { externalProductId: string; externalPriceId: string },
): Promise<StoreProductIdentityRow | null> {
	return await executeOne<StoreProductIdentityRow>(
		executor,
		drizzleSql`
		SELECT
			sp.id,
			sp.product_id,
			p.key AS product_key,
			p.type AS product_type,
			p.credit_amount
		FROM store_products sp
		JOIN products p ON p.id = sp.product_id AND p.project_id = sp.project_id
		WHERE sp.project_id = ${projectId}
			AND sp.provider = 'stripe'
			AND sp.channel = 'web'
			AND sp.external_product_id = ${input.externalProductId}
			AND sp.external_price_id = ${input.externalPriceId}
			AND sp.active = true
			AND p.active = true
		LIMIT 1
	`,
	);
}
