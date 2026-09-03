import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	primaryKey,
	smallint,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type {
	BillingChannel,
	BillingProvider,
	ProjectionJobPayload,
	ProjectionSyncReason,
	ProjectionSyncStatus,
	PurchaseKind,
	PurchaseStatus,
	StoreEventProcessingStatus,
	SubscriptionStatus,
} from "../billing/types";

const metadataColumn = () =>
	jsonb("metadata").$type<Record<string, unknown>>().notNull().default({});
const timestampColumns = () => ({
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable(
	"projects",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		key: text("key").notNull(),
		name: text("name").notNull(),
		active: boolean("active").notNull().default(true),
		publishedCatalogRevisionId: bigint("published_catalog_revision_id", { mode: "number" }),
		metadata: metadataColumn(),
		...timestampColumns(),
	},
	(table) => [uniqueIndex("idx_billing_projects_key").on(table.key)],
);

export const customers = pgTable(
	"customers",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		billingAccountId: text("billing_account_id").notNull(),
		email: text("email"),
		metadata: metadataColumn(),
		...timestampColumns(),
	},
	(table) => [
		unique("customers_project_id_id_unique").on(table.projectId, table.id),
		uniqueIndex("idx_billing_customers_billing_account_id").on(
			table.projectId,
			table.billingAccountId,
		),
	],
);

export const products = pgTable(
	"products",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		key: text("key").notNull(),
		entitlementKey: text("entitlement_key").notNull(),
		creditAmount: integer("credit_amount").notNull().default(0),
		name: text("name"),
		description: text("description"),
		type: text("type").$type<PurchaseKind>().notNull(),
		active: boolean("active").notNull().default(true),
		metadata: metadataColumn(),
		...timestampColumns(),
	},
	(table) => [
		unique("products_project_id_id_unique").on(table.projectId, table.id),
		uniqueIndex("idx_billing_products_key").on(table.projectId, table.key),
		check("products_credit_amount_check", sql`${table.creditAmount} >= 0`),
		check(
			"products_type_check",
			sql`${table.type} IN ('subscription', 'consumable', 'non_consumable')`,
		),
	],
);

export const storeProducts = pgTable(
	"store_products",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		productId: uuid("product_id")
			.notNull()
			.references(() => products.id, { onDelete: "restrict" }),
		provider: text("provider").$type<BillingProvider>().notNull(),
		channel: text("channel").$type<BillingChannel>().notNull(),
		externalProductId: text("external_product_id").notNull(),
		externalPriceId: text("external_price_id"),
		billingPeriod: text("billing_period").notNull(),
		currency: text("currency"),
		priceAmount: bigint("price_amount", { mode: "number" }),
		active: boolean("active").notNull().default(true),
		metadata: metadataColumn(),
		...timestampColumns(),
	},
	(table) => [
		unique("store_products_project_id_id_unique").on(table.projectId, table.id),
		foreignKey({
			name: "store_products_project_product_fk",
			columns: [table.projectId, table.productId],
			foreignColumns: [products.projectId, products.id],
		}),
		uniqueIndex("idx_billing_store_products_price")
			.on(table.projectId, table.provider, table.externalProductId, table.externalPriceId)
			.where(sql`${table.externalPriceId} IS NOT NULL`),
		uniqueIndex("idx_billing_store_products_no_price")
			.on(table.projectId, table.provider, table.externalProductId)
			.where(sql`${table.externalPriceId} IS NULL`),
		index("idx_billing_store_products_product_id").on(table.productId),
		check("store_products_provider_check", sql`${table.provider} IN ('apple', 'google', 'stripe')`),
		check("store_products_channel_check", sql`${table.channel} IN ('ios', 'android', 'web')`),
	],
);

export const providerCustomers = pgTable(
	"provider_customers",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		storeProductId: uuid("store_product_id")
			.notNull()
			.references(() => storeProducts.id, { onDelete: "restrict" }),
		provider: text("provider").$type<BillingProvider>().notNull(),
		externalCustomerId: text("external_customer_id").notNull(),
		metadata: metadataColumn(),
		...timestampColumns(),
	},
	(table) => [
		unique("provider_customers_project_id_id_unique").on(table.projectId, table.id),
		foreignKey({
			name: "provider_customers_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		uniqueIndex("idx_billing_provider_customers_external").on(
			table.projectId,
			table.provider,
			table.externalCustomerId,
		),
		uniqueIndex("idx_billing_provider_customers_stripe_customer")
			.on(table.projectId, table.customerId, table.provider)
			.where(sql`${table.provider} = 'stripe'`),
		index("idx_billing_provider_customers_customer_id").on(table.customerId),
		index("idx_billing_provider_customers_external_customer_id").on(table.externalCustomerId),
		check(
			"provider_customers_provider_check",
			sql`${table.provider} IN ('apple', 'google', 'stripe')`,
		),
	],
);

export const subscriptions = pgTable(
	"subscriptions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		productId: uuid("product_id")
			.notNull()
			.references(() => products.id, { onDelete: "restrict" }),
		storeProductId: uuid("store_product_id")
			.notNull()
			.references(() => storeProducts.id, { onDelete: "restrict" }),
		provider: text("provider").$type<BillingProvider>().notNull(),
		channel: text("channel").$type<BillingChannel>().notNull(),
		externalSubscriptionId: text("external_subscription_id").notNull(),
		externalProductId: text("external_product_id").notNull(),
		externalPriceId: text("external_price_id"),
		status: text("status").$type<SubscriptionStatus>().notNull(),
		providerStatus: text("provider_status"),
		startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		currentPeriodStart: timestamp("current_period_start", { withTimezone: true }),
		currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
		cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
		trialStartAt: timestamp("trial_start_at", { withTimezone: true }),
		trialEndAt: timestamp("trial_end_at", { withTimezone: true }),
		billingAnchorAt: timestamp("billing_anchor_at", { withTimezone: true }),
		providerScheduleId: text("provider_schedule_id"),
		autoRenew: boolean("auto_renew").notNull().default(true),
		latestTransactionId: text("latest_transaction_id"),
		latestProviderObjectId: text("latest_provider_object_id"),
		lastProviderEventCreated: bigint("last_provider_event_created", { mode: "number" })
			.notNull()
			.default(0),
		planVersionId: bigint("plan_version_id", { mode: "number" }),
		catalogRevisionId: bigint("catalog_revision_id", { mode: "number" }),
		entityId: bigint("entity_id", { mode: "number" }),
		scopeMode: text("scope_mode").$type<"account" | "entity">().notNull().default("account"),
		rawState: jsonb("raw_state").$type<Record<string, unknown>>().notNull().default({}),
		providerReconciliationAttempts: integer("provider_reconciliation_attempts")
			.notNull()
			.default(0),
		providerReconciliationError: text("provider_reconciliation_error"),
		providerReconciliationNextAttemptAt: timestamp("provider_reconciliation_next_attempt_at", {
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
		providerReconciliationLockedAt: timestamp("provider_reconciliation_locked_at", {
			withTimezone: true,
		}),
		providerReconciliationLockedBy: text("provider_reconciliation_locked_by"),
		providerReconciledAt: timestamp("provider_reconciled_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table) => [
		unique("subscriptions_project_id_id_unique").on(table.projectId, table.id),
		foreignKey({
			name: "subscriptions_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "subscriptions_project_product_fk",
			columns: [table.projectId, table.productId],
			foreignColumns: [products.projectId, products.id],
		}),
		foreignKey({
			name: "subscriptions_project_store_product_fk",
			columns: [table.projectId, table.storeProductId],
			foreignColumns: [storeProducts.projectId, storeProducts.id],
		}),
		uniqueIndex("idx_billing_subscriptions_external").on(
			table.projectId,
			table.provider,
			table.externalSubscriptionId,
		),
		index("idx_billing_subscriptions_customer_status").on(table.customerId, table.status),
		index("idx_billing_subscriptions_customer_expires").on(table.customerId, table.expiresAt),
		index("idx_billing_subscriptions_product_id").on(table.productId),
		index("idx_billing_subscriptions_store_product_id").on(table.storeProductId),
		index("idx_billing_subscriptions_latest_transaction").on(table.latestTransactionId),
		index("idx_billing_subscriptions_entity")
			.on(table.projectId, table.entityId, table.status)
			.where(sql`${table.entityId} IS NOT NULL`),
		index("idx_billing_subscriptions_last_provider_event").on(
			table.projectId,
			table.provider,
			table.lastProviderEventCreated,
		),
		index("idx_billing_subscriptions_provider_reconciliation_due")
			.on(table.providerReconciliationNextAttemptAt, table.providerReconciledAt, table.expiresAt)
			.where(sql`${table.status} IN ('active', 'grace_period', 'billing_retry', 'cancelled')`),
		check("subscriptions_provider_check", sql`${table.provider} IN ('apple', 'google', 'stripe')`),
		check("subscriptions_channel_check", sql`${table.channel} IN ('ios', 'android', 'web')`),
		check(
			"subscriptions_status_check",
			sql`${table.status} IN ('active', 'grace_period', 'billing_retry', 'cancelled', 'expired', 'refunded', 'revoked')`,
		),
	],
);

export const checkoutRequests = pgTable(
	"checkout_requests",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		storeProductId: uuid("store_product_id").references(() => storeProducts.id, {
			onDelete: "restrict",
		}),
		planVersionId: bigint("plan_version_id", { mode: "number" }).references(() => planVersions.id, {
			onDelete: "restrict",
		}),
		requestedQuantities: jsonb("requested_quantities")
			.$type<Record<string, number>>()
			.notNull()
			.default({}),
		requestedAddonPlanVersionIds: bigint("requested_addon_plan_version_ids", {
			mode: "number",
		})
			.array()
			.notNull()
			.default([]),
		provider: text("provider").$type<"stripe">().notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		requestHash: text("request_hash").notNull(),
		status: text("status").$type<"creating" | "created">().notNull().default("creating"),
		externalSessionId: text("external_session_id"),
		sessionUrl: text("session_url"),
		...timestampColumns(),
	},
	(table) => [
		unique("checkout_requests_project_id_id_unique").on(table.projectId, table.id),
		foreignKey({
			name: "checkout_requests_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "checkout_requests_project_store_product_fk",
			columns: [table.projectId, table.storeProductId],
			foreignColumns: [storeProducts.projectId, storeProducts.id],
		}),
		uniqueIndex("idx_billing_checkout_requests_idempotency").on(
			table.projectId,
			table.customerId,
			table.idempotencyKey,
		),
		uniqueIndex("idx_billing_checkout_requests_session")
			.on(table.projectId, table.provider, table.externalSessionId)
			.where(sql`${table.externalSessionId} IS NOT NULL`),
		index("idx_billing_checkout_requests_customer_created").on(table.customerId, table.createdAt),
		index("idx_billing_checkout_requests_store_product_id").on(table.storeProductId),
		check("checkout_requests_provider_check", sql`${table.provider} = 'stripe'`),
		check(
			"checkout_requests_idempotency_key_check",
			sql`char_length(${table.idempotencyKey}) BETWEEN 1 AND 200`,
		),
		check("checkout_requests_request_hash_check", sql`char_length(${table.requestHash}) = 64`),
		check("checkout_requests_status_check", sql`${table.status} IN ('creating', 'created')`),
		check(
			"checkout_requests_target_check",
			sql`(${table.storeProductId} IS NOT NULL AND ${table.planVersionId} IS NULL)
				OR (${table.storeProductId} IS NULL AND ${table.planVersionId} IS NOT NULL)`,
		),
	],
);

export const creditGrants = pgTable(
	"credit_grants",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
			onDelete: "set null",
		}),
		grantKey: text("grant_key").notNull(),
		grantKind: text("grant_kind").$type<"monthly" | "upgrade" | "topup">().notNull(),
		credits: integer("credits").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		plan: text("plan"),
		sourceEventId: text("source_event_id").notNull(),
		...timestampColumns(),
	},
	(table) => [
		unique("credit_grants_project_id_id_unique").on(table.projectId, table.id),
		foreignKey({
			name: "credit_grants_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "credit_grants_project_subscription_fk",
			columns: [table.projectId, table.subscriptionId],
			foreignColumns: [subscriptions.projectId, subscriptions.id],
		}),
		uniqueIndex("idx_billing_credit_grants_key").on(table.projectId, table.grantKey),
		index("idx_billing_credit_grants_customer_created").on(table.customerId, table.createdAt),
		index("idx_billing_credit_grants_subscription_id")
			.on(table.subscriptionId)
			.where(sql`${table.subscriptionId} IS NOT NULL`),
		check("credit_grants_kind_check", sql`${table.grantKind} IN ('monthly', 'upgrade', 'topup')`),
		check("credit_grants_credits_check", sql`${table.credits} > 0`),
		check(
			"credit_grants_expiry_check",
			sql`(${table.grantKind} = 'topup' AND ${table.expiresAt} IS NULL AND ${table.subscriptionId} IS NULL)
				OR (${table.grantKind} IN ('monthly', 'upgrade') AND ${table.expiresAt} IS NOT NULL)`,
		),
	],
);

