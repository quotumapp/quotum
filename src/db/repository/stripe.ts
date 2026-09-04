import { sql as drizzleSql } from "drizzle-orm";
import { NotFoundBillingError, PersistenceConflictError } from "../../billing/errors";
import type { PurchaseStatus } from "../../billing/types";
import type { ProjectInstanceContext } from "../../projects/context";
import type { StripeCatalog } from "../../providers/stripe/types";
import { RepositoryModule } from "./base";
import {
	materializeSubscriptionAllocations,
	materializeTopupAllocation,
	setPurchaseAllocationReversal,
	syncSubscriptionPriceItems,
} from "./catalog-allocations";
import {
	enqueueProjectionSyncJob,
	getEntitlementSnapshot,
	recomputeCustomerEntitlements,
} from "./entitlements";
import {
	ensureCustomer,
	findCustomerBySubscription,
	getStripeStoreProduct,
	resolveStripeCustomer,
	upsertProviderCustomer,
} from "./identities";
import {
	findStripeCreditReversalTarget,
	minBigInt,
	parseStripeAmountForComparison,
	proratedReversedCreditAmount,
} from "./invalidations";
import { upsertPurchase, upsertSubscription } from "./mutations";
import { parseNullableNonnegativeInteger, parseStripeWebStoreProductRow } from "./parsers";
import { executeOne, executeRows, jsonb } from "./query";
import { processedStripeRecordingResult, skippedStripeRecordingResult } from "./results";
import {
	recordStoreEventProcessingResult,
	recordStripeSkippedEventInTransaction,
} from "./store-events";
import type {
	CompleteStripeCheckoutRequestInput,
	GetStripeProviderCustomerInput,
	LinkStripeProviderCustomerInput,
	PrepareStripeCheckoutRequestInput,
	QueryExecutor,
	RecordStripeCreditPurchaseProjectionInput,
	RecordStripeCreditReversalProjectionInput,
	RecordStripeSkippedEventInput,
	RecordStripeSubscriptionProjectionInput,
	StripeBillingAccountSummary,
	StripeCheckoutRequestState,
	StripeRecordingResult,
	StripeRecurringCheckoutPlan,
	StripeWebStoreProductRow,
} from "./types";
import { requireNonBlank, requireStripeCustomerId, stripNulls } from "./validation";

export class StripeBillingRepository extends RepositoryModule {
	async listStripeCatalog(project: ProjectInstanceContext): Promise<StripeCatalog> {
		const projectId = project.projectInstanceId;
		const rows = await executeRows<{
			price_component_id: string | number | bigint;
			plan_key: string;
			plan_name: string;
			version: number;
			plan_kind: "base" | "addon";
			tier_rank: number;
			trial_days: number | null;
			trial_requires_payment_method: boolean;
			trial_end_behavior: "cancel" | "pause";
			upgrade_proration_behavior: "always_invoice" | "create_prorations" | "none";
			downgrade_proration_behavior: "always_invoice" | "create_prorations" | "none";
			price_key: string;
			component_kind: "base" | "licensed" | "metered_overage";
			feature_key: string | null;
			feature_unit: string | null;
			included_quantity: unknown;
			currency: string;
			unit_amount_minor: string | number;
			billing_units: unknown;
			billing_interval: "month" | "year";
			minimum_quantity: number;
			maximum_quantity: number | null;
			tax_behavior: "inclusive" | "exclusive" | "unspecified";
			pricing_model: "flat" | "graduated" | "volume";
		}>(
			this.database,
			drizzleSql`
				SELECT
					price.id AS price_component_id,
					plan.key AS plan_key, plan.name AS plan_name, version.version,
					version.plan_kind, version.tier_rank, version.trial_days,
					version.trial_requires_payment_method, version.trial_end_behavior,
					version.upgrade_proration_behavior, version.downgrade_proration_behavior,
					price.key AS price_key, price.component_kind, feature.key AS feature_key,
					feature.unit AS feature_unit, item.quantity AS included_quantity,
					price.currency, price.unit_amount_minor, price.billing_units,
					price.billing_interval, price.minimum_quantity, price.maximum_quantity,
					price.tax_behavior, price.pricing_model
				FROM plans plan
				JOIN plan_versions version
					ON version.project_id = plan.project_id AND version.id = plan.active_version_id
				JOIN price_components price
					ON price.project_id = version.project_id AND price.plan_version_id = version.id
				JOIN provider_price_bindings binding
					ON binding.project_id = price.project_id AND binding.price_component_id = price.id
					AND binding.provider = 'stripe' AND binding.channel = 'web'
					AND binding.status = 'published'
				LEFT JOIN plan_items item
					ON item.project_id = price.project_id AND item.id = price.plan_item_id
				LEFT JOIN features feature
					ON feature.project_id = item.project_id AND feature.id = item.feature_id
				WHERE plan.project_id = ${projectId}
					AND plan.active = true AND version.status = 'published'
					AND version.visibility = 'public'
				ORDER BY CASE version.plan_kind WHEN 'base' THEN 0 ELSE 1 END, plan.key,
					CASE price.component_kind WHEN 'base' THEN 0 WHEN 'licensed' THEN 1 ELSE 2 END,
					price.id
			`,
		);
		const tierRows = await executeRows<{
			price_component_id: string | number | bigint;
			up_to_quantity: unknown;
			unit_amount_minor: string | number;
			flat_amount_minor: string | number;
		}>(
			this.database,
			drizzleSql`
				SELECT tier.price_component_id, tier.up_to_quantity::text AS up_to_quantity,
					tier.unit_amount_minor, tier.flat_amount_minor
				FROM price_tiers tier
				JOIN price_components component
					ON component.project_id = tier.project_id AND component.id = tier.price_component_id
				WHERE tier.project_id = ${projectId}
				ORDER BY tier.price_component_id, tier.ordinal
			`,
		);
		const tiersByComponent = new Map<
			string,
			Array<{ upToQuantity: string | null; unitAmountMinor: number; flatAmountMinor: number }>
		>();
		for (const tier of tierRows) {
			const key = String(tier.price_component_id);
			const tiers = tiersByComponent.get(key) ?? [];
			tiers.push({
				upToQuantity: tier.up_to_quantity === null ? null : String(tier.up_to_quantity),
				unitAmountMinor: Number(tier.unit_amount_minor),
				flatAmountMinor: Number(tier.flat_amount_minor),
			});
			tiersByComponent.set(key, tiers);
		}
		const plans = new Map<string, StripeCatalog["plans"][number]>();
		for (const row of rows) {
			let plan = plans.get(row.plan_key);
			if (plan === undefined) {
				plan = {
					key: row.plan_key,
					name: row.plan_name,
					version: row.version,
					kind: row.plan_kind,
					tierRank: row.tier_rank,
					trialDays: row.trial_days,
					trialRequiresPaymentMethod: row.trial_requires_payment_method,
					trialEndBehavior: row.trial_end_behavior,
					upgradeProrationBehavior: row.upgrade_proration_behavior,
					downgradeProrationBehavior: row.downgrade_proration_behavior,
					components: [],
				};
				plans.set(row.plan_key, plan);
			}
			plan.components.push({
				key: row.price_key,
				kind: row.component_kind,
				featureKey: row.feature_key,
				featureUnit: row.feature_unit,
				includedQuantity:
					row.component_kind === "metered_overage" && row.included_quantity !== null
						? String(row.included_quantity)
						: null,
				currency: row.currency.toUpperCase(),
				unitAmountMinor: Number(row.unit_amount_minor),
				pricingModel: row.pricing_model,
				tiers: tiersByComponent.get(String(row.price_component_id)) ?? [],
				billingUnits: String(row.billing_units),
				interval: row.billing_interval,
				minimumQuantity: row.minimum_quantity,
				maximumQuantity: row.maximum_quantity,
				taxBehavior: row.tax_behavior,
			});
		}
		const oneTimeRows = await executeRows<{
			key: string;
			name: string;
			product_type: "consumable" | "non_consumable";
			currency: string;
			amount_minor: string | number;
			credits: number;
		}>(
			this.database,
			drizzleSql`
				SELECT
					product.key, COALESCE(NULLIF(product.name, ''), product.key) AS name,
					product.type AS product_type, upper(store.currency) AS currency,
					store.price_amount AS amount_minor, product.credit_amount AS credits
				FROM store_products store
				JOIN products product
					ON product.project_id = store.project_id AND product.id = store.product_id
				WHERE store.project_id = ${projectId}
					AND store.provider = 'stripe' AND store.channel = 'web'
					AND store.active = true AND product.active = true
					AND product.type IN ('consumable', 'non_consumable')
					AND store.price_amount > 0 AND store.currency IS NOT NULL
				ORDER BY product.created_at, product.key
			`,
		);
		return {
			schemaVersion: 1,
			plans: Array.from(plans.values()).filter((plan) =>
				plan.components.some((component) => component.kind !== "metered_overage"),
			),
			oneTimePurchases: oneTimeRows.map((row) => ({
				key: row.key,
				name: row.name,
				kind: row.product_type === "consumable" ? "topup" : "one_time",
				currency: row.currency,
				amountMinor: Number(row.amount_minor),
				credits: row.credits,
			})),
		};
	}