export const creditGrantProviderObjects = pgTable(
	"credit_grant_provider_objects",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		grantId: uuid("grant_id")
			.notNull()
			.references(() => creditGrants.id, { onDelete: "cascade" }),
		provider: text("provider").$type<BillingProvider>().notNull(),
		providerObjectId: text("provider_object_id").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		foreignKey({
			name: "credit_grant_provider_objects_project_grant_fk",
			columns: [table.projectId, table.grantId],
			foreignColumns: [creditGrants.projectId, creditGrants.id],
		}).onDelete("cascade"),
		uniqueIndex("idx_billing_credit_grant_provider_object").on(
			table.projectId,
			table.provider,
			table.providerObjectId,
		),
		index("idx_billing_credit_grant_provider_objects_grant_id").on(table.grantId),
		check(
			"credit_grant_provider_objects_provider_check",
			sql`${table.provider} IN ('apple', 'google', 'stripe')`,
		),
	],
);

export const creditReversals = pgTable(
	"credit_reversals",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		grantId: uuid("grant_id")
			.notNull()
			.references(() => creditGrants.id, { onDelete: "restrict" }),
		reversalKey: text("reversal_key").notNull(),
		reason: text("reason").$type<"refund" | "dispute" | "void">().notNull(),
		expectedCredits: integer("expected_credits").notNull(),
		sourceEventId: text("source_event_id").notNull(),
		providerObjectId: text("provider_object_id").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("credit_reversals_project_id_id_unique").on(table.projectId, table.id),
		foreignKey({
			name: "credit_reversals_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "credit_reversals_project_grant_fk",
			columns: [table.projectId, table.grantId],
			foreignColumns: [creditGrants.projectId, creditGrants.id],
		}),
		uniqueIndex("idx_billing_credit_reversals_key").on(table.projectId, table.reversalKey),
		uniqueIndex("idx_billing_credit_reversals_first_grant").on(table.projectId, table.grantId),
		index("idx_billing_credit_reversals_customer_created").on(table.customerId, table.createdAt),
		index("idx_billing_credit_reversals_grant_id").on(table.grantId),
		check("credit_reversals_reason_check", sql`${table.reason} IN ('refund', 'dispute', 'void')`),
		check("credit_reversals_expected_credits_check", sql`${table.expectedCredits} > 0`),
	],
);

export const billingInvoices = pgTable(
	"billing_invoices",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
			onDelete: "set null",
		}),
		externalInvoiceId: text("external_invoice_id").notNull(),
		externalSubscriptionId: text("external_subscription_id"),
		status: text("status").notNull(),
		amountPaid: bigint("amount_paid", { mode: "number" }).notNull().default(0),
		currency: text("currency").notNull(),
		paidAt: timestamp("paid_at", { withTimezone: true }),
		providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }).notNull(),
		lastProviderEventCreated: bigint("last_provider_event_created", { mode: "number" })
			.notNull()
			.default(0),
		rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull().default({}),
		...timestampColumns(),
	},
	(table) => [
		unique("billing_invoices_project_id_id_unique").on(table.projectId, table.id),
		foreignKey({
			name: "billing_invoices_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "billing_invoices_project_subscription_fk",
			columns: [table.projectId, table.subscriptionId],
			foreignColumns: [subscriptions.projectId, subscriptions.id],
		}),
		uniqueIndex("idx_billing_invoices_external").on(table.projectId, table.externalInvoiceId),
		index("idx_billing_invoices_customer_created").on(table.customerId, table.providerCreatedAt),
		index("idx_billing_invoices_subscription_id")
			.on(table.subscriptionId)
			.where(sql`${table.subscriptionId} IS NOT NULL`),
		check("billing_invoices_amount_paid_check", sql`${table.amountPaid} >= 0`),
	],
);

export const purchases = pgTable(
	"purchases",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		productId: uuid("product_id")
			.notNull()
			.references(() => products.id, { onDelete: "restrict" }),
		storeProductId: uuid("store_product_id").references(() => storeProducts.id, {
			onDelete: "set null",
		}),
		subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
			onDelete: "set null",
		}),
		provider: text("provider").$type<BillingProvider>().notNull(),
		channel: text("channel").$type<BillingChannel>().notNull(),
		purchaseKind: text("purchase_kind").$type<PurchaseKind>().notNull(),
		transactionId: text("transaction_id").notNull(),
		originalTransactionId: text("original_transaction_id"),
		status: text("status").$type<PurchaseStatus>().notNull(),
		purchasedAt: timestamp("purchased_at", { withTimezone: true }).notNull().defaultNow(),
		invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
		invalidationReason: text("invalidation_reason"),
		reversedAmount: bigint("reversed_amount", { mode: "number" }).notNull().default(0),
		reversedCreditAmount: integer("reversed_credit_amount").notNull().default(0),
		rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull().default({}),
		...timestampColumns(),
	},
	(table) => [
		unique("purchases_project_id_id_unique").on(table.projectId, table.id),
		foreignKey({
			name: "purchases_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "purchases_project_product_fk",
			columns: [table.projectId, table.productId],
			foreignColumns: [products.projectId, products.id],
		}),
		foreignKey({
			name: "purchases_project_store_product_fk",
			columns: [table.projectId, table.storeProductId],
			foreignColumns: [storeProducts.projectId, storeProducts.id],
		}).onDelete("set null"),
		foreignKey({
			name: "purchases_project_subscription_fk",
			columns: [table.projectId, table.subscriptionId],
			foreignColumns: [subscriptions.projectId, subscriptions.id],
		}).onDelete("set null"),
		uniqueIndex("idx_billing_purchases_transaction").on(
			table.projectId,
			table.provider,
			table.transactionId,
		),
		index("idx_billing_purchases_customer_created").on(table.customerId, table.createdAt),
		index("idx_billing_purchases_product_id").on(table.productId),
		index("idx_billing_purchases_store_product_id").on(table.storeProductId),
		index("idx_billing_purchases_subscription_id").on(table.subscriptionId),
		index("idx_billing_purchases_original_transaction").on(table.originalTransactionId),
		check("purchases_provider_check", sql`${table.provider} IN ('apple', 'google', 'stripe')`),
		check("purchases_channel_check", sql`${table.channel} IN ('ios', 'android', 'web')`),
		check(
			"purchases_purchase_kind_check",
			sql`${table.purchaseKind} IN ('subscription', 'consumable', 'non_consumable')`,
		),
		check(
			"purchases_status_check",
			sql`${table.status} IN ('completed', 'refunded', 'revoked', 'voided')`,
		),
		check("purchases_reversed_amount_check", sql`${table.reversedAmount} >= 0`),
		check("purchases_reversed_credit_amount_check", sql`${table.reversedCreditAmount} >= 0`),
	],
);

export const entitlements = pgTable(
	"entitlements",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		entitlementKey: text("entitlement_key").notNull(),
		active: boolean("active").notNull().default(false),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		sourceSubscriptionId: uuid("source_subscription_id").references(() => subscriptions.id, {
			onDelete: "set null",
		}),
		sourcePurchaseId: uuid("source_purchase_id").references(() => purchases.id, {
			onDelete: "set null",
		}),
		metadata: metadataColumn(),
		computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
		...timestampColumns(),
	},
	(table) => [
		unique("entitlements_project_id_id_unique").on(table.projectId, table.id),
		foreignKey({
			name: "entitlements_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "entitlements_project_subscription_fk",
			columns: [table.projectId, table.sourceSubscriptionId],
			foreignColumns: [subscriptions.projectId, subscriptions.id],
		}).onDelete("set null"),
		foreignKey({
			name: "entitlements_project_purchase_fk",
			columns: [table.projectId, table.sourcePurchaseId],
			foreignColumns: [purchases.projectId, purchases.id],
		}).onDelete("set null"),
		uniqueIndex("idx_billing_entitlements_customer_key").on(
			table.projectId,
			table.customerId,
			table.entitlementKey,
		),
		index("idx_billing_entitlements_source_subscription_id").on(table.sourceSubscriptionId),
		index("idx_billing_entitlements_source_purchase_id").on(table.sourcePurchaseId),
		index("idx_billing_entitlements_key_customer").on(table.entitlementKey, table.customerId),
	],
);

export const storeEvents = pgTable(
	"store_events",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		provider: text("provider").$type<BillingProvider>().notNull(),
		channel: text("channel").$type<BillingChannel>().notNull(),
		externalEventId: text("external_event_id"),
		eventFingerprint: text("event_fingerprint"),
		eventType: text("event_type").notNull(),
		customerId: uuid("customer_id").references(() => customers.id, { onDelete: "set null" }),
		storeProductId: uuid("store_product_id").references(() => storeProducts.id, {
			onDelete: "set null",
		}),
		transactionId: text("transaction_id"),
		purchaseKind: text("purchase_kind").$type<PurchaseKind | null>(),
		processingStatus: text("processing_status")
			.$type<StoreEventProcessingStatus>()
			.notNull()
			.default("pending"),
		processingError: text("processing_error"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
		rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull(),
		processedAt: timestamp("processed_at", { withTimezone: true }),
		lockedAt: timestamp("locked_at", { withTimezone: true }),
		lockedBy: text("locked_by"),
		...timestampColumns(),
	},
	(table) => [
		unique("store_events_project_id_id_unique").on(table.projectId, table.id),
		foreignKey({
			name: "store_events_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("set null"),
		foreignKey({
			name: "store_events_project_store_product_fk",
			columns: [table.projectId, table.storeProductId],
			foreignColumns: [storeProducts.projectId, storeProducts.id],
		}).onDelete("set null"),
		uniqueIndex("idx_billing_store_events_external_event")
			.on(table.projectId, table.provider, table.externalEventId)
			.where(sql`${table.externalEventId} IS NOT NULL`),
		uniqueIndex("idx_billing_store_events_null_event_fingerprint")
			.on(table.projectId, table.provider, table.eventFingerprint)
			.where(sql`${table.externalEventId} IS NULL AND ${table.eventFingerprint} IS NOT NULL`),
		index("idx_billing_store_events_due")
			.on(table.nextAttemptAt, table.createdAt)
			.where(sql`${table.processingStatus} IN ('pending', 'skipped', 'failed')`),
		index("idx_billing_store_events_stale_processing")
			.on(table.lockedAt, table.createdAt)
			.where(sql`${table.processingStatus} = 'processing'`),
		index("idx_billing_store_events_customer_id").on(table.customerId),
		index("idx_billing_store_events_store_product_id").on(table.storeProductId),
		check("store_events_provider_check", sql`${table.provider} IN ('apple', 'google', 'stripe')`),
		check("store_events_channel_check", sql`${table.channel} IN ('ios', 'android', 'web')`),
		check(
			"store_events_purchase_kind_check",
			sql`${table.purchaseKind} IS NULL OR ${table.purchaseKind} IN ('subscription', 'consumable', 'non_consumable')`,
		),
		check(
			"store_events_processing_status_check",
			sql`${table.processingStatus} IN ('pending', 'processing', 'processed', 'skipped', 'failed')`,
		),
	],
);

export const projectionSyncJobs = pgTable(
	"projection_sync_jobs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		idempotencyKey: text("idempotency_key").notNull(),
		reason: text("reason").$type<ProjectionSyncReason>().notNull(),
		payload: jsonb("payload").$type<ProjectionJobPayload>().notNull(),
		status: text("status").$type<ProjectionSyncStatus>().notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		lastError: text("last_error"),
		reprojectionRequested: boolean("reprojection_requested").notNull().default(false),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
		lockedAt: timestamp("locked_at", { withTimezone: true }),
		lockedBy: text("locked_by"),
		...timestampColumns(),
	},
	(table) => [
		unique("projection_sync_jobs_project_id_id_unique").on(table.projectId, table.id),
		foreignKey({
			name: "projection_sync_jobs_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		uniqueIndex("idx_billing_projection_sync_jobs_idempotency").on(
			table.projectId,
			table.idempotencyKey,
		),
		index("idx_billing_projection_sync_jobs_due")
			.on(table.nextAttemptAt, table.createdAt)
			.where(sql`${table.status} = 'pending'`),
		index("idx_billing_projection_sync_jobs_stale")
			.on(table.lockedAt, table.createdAt)
			.where(sql`${table.status} = 'processing'`),
		index("idx_billing_projection_sync_jobs_customer_id").on(table.customerId),
		check(
			"projection_sync_jobs_reason_check",
			sql`${table.reason} IN ('purchase_verified', 'provider_webhook', 'expiry_reconciliation', 'provider_reconciliation', 'usage_changed')`,
		),
		check(
			"projection_sync_jobs_status_check",
			sql`${table.status} IN ('pending', 'processing', 'succeeded', 'failed')`,
		),
	],
);

const meteringId = (name = "id") =>
	bigint(name, { mode: "number" }).primaryKey().generatedAlwaysAsIdentity();
const quantityColumn = (name: string) => numeric(name, { precision: 28, scale: 9 });

export const meteringSettings = pgTable("metering_settings", {
	projectId: uuid("project_id")
		.primaryKey()
		.references(() => projects.id, { onDelete: "cascade" }),
	clientIdempotencyTtlSeconds: integer("client_idempotency_ttl_seconds").notNull().default(86400),
	workerDeliveryTtlSeconds: integer("worker_delivery_ttl_seconds").notNull().default(86400),
	occurredAtMaxSkewSeconds: integer("occurred_at_max_skew_seconds").notNull().default(300),
	rawUsageRetentionDays: integer("raw_usage_retention_days").notNull().default(400),
	consumeP99TargetMs: integer("consume_p99_target_ms").notNull().default(50),
	...timestampColumns(),
});

export const catalogRevisions = pgTable(
	"catalog_revisions",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		revision: integer("revision").notNull(),
		status: text("status")
			.$type<"draft" | "validating" | "syncing" | "ready" | "published" | "failed">()
			.notNull(),
		intentHash: text("intent_hash").notNull(),
		createdBy: text("created_by").notNull(),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		metadata: metadataColumn(),
		...timestampColumns(),
	},
	(table) => [
		unique("catalog_revisions_project_id_id_unique").on(table.projectId, table.id),
		unique("catalog_revisions_project_revision_unique").on(table.projectId, table.revision),
		index("idx_billing_catalog_revisions_project_status").on(
			table.projectId,
			table.status,
			table.revision,
		),
	],
);

export const catalogDrafts = pgTable(
	"catalog_drafts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		baseRevision: integer("base_revision"),
		nextRevision: integer("next_revision").notNull(),
		intentHash: text("intent_hash").notNull(),
		previewToken: text("preview_token").notNull(),
		intent: jsonb("intent").$type<Record<string, unknown>>().notNull(),
		createdBy: text("created_by").notNull(),
		status: text("status")
			.$type<"previewed" | "published" | "expired">()
			.notNull()
			.default("previewed"),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		publishedRevisionId: bigint("published_revision_id", { mode: "number" }).references(
			() => catalogRevisions.id,
			{ onDelete: "restrict" },
		),
		...timestampColumns(),
	},
	(table) => [
		unique("catalog_drafts_project_id_id_unique").on(table.projectId, table.id),
		unique("catalog_drafts_project_token_unique").on(table.projectId, table.previewToken),
		index("idx_billing_catalog_drafts_expiry").on(table.status, table.expiresAt),
	],
);

export const commercialActionPreviews = pgTable(
	"commercial_action_previews",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		billingAccountId: text("billing_account_id").notNull(),
		previewToken: uuid("preview_token").notNull(),
		intentKind: text("intent_kind")
			.$type<"checkout_plan" | "checkout_product" | "subscription_change">()
			.notNull(),
		intentHash: text("intent_hash").notNull(),
		stateFingerprint: text("state_fingerprint").notNull(),
		intent: jsonb("intent").$type<Record<string, unknown>>().notNull(),
		preview: jsonb("preview").$type<Record<string, unknown>>().notNull(),
		status: text("status")
			.$type<"previewed" | "executing" | "executed">()
			.notNull()
			.default("previewed"),
		executionIdempotencyKey: text("execution_idempotency_key"),
		executionResult: jsonb("execution_result").$type<Record<string, unknown>>(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		executedAt: timestamp("executed_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table) => [
		unique("commercial_action_previews_project_id_id_unique").on(table.projectId, table.id),
		unique("commercial_action_previews_project_token_unique").on(
			table.projectId,
			table.previewToken,
		),
		index("idx_billing_commercial_previews_expiry")
			.on(table.expiresAt)
			.where(sql`${table.status} = 'previewed'`),
		index("idx_billing_commercial_previews_account_created").on(
			table.projectId,
			table.billingAccountId,
			table.createdAt,
		),
	],
);

export const catalogAuditLog = pgTable(
	"catalog_audit_log",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		catalogRevisionId: bigint("catalog_revision_id", { mode: "number" })
			.notNull()
			.references(() => catalogRevisions.id, { onDelete: "restrict" }),
		action: text("action")
			.$type<
				| "catalog_published"
				| "plan_migrated"
				| "catalog_archived"
				| "contract_published"
				| "contract_terminated"
				| "control_changed"
				| "auto_topup_reset"
				| "license_changed"
			>()
			.notNull(),
		actor: text("actor").notNull(),
		intentHash: text("intent_hash").notNull(),
		details: metadataColumn(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("catalog_audit_log_project_id_id_unique").on(table.projectId, table.id),
		index("idx_billing_catalog_audit_project_created").on(table.projectId, table.createdAt),
	],
);

export const catalogProviderOperations = pgTable(
	"catalog_provider_operations",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		catalogRevisionId: bigint("catalog_revision_id", { mode: "number" })
			.notNull()
			.references(() => catalogRevisions.id, { onDelete: "restrict" }),
		provider: text("provider").$type<BillingProvider>().notNull(),
		channel: text("channel").$type<BillingChannel>().notNull(),
		action: text("action").$type<"adopt_plan" | "adopt_topup" | "adopt_price">().notNull(),
		operationKey: text("operation_key").notNull(),
		storeProductId: uuid("store_product_id")
			.notNull()
			.references(() => storeProducts.id, { onDelete: "restrict" }),
		status: text("status").$type<"pending" | "processing" | "ready" | "failed">().notNull(),
		attempts: integer("attempts").notNull().default(0),
		lastError: text("last_error"),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table) => [
		unique("catalog_provider_operations_project_id_id_unique").on(table.projectId, table.id),
		unique("catalog_provider_operations_key_unique").on(table.projectId, table.operationKey),
		index("idx_billing_catalog_provider_operations_due").on(table.status, table.createdAt),
		index("idx_billing_catalog_provider_operations_revision").on(table.catalogRevisionId),
	],
);