	async getStripeBillingAccountSummary(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<StripeBillingAccountSummary> {
		requireNonBlank(billingAccountId, "p_billing_account_id");
		const projectId = project.projectInstanceId;
		const customer = await executeOne<{ id: string }>(
			this.database,
			drizzleSql`
				SELECT id
				FROM customers
				WHERE project_id = ${projectId} AND billing_account_id = ${billingAccountId}
				LIMIT 1
			`,
		);
		if (customer === null) {
			return { schemaVersion: 1, customerExists: false, subscriptions: [], recentInvoices: [] };
		}

		const subscriptionRows = await executeRows<{
			id: string;
			plan: string;
			provider_status: string | null;
			status: string;
			current_period_start: Date | string | null;
			current_period_end: Date | string | null;
			cancel_at_period_end: boolean;
		}>(
			this.database,
			drizzleSql`
				SELECT
					s.external_subscription_id AS id,
					COALESCE(plan.key, NULLIF(p.metadata->>'plan', ''), p.key) AS plan,
					s.provider_status,
					s.status,
					COALESCE(s.current_period_start, s.starts_at) AS current_period_start,
					COALESCE(s.current_period_end, s.expires_at) AS current_period_end,
					s.cancel_at_period_end
				FROM subscriptions s
				JOIN products p ON p.project_id = s.project_id AND p.id = s.product_id
				LEFT JOIN plan_versions version
					ON version.project_id = s.project_id AND version.id = s.plan_version_id
				LEFT JOIN plans plan
					ON plan.project_id = version.project_id AND plan.id = version.plan_id
				WHERE s.project_id = ${projectId}
					AND s.customer_id = ${customer.id}
					AND s.provider = 'stripe'
					AND s.channel = 'web'
				ORDER BY s.updated_at DESC
				LIMIT 20
			`,
		);
		const invoiceRows = await executeRows<{
			id: string;
			status: string;
			amount_paid: number | string;
			currency: string;
			paid_at: Date | string | null;
			provider_created_at: Date | string;
		}>(
			this.database,
			drizzleSql`
				SELECT
					external_invoice_id AS id,
					status,
					amount_paid,
					currency,
					paid_at,
					provider_created_at
				FROM billing_invoices
				WHERE project_id = ${projectId} AND customer_id = ${customer.id}
				ORDER BY provider_created_at DESC
				LIMIT 20
			`,
		);

		return {
			schemaVersion: 1,
			customerExists: true,
			subscriptions: subscriptionRows.map((row) => ({
				id: row.id,
				plan: row.plan,
				status: billingAccountSubscriptionStatus(row.provider_status ?? row.status),
				currentPeriodStart: isoTimestamp(row.current_period_start),
				currentPeriodEnd: isoTimestamp(row.current_period_end),
				cancelAtPeriodEnd: row.cancel_at_period_end,
			})),
			recentInvoices: invoiceRows.map((row) => ({
				id: row.id,
				status: billingAccountInvoiceStatus(row.status),
				amountPaidCents: Number(row.amount_paid),
				currency: row.currency.toUpperCase(),
				paidAt: isoTimestamp(row.paid_at),
				createdAt: requiredIsoTimestamp(row.provider_created_at),
			})),
		};
	}

	async prepareStripeCheckoutRequest(
		project: ProjectInstanceContext,
		input: PrepareStripeCheckoutRequestInput,
	): Promise<StripeCheckoutRequestState> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await ensureCustomer(tx, projectId, input.billingAccountId, null);
			const planVersionId = input.planVersionId ?? null;
			const target = await executeOne<{ valid: boolean }>(
				tx,
				input.storeProductId !== null
					? drizzleSql`
						SELECT true AS valid
						FROM store_products
						WHERE project_id = ${projectId}
							AND id = ${input.storeProductId}
							AND provider = 'stripe'
							AND channel = 'web'
						LIMIT 1
					`
					: drizzleSql`
						SELECT true AS valid
						FROM plan_versions pv
						JOIN plans p ON p.project_id = pv.project_id AND p.active_version_id = pv.id
						WHERE pv.project_id = ${projectId}
							AND pv.id = ${planVersionId}::bigint
							AND pv.status = 'published'
							AND p.active = true
						LIMIT 1
					`,
			);
			if (target === null || (input.storeProductId === null) === (planVersionId === null)) {
				throw new NotFoundBillingError(
					"Stripe Checkout catalog target was not found",
					"BILLING_PRODUCT_NOT_FOUND",
				);
			}

			await executeRows(
				tx,
				drizzleSql`
					INSERT INTO checkout_requests (
						project_id,
						customer_id,
						store_product_id,
						plan_version_id,
						requested_quantities,
						provider,
						idempotency_key,
						request_hash,
						status
					)
					VALUES (
						${projectId},
						${customer.id},
						${input.storeProductId},
						${planVersionId}::bigint,
						${jsonb(input.requestedQuantities ?? {})},
						'stripe',
						${input.idempotencyKey},
						${input.requestHash},
						'creating'
					)
					ON CONFLICT (project_id, customer_id, idempotency_key) DO NOTHING
				`,
			);
			const row = await checkoutRequestState(tx, {
				projectId,
				customerId: customer.id,
				idempotencyKey: input.idempotencyKey,
			});
			if (
				row.request_hash !== input.requestHash ||
				row.store_product_id !== input.storeProductId ||
				row.plan_version_id !== planVersionId
			) {
				throw new PersistenceConflictError(
					"Idempotency key was reused with a different request",
					"IDEMPOTENCY_CONFLICT",
				);
			}
			return stripeCheckoutRequestState(row);
		});
	}

	async completeStripeCheckoutRequest(
		project: ProjectInstanceContext,
		input: CompleteStripeCheckoutRequestInput,
	): Promise<StripeCheckoutRequestState> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await ensureCustomer(tx, projectId, input.billingAccountId, null);
			const row = await checkoutRequestState(tx, {
				projectId,
				customerId: customer.id,
				idempotencyKey: input.idempotencyKey,
			});
			if (row.request_hash !== input.requestHash) {
				throw new PersistenceConflictError(
					"Idempotency key was reused with a different request",
					"IDEMPOTENCY_CONFLICT",
				);
			}
			if (
				row.status === "created" &&
				(row.external_session_id !== input.externalSessionId ||
					row.session_url !== input.sessionUrl)
			) {
				throw new PersistenceConflictError(
					"Idempotent Checkout request resolved to a different Stripe session",
					"IDEMPOTENCY_CONFLICT",
				);
			}
			await executeRows(
				tx,
				drizzleSql`
					UPDATE checkout_requests
					SET
						status = 'created',
						external_session_id = ${input.externalSessionId},
						session_url = ${input.sessionUrl},
						updated_at = now()
					WHERE project_id = ${projectId}
						AND customer_id = ${customer.id}
						AND idempotency_key = ${input.idempotencyKey}
						AND request_hash = ${input.requestHash}
				`,
			);
			return {
				status: "created",
				externalSessionId: input.externalSessionId,
				sessionUrl: input.sessionUrl,
			};
		});
	}

	async getStripeWebStoreProductByKey(
		project: ProjectInstanceContext,
		productKey: string,
	): Promise<StripeWebStoreProductRow> {
		requireNonBlank(productKey, "p_product_key");
		const projectId = project.projectInstanceId;
		const row = await executeOne(
			this.database,
			drizzleSql`
			SELECT jsonb_build_object(
				'storeProductId', sp.id,
				'productId', p.id,
				'productKey', p.key,
				'productType', p.type,
				'creditAmount', p.credit_amount,
				'externalProductId', sp.external_product_id,
				'externalPriceId', sp.external_price_id,
				'billingPeriod', sp.billing_period,
				'currency', sp.currency,
				'priceAmount', sp.price_amount
			) AS value,
			p.type AS product_type,
			sp.price_amount,
			sp.currency
			FROM store_products sp
			JOIN products p ON p.id = sp.product_id AND p.project_id = sp.project_id
			WHERE sp.project_id = ${projectId}
				AND p.key = ${productKey}
				AND p.active = true
				AND sp.active = true
				AND sp.provider = 'stripe'
				AND sp.channel = 'web'
			ORDER BY sp.created_at ASC
			LIMIT 1
		`,
		);
		if (row === null) {
			throw new NotFoundBillingError(
				`Active Stripe web product ${productKey} was not found`,
				"BILLING_PRODUCT_NOT_FOUND",
			);
		}
		if (
			(row.product_type === "consumable" || row.product_type === "non_consumable") &&
			(row.price_amount === null || typeof row.currency !== "string" || row.currency.trim() === "")
		) {
			throw new Error(
				`Stripe consumable product price_amount and currency are required for ${productKey}`,
			);
		}
		return parseStripeWebStoreProductRow((row as { value: unknown }).value);
	}

	async getStripeRecurringCheckoutPlanByKey(
		project: ProjectInstanceContext,
		planKey: string,
		billingAccountId: string,
	): Promise<StripeRecurringCheckoutPlan> {
		requireNonBlank(planKey, "p_plan_key");
		requireNonBlank(billingAccountId, "p_billing_account_id");
		const projectId = project.projectInstanceId;
		const plan = await executeOne<{
			plan_version_id: string | number | bigint;
			plan_key: string;
			name: string;
			plan_kind: "base" | "addon";
			trial_days: number | null;
			trial_requires_payment_method: boolean;
			trial_end_behavior: "cancel" | "pause";
		}>(
			this.database,
			drizzleSql`
				SELECT
					pv.id AS plan_version_id,
					p.key AS plan_key,
					p.name,
					pv.plan_kind,
					pv.trial_days,
					pv.trial_requires_payment_method,
					pv.trial_end_behavior
				FROM plans p
				JOIN plan_versions pv
					ON pv.project_id = p.project_id AND pv.id = p.active_version_id
				WHERE p.project_id = ${projectId}
					AND p.key = ${planKey}
					AND p.active = true
					AND pv.status = 'published'
					AND (
						pv.visibility = 'public'
						OR EXISTS (
							SELECT 1 FROM customers customer
							WHERE customer.project_id = pv.project_id
								AND customer.id = pv.customer_id
								AND customer.billing_account_id = ${billingAccountId}
						)
					)
				LIMIT 1
			`,
		);
		if (plan === null) {
			throw new NotFoundBillingError(
				`Active plan ${planKey} was not found`,
				"BILLING_PLAN_NOT_FOUND",
			);
		}
		const rows = await executeRows<{
			price_component_id: string | number | bigint;
			price_key: string;
			component_kind: "base" | "licensed" | "metered_overage";
			feature_key: string | null;
			external_product_id: string;
			external_price_id: string;
			default_quantity: unknown;
			minimum_quantity: number;
			maximum_quantity: number | null;
			unit_amount_minor: number | string;
			currency: string;
			billing_interval: "month" | "year";
			pricing_model: "flat" | "graduated" | "volume";
		}>(
			this.database,
			drizzleSql`
				SELECT
					pc.id AS price_component_id,
					pc.key AS price_key,
					pc.component_kind,
					f.key AS feature_key,
					sp.external_product_id,
					sp.external_price_id,
					COALESCE(pi.quantity, 1) AS default_quantity,
					pc.minimum_quantity,
					pc.maximum_quantity,
					pc.unit_amount_minor,
					pc.currency,
					pc.billing_interval,
					pc.pricing_model
				FROM price_components pc
				JOIN provider_price_bindings ppb
					ON ppb.project_id = pc.project_id
					AND ppb.price_component_id = pc.id
					AND ppb.provider = 'stripe'
					AND ppb.channel = 'web'
					AND ppb.status = 'published'
				JOIN store_products sp
					ON sp.project_id = ppb.project_id AND sp.id = ppb.store_product_id
				LEFT JOIN plan_items pi
					ON pi.project_id = pc.project_id AND pi.id = pc.plan_item_id
				LEFT JOIN features f
					ON f.project_id = pi.project_id AND f.id = pi.feature_id
				WHERE pc.project_id = ${projectId}
					AND pc.plan_version_id = ${String(plan.plan_version_id)}::bigint
				ORDER BY
					CASE pc.component_kind WHEN 'base' THEN 0 WHEN 'licensed' THEN 1 ELSE 2 END,
					pc.id
			`,
		);
		if (!rows.some((row) => row.component_kind !== "metered_overage")) {
			throw new Error(`Plan ${planKey} has no Stripe Checkout price`);
		}
		return {
			planVersionId: String(plan.plan_version_id),
			planKey: plan.plan_key,
			name: plan.name,
			kind: plan.plan_kind,
			trialDays: plan.trial_days,
			trialRequiresPaymentMethod: plan.trial_requires_payment_method,
			trialEndBehavior: plan.trial_end_behavior,
			components: rows.map((row) => ({
				priceComponentId: String(row.price_component_id),
				priceKey: row.price_key,
				componentKind: row.component_kind,
				featureKey: row.feature_key,
				externalProductId: row.external_product_id,
				externalPriceId: row.external_price_id,
				defaultQuantity: Number(row.default_quantity),
				minimumQuantity: row.minimum_quantity,
				maximumQuantity: row.maximum_quantity,
				unitAmountMinor: Number(row.unit_amount_minor),
				pricingModel: row.pricing_model,
				currency: row.currency.toUpperCase(),
				billingInterval: row.billing_interval,
			})),
		};
	}

	async hasActiveBasePlan(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<boolean> {
		requireNonBlank(billingAccountId, "p_billing_account_id");
		const projectId = project.projectInstanceId;
		const row = await executeOne<{ active: boolean }>(
			this.database,
			drizzleSql`
				SELECT EXISTS (
					SELECT 1
					FROM customers c
					JOIN subscriptions s
						ON s.project_id = c.project_id AND s.customer_id = c.id
					JOIN plan_versions pv
						ON pv.project_id = s.project_id AND pv.id = s.plan_version_id
					WHERE c.project_id = ${projectId}
						AND c.billing_account_id = ${billingAccountId}
						AND pv.plan_kind = 'base'
						AND s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
						AND (s.expires_at IS NULL OR s.expires_at > now())
				) AS active
			`,
		);
		return row?.active === true;
	}

	async getStripeProviderCustomer(
		project: ProjectInstanceContext,
		input: GetStripeProviderCustomerInput,
	): Promise<string | null> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await ensureCustomer(tx, projectId, input.billingAccountId, input.email);
			const row = await executeOne<{ external_customer_id: string }>(
				tx,
				drizzleSql`
				SELECT pc.external_customer_id
				FROM provider_customers pc
				WHERE pc.project_id = ${projectId}
					AND pc.customer_id = ${customer.id}
					AND pc.provider = 'stripe'
				ORDER BY pc.created_at ASC
				LIMIT 1
			`,
			);
			return row?.external_customer_id ?? null;
		});
	}

	async linkStripeProviderCustomer(
		project: ProjectInstanceContext,
		input: LinkStripeProviderCustomerInput,
	): Promise<string> {
		requireStripeCustomerId(input.stripeCustomerId);
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await ensureCustomer(tx, projectId, input.billingAccountId, input.email);
			const existing = await executeOne<{ customer_id: string }>(
				tx,
				drizzleSql`
				SELECT pc.customer_id
				FROM provider_customers pc
				WHERE pc.project_id = ${projectId}
					AND pc.provider = 'stripe'
					AND pc.external_customer_id = ${input.stripeCustomerId}
				LIMIT 1
			`,
			);
			if (existing !== null && existing.customer_id !== customer.id) {
				throw new Error(
					`provider customer identity mismatch for Stripe customer id ${input.stripeCustomerId}`,
				);
			}

			await executeRows(
				tx,
				drizzleSql`
				INSERT INTO provider_customers (
					project_id,
					customer_id,
					provider,
					external_customer_id
				)
				VALUES (${projectId}, ${customer.id}, 'stripe', ${input.stripeCustomerId})
				ON CONFLICT DO NOTHING
			`,
			);

			const linked = await executeOne<{ external_customer_id: string }>(
				tx,
				drizzleSql`
				SELECT pc.external_customer_id
				FROM provider_customers pc
				WHERE pc.project_id = ${projectId}
					AND pc.customer_id = ${customer.id}
					AND pc.provider = 'stripe'
				ORDER BY pc.created_at ASC
				LIMIT 1
			`,
			);
			if (linked === null) {
				throw new Error(
					`provider customer identity mismatch for Stripe customer id ${input.stripeCustomerId}`,
				);
			}
			return linked.external_customer_id;
		});
	}

	async recordStripeCreditPurchaseAndEnqueueProjection(
		project: ProjectInstanceContext,
		input: RecordStripeCreditPurchaseProjectionInput,
	): Promise<StripeRecordingResult> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const resolved = await resolveStripeCustomer(tx, projectId, {
				billingAccountId: input.billingAccountId,
				stripeCustomerId: input.stripeCustomerId,
			});
			if (resolved === null) {
				await recordStripeSkippedEventInTransaction(tx, projectId, {
					eventType: input.eventType,
					externalEventId: input.externalEventId,
					transactionId: input.paymentIntentId,
					purchaseKind: input.purchaseKind,
					processingError: "Stripe customer could not be resolved for one-time purchase",
					rawPayload: input.rawPayload,
					replayStoreEventId: input.replayStoreEventId,
				});
				return skippedStripeRecordingResult();
			}

			if (input.stripeCustomerId !== null) {
				await upsertProviderCustomer(tx, projectId, {
					customerId: resolved.id,
					provider: "stripe",
					externalCustomerId: input.stripeCustomerId,
					identityError: `provider customer identity mismatch for Stripe customer id ${input.stripeCustomerId}`,
				});
			}

			const storeProduct = await getStripeStoreProduct(tx, projectId, {
				externalProductId: input.externalProductId,
				externalPriceId: input.externalPriceId,
			});
			if (storeProduct === null) {
				await recordStripeSkippedEventInTransaction(tx, projectId, {
					eventType: input.eventType,
					externalEventId: input.externalEventId,
					transactionId: input.paymentIntentId,
					purchaseKind: input.purchaseKind,
					processingError: "Stripe catalog product could not be resolved for one-time purchase",
					rawPayload: input.rawPayload,
					replayStoreEventId: input.replayStoreEventId,
				});
				return skippedStripeRecordingResult();
			}
			if (storeProduct.product_type !== input.purchaseKind) {
				await recordStripeSkippedEventInTransaction(tx, projectId, {
					eventType: input.eventType,
					externalEventId: input.externalEventId,
					transactionId: input.paymentIntentId,
					purchaseKind: input.purchaseKind,
					processingError: "Stripe catalog product type mismatch for one-time purchase",
					rawPayload: input.rawPayload,
					replayStoreEventId: input.replayStoreEventId,
				});
				return skippedStripeRecordingResult();
			}

			const storeEvent = await recordStoreEventProcessingResult(tx, projectId, {
				provider: "stripe",
				channel: "web",
				externalEventId: input.externalEventId,
				eventType: input.eventType,
				customerId: resolved.id,
				storeProductId: storeProduct.id,
				transactionId: input.paymentIntentId,
				purchaseKind: input.purchaseKind,
				processingStatus: "processed",
				processingError: null,
				rawPayload: input.rawPayload,
				raiseIdentityMismatch: true,
				replayStoreEventId: input.replayStoreEventId ?? null,
			});
			if (!storeEvent.applied) {
				return processedStripeRecordingResult(
					resolved.billing_account_id,
					await getEntitlementSnapshot(tx, projectId, resolved.billing_account_id),
				);
			}

			const purchaseId = await upsertPurchase(tx, projectId, {
				customerId: resolved.id,
				productId: storeProduct.product_id,
				storeProductId: storeProduct.id,
				subscriptionId: null,
				provider: "stripe",
				channel: "web",
				purchaseKind: input.purchaseKind,
				transactionId: input.paymentIntentId,
				originalTransactionId: input.chargeId,
				status: "completed",
				purchasedAt: input.purchasedAt,
				invalidatedAt: null,
				invalidationReason: null,
				rawPayload: input.rawPayload,
				identityError: `Stripe purchase identity mismatch for payment intent ${input.paymentIntentId}`,
			});
			if (input.purchaseKind === "consumable") {
				await materializeTopupAllocation(tx, {
					projectId,
					customerId: resolved.id,
					storeProductId: storeProduct.id,
					purchaseId,
					purchasedAt: input.purchasedAt,
				});
			}
			await upsertOneTimeStripeInvoice(tx, {
				projectId,
				customerId: resolved.id,
				checkoutSessionId: input.checkoutSessionId,
				amountPaidCents: input.amountPaidCents,
				currency: input.currency,
				purchasedAt: input.purchasedAt,
				rawPayload: input.rawPayload,
			});
			const snapshot = await recomputeCustomerEntitlements(
				tx,
				projectId,
				resolved.billing_account_id,
			);
			await enqueueProjectionSyncJob(tx, {
				customerId: resolved.id,
				idempotencyKey: input.projectionIdempotencyKey,
				reason: "provider_webhook",
				payload: {
					billingAccountId: resolved.billing_account_id,
					reason: "provider_webhook",
					entitlements: snapshot,
					purchase: {
						provider: "stripe",
						channel: "web",
						purchaseKind: input.purchaseKind,
						transactionId: input.paymentIntentId,
						productKey: storeProduct.product_key,
						creditAmount: storeProduct.credit_amount,
						totalCreditAmount: storeProduct.credit_amount,
						quantity: 1,
						purchasedAt: input.purchasedAt.toISOString(),
					},
				},
			});
			return processedStripeRecordingResult(resolved.billing_account_id, snapshot);
		});
	}

	async recordStripeSubscriptionAndEnqueueProjection(
		project: ProjectInstanceContext,
		input: RecordStripeSubscriptionProjectionInput,
	): Promise<StripeRecordingResult> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const transactionId = input.invoiceId ?? input.stripeSubscriptionId;

			if (input.subscriptionStatus === "billing_retry") {
				const existing = await findCustomerBySubscription(
					tx,
					projectId,
					"stripe",
					input.stripeSubscriptionId,
				);
				if (existing === null) {
					await recordStripeSkippedEventInTransaction(tx, projectId, {
						eventType: input.eventType,
						externalEventId: input.externalEventId,
						transactionId,
						purchaseKind: "subscription",
						processingError: "Stripe subscription could not be resolved for billing retry event",
						rawPayload: input.rawPayload,
					});
					return skippedStripeRecordingResult();
				}
			}

			const resolved =
				(await resolveStripeCustomer(tx, projectId, {
					billingAccountId: input.billingAccountId,
					stripeCustomerId: input.stripeCustomerId,
				})) ??
				(await findCustomerBySubscription(tx, projectId, "stripe", input.stripeSubscriptionId));

			if (resolved === null) {
				await recordStripeSkippedEventInTransaction(tx, projectId, {
					eventType: input.eventType,
					externalEventId: input.externalEventId,
					transactionId,
					purchaseKind: "subscription",
					processingError: "Stripe customer could not be resolved for subscription event",
					rawPayload: input.rawPayload,
					replayStoreEventId: input.replayStoreEventId,
				});
				return skippedStripeRecordingResult();
			}

			if (input.stripeCustomerId !== null) {
				await upsertProviderCustomer(tx, projectId, {
					customerId: resolved.id,
					provider: "stripe",
					externalCustomerId: input.stripeCustomerId,
					identityError: `provider customer identity mismatch for Stripe customer id ${input.stripeCustomerId}`,
				});
			}

			const storeProduct = await getStripeStoreProduct(tx, projectId, {
				externalProductId: input.externalProductId,
				externalPriceId: input.externalPriceId,
			});
			if (storeProduct === null) {
				await recordStripeSkippedEventInTransaction(tx, projectId, {
					eventType: input.eventType,
					externalEventId: input.externalEventId,
					transactionId,
					purchaseKind: "subscription",
					processingError: "Stripe catalog product could not be resolved for subscription event",
					rawPayload: input.rawPayload,
					replayStoreEventId: input.replayStoreEventId,
				});
				return skippedStripeRecordingResult();
			}
			if (storeProduct.product_type !== "subscription") {
				await recordStripeSkippedEventInTransaction(tx, projectId, {
					eventType: input.eventType,
					externalEventId: input.externalEventId,
					transactionId,
					purchaseKind: "subscription",
					processingError: "Stripe catalog product type mismatch for subscription event",
					rawPayload: input.rawPayload,
					replayStoreEventId: input.replayStoreEventId,
				});
				return skippedStripeRecordingResult();
			}

			const existingSubscription = await getStripeOperationSubscription(
				tx,
				projectId,
				input.stripeSubscriptionId,
			);

			const storeEvent = await recordStoreEventProcessingResult(tx, projectId, {
				provider: "stripe",
				channel: "web",
				externalEventId: input.externalEventId,
				eventType: input.eventType,
				customerId: resolved.id,
				storeProductId: storeProduct.id,
				transactionId,
				purchaseKind: "subscription",
				processingStatus: "processed",
				processingError: null,
				rawPayload: input.rawPayload,
				raiseIdentityMismatch: true,
				replayStoreEventId: input.replayStoreEventId ?? null,
			});
			if (!storeEvent.applied) {
				return processedStripeRecordingResult(
					resolved.billing_account_id,
					await getEntitlementSnapshot(tx, projectId, resolved.billing_account_id),
				);
			}
			const incomingPeriodEnd = input.currentPeriodEnd ?? input.expiresAt;
			const incomingProviderOrder = input.providerEventCreated ?? 0;
			const isStaleSubscriptionEvent =
				input.externalEventId !== null &&
				existingSubscription !== null &&
				(incomingProviderOrder < existingSubscription.last_provider_event_created ||
					(incomingProviderOrder === existingSubscription.last_provider_event_created &&
						incomingPeriodEnd !== null &&
						existingSubscription.current_period_end !== null &&
						incomingPeriodEnd < existingSubscription.current_period_end));
			if (isStaleSubscriptionEvent) {
				const snapshot = await getEntitlementSnapshot(tx, projectId, resolved.billing_account_id);
				await enqueueProjectionSyncJob(tx, {
					customerId: resolved.id,
					idempotencyKey: input.projectionIdempotencyKey,
					reason: input.projectionReason,
					payload: {
						billingAccountId: resolved.billing_account_id,
						reason: input.projectionReason,
						entitlements: snapshot,
					},
				});
				return processedStripeRecordingResult(resolved.billing_account_id, snapshot);
			}

			const deferredDowngrade =
				input.eventType === "customer.subscription.updated" &&
				input.cancelAtPeriodEnd === true &&
				existingSubscription !== null &&
				storeProduct.credit_amount < existingSubscription.credit_amount;
			const effectiveProduct = deferredDowngrade
				? existingSubscription
				: {
						product_id: storeProduct.product_id,
						store_product_id: storeProduct.id,
						product_key: storeProduct.product_key,
						credit_amount: storeProduct.credit_amount,
						external_product_id: input.externalProductId,
						external_price_id: input.externalPriceId,
					};
			const currentPeriodStart =
				input.currentPeriodStart ??
				existingSubscription?.current_period_start ??
				input.startsAt ??
				input.purchasedAt;
			const currentPeriodEnd =
				input.currentPeriodEnd ??
				input.expiresAt ??
				existingSubscription?.current_period_end ??
				null;

			const subscriptionRecordId = await upsertSubscription(tx, projectId, {
				customerId: resolved.id,
				productId: effectiveProduct.product_id,
				storeProductId: effectiveProduct.store_product_id,
				provider: "stripe",
				channel: "web",
				externalSubscriptionId: input.stripeSubscriptionId,
				externalProductId: effectiveProduct.external_product_id,
				externalPriceId: effectiveProduct.external_price_id,
				status: input.subscriptionStatus,
				startsAt: input.startsAt ?? input.purchasedAt,
				expiresAt: input.expiresAt,
				autoRenew: input.autoRenew ?? false,
				latestTransactionId: transactionId,
				providerStatus: input.providerStatus ?? input.subscriptionStatus,
				currentPeriodStart,
				currentPeriodEnd,
				cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
				latestProviderObjectId: input.invoiceId,
				lastProviderEventCreated: input.providerEventCreated ?? 0,
				enforceProviderEventOrder: input.externalEventId !== null,
				rawState: stripNulls({
					stripeCustomerId: input.stripeCustomerId,
					stripeSubscriptionId: input.stripeSubscriptionId,
					invoiceId: input.invoiceId,
					payload: input.rawPayload,
				}),
				updateProduct: true,
				identityError: `Stripe subscription identity mismatch for subscription ${input.stripeSubscriptionId}`,
			});
			await materializeSubscriptionAllocations(tx, {
				projectId,
				customerId: resolved.id,
				storeProductId: effectiveProduct.store_product_id,
				subscriptionId: subscriptionRecordId,
				status: input.subscriptionStatus,
				periodStartAt: currentPeriodStart,
				periodEndAt: currentPeriodEnd,
			});
			await syncSubscriptionPriceItems(tx, {
				projectId,
				subscriptionId: subscriptionRecordId,
				periodStartAt: currentPeriodStart,
				items: input.items ?? [],
			});
			await executeRows(
				tx,
				drizzleSql`
					UPDATE subscriptions
					SET
						trial_start_at = ${input.trialStart?.toISOString() ?? null},
						trial_end_at = ${input.trialEnd?.toISOString() ?? null},
						billing_anchor_at = COALESCE(billing_anchor_at, ${currentPeriodStart.toISOString()}),
						updated_at = now()
					WHERE project_id = ${projectId} AND id = ${subscriptionRecordId}
				`,
			);
			if (
				input.invoiceId !== null &&
				input.invoiceStatus !== null &&
				input.invoiceStatus !== undefined
			) {
				await upsertStripeInvoice(tx, {
					projectId,
					customerId: resolved.id,
					subscriptionId: subscriptionRecordId,
					externalInvoiceId: input.invoiceId,
					externalSubscriptionId: input.stripeSubscriptionId,
					status: input.invoiceStatus,
					amountPaid: input.invoiceAmountPaid ?? 0,
					currency: input.invoiceCurrency ?? "usd",
					paidAt: input.invoicePaidAt ?? null,
					providerCreatedAt: input.purchasedAt,
					lastProviderEventCreated: input.providerEventCreated ?? 0,
					rawPayload: input.rawPayload,
				});
			}

			const snapshot = await recomputeCustomerEntitlements(
				tx,
				projectId,
				resolved.billing_account_id,
			);
			await enqueueProjectionSyncJob(tx, {
				customerId: resolved.id,
				idempotencyKey: input.projectionIdempotencyKey,
				reason: input.projectionReason,
				payload: {
					billingAccountId: resolved.billing_account_id,
					reason: input.projectionReason,
					entitlements: snapshot,
				},
			});
			return processedStripeRecordingResult(resolved.billing_account_id, snapshot);
		});
	}

	async recordStripeCreditReversalAndEnqueueProjection(
		project: ProjectInstanceContext,
		input: RecordStripeCreditReversalProjectionInput,
	): Promise<StripeRecordingResult> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const target = await findStripeCreditReversalTarget(tx, projectId, input.paymentIntentId);
			if (target === null) {
				await recordStripeSkippedEventInTransaction(tx, projectId, {
					eventType: input.eventType,
					externalEventId: input.externalEventId,
					transactionId: input.reversalId,
					purchaseKind: null,
					processingError: "Stripe one-time purchase reversal target could not be resolved",
					rawPayload: input.rawPayload,
					replayStoreEventId: input.replayStoreEventId,
				});
				return skippedStripeRecordingResult();
			}
			const originalPriceAmount = parseStripeAmountForComparison(target.price_amount);
			if (originalPriceAmount === null || originalPriceAmount <= 0n) {
				await recordStripeSkippedEventInTransaction(tx, projectId, {
					eventType: input.eventType,
					externalEventId: input.externalEventId,
					transactionId: input.reversalId,
					purchaseKind: target.purchase_kind,
					processingError: "Stripe original purchase amount is invalid for credit reversal",
					rawPayload: input.rawPayload,
					replayStoreEventId: input.replayStoreEventId,
				});
				return skippedStripeRecordingResult();
			}
			const reversalAmount = parseStripeAmountForComparison(input.reversalAmount);
			if (reversalAmount === null) {
				await recordStripeSkippedEventInTransaction(tx, projectId, {
					eventType: input.eventType,
					externalEventId: input.externalEventId,
					transactionId: input.reversalId,
					purchaseKind: target.purchase_kind,
					processingError: "Stripe credit reversal amount is invalid for credit reversal",
					rawPayload: input.rawPayload,
					replayStoreEventId: input.replayStoreEventId,
				});
				return skippedStripeRecordingResult();
			}
			const previousReversedAmount = parseStripeAmountForComparison(target.reversed_amount ?? 0);
			const previousReversedCreditAmount = parseNullableNonnegativeInteger(
				target.reversed_credit_amount,
				"Stripe prior reversed credit amount is invalid for credit reversal",
			);
			if (previousReversedAmount === null || previousReversedCreditAmount === null) {
				await recordStripeSkippedEventInTransaction(tx, projectId, {
					eventType: input.eventType,
					externalEventId: input.externalEventId,
					transactionId: input.reversalId,
					purchaseKind: target.purchase_kind,
					processingError: "Stripe prior reversal amount is invalid for credit reversal",
					rawPayload: input.rawPayload,
					replayStoreEventId: input.replayStoreEventId,
				});
				return skippedStripeRecordingResult();
			}
			if (
				reversalAmount > originalPriceAmount ||
				(target.currency ?? "").toLowerCase() !== input.reversalCurrency.toLowerCase()
			) {
				await recordStripeSkippedEventInTransaction(tx, projectId, {
					eventType: input.eventType,
					externalEventId: input.externalEventId,
					transactionId: input.reversalId,
					purchaseKind: target.purchase_kind,
					processingError:
						"Stripe credit reversal amount or currency does not match original purchase",
					rawPayload: input.rawPayload,
					replayStoreEventId: input.replayStoreEventId,
				});
				return skippedStripeRecordingResult();
			}
			const nextReversedAmount = minBigInt(
				originalPriceAmount,
				previousReversedAmount + reversalAmount,
			);
			const nextReversedCreditAmount = proratedReversedCreditAmount(
				target.credit_amount,
				originalPriceAmount,
				nextReversedAmount,
			);
			const reversalCreditAmount = Math.max(
				0,
				nextReversedCreditAmount - previousReversedCreditAmount,
			);
			const fullyReversed = nextReversedAmount >= originalPriceAmount;
			const duplicateReversal = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					SELECT events.id
					FROM store_events events
					WHERE events.project_id = ${projectId}
						AND events.provider = 'stripe'
						AND events.transaction_id = ${input.reversalId}
						AND events.processing_status = 'processed'
						AND events.external_event_id IS DISTINCT FROM ${input.externalEventId}
						AND (
							(${input.reversalReason} = 'refund' AND events.event_type IN ('refund.created', 'refund.updated'))
							OR (${input.reversalReason} = 'dispute' AND events.event_type = 'charge.dispute.created')
						)
					LIMIT 1
				`,
			);

			const storeEvent = await recordStoreEventProcessingResult(tx, projectId, {
				provider: "stripe",
				channel: "web",
				externalEventId: input.externalEventId,
				eventType: input.eventType,
				customerId: target.customer_id,
				storeProductId: target.store_product_id,
				transactionId: input.reversalId,
				purchaseKind: target.purchase_kind,
				processingStatus: "processed",
				processingError: null,
				rawPayload: input.rawPayload,
				raiseIdentityMismatch: true,
				replayStoreEventId: input.replayStoreEventId ?? null,
			});
			if (!storeEvent.applied || duplicateReversal !== null) {
				return processedStripeRecordingResult(
					target.billing_account_id,
					await getEntitlementSnapshot(tx, projectId, target.billing_account_id),
				);
			}
			const purchaseStatus: PurchaseStatus =
				input.reversalReason === "refund" ? "refunded" : "voided";
			await executeRows(
				tx,
				drizzleSql`
				UPDATE purchases pu
				SET
					status = CASE WHEN ${fullyReversed} THEN ${purchaseStatus} ELSE pu.status END,
					invalidated_at = CASE WHEN ${fullyReversed} THEN ${input.reversedAt.toISOString()} ELSE pu.invalidated_at END,
					invalidation_reason = CASE WHEN ${fullyReversed} THEN ${input.reversalReason} ELSE pu.invalidation_reason END,
					reversed_amount = ${nextReversedAmount.toString()}::bigint,
					reversed_credit_amount = ${nextReversedCreditAmount},
					raw_payload = jsonb_set(
						jsonb_set(pu.raw_payload, '{stripeReversal}', ${jsonb(input.rawPayload)}, true),
						'{stripeReversalState}',
						${jsonb({
							reversedAmount: nextReversedAmount.toString(),
							reversedCreditAmount: nextReversedCreditAmount,
						})},
						true
					),
					updated_at = now()
				WHERE pu.id = ${target.purchase_id}
			`,
			);
			if (target.purchase_kind === "consumable") {
				await setPurchaseAllocationReversal(tx, {
					projectId,
					purchaseId: target.purchase_id,
					reversedCreditAmount: nextReversedCreditAmount,
					totalCreditAmount: target.credit_amount,
					reversedAt: input.reversedAt,
				});
			}

			const snapshot = await recomputeCustomerEntitlements(
				tx,
				projectId,
				target.billing_account_id,
			);
			await enqueueProjectionSyncJob(tx, {
				customerId: target.customer_id,
				idempotencyKey: input.projectionIdempotencyKey,
				reason: "provider_webhook",
				payload: {
					billingAccountId: target.billing_account_id,
					reason: "provider_webhook",
					entitlements: snapshot,
					reversal: {
						provider: "stripe",
						channel: "web",
						reason: input.reversalReason,
						transactionId: input.reversalId,
						originalTransactionId: input.paymentIntentId,
						productKey: target.product_key,
						creditAmount: reversalCreditAmount,
						totalCreditAmount: target.credit_amount,
						quantity: 1,
						reversedAt: input.reversedAt.toISOString(),
					},
				},
			});
			return processedStripeRecordingResult(target.billing_account_id, snapshot);
		});
	}

	async recordStripeSkippedEvent(
		project: ProjectInstanceContext,
		input: RecordStripeSkippedEventInput,
	): Promise<StripeRecordingResult> {
		return await this.transaction(async (tx) => {
			await recordStripeSkippedEventInTransaction(tx, project.projectInstanceId, input);
			return skippedStripeRecordingResult();
		});
	}
}

interface CheckoutRequestRow {
	store_product_id: string | null;
	plan_version_id: string | null;
	request_hash: string;
	status: "creating" | "created";
	external_session_id: string | null;
	session_url: string | null;
}

interface StripeOperationSubscriptionRow {
	id: string;
	product_id: string;
	store_product_id: string;
	product_key: string;
	credit_amount: number;
	external_product_id: string;
	external_price_id: string | null;
	current_period_start: Date | null;
	current_period_end: Date | null;
	last_provider_event_created: number;
}

async function getStripeOperationSubscription(
	executor: QueryExecutor,
	projectId: string,
	externalSubscriptionId: string,
): Promise<StripeOperationSubscriptionRow | null> {
	const row = await executeOne<{
		id: string;
		product_id: string;
		store_product_id: string;
		product_key: string;
		credit_amount: number;
		external_product_id: string;
		external_price_id: string | null;
		current_period_start: Date | string | null;
		current_period_end: Date | string | null;
		last_provider_event_created: number | string;
	}>(
		executor,
		drizzleSql`
			SELECT
				s.id,
				s.product_id,
				s.store_product_id,
				p.key AS product_key,
				p.credit_amount,
				s.external_product_id,
				s.external_price_id,
				s.current_period_start,
				s.current_period_end,
				s.last_provider_event_created
			FROM subscriptions s
			JOIN products p ON p.project_id = s.project_id AND p.id = s.product_id
			WHERE s.project_id = ${projectId}
				AND s.provider = 'stripe'
				AND s.external_subscription_id = ${externalSubscriptionId}
			FOR UPDATE
		`,
	);
	if (row === null) {
		return null;
	}
	return {
		...row,
		current_period_start: dateOrNull(row.current_period_start),
		current_period_end: dateOrNull(row.current_period_end),
		last_provider_event_created: Number(row.last_provider_event_created),
	};
}

async function upsertOneTimeStripeInvoice(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		checkoutSessionId?: string | null;
		amountPaidCents?: number | null;
		currency?: string | null;
		purchasedAt: Date;
		rawPayload: Record<string, unknown>;
	},
): Promise<void> {
	const checkoutSessionId = input.checkoutSessionId?.trim() ?? "";
	const currency = input.currency?.trim() ?? "";
	if (
		checkoutSessionId.length === 0 ||
		currency.length === 0 ||
		input.amountPaidCents === undefined ||
		input.amountPaidCents === null
	) {
		return;
	}

	await upsertStripeInvoice(executor, {
		projectId: input.projectId,
		customerId: input.customerId,
		subscriptionId: null,
		externalInvoiceId: checkoutSessionId,
		externalSubscriptionId: null,
		status: "paid",
		amountPaid: input.amountPaidCents,
		currency,
		paidAt: input.purchasedAt,
		providerCreatedAt: input.purchasedAt,
		lastProviderEventCreated: 0,
		rawPayload: input.rawPayload,
	});
}

async function upsertStripeInvoice(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		subscriptionId: string | null;
		externalInvoiceId: string;
		externalSubscriptionId: string | null;
		status: string;
		amountPaid: number;
		currency: string;
		paidAt: Date | null;
		providerCreatedAt: Date;
		lastProviderEventCreated: number;
		rawPayload: Record<string, unknown>;
	},
): Promise<void> {
	await executeRows(
		executor,
		drizzleSql`
			INSERT INTO billing_invoices (
				project_id,
				customer_id,
				subscription_id,
				external_invoice_id,
				external_subscription_id,
				status,
				amount_paid,
				currency,
				paid_at,
				provider_created_at,
				last_provider_event_created,
				raw_payload
			)
			VALUES (
				${input.projectId},
				${input.customerId},
				${input.subscriptionId},
				${input.externalInvoiceId},
				${input.externalSubscriptionId},
				${input.status},
				${input.amountPaid},
				${input.currency.toLowerCase()},
				${input.paidAt?.toISOString() ?? null},
				${input.providerCreatedAt.toISOString()},
				${input.lastProviderEventCreated},
				${jsonb(input.rawPayload)}
			)
			ON CONFLICT (project_id, external_invoice_id) DO UPDATE SET
				subscription_id = EXCLUDED.subscription_id,
				status = EXCLUDED.status,
				amount_paid = EXCLUDED.amount_paid,
				currency = EXCLUDED.currency,
				paid_at = EXCLUDED.paid_at,
				provider_created_at = EXCLUDED.provider_created_at,
				last_provider_event_created = EXCLUDED.last_provider_event_created,
				raw_payload = EXCLUDED.raw_payload,
				updated_at = now()
			WHERE billing_invoices.customer_id = EXCLUDED.customer_id
				AND billing_invoices.external_subscription_id IS NOT DISTINCT FROM EXCLUDED.external_subscription_id
				AND billing_invoices.last_provider_event_created <= EXCLUDED.last_provider_event_created
		`,
	);
}

function dateOrNull(value: Date | string | null): Date | null {
	return value === null ? null : new Date(value);
}

async function checkoutRequestState(
	executor: QueryExecutor,
	input: { projectId: string; customerId: string; idempotencyKey: string },
): Promise<CheckoutRequestRow> {
	const row = await executeOne<CheckoutRequestRow>(
		executor,
		drizzleSql`
				SELECT
					store_product_id,
					plan_version_id::text,
				request_hash,
				status,
				external_session_id,
				session_url
			FROM checkout_requests
			WHERE project_id = ${input.projectId}
				AND customer_id = ${input.customerId}
				AND idempotency_key = ${input.idempotencyKey}
			LIMIT 1
		`,
	);
	if (row === null) {
		throw new Error("Stripe Checkout request could not be persisted");
	}
	return row;
}

function stripeCheckoutRequestState(row: CheckoutRequestRow): StripeCheckoutRequestState {
	return {
		status: row.status,
		externalSessionId: row.external_session_id,
		sessionUrl: row.session_url,
	};
}

function billingAccountSubscriptionStatus(
	value: string,
): "trialing" | "active" | "past_due" | "unpaid" | "cancelled" {
	switch (value) {
		case "trialing":
		case "active":
		case "past_due":
		case "unpaid":
		case "cancelled":
			return value;
		case "canceled":
		case "expired":
		case "refunded":
		case "revoked":
			return "cancelled";
		case "billing_retry":
			return "past_due";
		default:
			return "active";
	}
}

function billingAccountInvoiceStatus(
	value: string,
): "draft" | "open" | "paid" | "uncollectible" | "void" | "unknown" {
	switch (value) {
		case "draft":
		case "open":
		case "paid":
		case "uncollectible":
		case "void":
			return value;
		default:
			return "unknown";
	}
}

function isoTimestamp(value: Date | string | null): string | null {
	return value === null ? null : new Date(value).toISOString();
}

function requiredIsoTimestamp(value: Date | string): string {
	return new Date(value).toISOString();
}