export const features = pgTable(
	"features",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		key: text("key").notNull(),
		name: text("name").notNull(),
		kind: text("kind").$type<"boolean" | "metered">().notNull(),
		meterKind: text("meter_kind").$type<"consumable" | "non_consumable" | null>(),
		unit: text("unit").notNull(),
		creditScale: smallint("credit_scale").notNull().default(0),
		filterDimensions: text("filter_dimensions").array().notNull().default([]),
		active: boolean("active").notNull().default(true),
		metadata: metadataColumn(),
		...timestampColumns(),
	},
	(table) => [
		unique("features_project_id_id_unique").on(table.projectId, table.id),
		unique("features_project_key_unique").on(table.projectId, table.key),
	],
);

export const plans = pgTable(
	"plans",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		key: text("key").notNull(),
		name: text("name").notNull(),
		activeVersionId: bigint("active_version_id", { mode: "number" }),
		active: boolean("active").notNull().default(true),
		metadata: metadataColumn(),
		...timestampColumns(),
	},
	(table) => [
		unique("plans_project_id_id_unique").on(table.projectId, table.id),
		unique("plans_project_key_unique").on(table.projectId, table.key),
	],
);

export const planVersions = pgTable(
	"plan_versions",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		planId: bigint("plan_id", { mode: "number" })
			.notNull()
			.references(() => plans.id, { onDelete: "restrict" }),
		catalogRevisionId: bigint("catalog_revision_id", { mode: "number" })
			.notNull()
			.references(() => catalogRevisions.id, { onDelete: "restrict" }),
		version: integer("version").notNull(),
		status: text("status").$type<"draft" | "published" | "archived">().notNull(),
		currency: text("currency"),
		baseAmountMinor: bigint("base_amount_minor", { mode: "number" }),
		billingInterval: text("billing_interval").$type<"month" | "year" | null>(),
		trialDays: integer("trial_days"),
		visibility: text("visibility")
			.$type<"public" | "customer_specific">()
			.notNull()
			.default("public"),
		customerId: uuid("customer_id").references(() => customers.id, { onDelete: "restrict" }),
		planKind: text("plan_kind").$type<"base" | "addon">().notNull().default("base"),
		tierRank: integer("tier_rank").notNull().default(0),
		trialRequiresPaymentMethod: boolean("trial_requires_payment_method").notNull().default(true),
		trialEndBehavior: text("trial_end_behavior")
			.$type<"cancel" | "pause">()
			.notNull()
			.default("cancel"),
		upgradeProrationBehavior: text("upgrade_proration_behavior")
			.$type<"always_invoice" | "create_prorations" | "none">()
			.notNull()
			.default("always_invoice"),
		downgradeProrationBehavior: text("downgrade_proration_behavior")
			.$type<"always_invoice" | "create_prorations" | "none">()
			.notNull()
			.default("none"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("plan_versions_project_id_id_unique").on(table.projectId, table.id),
		unique("plan_versions_project_plan_version_unique").on(
			table.projectId,
			table.planId,
			table.version,
		),
		index("idx_billing_plan_versions_revision").on(table.catalogRevisionId),
		index("idx_billing_plan_versions_customer")
			.on(table.projectId, table.customerId, table.status)
			.where(sql`${table.customerId} IS NOT NULL`),
	],
);

export const planItems = pgTable(
	"plan_items",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		planVersionId: bigint("plan_version_id", { mode: "number" })
			.notNull()
			.references(() => planVersions.id, { onDelete: "restrict" }),
		featureId: bigint("feature_id", { mode: "number" })
			.notNull()
			.references(() => features.id, { onDelete: "restrict" }),
		itemKind: text("item_kind")
			.$type<"access" | "allocation" | "meter_limit" | "licensed_quantity">()
			.notNull(),
		quantity: quantityColumn("quantity"),
		resetInterval: text("reset_interval").$type<"month" | "year" | null>(),
		expiresAfterSeconds: bigint("expires_after_seconds", { mode: "number" }),
		overagePolicy: text("overage_policy")
			.$type<"blocked" | "allowed">()
			.notNull()
			.default("blocked"),
		allocationScope: text("allocation_scope")
			.$type<"account" | "entity" | "license_pool">()
			.notNull()
			.default("account"),
		rolloverEnabled: boolean("rollover_enabled").notNull().default(false),
		rolloverMaxQuantity: quantityColumn("rollover_max_quantity"),
		rolloverExpiryMode: text("rollover_expiry_mode")
			.$type<"none" | "forever" | "months">()
			.notNull()
			.default("none"),
		rolloverExpiryMonths: integer("rollover_expiry_months"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("plan_items_project_id_id_unique").on(table.projectId, table.id),
		unique("plan_items_project_version_feature_unique").on(
			table.projectId,
			table.planVersionId,
			table.featureId,
		),
		index("idx_billing_plan_items_feature").on(table.featureId),
	],
);

export const priceComponents = pgTable(
	"price_components",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		planVersionId: bigint("plan_version_id", { mode: "number" })
			.notNull()
			.references(() => planVersions.id, { onDelete: "restrict" }),
		planItemId: bigint("plan_item_id", { mode: "number" }).references(() => planItems.id, {
			onDelete: "restrict",
		}),
		key: text("key").notNull(),
		componentKind: text("component_kind")
			.$type<"base" | "licensed" | "metered_overage">()
			.notNull(),
		chargeTiming: text("charge_timing").$type<"in_advance" | "in_arrears">().notNull(),
		currency: text("currency").notNull(),
		unitAmountMinor: bigint("unit_amount_minor", { mode: "number" }).notNull(),
		pricingModel: text("pricing_model")
			.$type<"flat" | "graduated" | "volume">()
			.notNull()
			.default("flat"),
		billingUnits: quantityColumn("billing_units").notNull().default("1"),
		billingInterval: text("billing_interval").$type<"month" | "year">().notNull(),
		minimumQuantity: integer("minimum_quantity").notNull().default(1),
		maximumQuantity: integer("maximum_quantity"),
		taxBehavior: text("tax_behavior")
			.$type<"inclusive" | "exclusive" | "unspecified">()
			.notNull()
			.default("unspecified"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("price_components_project_id_id_unique").on(table.projectId, table.id),
		unique("price_components_project_version_key_unique").on(
			table.projectId,
			table.planVersionId,
			table.key,
		),
		uniqueIndex("idx_billing_price_components_base")
			.on(table.projectId, table.planVersionId)
			.where(sql`${table.componentKind} = 'base'`),
		uniqueIndex("idx_billing_price_components_plan_item")
			.on(table.projectId, table.planItemId)
			.where(sql`${table.planItemId} IS NOT NULL`),
		index("idx_billing_price_components_version").on(table.planVersionId),
	],
);

export const priceTiers = pgTable(
	"price_tiers",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		priceComponentId: bigint("price_component_id", { mode: "number" })
			.notNull()
			.references(() => priceComponents.id, { onDelete: "restrict" }),
		ordinal: integer("ordinal").notNull(),
		upToQuantity: quantityColumn("up_to_quantity"),
		unitAmountMinor: bigint("unit_amount_minor", { mode: "number" }).notNull(),
		flatAmountMinor: bigint("flat_amount_minor", { mode: "number" }).notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("price_tiers_project_id_id_unique").on(table.projectId, table.id),
		unique("price_tiers_component_ordinal_unique").on(
			table.projectId,
			table.priceComponentId,
			table.ordinal,
		),
		index("idx_billing_price_tiers_component").on(
			table.projectId,
			table.priceComponentId,
			table.ordinal,
		),
	],
);

export const providerPriceBindings = pgTable(
	"provider_price_bindings",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		priceComponentId: bigint("price_component_id", { mode: "number" })
			.notNull()
			.references(() => priceComponents.id, { onDelete: "restrict" }),
		storeProductId: uuid("store_product_id")
			.notNull()
			.references(() => storeProducts.id, { onDelete: "restrict" }),
		provider: text("provider").$type<BillingProvider>().notNull(),
		channel: text("channel").$type<BillingChannel>().notNull(),
		status: text("status")
			.$type<"validating" | "syncing" | "ready" | "published" | "failed">()
			.notNull(),
		error: text("error"),
		...timestampColumns(),
	},
	(table) => [
		unique("provider_price_bindings_project_id_id_unique").on(table.projectId, table.id),
		unique("provider_price_bindings_component_provider_unique").on(
			table.projectId,
			table.priceComponentId,
			table.provider,
			table.channel,
		),
		index("idx_billing_provider_price_bindings_store").on(table.storeProductId),
	],
);

export const subscriptionItems = pgTable(
	"subscription_items",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		subscriptionId: uuid("subscription_id")
			.notNull()
			.references(() => subscriptions.id, { onDelete: "cascade" }),
		priceComponentId: bigint("price_component_id", { mode: "number" })
			.notNull()
			.references(() => priceComponents.id, { onDelete: "restrict" }),
		providerSubscriptionItemId: text("provider_subscription_item_id"),
		quantity: integer("quantity").notNull(),
		unitAmountMinor: bigint("unit_amount_minor", { mode: "number" }).notNull(),
		currency: text("currency").notNull(),
		active: boolean("active").notNull().default(true),
		startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
		endsAt: timestamp("ends_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table) => [
		unique("subscription_items_project_id_id_unique").on(table.projectId, table.id),
		unique("subscription_items_project_subscription_component_unique").on(
			table.projectId,
			table.subscriptionId,
			table.priceComponentId,
		),
		uniqueIndex("idx_billing_subscription_items_provider_item")
			.on(table.projectId, table.providerSubscriptionItemId)
			.where(sql`${table.providerSubscriptionItemId} IS NOT NULL`),
		index("idx_billing_subscription_items_subscription_active").on(
			table.subscriptionId,
			table.active,
		),
	],
);

export const subscriptionChanges = pgTable(
	"subscription_changes",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		subscriptionId: uuid("subscription_id")
			.notNull()
			.references(() => subscriptions.id, { onDelete: "cascade" }),
		fromPlanVersionId: bigint("from_plan_version_id", { mode: "number" })
			.notNull()
			.references(() => planVersions.id, { onDelete: "restrict" }),
		toPlanVersionId: bigint("to_plan_version_id", { mode: "number" })
			.notNull()
			.references(() => planVersions.id, { onDelete: "restrict" }),
		requestedQuantities: jsonb("requested_quantities")
			.$type<Record<string, number>>()
			.notNull()
			.default({}),
		changeKind: text("change_kind").$type<"upgrade" | "downgrade" | "quantity">().notNull(),
		effectiveMode: text("effective_mode").$type<"immediate" | "period_end">().notNull(),
		effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
		prorationBehavior: text("proration_behavior")
			.$type<"always_invoice" | "create_prorations" | "none">()
			.notNull(),
		status: text("status")
			.$type<"pending" | "processing" | "applied" | "failed" | "cancelled">()
			.notNull()
			.default("pending"),
		idempotencyKey: text("idempotency_key").notNull(),
		requestHash: text("request_hash").notNull(),
		providerRequestId: text("provider_request_id"),
		attempts: integer("attempts").notNull().default(0),
		lastError: text("last_error"),
		lockedAt: timestamp("locked_at", { withTimezone: true }),
		lockedBy: text("locked_by"),
		appliedAt: timestamp("applied_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table) => [
		unique("subscription_changes_project_id_id_unique").on(table.projectId, table.id),
		uniqueIndex("idx_billing_subscription_changes_idempotency").on(
			table.projectId,
			table.customerId,
			table.idempotencyKey,
		),
		uniqueIndex("idx_billing_subscription_changes_pending_scope")
			.on(table.projectId, table.subscriptionId)
			.where(sql`${table.status} IN ('pending', 'processing')`),
		index("idx_billing_subscription_changes_due")
			.on(table.effectiveAt, table.createdAt)
			.where(sql`${table.status} = 'pending'`),
		index("idx_billing_subscription_changes_stale")
			.on(table.lockedAt, table.createdAt)
			.where(sql`${table.status} = 'processing'`),
	],
);

export const rateCardEntries = pgTable(
	"rate_card_entries",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		catalogRevisionId: bigint("catalog_revision_id", { mode: "number" })
			.notNull()
			.references(() => catalogRevisions.id, { onDelete: "restrict" }),
		meterFeatureId: bigint("meter_feature_id", { mode: "number" })
			.notNull()
			.references(() => features.id, { onDelete: "restrict" }),
		walletFeatureId: bigint("wallet_feature_id", { mode: "number" })
			.notNull()
			.references(() => features.id, { onDelete: "restrict" }),
		ratePerUnit: numeric("rate_per_unit", { precision: 38, scale: 18 }).notNull(),
		pricingModel: text("pricing_model").$type<"flat" | "graduated">().notNull().default("flat"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("rate_card_entries_project_id_id_unique").on(table.projectId, table.id),
		unique("rate_card_entries_project_meter_unique").on(
			table.projectId,
			table.catalogRevisionId,
			table.meterFeatureId,
		),
		index("idx_billing_rate_card_entries_wallet").on(
			table.projectId,
			table.walletFeatureId,
			table.catalogRevisionId,
		),
	],
);

export const rateCardTiers = pgTable(
	"rate_card_tiers",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		rateCardEntryId: bigint("rate_card_entry_id", { mode: "number" })
			.notNull()
			.references(() => rateCardEntries.id, { onDelete: "restrict" }),
		ordinal: integer("ordinal").notNull(),
		upToQuantity: quantityColumn("up_to_quantity"),
		ratePerUnit: numeric("rate_per_unit", { precision: 38, scale: 18 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("rate_card_tiers_project_id_id_unique").on(table.projectId, table.id),
		unique("rate_card_tiers_entry_ordinal_unique").on(
			table.projectId,
			table.rateCardEntryId,
			table.ordinal,
		),
		index("idx_billing_rate_card_tiers_entry").on(
			table.projectId,
			table.rateCardEntryId,
			table.ordinal,
		),
	],
);

export const providerPlanBindings = pgTable(
	"provider_plan_bindings",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		planVersionId: bigint("plan_version_id", { mode: "number" })
			.notNull()
			.references(() => planVersions.id, { onDelete: "restrict" }),
		storeProductId: uuid("store_product_id")
			.notNull()
			.references(() => storeProducts.id, { onDelete: "restrict" }),
		provider: text("provider").$type<BillingProvider>().notNull(),
		channel: text("channel").$type<BillingChannel>().notNull(),
		status: text("status")
			.$type<"validating" | "syncing" | "ready" | "published" | "failed">()
			.notNull(),
		error: text("error"),
		...timestampColumns(),
	},
	(table) => [
		unique("provider_plan_bindings_project_id_id_unique").on(table.projectId, table.id),
		unique("provider_plan_bindings_project_store_unique").on(table.projectId, table.storeProductId),
		index("idx_billing_provider_plan_bindings_version").on(table.planVersionId),
	],
);

export const topupOptions = pgTable(
	"topup_options",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		catalogRevisionId: bigint("catalog_revision_id", { mode: "number" })
			.notNull()
			.references(() => catalogRevisions.id, { onDelete: "restrict" }),
		key: text("key").notNull(),
		featureId: bigint("feature_id", { mode: "number" })
			.notNull()
			.references(() => features.id, { onDelete: "restrict" }),
		quantity: quantityColumn("quantity").notNull(),
		expiresAfterSeconds: bigint("expires_after_seconds", { mode: "number" }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("topup_options_project_id_id_unique").on(table.projectId, table.id),
		unique("topup_options_project_revision_key_unique").on(
			table.projectId,
			table.catalogRevisionId,
			table.key,
		),
		index("idx_billing_topup_options_feature").on(table.featureId, table.catalogRevisionId),
	],
);

export const providerTopupBindings = pgTable(
	"provider_topup_bindings",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		topupOptionId: bigint("topup_option_id", { mode: "number" })
			.notNull()
			.references(() => topupOptions.id, { onDelete: "restrict" }),
		storeProductId: uuid("store_product_id")
			.notNull()
			.references(() => storeProducts.id, { onDelete: "restrict" }),
		provider: text("provider").$type<BillingProvider>().notNull(),
		channel: text("channel").$type<BillingChannel>().notNull(),
		status: text("status")
			.$type<"validating" | "syncing" | "ready" | "published" | "failed">()
			.notNull(),
		error: text("error"),
		...timestampColumns(),
	},
	(table) => [
		unique("provider_topup_bindings_project_id_id_unique").on(table.projectId, table.id),
		unique("provider_topup_bindings_project_store_unique").on(
			table.projectId,
			table.storeProductId,
		),
		index("idx_billing_provider_topup_bindings_option").on(table.topupOptionId),
	],
);

export const entities = pgTable(
	"entities",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		externalId: text("external_id").notNull(),
		kind: text("kind").notNull(),
		metadata: metadataColumn(),
		...timestampColumns(),
	},
	(table) => [
		unique("entities_project_id_id_unique").on(table.projectId, table.id),
		unique("entities_project_customer_external_unique").on(
			table.projectId,
			table.customerId,
			table.externalId,
		),
		index("idx_billing_entities_customer").on(table.customerId),
	],
);

export const balanceAllocations = pgTable(
	"balance_allocations",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		entityId: bigint("entity_id", { mode: "number" }).references(() => entities.id, {
			onDelete: "cascade",
		}),
		featureId: bigint("feature_id", { mode: "number" })
			.notNull()
			.references(() => features.id, { onDelete: "restrict" }),
		planItemId: bigint("plan_item_id", { mode: "number" }).references(() => planItems.id, {
			onDelete: "set null",
		}),
		subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
			onDelete: "set null",
		}),
		purchaseId: uuid("purchase_id").references(() => purchases.id, { onDelete: "set null" }),
		creditGrantId: uuid("credit_grant_id").references(() => creditGrants.id, {
			onDelete: "set null",
		}),
		sourceKind: text("source_kind").notNull(),
		sourceKey: text("source_key").notNull(),
		quantity: quantityColumn("quantity").notNull(),
		reversedQuantity: quantityColumn("reversed_quantity").notNull().default("0"),
		consumedQuantity: quantityColumn("consumed_quantity").notNull().default("0"),
		heldQuantity: quantityColumn("held_quantity").notNull().default("0"),
		periodStartAt: timestamp("period_start_at", { withTimezone: true }),
		periodEndAt: timestamp("period_end_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		reversedAt: timestamp("reversed_at", { withTimezone: true }),
		rolloverOriginAllocationId: bigint("rollover_origin_allocation_id", { mode: "number" }),
		rolloverPolicyRevision: integer("rollover_policy_revision"),
		rolloverProcessedAt: timestamp("rollover_processed_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table) => [
		unique("balance_allocations_project_id_id_unique").on(table.projectId, table.id),
		unique("balance_allocations_source_unique").on(
			table.projectId,
			table.featureId,
			table.sourceKind,
			table.sourceKey,
		),
		index("idx_billing_balance_allocations_customer").on(table.customerId),
		uniqueIndex("idx_billing_balance_allocations_rollover_origin")
			.on(table.projectId, table.rolloverOriginAllocationId)
			.where(sql`${table.rolloverOriginAllocationId} IS NOT NULL`),
	],
);

export const clientIdempotencyClaims = pgTable(
	"client_idempotency_claims",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		operation: text("operation").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		requestFingerprint: text("request_fingerprint").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("client_idempotency_claims_scope_unique").on(
			table.projectId,
			table.customerId,
			table.operation,
			table.idempotencyKey,
		),
		index("idx_billing_client_idempotency_expiry").on(table.expiresAt),
	],
);

export const workerDeliveryClaims = pgTable(
	"worker_delivery_claims",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		deliveryId: text("delivery_id").notNull(),
		requestContextId: text("request_context_id").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("worker_delivery_claims_scope_unique").on(table.projectId, table.deliveryId),
		index("idx_billing_worker_delivery_expiry").on(table.expiresAt),
	],
);

export const usageWindows = pgTable(
	"usage_windows",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		entityId: bigint("entity_id", { mode: "number" }).references(() => entities.id, {
			onDelete: "cascade",
		}),
		featureId: bigint("feature_id", { mode: "number" })
			.notNull()
			.references(() => features.id, { onDelete: "restrict" }),
		filterKey: text("filter_key"),
		subscriptionId: uuid("subscription_id").references(() => subscriptions.id, {
			onDelete: "restrict",
		}),
		anchorPlanItemId: bigint("anchor_plan_item_id", { mode: "number" }).references(
			() => planItems.id,
			{ onDelete: "set null" },
		),
		windowStartAt: timestamp("window_start_at", { withTimezone: true }).notNull(),
		windowEndAt: timestamp("window_end_at", { withTimezone: true }).notNull(),
		usage: quantityColumn("usage").notNull().default("0"),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("usage_windows_project_id_id_unique").on(table.projectId, table.id),
		uniqueIndex("idx_billing_usage_windows_scope_period").on(
			table.projectId,
			table.customerId,
			table.featureId,
			sql`COALESCE(${table.entityId}, 0::bigint)`,
			sql`COALESCE(${table.filterKey}, '')`,
			table.windowStartAt,
			table.windowEndAt,
		),
		index("idx_billing_usage_windows_closed_unbilled")
			.on(table.windowEndAt, table.projectId, table.subscriptionId, table.anchorPlanItemId)
			.where(sql`${table.subscriptionId} IS NOT NULL AND ${table.anchorPlanItemId} IS NOT NULL`),
	],
);

export const reservations = pgTable(
	"reservations",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		entityId: bigint("entity_id", { mode: "number" }).references(() => entities.id, {
			onDelete: "cascade",
		}),
		usageWindowId: bigint("usage_window_id", { mode: "number" }).references(() => usageWindows.id, {
			onDelete: "set null",
		}),
		usageWindowStartAt: timestamp("usage_window_start_at", { withTimezone: true }),
		usageWindowEndAt: timestamp("usage_window_end_at", { withTimezone: true }),
		meterFeatureId: bigint("meter_feature_id", { mode: "number" })
			.notNull()
			.references(() => features.id, { onDelete: "restrict" }),
		walletFeatureId: bigint("wallet_feature_id", { mode: "number" })
			.notNull()
			.references(() => features.id, { onDelete: "restrict" }),
		rateCardEntryId: bigint("rate_card_entry_id", { mode: "number" }).references(
			() => rateCardEntries.id,
			{ onDelete: "restrict" },
		),
		rateCardRevisionId: bigint("rate_card_revision_id", { mode: "number" }).references(
			() => catalogRevisions.id,
			{ onDelete: "restrict" },
		),
		rateCardPath: text("rate_card_path").$type<"direct" | "pinned" | "additive">().notNull(),
		requestedQuantity: quantityColumn("requested_quantity").notNull(),
		heldQuantity: quantityColumn("held_quantity").notNull(),
		confirmedQuantity: quantityColumn("confirmed_quantity"),
		status: text("status")
			.$type<"active" | "confirmed" | "released" | "expired">()
			.notNull()
			.default("active"),
		effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		finalizedAt: timestamp("finalized_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table) => [
		unique("reservations_project_id_id_unique").on(table.projectId, table.id),
		index("idx_billing_reservations_customer_feature").on(
			table.projectId,
			table.customerId,
			table.walletFeatureId,
			table.createdAt,
		),
	],
);

export const reservationAllocations = pgTable(
	"reservation_allocations",
	{
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		reservationId: uuid("reservation_id")
			.notNull()
			.references(() => reservations.id, { onDelete: "cascade" }),
		allocationId: bigint("allocation_id", { mode: "number" })
			.notNull()
			.references(() => balanceAllocations.id, { onDelete: "restrict" }),
		heldQuantity: quantityColumn("held_quantity").notNull(),
		consumedQuantity: quantityColumn("consumed_quantity").notNull().default("0"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		primaryKey({ columns: [table.projectId, table.reservationId, table.allocationId] }),
		index("idx_billing_reservation_allocations_allocation").on(table.projectId, table.allocationId),
	],
);

export const usageEvents = pgTable(
	"usage_events",
	{
		recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
		id: uuid("id").notNull().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		entityId: bigint("entity_id", { mode: "number" }).references(() => entities.id, {
			onDelete: "set null",
		}),
		meterFeatureId: bigint("meter_feature_id", { mode: "number" })
			.notNull()
			.references(() => features.id, { onDelete: "restrict" }),
		walletFeatureId: bigint("wallet_feature_id", { mode: "number" })
			.notNull()
			.references(() => features.id, { onDelete: "restrict" }),
		reservationId: uuid("reservation_id").references(() => reservations.id, {
			onDelete: "set null",
		}),
		originalEventId: uuid("original_event_id"),
		originalEventRecordedAt: timestamp("original_event_recorded_at", { withTimezone: true }),
		operation: text("operation").$type<"consume" | "confirm" | "correction">().notNull(),
		quantity: quantityColumn("quantity").notNull(),
		walletQuantity: quantityColumn("wallet_quantity").notNull(),
		occurredAt: timestamp("occurred_at", { withTimezone: true }),
		effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
		rateCardEntryId: bigint("rate_card_entry_id", { mode: "number" }),
		rateCardRevisionId: bigint("rate_card_revision_id", { mode: "number" }),
		rateCardPath: text("rate_card_path").$type<"direct" | "pinned" | "additive">().notNull(),
		rateInputs: jsonb("rate_inputs").$type<Record<string, unknown>>().notNull().default({}),
		filterKey: text("filter_key"),
		deductions: jsonb("deductions").$type<Array<Record<string, unknown>>>().notNull().default([]),
		metadata: metadataColumn(),
	},
	(table) => [
		primaryKey({ columns: [table.recordedAt, table.id] }),
		index("idx_billing_usage_events_customer_time").on(
			table.projectId,
			table.customerId,
			table.recordedAt,
		),
		index("idx_billing_usage_events_customer_feature_time").on(
			table.projectId,
			table.customerId,
			table.meterFeatureId,
			table.recordedAt,
			table.id,
		),
	],
);

export const usageEventRollups = pgTable(
	"usage_event_rollups",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		entityId: bigint("entity_id", { mode: "number" }).references(() => entities.id, {
			onDelete: "set null",
		}),
		meterFeatureId: bigint("meter_feature_id", { mode: "number" })
			.notNull()
			.references(() => features.id, { onDelete: "restrict" }),
		periodStartAt: timestamp("period_start_at", { withTimezone: true }).notNull(),
		periodEndAt: timestamp("period_end_at", { withTimezone: true }).notNull(),
		quantity: numeric("quantity", { precision: 38, scale: 9 }).notNull().default("0"),
		walletQuantity: numeric("wallet_quantity", { precision: 38, scale: 9 }).notNull().default("0"),
		eventCount: bigint("event_count", { mode: "number" }).notNull().default(0),
		status: text("status").$type<"open" | "closed">().notNull().default("open"),
		closedAt: timestamp("closed_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("usage_event_rollups_project_id_id_unique").on(table.projectId, table.id),
		uniqueIndex("idx_billing_usage_event_rollups_scope").on(
			table.projectId,
			table.customerId,
			table.meterFeatureId,
			sql`COALESCE(${table.entityId}, 0::bigint)`,
			table.periodStartAt,
		),
		index("idx_billing_usage_event_rollups_close").on(table.periodEndAt, table.id),
	],
);

export const usageInvoicePeriods = pgTable(
	"usage_invoice_periods",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		subscriptionId: uuid("subscription_id")
			.notNull()
			.references(() => subscriptions.id, { onDelete: "restrict" }),
		planItemId: bigint("plan_item_id", { mode: "number" })
			.notNull()
			.references(() => planItems.id, { onDelete: "restrict" }),
		priceComponentId: bigint("price_component_id", { mode: "number" })
			.notNull()
			.references(() => priceComponents.id, { onDelete: "restrict" }),
		periodStartAt: timestamp("period_start_at", { withTimezone: true }).notNull(),
		periodEndAt: timestamp("period_end_at", { withTimezone: true }).notNull(),
		usageQuantity: quantityColumn("usage_quantity").notNull(),
		includedQuantity: quantityColumn("included_quantity").notNull(),
		billableQuantity: quantityColumn("billable_quantity").notNull(),
		billingUnits: quantityColumn("billing_units").notNull(),
		unitAmountMinor: bigint("unit_amount_minor", { mode: "number" }).notNull(),
		amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
		currency: text("currency").notNull(),
		status: text("status")
			.$type<"pending" | "processing" | "invoiced" | "credited" | "failed">()
			.notNull()
			.default("pending"),
		externalInvoiceId: text("external_invoice_id"),
		attempts: integer("attempts").notNull().default(0),
		lastError: text("last_error"),
		lockedAt: timestamp("locked_at", { withTimezone: true }),
		lockedBy: text("locked_by"),
		invoicedAt: timestamp("invoiced_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table) => [
		unique("usage_invoice_periods_project_id_id_unique").on(table.projectId, table.id),
		unique("usage_invoice_periods_scope_unique").on(
			table.projectId,
			table.subscriptionId,
			table.planItemId,
			table.periodStartAt,
			table.periodEndAt,
		),
		uniqueIndex("idx_billing_usage_invoice_periods_external")
			.on(table.projectId, table.externalInvoiceId)
			.where(sql`${table.externalInvoiceId} IS NOT NULL`),
		index("idx_billing_usage_invoice_periods_due")
			.on(table.periodEndAt, table.createdAt)
			.where(sql`${table.status} = 'pending'`),
		index("idx_billing_usage_invoice_periods_stale")
			.on(table.lockedAt, table.createdAt)
			.where(sql`${table.status} = 'processing'`),
	],
);

export const usageInvoiceAdjustments = pgTable(
	"usage_invoice_adjustments",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		closedPeriodId: uuid("closed_period_id")
			.notNull()
			.references(() => usageInvoicePeriods.id, { onDelete: "restrict" }),
		usageEventId: uuid("usage_event_id").notNull(),
		usageEventRecordedAt: timestamp("usage_event_recorded_at", { withTimezone: true }).notNull(),
		quantity: numeric("quantity", { precision: 28, scale: 9 }).notNull(),
		amountMinor: bigint("amount_minor", { mode: "number" }).notNull(),
		currency: text("currency").notNull(),
		status: text("status")
			.$type<"pending" | "processing" | "invoiced" | "credited" | "failed">()
			.notNull()
			.default("pending"),
		externalInvoiceId: text("external_invoice_id"),
		attempts: integer("attempts").notNull().default(0),
		lastError: text("last_error"),
		lockedAt: timestamp("locked_at", { withTimezone: true }),
		lockedBy: text("locked_by"),
		invoicedAt: timestamp("invoiced_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table) => [
		unique("usage_invoice_adjustments_project_id_id_unique").on(table.projectId, table.id),
		unique("usage_invoice_adjustments_event_unique").on(
			table.projectId,
			table.usageEventRecordedAt,
			table.usageEventId,
		),
		uniqueIndex("idx_billing_usage_invoice_adjustments_external")
			.on(table.projectId, table.externalInvoiceId)
			.where(sql`${table.externalInvoiceId} IS NOT NULL`),
		index("idx_billing_usage_invoice_adjustments_due")
			.on(table.createdAt, table.id)
			.where(sql`${table.status} = 'pending'`),
		index("idx_billing_usage_invoice_adjustments_stale")
			.on(table.lockedAt, table.id)
			.where(sql`${table.status} = 'processing'`),
	],
);

export const enterpriseContracts = pgTable(
	"enterprise_contracts",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "restrict" }),
		contractKey: text("contract_key").notNull(),
		version: integer("version").notNull(),
		status: text("status").$type<"draft" | "published" | "expired" | "terminated">().notNull(),
		planVersionId: bigint("plan_version_id", { mode: "number" })
			.notNull()
			.references(() => planVersions.id, { onDelete: "restrict" }),
		replacesCommercialDefaults: boolean("replaces_commercial_defaults").notNull().default(true),
		effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		terms: jsonb("terms").$type<Record<string, unknown>>().notNull().default({}),
		previewToken: text("preview_token").notNull(),
		intentHash: text("intent_hash").notNull(),
		createdBy: text("created_by").notNull(),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table) => [
		unique("enterprise_contracts_project_id_id_unique").on(table.projectId, table.id),
		unique("enterprise_contracts_key_version_unique").on(
			table.projectId,
			table.customerId,
			table.contractKey,
			table.version,
		),
		unique("enterprise_contracts_preview_token_unique").on(table.projectId, table.previewToken),
		index("idx_billing_enterprise_contracts_active")
			.on(table.projectId, table.customerId, table.effectiveAt, table.version)
			.where(sql`${table.status} = 'published'`),
		index("idx_billing_enterprise_contracts_customer").on(
			table.projectId,
			table.customerId,
			table.effectiveAt,
		),
	],
);

export const controlPolicies = pgTable(
	"control_policies",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		sourceType: text("source_type")
			.$type<"plan_default" | "contract" | "account" | "entity">()
			.notNull(),
		planVersionId: bigint("plan_version_id", { mode: "number" }).references(() => planVersions.id, {
			onDelete: "restrict",
		}),
		contractId: bigint("contract_id", { mode: "number" }).references(() => enterpriseContracts.id, {
			onDelete: "restrict",
		}),
		customerId: uuid("customer_id").references(() => customers.id, { onDelete: "cascade" }),
		entityId: bigint("entity_id", { mode: "number" }).references(() => entities.id, {
			onDelete: "cascade",
		}),
		controlKind: text("control_kind").$type<"spend_limit" | "usage_limit">().notNull(),
		featureId: bigint("feature_id", { mode: "number" }).references(() => features.id, {
			onDelete: "restrict",
		}),
		currency: text("currency"),
		limitValue: numeric("limit_value", { precision: 38, scale: 9 }).notNull(),
		interval: text("interval").$type<"month" | "year" | "lifetime">().notNull(),
		revision: integer("revision").notNull(),
		effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		active: boolean("active").notNull().default(true),
		createdBy: text("created_by").notNull(),
		metadata: metadataColumn(),
		...timestampColumns(),
	},
	(table) => [
		unique("control_policies_project_id_id_unique").on(table.projectId, table.id),
		index("idx_billing_control_policies_plan")
			.on(table.projectId, table.planVersionId, table.controlKind)
			.where(sql`${table.sourceType} = 'plan_default' AND ${table.active} = true`),
		index("idx_billing_control_policies_contract")
			.on(table.projectId, table.contractId, table.controlKind)
			.where(sql`${table.sourceType} = 'contract' AND ${table.active} = true`),
		index("idx_billing_control_policies_account")
			.on(table.projectId, table.customerId, table.controlKind, table.featureId)
			.where(sql`${table.sourceType} IN ('account', 'entity') AND ${table.active} = true`),
	],
);

export const controlWindows = pgTable(
	"control_windows",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		controlPolicyId: bigint("control_policy_id", { mode: "number" })
			.notNull()
			.references(() => controlPolicies.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		entityId: bigint("entity_id", { mode: "number" }).references(() => entities.id, {
			onDelete: "cascade",
		}),
		windowStartAt: timestamp("window_start_at", { withTimezone: true }).notNull(),
		windowEndAt: timestamp("window_end_at", { withTimezone: true }),
		consumedValue: numeric("consumed_value", { precision: 38, scale: 9 }).notNull().default("0"),
		heldValue: numeric("held_value", { precision: 38, scale: 9 }).notNull().default("0"),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("control_windows_project_id_id_unique").on(table.projectId, table.id),
		unique("control_windows_scope_unique").on(
			table.projectId,
			table.controlPolicyId,
			table.customerId,
			table.windowStartAt,
		),
		index("idx_billing_control_windows_scope").on(
			table.projectId,
			table.customerId,
			table.controlPolicyId,
			table.windowStartAt,
		),
	],
);

export const reservationControlHolds = pgTable(
	"reservation_control_holds",
	{
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		reservationId: uuid("reservation_id")
			.notNull()
			.references(() => reservations.id, { onDelete: "cascade" }),
		controlWindowId: bigint("control_window_id", { mode: "number" })
			.notNull()
			.references(() => controlWindows.id, { onDelete: "restrict" }),
		heldValue: numeric("held_value", { precision: 38, scale: 9 }).notNull(),
		consumedValue: numeric("consumed_value", { precision: 38, scale: 9 }).notNull().default("0"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		primaryKey({
			columns: [table.projectId, table.reservationId, table.controlWindowId],
		}),
		index("idx_billing_reservation_control_holds_window").on(
			table.projectId,
			table.controlWindowId,
		),
	],
);

export const usageEventControlEntries = pgTable(
	"usage_event_control_entries",
	{
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		usageEventRecordedAt: timestamp("usage_event_recorded_at", { withTimezone: true }).notNull(),
		usageEventId: uuid("usage_event_id").notNull(),
		controlWindowId: bigint("control_window_id", { mode: "number" })
			.notNull()
			.references(() => controlWindows.id, { onDelete: "restrict" }),
		value: numeric("value", { precision: 38, scale: 9 }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		primaryKey({
			columns: [
				table.projectId,
				table.usageEventRecordedAt,
				table.usageEventId,
				table.controlWindowId,
			],
		}),
		index("idx_billing_usage_event_control_entries_window").on(
			table.projectId,
			table.controlWindowId,
			table.usageEventRecordedAt,
		),
		index("idx_billing_usage_event_control_entries_event").on(
			table.usageEventRecordedAt,
			table.usageEventId,
		),
	],
);

export const usageAlerts = pgTable(
	"usage_alerts",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		entityId: bigint("entity_id", { mode: "number" }).references(() => entities.id, {
			onDelete: "cascade",
		}),
		featureId: bigint("feature_id", { mode: "number" })
			.notNull()
			.references(() => features.id, { onDelete: "restrict" }),
		thresholdType: text("threshold_type").$type<"absolute" | "percentage">().notNull(),
		thresholdValue: numeric("threshold_value", { precision: 38, scale: 9 }).notNull(),
		interval: text("interval").$type<"month" | "year" | "lifetime">().notNull(),
		active: boolean("active").notNull().default(true),
		createdBy: text("created_by").notNull(),
		metadata: metadataColumn(),
		...timestampColumns(),
	},
	(table) => [
		unique("usage_alerts_project_id_id_unique").on(table.projectId, table.id),
		index("idx_billing_usage_alerts_scope")
			.on(table.projectId, table.customerId, table.featureId, table.entityId)
			.where(sql`${table.active} = true`),
	],
);

export const usageAlertStates = pgTable(
	"usage_alert_states",
	{
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		alertId: bigint("alert_id", { mode: "number" })
			.notNull()
			.references(() => usageAlerts.id, { onDelete: "cascade" }),
		windowStartAt: timestamp("window_start_at", { withTimezone: true }).notNull(),
		windowEndAt: timestamp("window_end_at", { withTimezone: true }),
		currentValue: numeric("current_value", { precision: 38, scale: 9 }).notNull().default("0"),
		thresholdValue: numeric("threshold_value", { precision: 38, scale: 9 }).notNull(),
		crossed: boolean("crossed").notNull().default(false),
		crossingSequence: integer("crossing_sequence").notNull().default(0),
		lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [primaryKey({ columns: [table.projectId, table.alertId] })],
);

export const usageAlertEvents = pgTable(
	"usage_alert_events",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		alertId: bigint("alert_id", { mode: "number" })
			.notNull()
			.references(() => usageAlerts.id, { onDelete: "cascade" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		entityId: bigint("entity_id", { mode: "number" }).references(() => entities.id, {
			onDelete: "set null",
		}),
		featureId: bigint("feature_id", { mode: "number" })
			.notNull()
			.references(() => features.id, { onDelete: "restrict" }),
		windowStartAt: timestamp("window_start_at", { withTimezone: true }).notNull(),
		crossingSequence: integer("crossing_sequence").notNull(),
		currentValue: numeric("current_value", { precision: 38, scale: 9 }).notNull(),
		thresholdValue: numeric("threshold_value", { precision: 38, scale: 9 }).notNull(),
		eventType: text("event_type").$type<"threshold_crossed" | "threshold_rearmed">().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		unique("usage_alert_events_project_id_id_unique").on(table.projectId, table.id),
		unique("usage_alert_events_crossing_unique").on(
			table.projectId,
			table.alertId,
			table.windowStartAt,
			table.crossingSequence,
			table.eventType,
		),
		index("idx_billing_usage_alert_events_customer").on(
			table.projectId,
			table.customerId,
			table.createdAt,
		),
	],
);

export const autoTopupPolicies = pgTable(
	"auto_topup_policies",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		entityId: bigint("entity_id", { mode: "number" }).references(() => entities.id, {
			onDelete: "cascade",
		}),
		featureId: bigint("feature_id", { mode: "number" })
			.notNull()
			.references(() => features.id, { onDelete: "restrict" }),
		topupOptionId: bigint("topup_option_id", { mode: "number" })
			.notNull()
			.references(() => topupOptions.id, { onDelete: "restrict" }),
		provider: text("provider").$type<BillingProvider>().notNull(),
		thresholdQuantity: quantityColumn("threshold_quantity").notNull(),
		cooldownSeconds: integer("cooldown_seconds").notNull().default(30),
		limitIntervalSeconds: integer("limit_interval_seconds").notNull().default(86400),
		maxPurchasesPerInterval: integer("max_purchases_per_interval").notNull().default(3),
		maxSpendMinor: bigint("max_spend_minor", { mode: "number" }),
		maxConsecutiveFailures: integer("max_consecutive_failures").notNull().default(3),
		active: boolean("active").notNull().default(true),
		createdBy: text("created_by").notNull(),
		...timestampColumns(),
	},
	(table) => [
		unique("auto_topup_policies_project_id_id_unique").on(table.projectId, table.id),
		uniqueIndex("idx_billing_auto_topup_policies_scope").on(
			table.projectId,
			table.customerId,
			table.featureId,
			sql`COALESCE(${table.entityId}, 0::bigint)`,
		),
	],
);

export const autoTopupStates = pgTable(
	"auto_topup_states",
	{
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		policyId: bigint("policy_id", { mode: "number" })
			.notNull()
			.references(() => autoTopupPolicies.id, { onDelete: "cascade" }),
		status: text("status").$type<"ready" | "cooldown" | "suspended">().notNull().default("ready"),
		intervalStartedAt: timestamp("interval_started_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		purchasesInInterval: integer("purchases_in_interval").notNull().default(0),
		spendMinorInInterval: bigint("spend_minor_in_interval", { mode: "number" })
			.notNull()
			.default(0),
		consecutiveFailures: integer("consecutive_failures").notNull().default(0),
		cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
		circuitOpenedAt: timestamp("circuit_opened_at", { withTimezone: true }),
		lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
		lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
		lastError: text("last_error"),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [primaryKey({ columns: [table.projectId, table.policyId] })],
);

export const autoTopupJobs = pgTable(
	"auto_topup_jobs",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		policyId: bigint("policy_id", { mode: "number" })
			.notNull()
			.references(() => autoTopupPolicies.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		storeProductId: uuid("store_product_id")
			.notNull()
			.references(() => storeProducts.id, { onDelete: "restrict" }),
		triggerKey: text("trigger_key").notNull(),
		provider: text("provider").$type<BillingProvider>().notNull(),
		status: text("status")
			.$type<"pending" | "processing" | "succeeded" | "failed" | "provider_action_required">()
			.notNull()
			.default("pending"),
		amountMinor: bigint("amount_minor", { mode: "number" }),
		chargedAmountMinor: bigint("charged_amount_minor", { mode: "number" }),
		currency: text("currency"),
		externalInvoiceId: text("external_invoice_id"),
		externalPaymentId: text("external_payment_id"),
		budgetReservedAt: timestamp("budget_reserved_at", { withTimezone: true }),
		budgetIntervalStartedAt: timestamp("budget_interval_started_at", { withTimezone: true }),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
		lockedAt: timestamp("locked_at", { withTimezone: true }),
		lockedBy: text("locked_by"),
		lastError: text("last_error"),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table) => [
		unique("auto_topup_jobs_project_id_id_unique").on(table.projectId, table.id),
		unique("auto_topup_jobs_trigger_unique").on(table.projectId, table.policyId, table.triggerKey),
		index("idx_billing_auto_topup_jobs_due")
			.on(table.nextAttemptAt, table.createdAt)
			.where(sql`${table.status} = 'pending'`),
		index("idx_billing_auto_topup_jobs_stale")
			.on(table.lockedAt, table.createdAt)
			.where(sql`${table.status} = 'processing'`),
		index("idx_billing_auto_topup_jobs_policy").on(table.policyId),
		index("idx_billing_auto_topup_jobs_customer").on(table.customerId, table.createdAt),
		index("idx_billing_auto_topup_jobs_store_product").on(table.storeProductId),
	],
);

export const catalogMigrationDrafts = pgTable(
	"catalog_migration_drafts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		fromPlanVersionId: bigint("from_plan_version_id", { mode: "number" })
			.notNull()
			.references(() => planVersions.id, { onDelete: "restrict" }),
		toPlanVersionId: bigint("to_plan_version_id", { mode: "number" })
			.notNull()
			.references(() => planVersions.id, { onDelete: "restrict" }),
		previewToken: text("preview_token").notNull(),
		intentHash: text("intent_hash").notNull(),
		effectiveMode: text("effective_mode").$type<"immediate" | "period_end">().notNull(),
		status: text("status")
			.$type<"previewed" | "published" | "expired">()
			.notNull()
			.default("previewed"),
		impact: jsonb("impact").$type<Record<string, unknown>>().notNull(),
		createdBy: text("created_by").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table) => [
		unique("catalog_migration_drafts_project_id_id_unique").on(table.projectId, table.id),
		unique("catalog_migration_drafts_token_unique").on(table.projectId, table.previewToken),
		index("idx_billing_catalog_migration_drafts_expiry").on(table.status, table.expiresAt),
	],
);

export const catalogMigrationJobs = pgTable(
	"catalog_migration_jobs",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		draftId: uuid("draft_id")
			.notNull()
			.references(() => catalogMigrationDrafts.id, { onDelete: "restrict" }),
		subscriptionId: uuid("subscription_id")
			.notNull()
			.references(() => subscriptions.id, { onDelete: "cascade" }),
		subscriptionChangeId: uuid("subscription_change_id").references(() => subscriptionChanges.id, {
			onDelete: "set null",
		}),
		status: text("status")
			.$type<"pending" | "processing" | "waiting_provider" | "applied" | "failed" | "skipped">()
			.notNull()
			.default("pending"),
		effectiveMode: text("effective_mode").$type<"immediate" | "period_end">().notNull(),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
		lockedAt: timestamp("locked_at", { withTimezone: true }),
		lockedBy: text("locked_by"),
		lastError: text("last_error"),
		appliedAt: timestamp("applied_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table) => [
		unique("catalog_migration_jobs_project_id_id_unique").on(table.projectId, table.id),
		unique("catalog_migration_jobs_subscription_unique").on(
			table.projectId,
			table.draftId,
			table.subscriptionId,
		),
		index("idx_billing_catalog_migration_jobs_due")
			.on(table.nextAttemptAt, table.createdAt)
			.where(sql`${table.status} = 'pending'`),
		index("idx_billing_catalog_migration_jobs_stale")
			.on(table.lockedAt, table.createdAt)
			.where(sql`${table.status} = 'processing'`),
		index("idx_billing_catalog_migration_jobs_change")
			.on(table.subscriptionChangeId)
			.where(sql`${table.subscriptionChangeId} IS NOT NULL`),
	],
);

export const licensePools = pgTable(
	"license_pools",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		subscriptionId: uuid("subscription_id")
			.notNull()
			.references(() => subscriptions.id, { onDelete: "cascade" }),
		planItemId: bigint("plan_item_id", { mode: "number" })
			.notNull()
			.references(() => planItems.id, { onDelete: "restrict" }),
		featureId: bigint("feature_id", { mode: "number" })
			.notNull()
			.references(() => features.id, { onDelete: "restrict" }),
		quantity: integer("quantity").notNull(),
		active: boolean("active").notNull().default(true),
		...timestampColumns(),
	},
	(table) => [
		unique("license_pools_project_id_id_unique").on(table.projectId, table.id),
		unique("license_pools_item_unique").on(table.projectId, table.subscriptionId, table.planItemId),
		index("idx_billing_license_pools_customer").on(table.projectId, table.customerId, table.active),
	],
);

export const licenseAssignments = pgTable(
	"license_assignments",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		licensePoolId: bigint("license_pool_id", { mode: "number" })
			.notNull()
			.references(() => licensePools.id, { onDelete: "cascade" }),
		entityId: bigint("entity_id", { mode: "number" })
			.notNull()
			.references(() => entities.id, { onDelete: "cascade" }),
		quantity: integer("quantity").notNull().default(1),
		assignedBy: text("assigned_by").notNull(),
		assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		metadata: metadataColumn(),
	},
	(table) => [
		unique("license_assignments_project_id_id_unique").on(table.projectId, table.id),
		uniqueIndex("idx_billing_license_assignments_active")
			.on(table.projectId, table.licensePoolId, table.entityId)
			.where(sql`${table.revokedAt} IS NULL`),
		index("idx_billing_license_assignments_entity")
			.on(table.projectId, table.entityId)
			.where(sql`${table.revokedAt} IS NULL`),
	],
);

export type ProjectRow = typeof projects.$inferSelect;
export type CustomerRow = typeof customers.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type StoreProductRow = typeof storeProducts.$inferSelect;
export type ProviderCustomerRow = typeof providerCustomers.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type PurchaseRow = typeof purchases.$inferSelect;
export type EntitlementRow = typeof entitlements.$inferSelect;
export type StoreEventRow = typeof storeEvents.$inferSelect;
export type ProjectionSyncJobRecord = typeof projectionSyncJobs.$inferSelect;
export type CatalogRevisionRow = typeof catalogRevisions.$inferSelect;
export type CatalogDraftRow = typeof catalogDrafts.$inferSelect;
export type CatalogProviderOperationRow = typeof catalogProviderOperations.$inferSelect;
export type FeatureRow = typeof features.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;
export type PlanVersionRow = typeof planVersions.$inferSelect;
export type PlanItemRow = typeof planItems.$inferSelect;
export type PriceComponentRow = typeof priceComponents.$inferSelect;
export type PriceTierRow = typeof priceTiers.$inferSelect;
export type ProviderPriceBindingRow = typeof providerPriceBindings.$inferSelect;
export type SubscriptionItemRow = typeof subscriptionItems.$inferSelect;
export type SubscriptionChangeRow = typeof subscriptionChanges.$inferSelect;
export type RateCardEntryRow = typeof rateCardEntries.$inferSelect;
export type RateCardTierRow = typeof rateCardTiers.$inferSelect;
export type ProviderPlanBindingRow = typeof providerPlanBindings.$inferSelect;
export type TopupOptionRow = typeof topupOptions.$inferSelect;
export type ProviderTopupBindingRow = typeof providerTopupBindings.$inferSelect;
export type BalanceAllocationRow = typeof balanceAllocations.$inferSelect;
export type ReservationRow = typeof reservations.$inferSelect;
export type UsageEventRow = typeof usageEvents.$inferSelect;
export type UsageEventRollupRow = typeof usageEventRollups.$inferSelect;
export type UsageInvoicePeriodRow = typeof usageInvoicePeriods.$inferSelect;
export type UsageInvoiceAdjustmentRow = typeof usageInvoiceAdjustments.$inferSelect;
export type EnterpriseContractRow = typeof enterpriseContracts.$inferSelect;
export type ControlPolicyRow = typeof controlPolicies.$inferSelect;
export type ControlWindowRow = typeof controlWindows.$inferSelect;
export type ReservationControlHoldRow = typeof reservationControlHolds.$inferSelect;
export type UsageEventControlEntryRow = typeof usageEventControlEntries.$inferSelect;
export type UsageAlertRow = typeof usageAlerts.$inferSelect;
export type UsageAlertEventRow = typeof usageAlertEvents.$inferSelect;
export type AutoTopupPolicyRow = typeof autoTopupPolicies.$inferSelect;
export type AutoTopupJobRow = typeof autoTopupJobs.$inferSelect;
export type CatalogMigrationDraftRow = typeof catalogMigrationDrafts.$inferSelect;
export type CatalogMigrationJobRow = typeof catalogMigrationJobs.$inferSelect;
export type LicensePoolRow = typeof licensePools.$inferSelect;
export type LicenseAssignmentRow = typeof licenseAssignments.$inferSelect;
