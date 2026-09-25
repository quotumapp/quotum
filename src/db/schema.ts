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
	type PgTableExtraConfigValue,
	pgTable,
	primaryKey,
	smallint,
	text,
	timestamp,
	unique,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type { PaymentSetupStatus } from "../billing/payment-setup";
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
import type { ProjectEnvironment, ProjectLifecycleStatus } from "../projects/context";

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
		platformProjectId: uuid("platform_project_id").notNull(),
		key: text("key").notNull(),
		name: text("name").notNull(),
		environment: text("environment").$type<ProjectEnvironment>().notNull(),
		lifecycleStatus: text("lifecycle_status").$type<ProjectLifecycleStatus>().notNull(),
		internalProject: boolean("internal_project").notNull(),
		publishedCatalogRevisionId: bigint("published_catalog_revision_id", { mode: "number" }),
		metadata: metadataColumn(),
		...timestampColumns(),
	},
	(table): PgTableExtraConfigValue[] => [
		check(
			"projects_key_format_check",
			sql`((((char_length(key) >= 1) AND (char_length(key) <= 80)) AND (key ~ '^[a-z0-9][a-z0-9_-]*$'::text)))`,
		),
		check(
			"projects_name_check",
			sql`((((char_length(name) >= 1) AND (char_length(name) <= 120)) AND (name = btrim(name))))`,
		),
		check(
			"projects_environment_check",
			sql`((environment = ANY (ARRAY['sandbox'::text, 'production'::text, 'internal'::text])))`,
		),
		check(
			"projects_lifecycle_status_check",
			sql`((lifecycle_status = ANY (ARRAY['inactive'::text, 'active'::text, 'suspended'::text, 'deactivating'::text, 'deactivated'::text])))`,
		),
		check(
			"projects_internal_environment_check",
			sql`((internal_project = (environment = 'internal'::text)))`,
		),
		foreignKey({
			name: "projects_published_catalog_revision_fk",
			columns: [table.id, table.publishedCatalogRevisionId],
			foreignColumns: [catalogRevisions.projectId, catalogRevisions.id],
		}).onDelete("restrict"),
		index("idx_billing_projects_published_catalog_revision")
			.on(table.publishedCatalogRevisionId)
			.where(sql`(published_catalog_revision_id IS NOT NULL)`),
		uniqueIndex("idx_billing_projects_key").on(table.key),
		index("idx_billing_projects_platform_project").on(table.platformProjectId),
		unique("projects_platform_project_environment_unique").on(
			table.platformProjectId,
			table.environment,
		),
	],
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
		projectionSequence: bigint("projection_sequence", { mode: "number" }).notNull().default(0),
		...timestampColumns(),
	},
	(table): PgTableExtraConfigValue[] => [
		check("customers_projection_sequence_check", sql`((projection_sequence >= 0))`),
		index("idx_billing_customers_billing_account_id_trgm").using(
			"gin",
			table.billingAccountId.op("gin_trgm_ops"),
		),
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
	(table): PgTableExtraConfigValue[] => [
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
	(table): PgTableExtraConfigValue[] => [
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
		provider: text("provider").$type<BillingProvider>().notNull(),
		providerAccountId: text("provider_account_id"),
		externalCustomerId: text("external_customer_id").notNull(),
		metadata: metadataColumn(),
		...timestampColumns(),
	},
	(table): PgTableExtraConfigValue[] => [
		index("idx_billing_provider_customers_external_customer_id_trgm").using(
			"gin",
			table.externalCustomerId.op("gin_trgm_ops"),
		),
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
		providerAccountId: text("provider_account_id"),
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
		trialEndingNotifiedAt: timestamp("trial_ending_notified_at", { withTimezone: true }),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"subscriptions_trial_bounds_check",
			sql`((((trial_start_at IS NULL) AND (trial_end_at IS NULL)) OR ((trial_start_at IS NOT NULL) AND (trial_end_at IS NOT NULL) AND (trial_end_at > trial_start_at))))`,
		),
		check(
			"subscriptions_trial_notice_check",
			sql`(((trial_ending_notified_at IS NULL) OR (trial_end_at IS NOT NULL)))`,
		),
		check(
			"subscriptions_scope_mode_check",
			sql`((scope_mode = ANY (ARRAY['account'::text, 'entity'::text])))`,
		),
		check(
			"subscriptions_scope_entity_check",
			sql`((((scope_mode = 'account'::text) AND (entity_id IS NULL)) OR ((scope_mode = 'entity'::text) AND (entity_id IS NOT NULL))))`,
		),
		foreignKey({
			name: "subscriptions_project_plan_version_fk",
			columns: [table.projectId, table.planVersionId],
			foreignColumns: [planVersions.projectId, planVersions.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "subscriptions_project_catalog_revision_fk",
			columns: [table.projectId, table.catalogRevisionId],
			foreignColumns: [catalogRevisions.projectId, catalogRevisions.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "subscriptions_project_entity_fk",
			columns: [table.projectId, table.entityId],
			foreignColumns: [entities.projectId, entities.id],
		}).onDelete("restrict"),
		index("idx_billing_subscriptions_latest_transaction_id_trgm").using(
			"gin",
			table.latestTransactionId.op("gin_trgm_ops"),
		),
		index("idx_billing_subscriptions_raw_state_order_id")
			.on(sql`(raw_state ->> 'orderId'::text)`)
			.where(sql`(raw_state ? 'orderId'::text)`),
		index("idx_billing_subscriptions_plan_version")
			.on(table.planVersionId)
			.where(sql`(plan_version_id IS NOT NULL)`),
		index("idx_billing_subscriptions_external_subscription_id_trgm").using(
			"gin",
			table.externalSubscriptionId.op("gin_trgm_ops"),
		),
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
		index("idx_billing_subscriptions_trial_ending_due")
			.on(table.trialEndAt)
			.where(
				sql`${table.trialEndingNotifiedAt} IS NULL AND ${table.trialEndAt} IS NOT NULL AND ${table.status} IN ('active', 'grace_period', 'billing_retry', 'cancelled')`,
			),
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
		providerAccountId: text("provider_account_id"),
		idempotencyKey: text("idempotency_key").notNull(),
		requestHash: text("request_hash").notNull(),
		status: text("status").$type<"creating" | "created">().notNull().default("creating"),
		externalSessionId: text("external_session_id"),
		sessionUrl: text("session_url"),
		...timestampColumns(),
	},
	(table): PgTableExtraConfigValue[] => [
		check(
			"checkout_requests_quantities_check",
			sql`((jsonb_typeof(requested_quantities) = 'object'::text))`,
		),
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
		index("idx_billing_checkout_requests_customer_created").on(
			table.customerId,
			table.createdAt.desc(),
		),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"credit_grants_grant_kind_check",
			sql`((grant_kind = ANY (ARRAY['monthly'::text, 'upgrade'::text, 'topup'::text])))`,
		),
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
		index("idx_billing_credit_grants_customer_created").on(
			table.customerId,
			table.createdAt.desc(),
		),
		index("idx_billing_credit_grants_subscription_id")
			.on(table.subscriptionId)
			.where(sql`${table.subscriptionId} IS NOT NULL`),
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
	(table): PgTableExtraConfigValue[] => [
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
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "credit_reversals_project_grant_fk",
			columns: [table.projectId, table.grantId],
			foreignColumns: [creditGrants.projectId, creditGrants.id],
		}).onDelete("restrict"),
		unique("credit_reversals_project_id_id_unique").on(table.projectId, table.id),
		foreignKey({
			name: "credit_reversals_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),

		uniqueIndex("idx_billing_credit_reversals_key").on(table.projectId, table.reversalKey),
		uniqueIndex("idx_billing_credit_reversals_first_grant").on(table.projectId, table.grantId),
		index("idx_billing_credit_reversals_customer_created").on(
			table.customerId,
			table.createdAt.desc(),
		),
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
	(table): PgTableExtraConfigValue[] => [
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
		index("idx_billing_invoices_customer_created").on(
			table.customerId,
			table.providerCreatedAt.desc(),
		),
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
		amountPaidMinor: bigint("amount_paid_minor", { mode: "number" }),
		currency: text("currency"),
		rawPayload: jsonb("raw_payload").$type<Record<string, unknown>>().notNull().default({}),
		...timestampColumns(),
	},
	(table): PgTableExtraConfigValue[] => [
		index("idx_billing_purchases_raw_payload_order_id")
			.on(sql`(raw_payload ->> 'orderId'::text)`)
			.where(sql`(raw_payload ? 'orderId'::text)`),
		index("idx_billing_purchases_original_transaction_id_trgm").using(
			"gin",
			table.originalTransactionId.op("gin_trgm_ops"),
		),
		index("idx_billing_purchases_transaction_id_trgm").using(
			"gin",
			table.transactionId.op("gin_trgm_ops"),
		),
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
		check(
			"purchases_amount_paid_minor_check",
			sql`${table.amountPaidMinor} IS NULL OR ${table.amountPaidMinor} >= 0`,
		),
		check(
			"purchases_currency_check",
			sql`${table.currency} IS NULL OR char_length(${table.currency}) = 3`,
		),
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
		// Composite FK to plan_grants is added after that table in the SQL baseline.
		sourcePlanGrantId: uuid("source_plan_grant_id"),
		metadata: metadataColumn(),
		computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
		...timestampColumns(),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "entitlements_project_plan_grant_fk",
			columns: [table.projectId, table.sourcePlanGrantId],
			foreignColumns: [planGrants.projectId, planGrants.id],
		}),
		index("idx_billing_entitlements_entitlement_key_trgm").using(
			"gin",
			table.entitlementKey.op("gin_trgm_ops"),
		),
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
		index("idx_billing_entitlements_source_plan_grant_id")
			.on(table.sourcePlanGrantId)
			.where(sql`${table.sourcePlanGrantId} IS NOT NULL`),
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
	(table): PgTableExtraConfigValue[] => [
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
		payload: jsonb("payload").$type<ProjectionJobPayload | null>(),
		status: text("status").$type<ProjectionSyncStatus>().notNull().default("pending"),
		attempts: integer("attempts").notNull().default(0),
		lastError: text("last_error"),
		reprojectionRequested: boolean("reprojection_requested").notNull().default(false),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
		lockedAt: timestamp("locked_at", { withTimezone: true }),
		lockedBy: text("locked_by"),
		...timestampColumns(),
	},
	(table): PgTableExtraConfigValue[] => [
		check(
			"projection_sync_jobs_payload_check",
			sql`((((payload IS NULL) AND (reason = 'usage_changed'::text)) OR (COALESCE((jsonb_typeof(payload) = 'object'::text), false) AND COALESCE((jsonb_typeof((payload -> 'billingAccountId'::text)) = 'string'::text), false) AND COALESCE((jsonb_typeof((payload -> 'generatedAt'::text)) = 'string'::text), false) AND COALESCE((jsonb_typeof((payload -> 'reason'::text)) = 'string'::text), false) AND COALESCE(((payload ->> 'reason'::text) = reason), false) AND COALESCE(((payload ->> 'generatedAt'::text) = ((payload -> 'entitlements'::text) ->> 'generatedAt'::text)), false) AND COALESCE(((payload ->> 'billingAccountId'::text) = ((payload -> 'entitlements'::text) ->> 'billingAccountId'::text)), false) AND COALESCE((jsonb_typeof((payload -> 'entitlements'::text)) = 'object'::text), false) AND COALESCE((jsonb_typeof(((payload -> 'entitlements'::text) -> 'entitlements'::text)) = 'array'::text), false) AND COALESCE((jsonb_typeof((payload -> 'balances'::text)) = 'array'::text), false) AND (NOT (payload ? 'operation'::text)) AND (NOT ((payload ? 'purchase'::text) AND (payload ? 'reversal'::text))) AND (NOT ((payload ? 'trial'::text) AND ((payload ? 'purchase'::text) OR (payload ? 'reversal'::text)))))))`,
		),
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

export const meteringSettings = pgTable(
	"metering_settings",
	{
		projectId: uuid("project_id")
			.primaryKey()
			.references(() => projects.id, { onDelete: "cascade" }),
		clientIdempotencyTtlSeconds: integer("client_idempotency_ttl_seconds").notNull().default(86400),
		workerDeliveryTtlSeconds: integer("worker_delivery_ttl_seconds").notNull().default(86400),
		occurredAtMaxSkewSeconds: integer("occurred_at_max_skew_seconds").notNull().default(300),
		rawUsageRetentionDays: integer("raw_usage_retention_days").notNull().default(400),
		consumeP99TargetMs: integer("consume_p99_target_ms").notNull().default(50),
		projectionUsageDebounceMs: integer("projection_usage_debounce_ms").notNull().default(1000),
		...timestampColumns(),
	},
	(_table): PgTableExtraConfigValue[] => [
		check(
			"metering_settings_client_idempotency_ttl_seconds_check",
			sql`(((client_idempotency_ttl_seconds >= 60) AND (client_idempotency_ttl_seconds <= 604800)))`,
		),
		check(
			"metering_settings_worker_delivery_ttl_seconds_check",
			sql`(((worker_delivery_ttl_seconds >= 60) AND (worker_delivery_ttl_seconds <= 604800)))`,
		),
		check(
			"metering_settings_occurred_at_max_skew_seconds_check",
			sql`(((occurred_at_max_skew_seconds >= 0) AND (occurred_at_max_skew_seconds <= 86400)))`,
		),
		check(
			"metering_settings_raw_usage_retention_days_check",
			sql`(((raw_usage_retention_days >= 30) AND (raw_usage_retention_days <= 3650)))`,
		),
		check(
			"metering_settings_consume_p99_target_ms_check",
			sql`(((consume_p99_target_ms >= 1) AND (consume_p99_target_ms <= 10000)))`,
		),
		check(
			"metering_settings_projection_usage_debounce_ms_check",
			sql`(((projection_usage_debounce_ms >= 0) AND (projection_usage_debounce_ms <= 30000)))`,
		),
	],
);

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
	(table): PgTableExtraConfigValue[] => [
		check("catalog_revisions_revision_check", sql`((revision > 0))`),
		check(
			"catalog_revisions_status_check",
			sql`((status = ANY (ARRAY['draft'::text, 'validating'::text, 'syncing'::text, 'ready'::text, 'published'::text, 'failed'::text])))`,
		),
		check("catalog_revisions_intent_hash_check", sql`((char_length(intent_hash) = 64))`),
		check(
			"catalog_revisions_publish_state_check",
			sql`((((status = 'published'::text) AND (published_at IS NOT NULL)) OR ((status <> 'published'::text) AND (published_at IS NULL))))`,
		),
		unique("catalog_revisions_project_id_id_unique").on(table.projectId, table.id),
		unique("catalog_revisions_project_revision_unique").on(table.projectId, table.revision),
		index("idx_billing_catalog_revisions_project_status").on(
			table.projectId,
			table.status,
			table.revision.desc(),
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
	(table): PgTableExtraConfigValue[] => [
		check("catalog_drafts_preview_token_check", sql`((char_length(preview_token) = 64))`),
		check("catalog_drafts_next_revision_check", sql`((next_revision > 0))`),
		check("catalog_drafts_intent_hash_check", sql`((char_length(intent_hash) = 64))`),
		check("catalog_drafts_intent_check", sql`((jsonb_typeof(intent) = 'object'::text))`),
		check(
			"catalog_drafts_status_check",
			sql`((status = ANY (ARRAY['previewed'::text, 'published'::text, 'expired'::text])))`,
		),
		check(
			"catalog_drafts_state_check",
			sql`((((status = 'published'::text) AND (published_revision_id IS NOT NULL)) OR ((status <> 'published'::text) AND (published_revision_id IS NULL))))`,
		),
		unique("catalog_drafts_project_id_id_unique").on(table.projectId, table.id),
		unique("catalog_drafts_project_token_unique").on(table.projectId, table.previewToken),
		index("idx_billing_catalog_drafts_expiry")
			.on(table.expiresAt)
			.where(sql`(status = 'previewed'::text)`),
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
			.$type<
				| "checkout_plan"
				| "checkout_product"
				| "subscription_change"
				| "cancel"
				| "uncancel"
				| "setup_payment"
			>()
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"commercial_action_previews_billing_account_id_check",
			sql`(((char_length(billing_account_id) >= 1) AND (char_length(billing_account_id) <= 200)))`,
		),
		check(
			"commercial_action_previews_intent_kind_check",
			sql`((intent_kind = ANY (ARRAY['checkout_plan'::text, 'checkout_product'::text, 'subscription_change'::text, 'cancel'::text, 'uncancel'::text, 'setup_payment'::text])))`,
		),
		check("commercial_action_previews_intent_hash_check", sql`((char_length(intent_hash) = 64))`),
		check(
			"commercial_action_previews_state_fingerprint_check",
			sql`((char_length(state_fingerprint) = 64))`,
		),
		check(
			"commercial_action_previews_intent_check",
			sql`((jsonb_typeof(intent) = 'object'::text))`,
		),
		check(
			"commercial_action_previews_preview_check",
			sql`((jsonb_typeof(preview) = 'object'::text))`,
		),
		check(
			"commercial_action_previews_status_check",
			sql`((status = ANY (ARRAY['previewed'::text, 'executing'::text, 'executed'::text])))`,
		),
		check(
			"commercial_action_previews_execution_idempotency_key_check",
			sql`(((execution_idempotency_key IS NULL) OR ((char_length(execution_idempotency_key) >= 1) AND (char_length(execution_idempotency_key) <= 200))))`,
		),
		check(
			"commercial_action_previews_execution_result_check",
			sql`(((execution_result IS NULL) OR (jsonb_typeof(execution_result) = 'object'::text)))`,
		),
		check(
			"commercial_action_previews_state_check",
			sql`((((status = 'previewed'::text) AND (execution_idempotency_key IS NULL) AND (execution_result IS NULL) AND (executed_at IS NULL)) OR ((status = 'executing'::text) AND (execution_idempotency_key IS NOT NULL) AND (execution_result IS NULL) AND (executed_at IS NULL)) OR ((status = 'executed'::text) AND (execution_idempotency_key IS NOT NULL) AND (execution_result IS NOT NULL) AND (executed_at IS NOT NULL))))`,
		),
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
			table.createdAt.desc(),
		),
	],
);

/**
 * Hosted payment-method setup. The SQL baseline is authoritative; this mirrors it, including the
 * partial unique index that keeps one unresolved setup per billing account and provider identity.
 */
export const paymentSetupSessions = pgTable(
	"payment_setup_sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		customerId: uuid("customer_id")
			.notNull()
			.references(() => customers.id, { onDelete: "cascade" }),
		billingAccountId: text("billing_account_id").notNull(),
		provider: text("provider").$type<"stripe">().notNull(),
		providerAccountId: text("provider_account_id"),
		providerCustomerId: text("provider_customer_id").notNull(),
		previewToken: uuid("preview_token").notNull(),
		providerIdempotencyKey: text("provider_idempotency_key").notNull(),
		requestHash: text("request_hash").notNull(),
		currency: text("currency").notNull(),
		email: text("email"),
		successUrl: text("success_url").notNull(),
		cancelUrl: text("cancel_url").notNull(),
		status: text("status").$type<PaymentSetupStatus>().notNull().default("creating"),
		externalSessionId: text("external_session_id"),
		sessionUrl: text("session_url"),
		externalSetupIntentId: text("external_setup_intent_id"),
		intendedPaymentMethodId: text("intended_payment_method_id"),
		defaultPaymentMethodId: text("default_payment_method_id"),
		cardBrand: text("card_brand"),
		cardLast4: text("card_last4"),
		cardExpMonth: integer("card_exp_month"),
		cardExpYear: integer("card_exp_year"),
		attentionReason: text("attention_reason"),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		claimedBy: text("claimed_by"),
		claimedAt: timestamp("claimed_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table): PgTableExtraConfigValue[] => [
		check("payment_setup_sessions_provider_check", sql`${table.provider} = 'stripe'`),
		check(
			"payment_setup_sessions_billing_account_id_check",
			sql`char_length(${table.billingAccountId}) BETWEEN 1 AND 200`,
		),
		check(
			"payment_setup_sessions_provider_customer_id_check",
			sql`char_length(${table.providerCustomerId}) BETWEEN 1 AND 200`,
		),
		check(
			"payment_setup_sessions_provider_idempotency_key_check",
			sql`char_length(${table.providerIdempotencyKey}) BETWEEN 1 AND 255`,
		),
		check("payment_setup_sessions_request_hash_check", sql`char_length(${table.requestHash}) = 64`),
		check("payment_setup_sessions_currency_check", sql`${table.currency} ~ '^[a-z]{3}$'`),
		check(
			"payment_setup_sessions_email_check",
			sql`${table.email} IS NULL OR char_length(${table.email}) BETWEEN 1 AND 320`,
		),
		check(
			"payment_setup_sessions_success_url_check",
			sql`char_length(${table.successUrl}) BETWEEN 1 AND 2000`,
		),
		check(
			"payment_setup_sessions_cancel_url_check",
			sql`char_length(${table.cancelUrl}) BETWEEN 1 AND 2000`,
		),
		check(
			"payment_setup_sessions_status_check",
			sql`${table.status} IN ('creating', 'awaiting_customer', 'applying_default', 'completed', 'expired', 'needs_attention')`,
		),
		check(
			"payment_setup_sessions_external_session_id_check",
			sql`${table.externalSessionId} IS NULL OR char_length(${table.externalSessionId}) BETWEEN 1 AND 200`,
		),
		check(
			"payment_setup_sessions_card_brand_check",
			sql`${table.cardBrand} IS NULL OR char_length(${table.cardBrand}) BETWEEN 1 AND 40`,
		),
		check(
			"payment_setup_sessions_card_last4_check",
			sql`${table.cardLast4} IS NULL OR ${table.cardLast4} ~ '^[0-9]{4}$'`,
		),
		check(
			"payment_setup_sessions_card_exp_month_check",
			sql`${table.cardExpMonth} IS NULL OR ${table.cardExpMonth} BETWEEN 1 AND 12`,
		),
		check(
			"payment_setup_sessions_card_exp_year_check",
			sql`${table.cardExpYear} IS NULL OR ${table.cardExpYear} BETWEEN 2000 AND 2200`,
		),
		check(
			"payment_setup_sessions_attention_reason_check",
			sql`${table.attentionReason} IS NULL OR char_length(${table.attentionReason}) BETWEEN 1 AND 500`,
		),
		check(
			"payment_setup_sessions_claimed_by_check",
			sql`${table.claimedBy} IS NULL OR char_length(${table.claimedBy}) BETWEEN 1 AND 200`,
		),
		check(
			"payment_setup_sessions_claim_check",
			sql`(${table.claimedBy} IS NULL AND ${table.claimedAt} IS NULL) OR (${table.claimedBy} IS NOT NULL AND ${table.claimedAt} IS NOT NULL)`,
		),
		check(
			"payment_setup_sessions_state_check",
			sql`
				(${table.status} = 'creating' AND ${table.completedAt} IS NULL AND ${table.defaultPaymentMethodId} IS NULL)
				OR (${table.status} = 'awaiting_customer' AND ${table.externalSessionId} IS NOT NULL
					AND ${table.sessionUrl} IS NOT NULL AND ${table.completedAt} IS NULL AND ${table.defaultPaymentMethodId} IS NULL)
				OR (${table.status} = 'applying_default' AND ${table.externalSessionId} IS NOT NULL
					AND ${table.intendedPaymentMethodId} IS NOT NULL AND ${table.completedAt} IS NULL AND ${table.defaultPaymentMethodId} IS NULL)
				OR (${table.status} = 'completed' AND ${table.externalSessionId} IS NOT NULL
					AND ${table.defaultPaymentMethodId} IS NOT NULL AND ${table.completedAt} IS NOT NULL)
				OR (${table.status} = 'expired' AND ${table.completedAt} IS NULL AND ${table.defaultPaymentMethodId} IS NULL)
				OR (${table.status} = 'needs_attention' AND ${table.attentionReason} IS NOT NULL AND ${table.completedAt} IS NULL)
			`,
		),
		check(
			"payment_setup_sessions_card_check",
			sql`${table.defaultPaymentMethodId} IS NOT NULL OR (${table.cardBrand} IS NULL AND ${table.cardLast4} IS NULL AND ${table.cardExpMonth} IS NULL AND ${table.cardExpYear} IS NULL)`,
		),
		unique("payment_setup_sessions_project_id_id_unique").on(table.projectId, table.id),
		unique("payment_setup_sessions_project_preview_unique").on(table.projectId, table.previewToken),
		foreignKey({
			name: "payment_setup_sessions_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		uniqueIndex("idx_billing_payment_setup_active")
			.on(
				table.projectId,
				table.customerId,
				table.provider,
				sql`COALESCE(${table.providerAccountId}, '')`,
			)
			.where(
				sql`${table.status} IN ('creating', 'awaiting_customer', 'applying_default', 'needs_attention')`,
			),
		uniqueIndex("idx_billing_payment_setup_external_session")
			.on(table.projectId, table.externalSessionId)
			.where(sql`${table.externalSessionId} IS NOT NULL`),
		index("idx_billing_payment_setup_account_created").on(
			table.projectId,
			table.billingAccountId,
			table.createdAt.desc(),
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
		details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table): PgTableExtraConfigValue[] => [
		check("catalog_audit_log_intent_hash_check", sql`((char_length(intent_hash) = 64))`),
		check(
			"catalog_audit_log_action_check",
			sql`((action = ANY (ARRAY['catalog_published'::text, 'plan_migrated'::text, 'catalog_archived'::text, 'contract_published'::text, 'contract_terminated'::text, 'control_changed'::text, 'auto_topup_reset'::text, 'license_changed'::text])))`,
		),
		foreignKey({
			name: "catalog_audit_log_project_revision_fk",
			columns: [table.projectId, table.catalogRevisionId],
			foreignColumns: [catalogRevisions.projectId, catalogRevisions.id],
		}),
		unique("catalog_audit_log_project_id_id_unique").on(table.projectId, table.id),
		index("idx_billing_catalog_audit_project_created").on(table.projectId, table.createdAt.desc()),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"catalog_provider_operations_provider_check",
			sql`((provider = ANY (ARRAY['apple'::text, 'google'::text, 'stripe'::text])))`,
		),
		check(
			"catalog_provider_operations_channel_check",
			sql`((channel = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])))`,
		),
		check(
			"catalog_provider_operations_status_check",
			sql`((status = ANY (ARRAY['pending'::text, 'processing'::text, 'ready'::text, 'failed'::text])))`,
		),
		check("catalog_provider_operations_attempts_check", sql`((attempts >= 0))`),
		check(
			"catalog_provider_operations_state_check",
			sql`((((status = 'ready'::text) AND (completed_at IS NOT NULL) AND (last_error IS NULL)) OR ((status = 'failed'::text) AND (last_error IS NOT NULL) AND (completed_at IS NULL)) OR ((status = ANY (ARRAY['pending'::text, 'processing'::text])) AND (completed_at IS NULL))))`,
		),
		check(
			"catalog_provider_operations_action_check",
			sql`((action = ANY (ARRAY['adopt_plan'::text, 'adopt_topup'::text, 'adopt_price'::text])))`,
		),
		foreignKey({
			name: "catalog_provider_operations_project_revision_fk",
			columns: [table.projectId, table.catalogRevisionId],
			foreignColumns: [catalogRevisions.projectId, catalogRevisions.id],
		}),
		foreignKey({
			name: "catalog_provider_operations_project_store_fk",
			columns: [table.projectId, table.storeProductId],
			foreignColumns: [storeProducts.projectId, storeProducts.id],
		}),
		unique("catalog_provider_operations_project_id_id_unique").on(table.projectId, table.id),
		unique("catalog_provider_operations_key_unique").on(table.projectId, table.operationKey),
		index("idx_billing_catalog_provider_operations_due")
			.on(table.status, table.createdAt)
			.where(sql`${table.status} IN ('pending', 'processing', 'failed')`),
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
	(table): PgTableExtraConfigValue[] => [
		check("features_kind_check", sql`((kind = ANY (ARRAY['boolean'::text, 'metered'::text])))`),
		check(
			"features_meter_kind_check",
			sql`(((meter_kind IS NULL) OR (meter_kind = ANY (ARRAY['consumable'::text, 'non_consumable'::text]))))`,
		),
		check("features_credit_scale_check", sql`(((credit_scale >= 0) AND (credit_scale <= 9)))`),
		check(
			"features_kind_meter_check",
			sql`((((kind = 'boolean'::text) AND (meter_kind IS NULL) AND (credit_scale = 0)) OR ((kind = 'metered'::text) AND (meter_kind IS NOT NULL))))`,
		),
		check(
			"features_filter_dimensions_check",
			sql`(((cardinality(filter_dimensions) <= 8) AND (array_position(filter_dimensions, ''::text) IS NULL)))`,
		),
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
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "plans_active_version_fk",
			columns: [table.projectId, table.activeVersionId],
			foreignColumns: [planVersions.projectId, planVersions.id],
		}).onDelete("restrict"),
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
		customerId: uuid("customer_id"),
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
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "plan_versions_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("restrict"),
		check("plan_versions_version_check", sql`((version > 0))`),
		check(
			"plan_versions_status_check",
			sql`((status = ANY (ARRAY['draft'::text, 'published'::text, 'archived'::text])))`,
		),
		check(
			"plan_versions_base_amount_minor_check",
			sql`(((base_amount_minor IS NULL) OR (base_amount_minor >= 0)))`,
		),
		check(
			"plan_versions_billing_interval_check",
			sql`(((billing_interval IS NULL) OR (billing_interval = ANY (ARRAY['month'::text, 'year'::text]))))`,
		),
		check(
			"plan_versions_trial_days_check",
			sql`(((trial_days IS NULL) OR ((trial_days >= 0) AND (trial_days <= 730))))`,
		),
		check(
			"plan_versions_price_check",
			sql`((((base_amount_minor IS NULL) AND (currency IS NULL)) OR ((base_amount_minor IS NOT NULL) AND (currency IS NOT NULL))))`,
		),
		check(
			"plan_versions_plan_kind_check",
			sql`((plan_kind = ANY (ARRAY['base'::text, 'addon'::text])))`,
		),
		check(
			"plan_versions_trial_end_behavior_check",
			sql`((trial_end_behavior = ANY (ARRAY['cancel'::text, 'pause'::text])))`,
		),
		check(
			"plan_versions_upgrade_proration_check",
			sql`((upgrade_proration_behavior = ANY (ARRAY['always_invoice'::text, 'create_prorations'::text, 'none'::text])))`,
		),
		check(
			"plan_versions_downgrade_proration_check",
			sql`((downgrade_proration_behavior = ANY (ARRAY['always_invoice'::text, 'create_prorations'::text, 'none'::text])))`,
		),
		check(
			"plan_versions_visibility_check",
			sql`((visibility = ANY (ARRAY['public'::text, 'customer_specific'::text])))`,
		),
		check(
			"plan_versions_visibility_customer_check",
			sql`((((visibility = 'public'::text) AND (customer_id IS NULL)) OR ((visibility = 'customer_specific'::text) AND (customer_id IS NOT NULL))))`,
		),
		foreignKey({
			name: "plan_versions_project_plan_fk",
			columns: [table.projectId, table.planId],
			foreignColumns: [plans.projectId, plans.id],
		}),
		foreignKey({
			name: "plan_versions_project_revision_fk",
			columns: [table.projectId, table.catalogRevisionId],
			foreignColumns: [catalogRevisions.projectId, catalogRevisions.id],
		}),
		index("idx_billing_plan_versions_plan").on(table.planId, table.version.desc()),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"plan_items_reset_interval_check",
			sql`(((reset_interval IS NULL) OR (reset_interval = ANY (ARRAY['month'::text, 'year'::text]))))`,
		),
		check(
			"plan_items_expires_after_seconds_check",
			sql`(((expires_after_seconds IS NULL) OR (expires_after_seconds > 0)))`,
		),
		check(
			"plan_items_overage_policy_check",
			sql`((overage_policy = ANY (ARRAY['blocked'::text, 'allowed'::text])))`,
		),
		check(
			"plan_items_item_kind_check",
			sql`((item_kind = ANY (ARRAY['access'::text, 'allocation'::text, 'meter_limit'::text, 'licensed_quantity'::text])))`,
		),
		check(
			"plan_items_quantity_check",
			sql`((((item_kind = 'access'::text) AND (quantity IS NULL) AND (reset_interval IS NULL)) OR ((item_kind = ANY (ARRAY['allocation'::text, 'meter_limit'::text, 'licensed_quantity'::text])) AND (quantity IS NOT NULL) AND (quantity > (0)::numeric))))`,
		),
		check(
			"plan_items_licensed_reset_check",
			sql`(((item_kind <> 'licensed_quantity'::text) OR (reset_interval IS NULL)))`,
		),
		check(
			"plan_items_overage_check",
			sql`(((overage_policy = 'blocked'::text) OR (item_kind = 'meter_limit'::text)))`,
		),
		check(
			"plan_items_allocation_scope_check",
			sql`((allocation_scope = ANY (ARRAY['account'::text, 'entity'::text, 'license_pool'::text])))`,
		),
		check(
			"plan_items_rollover_max_check",
			sql`(((rollover_max_quantity IS NULL) OR (rollover_max_quantity > (0)::numeric)))`,
		),
		check(
			"plan_items_rollover_expiry_check",
			sql`((((rollover_enabled = false) AND (rollover_max_quantity IS NULL) AND (rollover_expiry_mode = 'none'::text) AND (rollover_expiry_months IS NULL)) OR ((rollover_enabled = true) AND (rollover_expiry_mode = ANY (ARRAY['forever'::text, 'months'::text])) AND (((rollover_expiry_mode = 'forever'::text) AND (rollover_expiry_months IS NULL)) OR ((rollover_expiry_mode = 'months'::text) AND ((rollover_expiry_months >= 1) AND (rollover_expiry_months <= 120)))))))`,
		),
		check(
			"plan_items_rollover_kind_check",
			sql`(((rollover_enabled = false) OR (item_kind = 'allocation'::text)))`,
		),
		foreignKey({
			name: "plan_items_project_version_fk",
			columns: [table.projectId, table.planVersionId],
			foreignColumns: [planVersions.projectId, planVersions.id],
		}),
		foreignKey({
			name: "plan_items_project_feature_fk",
			columns: [table.projectId, table.featureId],
			foreignColumns: [features.projectId, features.id],
		}),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"price_components_component_kind_check",
			sql`((component_kind = ANY (ARRAY['base'::text, 'licensed'::text, 'metered_overage'::text])))`,
		),
		check(
			"price_components_charge_timing_check",
			sql`((charge_timing = ANY (ARRAY['in_advance'::text, 'in_arrears'::text])))`,
		),
		check("price_components_currency_check", sql`((char_length(currency) = 3))`),
		check("price_components_unit_amount_minor_check", sql`((unit_amount_minor >= 0))`),
		check("price_components_billing_units_check", sql`((billing_units > (0)::numeric))`),
		check(
			"price_components_billing_interval_check",
			sql`((billing_interval = ANY (ARRAY['month'::text, 'year'::text])))`,
		),
		check("price_components_minimum_quantity_check", sql`((minimum_quantity > 0))`),
		check(
			"price_components_check",
			sql`(((maximum_quantity IS NULL) OR (maximum_quantity >= minimum_quantity)))`,
		),
		check(
			"price_components_tax_behavior_check",
			sql`((tax_behavior = ANY (ARRAY['inclusive'::text, 'exclusive'::text, 'unspecified'::text])))`,
		),
		check(
			"price_components_shape_check",
			sql`((((component_kind = 'base'::text) AND (plan_item_id IS NULL) AND (charge_timing = 'in_advance'::text)) OR ((component_kind = 'licensed'::text) AND (plan_item_id IS NOT NULL) AND (charge_timing = 'in_advance'::text)) OR ((component_kind = 'metered_overage'::text) AND (plan_item_id IS NOT NULL) AND (charge_timing = 'in_arrears'::text))))`,
		),
		check(
			"price_components_pricing_model_check",
			sql`((pricing_model = ANY (ARRAY['flat'::text, 'graduated'::text, 'volume'::text])))`,
		),
		foreignKey({
			name: "price_components_project_version_fk",
			columns: [table.projectId, table.planVersionId],
			foreignColumns: [planVersions.projectId, planVersions.id],
		}),
		foreignKey({
			name: "price_components_project_item_fk",
			columns: [table.projectId, table.planItemId],
			foreignColumns: [planItems.projectId, planItems.id],
		}),
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
	(table): PgTableExtraConfigValue[] => [
		check("price_tiers_ordinal_check", sql`((ordinal >= 0))`),
		check(
			"price_tiers_up_to_quantity_check",
			sql`(((up_to_quantity IS NULL) OR (up_to_quantity > (0)::numeric)))`,
		),
		check("price_tiers_unit_amount_minor_check", sql`((unit_amount_minor >= 0))`),
		check("price_tiers_flat_amount_minor_check", sql`((flat_amount_minor >= 0))`),
		foreignKey({
			name: "price_tiers_project_component_fk",
			columns: [table.projectId, table.priceComponentId],
			foreignColumns: [priceComponents.projectId, priceComponents.id],
		}).onDelete("restrict"),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"provider_price_bindings_provider_check",
			sql`((provider = ANY (ARRAY['apple'::text, 'google'::text, 'stripe'::text])))`,
		),
		check(
			"provider_price_bindings_channel_check",
			sql`((channel = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])))`,
		),
		check(
			"provider_price_bindings_status_check",
			sql`((status = ANY (ARRAY['validating'::text, 'syncing'::text, 'ready'::text, 'published'::text, 'failed'::text])))`,
		),
		foreignKey({
			name: "provider_price_bindings_project_component_fk",
			columns: [table.projectId, table.priceComponentId],
			foreignColumns: [priceComponents.projectId, priceComponents.id],
		}),
		foreignKey({
			name: "provider_price_bindings_project_store_fk",
			columns: [table.projectId, table.storeProductId],
			foreignColumns: [storeProducts.projectId, storeProducts.id],
		}),
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
	(table): PgTableExtraConfigValue[] => [
		check("subscription_items_quantity_check", sql`((quantity > 0))`),
		check("subscription_items_unit_amount_minor_check", sql`((unit_amount_minor >= 0))`),
		check("subscription_items_currency_check", sql`((char_length(currency) = 3))`),
		check("subscription_items_bounds_check", sql`(((ends_at IS NULL) OR (ends_at > starts_at)))`),
		foreignKey({
			name: "subscription_items_project_subscription_fk",
			columns: [table.projectId, table.subscriptionId],
			foreignColumns: [subscriptions.projectId, subscriptions.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "subscription_items_project_component_fk",
			columns: [table.projectId, table.priceComponentId],
			foreignColumns: [priceComponents.projectId, priceComponents.id],
		}),
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
		provider: text("provider").$type<BillingProvider>().notNull(),
		providerAccountId: text("provider_account_id"),
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
		synchronizedAt: timestamp("synchronized_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table): PgTableExtraConfigValue[] => [
		check(
			"subscription_changes_requested_quantities_check",
			sql`((jsonb_typeof(requested_quantities) = 'object'::text))`,
		),
		check(
			"subscription_changes_change_kind_check",
			sql`((change_kind = ANY (ARRAY['upgrade'::text, 'downgrade'::text, 'quantity'::text])))`,
		),
		check(
			"subscription_changes_effective_mode_check",
			sql`((effective_mode = ANY (ARRAY['immediate'::text, 'period_end'::text])))`,
		),
		check(
			"subscription_changes_proration_behavior_check",
			sql`((proration_behavior = ANY (ARRAY['always_invoice'::text, 'create_prorations'::text, 'none'::text])))`,
		),
		check(
			"subscription_changes_status_check",
			sql`((status = ANY (ARRAY['pending'::text, 'processing'::text, 'applied'::text, 'failed'::text, 'cancelled'::text])))`,
		),
		check(
			"subscription_changes_idempotency_key_check",
			sql`(((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 200)))`,
		),
		check("subscription_changes_request_hash_check", sql`((char_length(request_hash) = 64))`),
		check("subscription_changes_attempts_check", sql`((attempts >= 0))`),
		check(
			"subscription_changes_state_check",
			sql`((((status = 'applied'::text) AND (applied_at IS NOT NULL) AND (last_error IS NULL)) OR ((status = 'failed'::text) AND (last_error IS NOT NULL) AND (applied_at IS NULL)) OR ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'cancelled'::text])) AND (applied_at IS NULL))))`,
		),
		foreignKey({
			name: "subscription_changes_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "subscription_changes_project_subscription_fk",
			columns: [table.projectId, table.subscriptionId],
			foreignColumns: [subscriptions.projectId, subscriptions.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "subscription_changes_project_from_plan_fk",
			columns: [table.projectId, table.fromPlanVersionId],
			foreignColumns: [planVersions.projectId, planVersions.id],
		}),
		foreignKey({
			name: "subscription_changes_project_to_plan_fk",
			columns: [table.projectId, table.toPlanVersionId],
			foreignColumns: [planVersions.projectId, planVersions.id],
		}),
		check(
			"subscription_changes_provider_check",
			sql`${table.provider} IN ('apple', 'google', 'stripe')`,
		),
		check(
			"subscription_changes_synchronization_check",
			sql`${table.synchronizedAt} IS NULL OR ${table.status} = 'applied'`,
		),
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
	(table): PgTableExtraConfigValue[] => [
		check("rate_card_entries_rate_per_unit_check", sql`((rate_per_unit > (0)::numeric))`),
		check(
			"rate_card_entries_distinct_features_check",
			sql`((meter_feature_id <> wallet_feature_id))`,
		),
		check(
			"rate_card_entries_pricing_model_check",
			sql`((pricing_model = ANY (ARRAY['flat'::text, 'graduated'::text])))`,
		),
		foreignKey({
			name: "rate_card_entries_project_revision_fk",
			columns: [table.projectId, table.catalogRevisionId],
			foreignColumns: [catalogRevisions.projectId, catalogRevisions.id],
		}),
		foreignKey({
			name: "rate_card_entries_project_meter_fk",
			columns: [table.projectId, table.meterFeatureId],
			foreignColumns: [features.projectId, features.id],
		}),
		foreignKey({
			name: "rate_card_entries_project_wallet_fk",
			columns: [table.projectId, table.walletFeatureId],
			foreignColumns: [features.projectId, features.id],
		}),
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
	(table): PgTableExtraConfigValue[] => [
		check("rate_card_tiers_ordinal_check", sql`((ordinal >= 0))`),
		check(
			"rate_card_tiers_up_to_quantity_check",
			sql`(((up_to_quantity IS NULL) OR (up_to_quantity > (0)::numeric)))`,
		),
		check("rate_card_tiers_rate_per_unit_check", sql`((rate_per_unit > (0)::numeric))`),
		foreignKey({
			name: "rate_card_tiers_project_entry_fk",
			columns: [table.projectId, table.rateCardEntryId],
			foreignColumns: [rateCardEntries.projectId, rateCardEntries.id],
		}).onDelete("restrict"),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"provider_plan_bindings_provider_check",
			sql`((provider = ANY (ARRAY['apple'::text, 'google'::text, 'stripe'::text])))`,
		),
		check(
			"provider_plan_bindings_channel_check",
			sql`((channel = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])))`,
		),
		check(
			"provider_plan_bindings_status_check",
			sql`((status = ANY (ARRAY['validating'::text, 'syncing'::text, 'ready'::text, 'published'::text, 'failed'::text])))`,
		),
		foreignKey({
			name: "provider_plan_bindings_project_version_fk",
			columns: [table.projectId, table.planVersionId],
			foreignColumns: [planVersions.projectId, planVersions.id],
		}),
		foreignKey({
			name: "provider_plan_bindings_project_store_fk",
			columns: [table.projectId, table.storeProductId],
			foreignColumns: [storeProducts.projectId, storeProducts.id],
		}),
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
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "topup_options_project_revision_fk",
			columns: [table.projectId, table.catalogRevisionId],
			foreignColumns: [catalogRevisions.projectId, catalogRevisions.id],
		}),
		check("topup_options_quantity_check", sql`((quantity > (0)::numeric))`),
		check(
			"topup_options_expires_after_seconds_check",
			sql`(((expires_after_seconds IS NULL) OR (expires_after_seconds > 0)))`,
		),
		foreignKey({
			name: "topup_options_project_feature_fk",
			columns: [table.projectId, table.featureId],
			foreignColumns: [features.projectId, features.id],
		}),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"provider_topup_bindings_provider_check",
			sql`((provider = ANY (ARRAY['apple'::text, 'google'::text, 'stripe'::text])))`,
		),
		check(
			"provider_topup_bindings_channel_check",
			sql`((channel = ANY (ARRAY['ios'::text, 'android'::text, 'web'::text])))`,
		),
		check(
			"provider_topup_bindings_status_check",
			sql`((status = ANY (ARRAY['validating'::text, 'syncing'::text, 'ready'::text, 'published'::text, 'failed'::text])))`,
		),
		foreignKey({
			name: "provider_topup_bindings_project_option_fk",
			columns: [table.projectId, table.topupOptionId],
			foreignColumns: [topupOptions.projectId, topupOptions.id],
		}),
		foreignKey({
			name: "provider_topup_bindings_project_store_fk",
			columns: [table.projectId, table.storeProductId],
			foreignColumns: [storeProducts.projectId, storeProducts.id],
		}),
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
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "entities_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
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
		// Composite FK to promotion_redemptions is added after that table in the SQL baseline.
		promotionRedemptionId: uuid("promotion_redemption_id"),
		// Composite FK to plan_grants is added after that table in the SQL baseline.
		planGrantId: uuid("plan_grant_id"),
		...timestampColumns(),
	},
	(table): PgTableExtraConfigValue[] => [
		check(
			"balance_allocations_source_kind_check",
			sql`((source_kind = ANY (ARRAY['subscription'::text, 'purchase'::text, 'credit_grant'::text, 'topup'::text, 'reward'::text, 'operator'::text, 'rollover'::text])))`,
		),
		check("balance_allocations_quantity_check", sql`((quantity > (0)::numeric))`),
		check(
			"balance_allocations_check",
			sql`(((reversed_quantity >= (0)::numeric) AND (reversed_quantity <= quantity)))`,
		),
		check(
			"balance_allocations_consumed_quantity_check",
			sql`((consumed_quantity >= (0)::numeric))`,
		),
		check("balance_allocations_held_quantity_check", sql`((held_quantity >= (0)::numeric))`),
		check(
			"balance_allocations_capacity_check",
			sql`(((consumed_quantity + held_quantity) <= quantity))`,
		),
		check(
			"balance_allocations_period_check",
			sql`(((period_start_at IS NULL) OR (period_end_at IS NULL) OR (period_start_at < period_end_at)))`,
		),
		check(
			"balance_allocations_rollover_shape_check",
			sql`((((source_kind = 'rollover'::text) AND (rollover_origin_allocation_id IS NOT NULL) AND (rollover_policy_revision IS NOT NULL) AND (rollover_policy_revision > 0)) OR ((source_kind <> 'rollover'::text) AND (rollover_origin_allocation_id IS NULL) AND (rollover_policy_revision IS NULL))))`,
		),
		foreignKey({
			name: "balance_allocations_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "balance_allocations_project_entity_fk",
			columns: [table.projectId, table.entityId],
			foreignColumns: [entities.projectId, entities.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "balance_allocations_project_feature_fk",
			columns: [table.projectId, table.featureId],
			foreignColumns: [features.projectId, features.id],
		}),
		foreignKey({
			name: "balance_allocations_project_plan_item_fk",
			columns: [table.projectId, table.planItemId],
			foreignColumns: [planItems.projectId, planItems.id],
		}).onDelete("set null"),
		foreignKey({
			name: "balance_allocations_rollover_origin_fk",
			columns: [table.projectId, table.rolloverOriginAllocationId],
			foreignColumns: [table.projectId, table.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "balance_allocations_project_promotion_redemption_fk",
			columns: [table.projectId, table.promotionRedemptionId],
			foreignColumns: [promotionRedemptions.projectId, promotionRedemptions.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "balance_allocations_project_plan_grant_fk",
			columns: [table.projectId, table.planGrantId],
			foreignColumns: [planGrants.projectId, planGrants.id],
		}),
		index("idx_billing_balance_allocations_plan_item")
			.on(table.planItemId)
			.where(sql`(plan_item_id IS NOT NULL)`),
		index("idx_billing_balance_allocations_spend_order")
			.on(
				table.projectId,
				table.customerId,
				table.featureId,
				table.entityId,
				table.expiresAt,
				table.createdAt,
				table.id,
			)
			.where(sql`(reversed_at IS NULL)`),
		index("idx_billing_balance_allocations_credit_grant")
			.on(table.creditGrantId)
			.where(sql`(credit_grant_id IS NOT NULL)`),
		index("idx_billing_balance_allocations_purchase")
			.on(table.purchaseId)
			.where(sql`(purchase_id IS NOT NULL)`),
		index("idx_billing_balance_allocations_subscription")
			.on(table.subscriptionId)
			.where(sql`(subscription_id IS NOT NULL)`),
		index("idx_billing_balance_allocations_entity")
			.on(table.entityId)
			.where(sql`(entity_id IS NOT NULL)`),
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
		index("idx_billing_balance_allocations_promotion_redemption")
			.on(table.projectId, table.promotionRedemptionId)
			.where(sql`${table.promotionRedemptionId} IS NOT NULL`),
		index("idx_billing_balance_allocations_plan_grant")
			.on(table.projectId, table.planGrantId)
			.where(sql`${table.planGrantId} IS NOT NULL`),
		check(
			"balance_allocations_reward_provenance_check",
			sql`(${table.sourceKind} = 'reward') = (${table.promotionRedemptionId} IS NOT NULL OR ${table.planGrantId} IS NOT NULL)`,
		),
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
		recoveryVersion: smallint("recovery_version").notNull().default(0),
		retentionPolicyVersion: text("retention_policy_version").notNull().default("usage-recovery-v1"),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		resultExpiresAt: timestamp("result_expires_at", { withTimezone: true }),
		outcome: jsonb("outcome"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table): PgTableExtraConfigValue[] => [
		check(
			"client_idempotency_claims_idempotency_key_check",
			sql`(((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 200)))`,
		),
		check(
			"client_idempotency_claims_request_fingerprint_check",
			sql`((char_length(request_fingerprint) = 64))`,
		),
		check(
			"client_idempotency_claims_recovery_version_check",
			sql`((recovery_version = ANY (ARRAY[0, 1])))`,
		),
		check(
			"client_idempotency_claims_retention_policy_version_check",
			sql`((retention_policy_version = 'usage-recovery-v1'::text))`,
		),
		check("client_idempotency_claims_expiry_check", sql`((expires_at > created_at))`),
		foreignKey({
			name: "client_idempotency_claims_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		unique("client_idempotency_claims_scope_unique").on(
			table.projectId,
			table.customerId,
			table.operation,
			table.idempotencyKey,
		),
		check(
			"client_operation_completion_check",
			sql`
   (completed_at IS NULL AND result_expires_at IS NULL AND outcome IS NULL)
   OR (completed_at IS NOT NULL AND result_expires_at IS NOT NULL
    AND result_expires_at >= completed_at + INTERVAL '24 hours'
    AND expires_at >= result_expires_at
    AND (recovery_version = 0 OR expires_at >= completed_at + INTERVAL '168 hours'))
  `,
		),
		check(
			"client_operation_outcome_bound",
			sql`
   outcome IS NULL OR (jsonb_typeof(outcome) = 'object' AND octet_length(outcome::text) <= 65536)
  `,
		),
		index("idx_client_operation_result_expiry")
			.on(table.resultExpiresAt, table.id)
			.where(sql`outcome IS NOT NULL AND completed_at IS NOT NULL`),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"worker_delivery_claims_delivery_id_check",
			sql`(((char_length(delivery_id) >= 1) AND (char_length(delivery_id) <= 256)))`,
		),
		check("worker_delivery_claims_expiry_check", sql`((expires_at > created_at))`),
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
	(table): PgTableExtraConfigValue[] => [
		check("usage_windows_usage_check", sql`((usage >= (0)::numeric))`),
		check("usage_windows_bounds_check", sql`((window_start_at < window_end_at))`),
		check(
			"usage_windows_filter_key_check",
			sql`(((filter_key IS NULL) OR (filter_key <> ''::text)))`,
		),
		foreignKey({
			name: "usage_windows_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "usage_windows_project_entity_fk",
			columns: [table.projectId, table.entityId],
			foreignColumns: [entities.projectId, entities.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "usage_windows_project_feature_fk",
			columns: [table.projectId, table.featureId],
			foreignColumns: [features.projectId, features.id],
		}),
		foreignKey({
			name: "usage_windows_project_anchor_fk",
			columns: [table.projectId, table.anchorPlanItemId],
			foreignColumns: [planItems.projectId, planItems.id],
		}).onDelete("set null"),
		foreignKey({
			name: "usage_windows_project_subscription_fk",
			columns: [table.projectId, table.subscriptionId],
			foreignColumns: [subscriptions.projectId, subscriptions.id],
		}).onDelete("restrict"),
		index("idx_billing_usage_windows_customer_feature").on(
			table.projectId,
			table.customerId,
			table.featureId,
		),
		index("idx_billing_usage_windows_anchor")
			.on(table.anchorPlanItemId)
			.where(sql`(anchor_plan_item_id IS NOT NULL)`),
		index("idx_billing_usage_windows_entity")
			.on(table.entityId)
			.where(sql`(entity_id IS NOT NULL)`),
		unique("usage_windows_project_id_id_unique").on(table.projectId, table.id),
		uniqueIndex("idx_billing_usage_windows_scope_period").on(
			table.projectId,
			table.customerId,
			table.featureId,
			sql`COALESCE(${table.entityId}, 0::bigint)`,
			sql`COALESCE(${table.filterKey}, '' COLLATE "C")`,
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"reservations_rate_card_path_check",
			sql`((rate_card_path = ANY (ARRAY['direct'::text, 'pinned'::text, 'additive'::text])))`,
		),
		check("reservations_requested_quantity_check", sql`((requested_quantity > (0)::numeric))`),
		check("reservations_held_quantity_check", sql`((held_quantity >= (0)::numeric))`),
		check(
			"reservations_status_check",
			sql`((status = ANY (ARRAY['active'::text, 'confirmed'::text, 'released'::text, 'expired'::text])))`,
		),
		check("reservations_expiry_check", sql`((expires_at > effective_at))`),
		check(
			"reservations_usage_window_check",
			sql`((((usage_window_id IS NULL) AND (usage_window_start_at IS NULL) AND (usage_window_end_at IS NULL)) OR ((usage_window_id IS NOT NULL) AND (usage_window_start_at IS NOT NULL) AND (usage_window_end_at IS NOT NULL) AND (usage_window_start_at < usage_window_end_at))))`,
		),
		check(
			"reservations_final_state_check",
			sql`((((status = 'active'::text) AND (finalized_at IS NULL) AND (confirmed_quantity IS NULL)) OR ((status = 'confirmed'::text) AND (finalized_at IS NOT NULL) AND (confirmed_quantity IS NOT NULL)) OR ((status = ANY (ARRAY['released'::text, 'expired'::text])) AND (finalized_at IS NOT NULL) AND (confirmed_quantity IS NULL))))`,
		),
		foreignKey({
			name: "reservations_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "reservations_project_entity_fk",
			columns: [table.projectId, table.entityId],
			foreignColumns: [entities.projectId, entities.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "reservations_project_usage_window_fk",
			columns: [table.projectId, table.usageWindowId],
			foreignColumns: [usageWindows.projectId, usageWindows.id],
		}).onDelete("set null"),
		foreignKey({
			name: "reservations_project_meter_feature_fk",
			columns: [table.projectId, table.meterFeatureId],
			foreignColumns: [features.projectId, features.id],
		}),
		foreignKey({
			name: "reservations_project_wallet_feature_fk",
			columns: [table.projectId, table.walletFeatureId],
			foreignColumns: [features.projectId, features.id],
		}),
		foreignKey({
			name: "reservations_project_rate_entry_fk",
			columns: [table.projectId, table.rateCardEntryId],
			foreignColumns: [rateCardEntries.projectId, rateCardEntries.id],
		}),
		foreignKey({
			name: "reservations_project_rate_revision_fk",
			columns: [table.projectId, table.rateCardRevisionId],
			foreignColumns: [catalogRevisions.projectId, catalogRevisions.id],
		}),
		index("idx_billing_reservations_active_expiry")
			.on(table.expiresAt, table.createdAt)
			.where(sql`(status = 'active'::text)`),
		index("idx_billing_reservations_entity").on(table.entityId).where(sql`(entity_id IS NOT NULL)`),
		index("idx_billing_reservations_usage_window")
			.on(table.usageWindowId, table.status, table.expiresAt)
			.where(sql`(usage_window_id IS NOT NULL)`),
		unique("reservations_project_id_id_unique").on(table.projectId, table.id),
		index("idx_billing_reservations_customer_feature").on(
			table.projectId,
			table.customerId,
			table.walletFeatureId,
			table.createdAt.desc(),
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
	(table): PgTableExtraConfigValue[] => [
		check("reservation_allocations_held_quantity_check", sql`((held_quantity >= (0)::numeric))`),
		check(
			"reservation_allocations_consumed_quantity_check",
			sql`((consumed_quantity >= (0)::numeric))`,
		),
		check("reservation_allocations_consumed_check", sql`((consumed_quantity <= held_quantity))`),
		foreignKey({
			name: "reservation_allocations_project_reservation_fk",
			columns: [table.projectId, table.reservationId],
			foreignColumns: [reservations.projectId, reservations.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "reservation_allocations_project_allocation_fk",
			columns: [table.projectId, table.allocationId],
			foreignColumns: [balanceAllocations.projectId, balanceAllocations.id],
		}).onDelete("restrict"),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"usage_events_operation_check",
			sql`((operation = ANY (ARRAY['consume'::text, 'confirm'::text, 'correction'::text])))`,
		),
		foreignKey({
			name: "usage_events_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		check(
			"usage_events_rate_card_path_check",
			sql`((rate_card_path = ANY (ARRAY['direct'::text, 'pinned'::text, 'additive'::text])))`,
		),
		check(
			"usage_events_quantity_check",
			sql`((((operation = ANY (ARRAY['consume'::text, 'confirm'::text])) AND (quantity > (0)::numeric) AND (wallet_quantity >= (0)::numeric)) OR ((operation = 'correction'::text) AND (quantity < (0)::numeric) AND (wallet_quantity <= (0)::numeric))))`,
		),
		check(
			"usage_events_original_check",
			sql`((((operation = 'correction'::text) AND (original_event_id IS NOT NULL) AND (original_event_recorded_at IS NOT NULL)) OR ((operation <> 'correction'::text) AND (original_event_id IS NULL) AND (original_event_recorded_at IS NULL))))`,
		),
		check("usage_events_deductions_check", sql`((jsonb_typeof(deductions) = 'array'::text))`),
		foreignKey({
			name: "usage_events_rate_card_entry_id_fkey",
			columns: [table.rateCardEntryId],
			foreignColumns: [rateCardEntries.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "usage_events_rate_card_revision_id_fkey",
			columns: [table.rateCardRevisionId],
			foreignColumns: [catalogRevisions.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "usage_events_project_entity_fk",
			columns: [table.projectId, table.entityId],
			foreignColumns: [entities.projectId, entities.id],
		}).onDelete("set null"),
		foreignKey({
			name: "usage_events_project_meter_feature_fk",
			columns: [table.projectId, table.meterFeatureId],
			foreignColumns: [features.projectId, features.id],
		}),
		foreignKey({
			name: "usage_events_project_wallet_feature_fk",
			columns: [table.projectId, table.walletFeatureId],
			foreignColumns: [features.projectId, features.id],
		}),
		foreignKey({
			name: "usage_events_project_rate_entry_fk",
			columns: [table.projectId, table.rateCardEntryId],
			foreignColumns: [rateCardEntries.projectId, rateCardEntries.id],
		}),
		foreignKey({
			name: "usage_events_project_rate_revision_fk",
			columns: [table.projectId, table.rateCardRevisionId],
			foreignColumns: [catalogRevisions.projectId, catalogRevisions.id],
		}),
		index("idx_billing_usage_events_reservation")
			.on(table.reservationId, table.recordedAt.desc())
			.where(sql`(reservation_id IS NOT NULL)`),
		index("idx_billing_usage_events_feature_time").on(
			table.projectId,
			table.meterFeatureId,
			table.recordedAt.desc(),
		),
		index("idx_billing_usage_events_original")
			.on(table.originalEventRecordedAt, table.originalEventId)
			.where(sql`(original_event_id IS NOT NULL)`),
		primaryKey({ columns: [table.recordedAt, table.id] }),
		index("idx_billing_usage_events_customer_time").on(
			table.projectId,
			table.customerId,
			table.recordedAt.desc(),
		),
		index("idx_billing_usage_events_project_time").on(
			table.projectId,
			table.recordedAt.desc(),
			table.id.desc(),
		),
		index("idx_billing_usage_events_customer_feature_time").on(
			table.projectId,
			table.customerId,
			table.meterFeatureId,
			table.recordedAt.desc(),
			table.id.desc(),
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
	(table): PgTableExtraConfigValue[] => [
		check("usage_event_rollups_event_count_check", sql`((event_count >= 0))`),
		check(
			"usage_event_rollups_status_check",
			sql`((status = ANY (ARRAY['open'::text, 'closed'::text])))`,
		),
		check("usage_event_rollups_period_check", sql`((period_start_at < period_end_at))`),
		check(
			"usage_event_rollups_state_check",
			sql`((((status = 'open'::text) AND (closed_at IS NULL)) OR ((status = 'closed'::text) AND (closed_at IS NOT NULL))))`,
		),
		foreignKey({
			name: "usage_event_rollups_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "usage_event_rollups_project_entity_fk",
			columns: [table.projectId, table.entityId],
			foreignColumns: [entities.projectId, entities.id],
		}).onDelete("set null"),
		foreignKey({
			name: "usage_event_rollups_project_feature_fk",
			columns: [table.projectId, table.meterFeatureId],
			foreignColumns: [features.projectId, features.id],
		}),
		unique("usage_event_rollups_project_id_id_unique").on(table.projectId, table.id),
		uniqueIndex("idx_billing_usage_event_rollups_scope").on(
			table.projectId,
			table.customerId,
			table.meterFeatureId,
			sql`COALESCE(${table.entityId}, 0::bigint)`,
			table.periodStartAt,
		),
		index("idx_billing_usage_event_rollups_close")
			.on(table.periodEndAt, table.id)
			.where(sql`${table.status} = 'open'`),
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
		provider: text("provider").$type<BillingProvider>().notNull(),
		providerAccountId: text("provider_account_id"),
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
	(table): PgTableExtraConfigValue[] => [
		check("usage_invoice_periods_usage_quantity_check", sql`((usage_quantity >= (0)::numeric))`),
		check(
			"usage_invoice_periods_included_quantity_check",
			sql`((included_quantity >= (0)::numeric))`,
		),
		check(
			"usage_invoice_periods_billable_quantity_check",
			sql`((billable_quantity >= (0)::numeric))`,
		),
		check("usage_invoice_periods_billing_units_check", sql`((billing_units > (0)::numeric))`),
		check("usage_invoice_periods_unit_amount_minor_check", sql`((unit_amount_minor >= 0))`),
		check("usage_invoice_periods_amount_minor_check", sql`((amount_minor >= 0))`),
		check("usage_invoice_periods_currency_check", sql`((char_length(currency) = 3))`),
		check(
			"usage_invoice_periods_status_check",
			sql`((status = ANY (ARRAY['pending'::text, 'processing'::text, 'invoiced'::text, 'credited'::text, 'failed'::text])))`,
		),
		check("usage_invoice_periods_attempts_check", sql`((attempts >= 0))`),
		check("usage_invoice_periods_bounds_check", sql`((period_end_at > period_start_at))`),
		check(
			"usage_invoice_periods_state_check",
			sql`((((status = ANY (ARRAY['invoiced'::text, 'credited'::text])) AND (invoiced_at IS NOT NULL) AND (last_error IS NULL)) OR ((status = 'failed'::text) AND (last_error IS NOT NULL) AND (invoiced_at IS NULL)) OR ((status = ANY (ARRAY['pending'::text, 'processing'::text])) AND (invoiced_at IS NULL))))`,
		),
		foreignKey({
			name: "usage_invoice_periods_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "usage_invoice_periods_project_subscription_fk",
			columns: [table.projectId, table.subscriptionId],
			foreignColumns: [subscriptions.projectId, subscriptions.id],
		}),
		foreignKey({
			name: "usage_invoice_periods_project_plan_item_fk",
			columns: [table.projectId, table.planItemId],
			foreignColumns: [planItems.projectId, planItems.id],
		}),
		foreignKey({
			name: "usage_invoice_periods_project_component_fk",
			columns: [table.projectId, table.priceComponentId],
			foreignColumns: [priceComponents.projectId, priceComponents.id],
		}),
		check(
			"usage_invoice_periods_provider_check",
			sql`${table.provider} IN ('apple', 'google', 'stripe')`,
		),
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
	(table): PgTableExtraConfigValue[] => [
		check("usage_invoice_adjustments_quantity_check", sql`((quantity <> (0)::numeric))`),
		check("usage_invoice_adjustments_currency_check", sql`((char_length(currency) = 3))`),
		check(
			"usage_invoice_adjustments_status_check",
			sql`((status = ANY (ARRAY['pending'::text, 'processing'::text, 'invoiced'::text, 'credited'::text, 'failed'::text])))`,
		),
		check("usage_invoice_adjustments_attempts_check", sql`((attempts >= 0))`),
		check(
			"usage_invoice_adjustments_state_check",
			sql`((((status = ANY (ARRAY['invoiced'::text, 'credited'::text])) AND (invoiced_at IS NOT NULL) AND (last_error IS NULL)) OR ((status = 'failed'::text) AND (last_error IS NOT NULL) AND (invoiced_at IS NULL)) OR ((status = ANY (ARRAY['pending'::text, 'processing'::text])) AND (invoiced_at IS NULL))))`,
		),
		foreignKey({
			name: "usage_invoice_adjustments_event_fk",
			columns: [table.usageEventRecordedAt, table.usageEventId],
			foreignColumns: [usageEvents.recordedAt, usageEvents.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "usage_invoice_adjustments_project_period_fk",
			columns: [table.projectId, table.closedPeriodId],
			foreignColumns: [usageInvoicePeriods.projectId, usageInvoicePeriods.id],
		}),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"enterprise_contracts_contract_key_check",
			sql`(((char_length(contract_key) >= 1) AND (char_length(contract_key) <= 120)))`,
		),
		check("enterprise_contracts_version_check", sql`((version > 0))`),
		check(
			"enterprise_contracts_status_check",
			sql`((status = ANY (ARRAY['draft'::text, 'published'::text, 'expired'::text, 'terminated'::text])))`,
		),
		check("enterprise_contracts_terms_check", sql`((jsonb_typeof(terms) = 'object'::text))`),
		check("enterprise_contracts_preview_token_check", sql`((char_length(preview_token) = 64))`),
		check("enterprise_contracts_intent_hash_check", sql`((char_length(intent_hash) = 64))`),
		check(
			"enterprise_contracts_created_by_check",
			sql`(((char_length(created_by) >= 1) AND (char_length(created_by) <= 200)))`,
		),
		check(
			"enterprise_contracts_bounds_check",
			sql`(((expires_at IS NULL) OR (expires_at > effective_at)))`,
		),
		check(
			"enterprise_contracts_publish_check",
			sql`((((status = 'draft'::text) AND (published_at IS NULL)) OR ((status <> 'draft'::text) AND (published_at IS NOT NULL))))`,
		),
		foreignKey({
			name: "enterprise_contracts_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "enterprise_contracts_project_plan_fk",
			columns: [table.projectId, table.planVersionId],
			foreignColumns: [planVersions.projectId, planVersions.id],
		}).onDelete("restrict"),
		unique("enterprise_contracts_project_id_id_unique").on(table.projectId, table.id),
		unique("enterprise_contracts_key_version_unique").on(
			table.projectId,
			table.customerId,
			table.contractKey,
			table.version,
		),
		unique("enterprise_contracts_preview_token_unique").on(table.projectId, table.previewToken),
		index("idx_billing_enterprise_contracts_active")
			.on(table.projectId, table.customerId, table.effectiveAt.desc(), table.version.desc())
			.where(sql`(status = 'published'::text)`),
		index("idx_billing_enterprise_contracts_customer").on(
			table.projectId,
			table.customerId,
			table.effectiveAt.desc(),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"control_policies_source_type_check",
			sql`((source_type = ANY (ARRAY['plan_default'::text, 'contract'::text, 'account'::text, 'entity'::text])))`,
		),
		check(
			"control_policies_control_kind_check",
			sql`((control_kind = ANY (ARRAY['spend_limit'::text, 'usage_limit'::text])))`,
		),
		check("control_policies_limit_value_check", sql`((limit_value >= (0)::numeric))`),
		check(
			"control_policies_interval_check",
			sql`(("interval" = ANY (ARRAY['month'::text, 'year'::text, 'lifetime'::text])))`,
		),
		check("control_policies_revision_check", sql`((revision > 0))`),
		check(
			"control_policies_created_by_check",
			sql`(((char_length(created_by) >= 1) AND (char_length(created_by) <= 200)))`,
		),
		foreignKey({
			name: "control_policies_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "control_policies_project_entity_fk",
			columns: [table.projectId, table.entityId],
			foreignColumns: [entities.projectId, entities.id],
		}).onDelete("cascade"),
		check("control_policies_metadata_check", sql`((jsonb_typeof(metadata) = 'object'::text))`),
		check(
			"control_policies_bounds_check",
			sql`(((expires_at IS NULL) OR (expires_at > effective_at)))`,
		),
		check(
			"control_policies_value_shape_check",
			sql`((((control_kind = 'spend_limit'::text) AND (currency IS NOT NULL) AND (feature_id IS NULL) AND (trunc(limit_value) = limit_value)) OR ((control_kind = 'usage_limit'::text) AND (currency IS NULL) AND (feature_id IS NOT NULL))))`,
		),
		check(
			"control_policies_source_shape_check",
			sql`((((source_type = 'plan_default'::text) AND (plan_version_id IS NOT NULL) AND (contract_id IS NULL) AND (customer_id IS NULL) AND (entity_id IS NULL)) OR ((source_type = 'contract'::text) AND (plan_version_id IS NULL) AND (contract_id IS NOT NULL) AND (customer_id IS NULL) AND (entity_id IS NULL)) OR ((source_type = 'account'::text) AND (plan_version_id IS NULL) AND (contract_id IS NULL) AND (customer_id IS NOT NULL) AND (entity_id IS NULL)) OR ((source_type = 'entity'::text) AND (plan_version_id IS NULL) AND (contract_id IS NULL) AND (customer_id IS NOT NULL) AND (entity_id IS NOT NULL))))`,
		),
		foreignKey({
			name: "control_policies_project_plan_fk",
			columns: [table.projectId, table.planVersionId],
			foreignColumns: [planVersions.projectId, planVersions.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "control_policies_project_contract_fk",
			columns: [table.projectId, table.contractId],
			foreignColumns: [enterpriseContracts.projectId, enterpriseContracts.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "control_policies_project_feature_fk",
			columns: [table.projectId, table.featureId],
			foreignColumns: [features.projectId, features.id],
		}).onDelete("restrict"),
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
	(table): PgTableExtraConfigValue[] => [
		check("control_windows_consumed_value_check", sql`((consumed_value >= (0)::numeric))`),
		check("control_windows_held_value_check", sql`((held_value >= (0)::numeric))`),
		check(
			"control_windows_bounds_check",
			sql`(((window_end_at IS NULL) OR (window_end_at > window_start_at)))`,
		),
		foreignKey({
			name: "control_windows_project_policy_fk",
			columns: [table.projectId, table.controlPolicyId],
			foreignColumns: [controlPolicies.projectId, controlPolicies.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "control_windows_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "control_windows_project_entity_fk",
			columns: [table.projectId, table.entityId],
			foreignColumns: [entities.projectId, entities.id],
		}).onDelete("cascade"),
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
			table.windowStartAt.desc(),
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
	(table): PgTableExtraConfigValue[] => [
		check("reservation_control_holds_held_value_check", sql`((held_value >= (0)::numeric))`),
		check(
			"reservation_control_holds_consumed_value_check",
			sql`((consumed_value >= (0)::numeric))`,
		),
		foreignKey({
			name: "reservation_control_holds_project_reservation_fk",
			columns: [table.projectId, table.reservationId],
			foreignColumns: [reservations.projectId, reservations.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "reservation_control_holds_project_window_fk",
			columns: [table.projectId, table.controlWindowId],
			foreignColumns: [controlWindows.projectId, controlWindows.id],
		}).onDelete("restrict"),
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
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "usage_event_control_entries_event_fk",
			columns: [table.usageEventRecordedAt, table.usageEventId],
			foreignColumns: [usageEvents.recordedAt, usageEvents.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "usage_event_control_entries_project_window_fk",
			columns: [table.projectId, table.controlWindowId],
			foreignColumns: [controlWindows.projectId, controlWindows.id],
		}).onDelete("restrict"),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"usage_alerts_threshold_type_check",
			sql`((threshold_type = ANY (ARRAY['absolute'::text, 'percentage'::text])))`,
		),
		check("usage_alerts_threshold_value_check", sql`((threshold_value > (0)::numeric))`),
		check(
			"usage_alerts_interval_check",
			sql`(("interval" = ANY (ARRAY['month'::text, 'year'::text, 'lifetime'::text])))`,
		),
		check(
			"usage_alerts_created_by_check",
			sql`(((char_length(created_by) >= 1) AND (char_length(created_by) <= 200)))`,
		),
		check("usage_alerts_metadata_check", sql`((jsonb_typeof(metadata) = 'object'::text))`),
		check(
			"usage_alerts_percentage_check",
			sql`(((threshold_type <> 'percentage'::text) OR (threshold_value <= (100)::numeric)))`,
		),
		foreignKey({
			name: "usage_alerts_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "usage_alerts_project_entity_fk",
			columns: [table.projectId, table.entityId],
			foreignColumns: [entities.projectId, entities.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "usage_alerts_project_feature_fk",
			columns: [table.projectId, table.featureId],
			foreignColumns: [features.projectId, features.id],
		}).onDelete("restrict"),
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
	(table): PgTableExtraConfigValue[] => [
		check("usage_alert_states_crossing_sequence_check", sql`((crossing_sequence >= 0))`),
		check(
			"usage_alert_states_bounds_check",
			sql`(((window_end_at IS NULL) OR (window_end_at > window_start_at)))`,
		),
		foreignKey({
			name: "usage_alert_states_project_alert_fk",
			columns: [table.projectId, table.alertId],
			foreignColumns: [usageAlerts.projectId, usageAlerts.id],
		}).onDelete("cascade"),
		primaryKey({ columns: [table.projectId, table.alertId] }),
	],
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
	(table): PgTableExtraConfigValue[] => [
		check("usage_alert_events_crossing_sequence_check", sql`((crossing_sequence > 0))`),
		check(
			"usage_alert_events_event_type_check",
			sql`((event_type = ANY (ARRAY['threshold_crossed'::text, 'threshold_rearmed'::text])))`,
		),
		foreignKey({
			name: "usage_alert_events_project_alert_fk",
			columns: [table.projectId, table.alertId],
			foreignColumns: [usageAlerts.projectId, usageAlerts.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "usage_alert_events_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
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
			table.createdAt.desc(),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"auto_topup_policies_provider_check",
			sql`((provider = ANY (ARRAY['apple'::text, 'google'::text, 'stripe'::text])))`,
		),
		check(
			"auto_topup_policies_threshold_quantity_check",
			sql`((threshold_quantity >= (0)::numeric))`,
		),
		check(
			"auto_topup_policies_cooldown_seconds_check",
			sql`(((cooldown_seconds >= 30) AND (cooldown_seconds <= 86400)))`,
		),
		check(
			"auto_topup_policies_limit_interval_seconds_check",
			sql`((limit_interval_seconds >= 60))`,
		),
		check(
			"auto_topup_policies_max_purchases_per_interval_check",
			sql`((max_purchases_per_interval > 0))`,
		),
		check(
			"auto_topup_policies_max_spend_minor_check",
			sql`(((max_spend_minor IS NULL) OR (max_spend_minor > 0)))`,
		),
		check(
			"auto_topup_policies_max_consecutive_failures_check",
			sql`((max_consecutive_failures > 0))`,
		),
		check(
			"auto_topup_policies_created_by_check",
			sql`(((char_length(created_by) >= 1) AND (char_length(created_by) <= 200)))`,
		),
		foreignKey({
			name: "auto_topup_policies_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "auto_topup_policies_project_entity_fk",
			columns: [table.projectId, table.entityId],
			foreignColumns: [entities.projectId, entities.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "auto_topup_policies_project_feature_fk",
			columns: [table.projectId, table.featureId],
			foreignColumns: [features.projectId, features.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "auto_topup_policies_project_option_fk",
			columns: [table.projectId, table.topupOptionId],
			foreignColumns: [topupOptions.projectId, topupOptions.id],
		}).onDelete("restrict"),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"auto_topup_states_status_check",
			sql`((status = ANY (ARRAY['ready'::text, 'cooldown'::text, 'suspended'::text])))`,
		),
		check("auto_topup_states_purchases_in_interval_check", sql`((purchases_in_interval >= 0))`),
		check("auto_topup_states_spend_minor_in_interval_check", sql`((spend_minor_in_interval >= 0))`),
		check("auto_topup_states_consecutive_failures_check", sql`((consecutive_failures >= 0))`),
		check(
			"auto_topup_states_shape_check",
			sql`((((status = 'suspended'::text) AND (circuit_opened_at IS NOT NULL)) OR ((status <> 'suspended'::text) AND (circuit_opened_at IS NULL))))`,
		),
		foreignKey({
			name: "auto_topup_states_project_policy_fk",
			columns: [table.projectId, table.policyId],
			foreignColumns: [autoTopupPolicies.projectId, autoTopupPolicies.id],
		}).onDelete("cascade"),
		primaryKey({ columns: [table.projectId, table.policyId] }),
	],
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
		providerAccountId: text("provider_account_id"),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"auto_topup_jobs_amount_minor_check",
			sql`(((amount_minor IS NULL) OR (amount_minor >= 0)))`,
		),
		check(
			"auto_topup_jobs_trigger_key_check",
			sql`(((char_length(trigger_key) >= 1) AND (char_length(trigger_key) <= 256)))`,
		),
		check(
			"auto_topup_jobs_provider_check",
			sql`((provider = ANY (ARRAY['apple'::text, 'google'::text, 'stripe'::text])))`,
		),
		check(
			"auto_topup_jobs_status_check",
			sql`((status = ANY (ARRAY['pending'::text, 'processing'::text, 'succeeded'::text, 'failed'::text, 'provider_action_required'::text])))`,
		),
		check(
			"auto_topup_jobs_charged_amount_minor_check",
			sql`(((charged_amount_minor IS NULL) OR (charged_amount_minor >= 0)))`,
		),
		check("auto_topup_jobs_attempts_check", sql`((attempts >= 0))`),
		check(
			"auto_topup_jobs_state_check",
			sql`((((status = 'succeeded'::text) AND (completed_at IS NOT NULL) AND (charged_amount_minor IS NOT NULL) AND (external_invoice_id IS NOT NULL)) OR ((status = ANY (ARRAY['failed'::text, 'provider_action_required'::text])) AND (completed_at IS NOT NULL) AND (last_error IS NOT NULL)) OR ((status = ANY (ARRAY['pending'::text, 'processing'::text])) AND (completed_at IS NULL))))`,
		),
		foreignKey({
			name: "auto_topup_jobs_project_policy_fk",
			columns: [table.projectId, table.policyId],
			foreignColumns: [autoTopupPolicies.projectId, autoTopupPolicies.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "auto_topup_jobs_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "auto_topup_jobs_project_store_product_fk",
			columns: [table.projectId, table.storeProductId],
			foreignColumns: [storeProducts.projectId, storeProducts.id],
		}).onDelete("restrict"),
		unique("auto_topup_jobs_project_id_id_unique").on(table.projectId, table.id),
		unique("auto_topup_jobs_trigger_unique").on(table.projectId, table.policyId, table.triggerKey),
		index("idx_billing_auto_topup_jobs_due")
			.on(table.nextAttemptAt, table.createdAt)
			.where(sql`${table.status} = 'pending'`),
		index("idx_billing_auto_topup_jobs_stale")
			.on(table.lockedAt, table.createdAt)
			.where(sql`${table.status} = 'processing'`),
		index("idx_billing_auto_topup_jobs_policy").on(table.policyId),
		index("idx_billing_auto_topup_jobs_customer").on(table.customerId, table.createdAt.desc()),
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
	(table): PgTableExtraConfigValue[] => [
		check("catalog_migration_drafts_preview_token_check", sql`((char_length(preview_token) = 64))`),
		check("catalog_migration_drafts_intent_hash_check", sql`((char_length(intent_hash) = 64))`),
		check(
			"catalog_migration_drafts_effective_mode_check",
			sql`((effective_mode = ANY (ARRAY['immediate'::text, 'period_end'::text])))`,
		),
		check(
			"catalog_migration_drafts_status_check",
			sql`((status = ANY (ARRAY['previewed'::text, 'published'::text, 'expired'::text])))`,
		),
		check("catalog_migration_drafts_impact_check", sql`((jsonb_typeof(impact) = 'object'::text))`),
		check(
			"catalog_migration_drafts_created_by_check",
			sql`(((char_length(created_by) >= 1) AND (char_length(created_by) <= 200)))`,
		),
		check(
			"catalog_migration_drafts_distinct_check",
			sql`((from_plan_version_id <> to_plan_version_id))`,
		),
		check(
			"catalog_migration_drafts_publish_check",
			sql`((((status = 'published'::text) AND (published_at IS NOT NULL)) OR ((status <> 'published'::text) AND (published_at IS NULL))))`,
		),
		foreignKey({
			name: "catalog_migration_drafts_project_from_fk",
			columns: [table.projectId, table.fromPlanVersionId],
			foreignColumns: [planVersions.projectId, planVersions.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "catalog_migration_drafts_project_to_fk",
			columns: [table.projectId, table.toPlanVersionId],
			foreignColumns: [planVersions.projectId, planVersions.id],
		}).onDelete("restrict"),
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
	(table): PgTableExtraConfigValue[] => [
		check(
			"catalog_migration_jobs_status_check",
			sql`((status = ANY (ARRAY['pending'::text, 'processing'::text, 'waiting_provider'::text, 'applied'::text, 'failed'::text, 'skipped'::text])))`,
		),
		check(
			"catalog_migration_jobs_effective_mode_check",
			sql`((effective_mode = ANY (ARRAY['immediate'::text, 'period_end'::text])))`,
		),
		check("catalog_migration_jobs_attempts_check", sql`((attempts >= 0))`),
		check(
			"catalog_migration_jobs_state_check",
			sql`((((status = 'applied'::text) AND (applied_at IS NOT NULL) AND (last_error IS NULL)) OR ((status = ANY (ARRAY['failed'::text, 'skipped'::text])) AND (applied_at IS NULL) AND (last_error IS NOT NULL)) OR ((status = 'waiting_provider'::text) AND (applied_at IS NULL) AND (subscription_change_id IS NOT NULL)) OR ((status = ANY (ARRAY['pending'::text, 'processing'::text])) AND (applied_at IS NULL))))`,
		),
		foreignKey({
			name: "catalog_migration_jobs_project_draft_fk",
			columns: [table.projectId, table.draftId],
			foreignColumns: [catalogMigrationDrafts.projectId, catalogMigrationDrafts.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "catalog_migration_jobs_project_subscription_fk",
			columns: [table.projectId, table.subscriptionId],
			foreignColumns: [subscriptions.projectId, subscriptions.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "catalog_migration_jobs_project_change_fk",
			columns: [table.projectId, table.subscriptionChangeId],
			foreignColumns: [subscriptionChanges.projectId, subscriptionChanges.id],
		}).onDelete("set null"),
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
	(table): PgTableExtraConfigValue[] => [
		check("license_pools_quantity_check", sql`((quantity > 0))`),
		foreignKey({
			name: "license_pools_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "license_pools_project_subscription_fk",
			columns: [table.projectId, table.subscriptionId],
			foreignColumns: [subscriptions.projectId, subscriptions.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "license_pools_project_plan_item_fk",
			columns: [table.projectId, table.planItemId],
			foreignColumns: [planItems.projectId, planItems.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "license_pools_project_feature_fk",
			columns: [table.projectId, table.featureId],
			foreignColumns: [features.projectId, features.id],
		}).onDelete("restrict"),
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
	(table): PgTableExtraConfigValue[] => [
		check("license_assignments_quantity_check", sql`((quantity > 0))`),
		check(
			"license_assignments_assigned_by_check",
			sql`(((char_length(assigned_by) >= 1) AND (char_length(assigned_by) <= 200)))`,
		),
		check("license_assignments_metadata_check", sql`((jsonb_typeof(metadata) = 'object'::text))`),
		check(
			"license_assignments_bounds_check",
			sql`(((revoked_at IS NULL) OR (revoked_at >= assigned_at)))`,
		),
		foreignKey({
			name: "license_assignments_project_pool_fk",
			columns: [table.projectId, table.licensePoolId],
			foreignColumns: [licensePools.projectId, licensePools.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "license_assignments_project_entity_fk",
			columns: [table.projectId, table.entityId],
			foreignColumns: [entities.projectId, entities.id],
		}).onDelete("cascade"),
		unique("license_assignments_project_id_id_unique").on(table.projectId, table.id),
		uniqueIndex("idx_billing_license_assignments_active")
			.on(table.projectId, table.licensePoolId, table.entityId)
			.where(sql`${table.revokedAt} IS NULL`),
		index("idx_billing_license_assignments_entity")
			.on(table.projectId, table.entityId)
			.where(sql`${table.revokedAt} IS NULL`),
	],
);

export const promotions = pgTable(
	"promotions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		key: text("key").notNull(),
		name: text("name").notNull(),
		effectKind: text("effect_kind").$type<"discount" | "feature_grant" | "plan_grant">().notNull(),
		status: text("status").$type<"active" | "archived">().notNull().default("active"),
		allowedChannels: text("allowed_channels")
			.array()
			.$type<Array<"web" | "ios" | "android">>()
			.notNull()
			.default(sql`ARRAY['web', 'ios', 'android']::text[]`),
		discountType: text("discount_type").$type<"percent" | "amount">(),
		percentOffBps: integer("percent_off_bps"),
		discountDuration: text("discount_duration").$type<"once" | "repeating" | "forever">(),
		durationMonths: integer("duration_months"),
		planId: bigint("plan_id", { mode: "number" }),
		grantDurationUnit: text("grant_duration_unit").$type<"day" | "month">(),
		grantDurationCount: integer("grant_duration_count"),
		termsHash: text("terms_hash").notNull(),
		metadata: metadataColumn(),
		createdBy: text("created_by").notNull(),
		archivedBy: text("archived_by"),
		archivedAt: timestamp("archived_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table): PgTableExtraConfigValue[] => [
		check("promotions_key_check", sql`(((char_length(key) >= 1) AND (char_length(key) <= 120)))`),
		check(
			"promotions_name_check",
			sql`(((char_length(name) >= 1) AND (char_length(name) <= 200)))`,
		),
		check(
			"promotions_effect_kind_check",
			sql`((effect_kind = ANY (ARRAY['discount'::text, 'feature_grant'::text, 'plan_grant'::text])))`,
		),
		check(
			"promotions_status_check",
			sql`((status = ANY (ARRAY['active'::text, 'archived'::text])))`,
		),
		check(
			"promotions_discount_type_check",
			sql`(((discount_type IS NULL) OR (discount_type = ANY (ARRAY['percent'::text, 'amount'::text]))))`,
		),
		check(
			"promotions_percent_off_bps_check",
			sql`(((percent_off_bps IS NULL) OR ((percent_off_bps >= 1) AND (percent_off_bps <= 10000))))`,
		),
		check(
			"promotions_discount_duration_check",
			sql`(((discount_duration IS NULL) OR (discount_duration = ANY (ARRAY['once'::text, 'repeating'::text, 'forever'::text]))))`,
		),
		check(
			"promotions_duration_months_check",
			sql`(((duration_months IS NULL) OR ((duration_months >= 1) AND (duration_months <= 36))))`,
		),
		check(
			"promotions_grant_duration_unit_check",
			sql`(((grant_duration_unit IS NULL) OR (grant_duration_unit = ANY (ARRAY['day'::text, 'month'::text]))))`,
		),
		check(
			"promotions_grant_duration_count_check",
			sql`(((grant_duration_count IS NULL) OR ((grant_duration_count >= 1) AND (grant_duration_count <= 730))))`,
		),
		check("promotions_terms_hash_check", sql`((char_length(terms_hash) = 64))`),
		check("promotions_metadata_check", sql`((jsonb_typeof(metadata) = 'object'::text))`),
		check(
			"promotions_created_by_check",
			sql`(((char_length(created_by) >= 1) AND (char_length(created_by) <= 200)))`,
		),
		check(
			"promotions_archived_by_check",
			sql`(((archived_by IS NULL) OR ((char_length(archived_by) >= 1) AND (char_length(archived_by) <= 200))))`,
		),
		unique("promotions_project_id_id_unique").on(table.projectId, table.id),
		unique("promotions_project_key_unique").on(table.projectId, table.key),
		foreignKey({
			name: "promotions_project_plan_fk",
			columns: [table.projectId, table.planId],
			foreignColumns: [plans.projectId, plans.id],
		}).onDelete("restrict"),
		index("idx_billing_promotions_project_created").on(
			table.projectId,
			table.createdAt.desc(),
			table.id.desc(),
		),
		check(
			"promotions_allowed_channels_check",
			sql`cardinality(${table.allowedChannels}) BETWEEN 1 AND 3 AND ${table.allowedChannels} <@ ARRAY['web', 'ios', 'android']::text[]`,
		),
		check(
			"promotions_effect_terms_check",
			sql`(${table.effectKind} = 'discount' AND ${table.discountType} IS NOT NULL AND ${table.discountDuration} IS NOT NULL AND (${table.discountType} = 'percent') = (${table.percentOffBps} IS NOT NULL) AND (${table.discountDuration} = 'repeating') = (${table.durationMonths} IS NOT NULL) AND ${table.planId} IS NULL AND ${table.grantDurationUnit} IS NULL AND ${table.grantDurationCount} IS NULL) OR (${table.effectKind} = 'feature_grant' AND ${table.discountType} IS NULL AND ${table.percentOffBps} IS NULL AND ${table.discountDuration} IS NULL AND ${table.durationMonths} IS NULL AND ${table.planId} IS NULL AND ${table.grantDurationUnit} IS NULL AND ${table.grantDurationCount} IS NULL) OR (${table.effectKind} = 'plan_grant' AND ${table.discountType} IS NULL AND ${table.percentOffBps} IS NULL AND ${table.discountDuration} IS NULL AND ${table.durationMonths} IS NULL AND ${table.planId} IS NOT NULL AND ${table.grantDurationUnit} IS NOT NULL AND ${table.grantDurationCount} IS NOT NULL)`,
		),
		check(
			"promotions_archive_check",
			sql`(${table.status} = 'active' AND ${table.archivedAt} IS NULL AND ${table.archivedBy} IS NULL) OR (${table.status} = 'archived' AND ${table.archivedAt} IS NOT NULL AND ${table.archivedBy} IS NOT NULL)`,
		),
	],
);

export const promotionDiscountAmounts = pgTable(
	"promotion_discount_amounts",
	{
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		promotionId: uuid("promotion_id").notNull(),
		currency: text("currency").notNull(),
		amountOffMinor: bigint("amount_off_minor", { mode: "number" }).notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		check("promotion_discount_amounts_currency_check", sql`((currency ~ '^[A-Z]{3}$'::text))`),
		check("promotion_discount_amounts_amount_off_minor_check", sql`((amount_off_minor > 0))`),
		primaryKey({
			name: "promotion_discount_amounts_pkey",
			columns: [table.projectId, table.promotionId, table.currency],
		}),
		foreignKey({
			name: "promotion_discount_amounts_project_promotion_fk",
			columns: [table.projectId, table.promotionId],
			foreignColumns: [promotions.projectId, promotions.id],
		}).onDelete("restrict"),
	],
);

export const promotionTargets = pgTable(
	"promotion_targets",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		promotionId: uuid("promotion_id").notNull(),
		targetKind: text("target_kind").$type<"plan" | "product">().notNull(),
		planId: bigint("plan_id", { mode: "number" }),
		productId: uuid("product_id"),
	},
	(table): PgTableExtraConfigValue[] => [
		check(
			"promotion_targets_target_kind_check",
			sql`((target_kind = ANY (ARRAY['plan'::text, 'product'::text])))`,
		),
		unique("promotion_targets_project_id_id_unique").on(table.projectId, table.id),
		foreignKey({
			name: "promotion_targets_project_promotion_fk",
			columns: [table.projectId, table.promotionId],
			foreignColumns: [promotions.projectId, promotions.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "promotion_targets_project_plan_fk",
			columns: [table.projectId, table.planId],
			foreignColumns: [plans.projectId, plans.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "promotion_targets_project_product_fk",
			columns: [table.projectId, table.productId],
			foreignColumns: [products.projectId, products.id],
		}).onDelete("restrict"),
		check(
			"promotion_targets_shape_check",
			sql`(${table.targetKind} = 'plan' AND ${table.planId} IS NOT NULL AND ${table.productId} IS NULL) OR (${table.targetKind} = 'product' AND ${table.productId} IS NOT NULL AND ${table.planId} IS NULL)`,
		),
		uniqueIndex("idx_billing_promotion_targets_plan")
			.on(table.projectId, table.promotionId, table.planId)
			.where(sql`${table.planId} IS NOT NULL`),
		uniqueIndex("idx_billing_promotion_targets_product")
			.on(table.projectId, table.promotionId, table.productId)
			.where(sql`${table.productId} IS NOT NULL`),
	],
);

export const promotionGrantItems = pgTable(
	"promotion_grant_items",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		promotionId: uuid("promotion_id").notNull(),
		featureId: bigint("feature_id", { mode: "number" }).notNull(),
		quantity: quantityColumn("quantity").notNull(),
		expiresAfterSeconds: bigint("expires_after_seconds", { mode: "number" }),
	},
	(table): PgTableExtraConfigValue[] => [
		check("promotion_grant_items_quantity_check", sql`((quantity > (0)::numeric))`),
		check(
			"promotion_grant_items_expires_after_seconds_check",
			sql`(((expires_after_seconds IS NULL) OR (expires_after_seconds > 0)))`,
		),
		unique("promotion_grant_items_project_id_id_unique").on(table.projectId, table.id),
		unique("promotion_grant_items_project_feature_unique").on(
			table.projectId,
			table.promotionId,
			table.featureId,
		),
		foreignKey({
			name: "promotion_grant_items_project_promotion_fk",
			columns: [table.projectId, table.promotionId],
			foreignColumns: [promotions.projectId, promotions.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "promotion_grant_items_project_feature_fk",
			columns: [table.projectId, table.featureId],
			foreignColumns: [features.projectId, features.id],
		}).onDelete("restrict"),
	],
);

export const promotionCodes = pgTable(
	"promotion_codes",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		promotionId: uuid("promotion_id").notNull(),
		code: text("code").notNull(),
		normalizedCode: text("normalized_code").notNull(),
		active: boolean("active").notNull().default(true),
		startsAt: timestamp("starts_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		maxRedemptions: integer("max_redemptions"),
		maxRedemptionsPerCustomer: integer("max_redemptions_per_customer"),
		firstPurchaseOnly: boolean("first_purchase_only").notNull().default(false),
		billingAccountId: text("billing_account_id"),
		hostedCheckoutEnabled: boolean("hosted_checkout_enabled").notNull().default(false),
		redeemedCount: integer("redeemed_count").notNull().default(0),
		reservedCount: integer("reserved_count").notNull().default(0),
		createdBy: text("created_by").notNull(),
		deactivatedBy: text("deactivated_by"),
		deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table): PgTableExtraConfigValue[] => [
		check("promotion_codes_code_check", sql`((code ~ '^[A-Za-z0-9-]{3,64}$'::text))`),
		check(
			"promotion_codes_normalized_code_check",
			sql`((normalized_code ~ '^[A-Z0-9-]{3,64}$'::text))`,
		),
		check(
			"promotion_codes_max_redemptions_check",
			sql`(((max_redemptions IS NULL) OR (max_redemptions > 0)))`,
		),
		check(
			"promotion_codes_max_redemptions_per_customer_check",
			sql`(((max_redemptions_per_customer IS NULL) OR (max_redemptions_per_customer > 0)))`,
		),
		check(
			"promotion_codes_billing_account_id_check",
			sql`(((billing_account_id IS NULL) OR ((char_length(billing_account_id) >= 1) AND (char_length(billing_account_id) <= 200))))`,
		),
		check("promotion_codes_redeemed_count_check", sql`((redeemed_count >= 0))`),
		check("promotion_codes_reserved_count_check", sql`((reserved_count >= 0))`),
		check(
			"promotion_codes_created_by_check",
			sql`(((char_length(created_by) >= 1) AND (char_length(created_by) <= 200)))`,
		),
		check(
			"promotion_codes_deactivated_by_check",
			sql`(((deactivated_by IS NULL) OR ((char_length(deactivated_by) >= 1) AND (char_length(deactivated_by) <= 200))))`,
		),
		unique("promotion_codes_project_id_id_unique").on(table.projectId, table.id),
		unique("promotion_codes_project_code_unique").on(table.projectId, table.normalizedCode),
		foreignKey({
			name: "promotion_codes_project_promotion_fk",
			columns: [table.projectId, table.promotionId],
			foreignColumns: [promotions.projectId, promotions.id],
		}).onDelete("restrict"),
		index("idx_billing_promotion_codes_promotion_created").on(
			table.projectId,
			table.promotionId,
			table.createdAt.desc(),
			table.id.desc(),
		),
		check("promotion_codes_normalized_check", sql`${table.normalizedCode} = upper(${table.code})`),
		check(
			"promotion_codes_window_check",
			sql`${table.startsAt} IS NULL OR ${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.startsAt}`,
		),
		check(
			"promotion_codes_deactivation_check",
			sql`(${table.active} AND ${table.deactivatedAt} IS NULL AND ${table.deactivatedBy} IS NULL) OR (NOT ${table.active} AND ${table.deactivatedAt} IS NOT NULL AND ${table.deactivatedBy} IS NOT NULL)`,
		),
		check(
			"promotion_codes_hosted_check",
			sql`NOT ${table.hostedCheckoutEnabled} OR (${table.billingAccountId} IS NULL AND ${table.maxRedemptionsPerCustomer} IS NULL)`,
		),
	],
);

export const promotionProviderObjects = pgTable(
	"promotion_provider_objects",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		promotionId: uuid("promotion_id").notNull(),
		promotionCodeId: uuid("promotion_code_id"),
		parentObjectId: uuid("parent_object_id"),
		provider: text("provider").$type<"stripe" | "apple" | "google">().notNull(),
		objectKind: text("object_kind")
			.$type<
				| "coupon"
				| "promotion_code"
				| "apple_promotional_offer"
				| "apple_offer_code"
				| "google_developer_offer"
				| "google_promo_code"
			>()
			.notNull(),
		externalId: text("external_id"),
		productExternalId: text("product_external_id"),
		basePlanId: text("base_plan_id"),
		redemptionCode: text("redemption_code"),
		appliesTo: jsonb("applies_to").$type<Record<string, unknown>>().notNull().default({}),
		appliesToHash: text("applies_to_hash"),
		catalogRevisionId: bigint("catalog_revision_id", { mode: "number" }),
		status: text("status")
			.$type<"pending" | "ready" | "failed" | "retired">()
			.notNull()
			.default("pending"),
		desiredActive: boolean("desired_active").notNull().default(true),
		desiredGeneration: integer("desired_generation").notNull().default(0),
		providerActive: boolean("provider_active"),
		retireRequested: boolean("retire_requested").notNull().default(false),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
		lockedAt: timestamp("locked_at", { withTimezone: true }),
		lockedBy: text("locked_by"),
		error: text("error"),
		readyAt: timestamp("ready_at", { withTimezone: true }),
		retiredAt: timestamp("retired_at", { withTimezone: true }),
		...timestampColumns(),
	},
	(table): PgTableExtraConfigValue[] => [
		check(
			"promotion_provider_objects_provider_check",
			sql`((provider = ANY (ARRAY['stripe'::text, 'apple'::text, 'google'::text])))`,
		),
		check(
			"promotion_provider_objects_object_kind_check",
			sql`((object_kind = ANY (ARRAY['coupon'::text, 'promotion_code'::text, 'apple_promotional_offer'::text, 'apple_offer_code'::text, 'google_developer_offer'::text, 'google_promo_code'::text])))`,
		),
		check(
			"promotion_provider_objects_external_id_check",
			sql`(((external_id IS NULL) OR ((char_length(external_id) >= 1) AND (char_length(external_id) <= 255))))`,
		),
		check("promotion_provider_objects_desired_generation_check", sql`((desired_generation >= 0))`),
		check(
			"promotion_provider_objects_product_external_id_check",
			sql`(((product_external_id IS NULL) OR ((char_length(product_external_id) >= 1) AND (char_length(product_external_id) <= 255))))`,
		),
		check(
			"promotion_provider_objects_base_plan_id_check",
			sql`(((base_plan_id IS NULL) OR ((char_length(base_plan_id) >= 1) AND (char_length(base_plan_id) <= 255))))`,
		),
		check(
			"promotion_provider_objects_redemption_code_check",
			sql`(((redemption_code IS NULL) OR ((char_length(redemption_code) >= 1) AND (char_length(redemption_code) <= 255))))`,
		),
		check(
			"promotion_provider_objects_applies_to_check",
			sql`((jsonb_typeof(applies_to) = 'object'::text))`,
		),
		check(
			"promotion_provider_objects_applies_to_hash_check",
			sql`(((applies_to_hash IS NULL) OR (char_length(applies_to_hash) = 64)))`,
		),
		check(
			"promotion_provider_objects_status_check",
			sql`((status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text, 'retired'::text])))`,
		),
		check("promotion_provider_objects_attempts_check", sql`((attempts >= 0))`),
		check(
			"promotion_provider_objects_locked_by_check",
			sql`(((locked_by IS NULL) OR ((char_length(locked_by) >= 1) AND (char_length(locked_by) <= 200))))`,
		),
		check(
			"promotion_provider_objects_error_check",
			sql`(((error IS NULL) OR (char_length(error) <= 2000)))`,
		),
		unique("promotion_provider_objects_project_id_id_unique").on(table.projectId, table.id),
		foreignKey({
			name: "promotion_provider_objects_project_promotion_fk",
			columns: [table.projectId, table.promotionId],
			foreignColumns: [promotions.projectId, promotions.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "promotion_provider_objects_project_code_fk",
			columns: [table.projectId, table.promotionCodeId],
			foreignColumns: [promotionCodes.projectId, promotionCodes.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "promotion_provider_objects_project_parent_fk",
			columns: [table.projectId, table.parentObjectId],
			foreignColumns: [table.projectId, table.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "promotion_provider_objects_project_revision_fk",
			columns: [table.projectId, table.catalogRevisionId],
			foreignColumns: [catalogRevisions.projectId, catalogRevisions.id],
		}).onDelete("restrict"),
		check(
			"promotion_provider_objects_shape_check",
			sql`(${table.objectKind} = 'coupon' AND ${table.provider} = 'stripe' AND ${table.promotionCodeId} IS NULL AND ${table.parentObjectId} IS NULL AND ${table.appliesToHash} IS NOT NULL) OR (${table.objectKind} = 'promotion_code' AND ${table.provider} = 'stripe' AND ${table.promotionCodeId} IS NOT NULL AND ${table.parentObjectId} IS NOT NULL) OR (${table.objectKind} IN ('apple_promotional_offer', 'apple_offer_code') AND ${table.provider} = 'apple' AND ${table.parentObjectId} IS NULL AND ${table.externalId} IS NOT NULL AND ${table.productExternalId} IS NOT NULL) OR (${table.objectKind} IN ('google_developer_offer', 'google_promo_code') AND ${table.provider} = 'google' AND ${table.parentObjectId} IS NULL AND ${table.productExternalId} IS NOT NULL AND (${table.externalId} IS NOT NULL OR ${table.redemptionCode} IS NOT NULL))`,
		),
		check(
			"promotion_provider_objects_state_check",
			sql`(${table.status} <> 'ready' OR (${table.externalId} IS NOT NULL OR ${table.redemptionCode} IS NOT NULL) AND ${table.readyAt} IS NOT NULL) AND (${table.status} <> 'failed' OR ${table.error} IS NOT NULL) AND (${table.status} <> 'retired' OR ${table.retiredAt} IS NOT NULL)`,
		),
		uniqueIndex("idx_billing_promotion_provider_objects_coupon")
			.on(table.projectId, table.promotionId, table.provider, table.appliesToHash)
			.where(sql`${table.objectKind} = 'coupon' AND ${table.status} <> 'retired'`),
		uniqueIndex("idx_billing_promotion_provider_objects_live_code")
			.on(table.projectId, table.promotionCodeId, table.provider)
			.where(sql`${table.objectKind} = 'promotion_code' AND ${table.status} <> 'retired'`),
		uniqueIndex("idx_billing_promotion_provider_objects_external")
			.on(table.projectId, table.provider, table.objectKind, table.externalId)
			.where(sql`${table.externalId} IS NOT NULL`),
		index("idx_billing_promotion_provider_objects_promotion").on(
			table.projectId,
			table.promotionId,
			table.createdAt,
		),
		index("idx_billing_promotion_provider_objects_due")
			.on(table.nextAttemptAt, table.id)
			.where(
				sql`${table.status} = 'pending' OR (${table.status} = 'ready' AND ${table.providerActive} IS DISTINCT FROM ${table.desiredActive})`,
			),
	],
);

export const promotionRedemptions = pgTable(
	"promotion_redemptions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		promotionId: uuid("promotion_id").notNull(),
		promotionCodeId: uuid("promotion_code_id"),
		customerId: uuid("customer_id").notNull(),
		channel: text("channel").$type<"web" | "ios" | "android">().notNull(),
		status: text("status").$type<"reserved" | "applied" | "released" | "reversed">().notNull(),
		provider: text("provider").$type<"quotum" | "stripe" | "apple" | "google">().notNull(),
		source: text("source")
			.$type<
				| "api_redeem"
				| "commercial_action"
				| "stripe_hosted_checkout"
				| "apple_offer"
				| "google_offer"
			>()
			.notNull(),
		commercialActionPreviewId: uuid("commercial_action_preview_id"),
		subscriptionChangeId: uuid("subscription_change_id"),
		purchaseId: uuid("purchase_id"),
		providerObjectId: uuid("provider_object_id"),
		stripeCouponId: text("stripe_coupon_id"),
		stripePromotionCodeId: text("stripe_promotion_code_id"),
		stripeCheckoutSessionId: text("stripe_checkout_session_id"),
		stripeInvoiceId: text("stripe_invoice_id"),
		externalSubscriptionId: text("external_subscription_id"),
		providerSubscriptionRef: text("provider_subscription_ref"),
		providerTransactionId: text("provider_transaction_id"),
		providerOfferType: text("provider_offer_type"),
		lastObservedTransactionId: text("last_observed_transaction_id"),
		lastObservedAt: timestamp("last_observed_at", { withTimezone: true }),
		currency: text("currency"),
		amountSubtotalMinor: bigint("amount_subtotal_minor", { mode: "number" }),
		amountDiscountMinor: bigint("amount_discount_minor", { mode: "number" }),
		amountTotalMinor: bigint("amount_total_minor", { mode: "number" }),
		effectSnapshot: jsonb("effect_snapshot").$type<Record<string, unknown>>().notNull(),
		result: jsonb("result").$type<Record<string, unknown>>(),
		limitViolation: text("limit_violation").$type<
			"global" | "first_purchase" | "not_applicable" | "inactive" | "expired"
		>(),
		actor: text("actor").notNull(),
		reason: text("reason"),
		idempotencyKey: text("idempotency_key").notNull(),
		requestHash: text("request_hash").notNull(),
		reservedUntil: timestamp("reserved_until", { withTimezone: true }),
		appliedAt: timestamp("applied_at", { withTimezone: true }),
		releasedAt: timestamp("released_at", { withTimezone: true }),
		reversedAt: timestamp("reversed_at", { withTimezone: true }),
		reversalActor: text("reversal_actor"),
		reversalReason: text("reversal_reason"),
		reversalIdempotencyKey: text("reversal_idempotency_key"),
		reversalRequestHash: text("reversal_request_hash"),
		reversalResult: jsonb("reversal_result").$type<Record<string, unknown>>(),
		...timestampColumns(),
	},
	(table): PgTableExtraConfigValue[] => [
		check(
			"promotion_redemptions_channel_check",
			sql`((channel = ANY (ARRAY['web'::text, 'ios'::text, 'android'::text])))`,
		),
		check(
			"promotion_redemptions_status_check",
			sql`((status = ANY (ARRAY['reserved'::text, 'applied'::text, 'released'::text, 'reversed'::text])))`,
		),
		check(
			"promotion_redemptions_provider_check",
			sql`((provider = ANY (ARRAY['quotum'::text, 'stripe'::text, 'apple'::text, 'google'::text])))`,
		),
		check(
			"promotion_redemptions_source_check",
			sql`((source = ANY (ARRAY['api_redeem'::text, 'commercial_action'::text, 'stripe_hosted_checkout'::text, 'apple_offer'::text, 'google_offer'::text])))`,
		),
		check(
			"promotion_redemptions_currency_check",
			sql`(((currency IS NULL) OR (currency ~ '^[A-Z]{3}$'::text)))`,
		),
		check(
			"promotion_redemptions_amount_subtotal_minor_check",
			sql`(((amount_subtotal_minor IS NULL) OR (amount_subtotal_minor >= 0)))`,
		),
		check(
			"promotion_redemptions_amount_discount_minor_check",
			sql`(((amount_discount_minor IS NULL) OR (amount_discount_minor >= 0)))`,
		),
		check(
			"promotion_redemptions_amount_total_minor_check",
			sql`(((amount_total_minor IS NULL) OR (amount_total_minor >= 0)))`,
		),
		check(
			"promotion_redemptions_effect_snapshot_check",
			sql`((jsonb_typeof(effect_snapshot) = 'object'::text))`,
		),
		check(
			"promotion_redemptions_result_check",
			sql`(((result IS NULL) OR ((jsonb_typeof(result) = 'object'::text) AND (octet_length((result)::text) <= 16384))))`,
		),
		check(
			"promotion_redemptions_limit_violation_check",
			sql`(((limit_violation IS NULL) OR (limit_violation = ANY (ARRAY['global'::text, 'first_purchase'::text, 'not_applicable'::text, 'inactive'::text, 'expired'::text]))))`,
		),
		check(
			"promotion_redemptions_actor_check",
			sql`(((char_length(actor) >= 1) AND (char_length(actor) <= 200)))`,
		),
		check(
			"promotion_redemptions_reason_check",
			sql`(((reason IS NULL) OR ((char_length(reason) >= 1) AND (char_length(reason) <= 500))))`,
		),
		check(
			"promotion_redemptions_idempotency_key_check",
			sql`(((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 255)))`,
		),
		check("promotion_redemptions_request_hash_check", sql`((char_length(request_hash) = 64))`),
		check(
			"promotion_redemptions_reversal_actor_check",
			sql`(((reversal_actor IS NULL) OR ((char_length(reversal_actor) >= 1) AND (char_length(reversal_actor) <= 200))))`,
		),
		check(
			"promotion_redemptions_reversal_reason_check",
			sql`(((reversal_reason IS NULL) OR ((char_length(reversal_reason) >= 1) AND (char_length(reversal_reason) <= 500))))`,
		),
		check(
			"promotion_redemptions_reversal_idempotency_key_check",
			sql`(((reversal_idempotency_key IS NULL) OR ((char_length(reversal_idempotency_key) >= 1) AND (char_length(reversal_idempotency_key) <= 255))))`,
		),
		check(
			"promotion_redemptions_reversal_request_hash_check",
			sql`(((reversal_request_hash IS NULL) OR (char_length(reversal_request_hash) = 64)))`,
		),
		check(
			"promotion_redemptions_reversal_result_check",
			sql`(((reversal_result IS NULL) OR ((jsonb_typeof(reversal_result) = 'object'::text) AND (octet_length((reversal_result)::text) <= 16384))))`,
		),
		unique("promotion_redemptions_project_id_id_unique").on(table.projectId, table.id),
		unique("promotion_redemptions_idempotency_unique").on(
			table.projectId,
			table.customerId,
			table.idempotencyKey,
		),
		foreignKey({
			name: "promotion_redemptions_project_promotion_fk",
			columns: [table.projectId, table.promotionId],
			foreignColumns: [promotions.projectId, promotions.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "promotion_redemptions_project_code_fk",
			columns: [table.projectId, table.promotionCodeId],
			foreignColumns: [promotionCodes.projectId, promotionCodes.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "promotion_redemptions_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "promotion_redemptions_project_preview_fk",
			columns: [table.projectId, table.commercialActionPreviewId],
			foreignColumns: [commercialActionPreviews.projectId, commercialActionPreviews.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "promotion_redemptions_project_change_fk",
			columns: [table.projectId, table.subscriptionChangeId],
			foreignColumns: [subscriptionChanges.projectId, subscriptionChanges.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "promotion_redemptions_project_purchase_fk",
			columns: [table.projectId, table.purchaseId],
			foreignColumns: [purchases.projectId, purchases.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "promotion_redemptions_project_provider_object_fk",
			columns: [table.projectId, table.providerObjectId],
			foreignColumns: [promotionProviderObjects.projectId, promotionProviderObjects.id],
		}).onDelete("restrict"),
		check(
			"promotion_redemptions_code_required_check",
			sql`${table.promotionCodeId} IS NOT NULL OR ${table.source} IN ('apple_offer', 'google_offer')`,
		),
		check(
			"promotion_redemptions_state_check",
			sql`(${table.status} = 'reserved' AND ${table.reservedUntil} IS NOT NULL AND ${table.appliedAt} IS NULL AND ${table.releasedAt} IS NULL AND ${table.reversedAt} IS NULL) OR (${table.status} = 'applied' AND ${table.appliedAt} IS NOT NULL AND ${table.reversedAt} IS NULL) OR (${table.status} = 'released' AND ${table.releasedAt} IS NOT NULL AND ${table.appliedAt} IS NULL AND ${table.reversedAt} IS NULL) OR (${table.status} = 'reversed' AND ${table.appliedAt} IS NOT NULL AND ${table.reversedAt} IS NOT NULL)`,
		),
		index("idx_billing_promotion_redemptions_code_customer")
			.on(table.projectId, table.promotionCodeId, table.customerId)
			.where(sql`${table.status} IN ('reserved', 'applied', 'reversed')`),
		index("idx_billing_promotion_redemptions_reserved_expiry")
			.on(table.reservedUntil, table.id)
			.where(sql`${table.status} = 'reserved'`),
		index("idx_billing_promotion_redemptions_promotion_created").on(
			table.projectId,
			table.promotionId,
			table.createdAt.desc(),
			table.id.desc(),
		),
		index("idx_billing_promotion_redemptions_customer_created").on(
			table.projectId,
			table.customerId,
			table.createdAt.desc(),
			table.id.desc(),
		),
		uniqueIndex("idx_billing_promotion_redemptions_checkout_session")
			.on(table.projectId, table.stripeCheckoutSessionId)
			.where(sql`${table.stripeCheckoutSessionId} IS NOT NULL`),
		uniqueIndex("idx_billing_promotion_redemptions_subscription_change")
			.on(table.projectId, table.subscriptionChangeId)
			.where(sql`${table.subscriptionChangeId} IS NOT NULL`),
		index("idx_billing_promotion_redemptions_purchase")
			.on(table.projectId, table.purchaseId)
			.where(sql`${table.purchaseId} IS NOT NULL`),
	],
);

export const promotionAuditEvents = pgTable(
	"promotion_audit_events",
	{
		id: meteringId(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		promotionId: uuid("promotion_id").notNull(),
		promotionCodeId: uuid("promotion_code_id"),
		action: text("action")
			.$type<
				| "promotion_created"
				| "promotion_archived"
				| "codes_added"
				| "code_deactivated"
				| "provider_mapping_added"
				| "provider_sync_requested"
			>()
			.notNull(),
		actor: text("actor").notNull(),
		details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table): PgTableExtraConfigValue[] => [
		check(
			"promotion_audit_events_action_check",
			sql`((action = ANY (ARRAY['promotion_created'::text, 'promotion_archived'::text, 'codes_added'::text, 'code_deactivated'::text, 'provider_mapping_added'::text, 'provider_sync_requested'::text])))`,
		),
		check(
			"promotion_audit_events_actor_check",
			sql`(((char_length(actor) >= 1) AND (char_length(actor) <= 200)))`,
		),
		check("promotion_audit_events_details_check", sql`((jsonb_typeof(details) = 'object'::text))`),
		unique("promotion_audit_events_project_id_id_unique").on(table.projectId, table.id),
		foreignKey({
			name: "promotion_audit_events_project_promotion_fk",
			columns: [table.projectId, table.promotionId],
			foreignColumns: [promotions.projectId, promotions.id],
		}).onDelete("restrict"),
		foreignKey({
			name: "promotion_audit_events_project_code_fk",
			columns: [table.projectId, table.promotionCodeId],
			foreignColumns: [promotionCodes.projectId, promotionCodes.id],
		}).onDelete("restrict"),
		index("idx_billing_promotion_audit_events_promotion_created").on(
			table.projectId,
			table.promotionId,
			table.createdAt.desc(),
		),
	],
);

export const planGrants = pgTable(
	"plan_grants",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "restrict" }),
		customerId: uuid("customer_id").notNull(),
		planId: bigint("plan_id", { mode: "number" }).notNull(),
		planVersionId: bigint("plan_version_id", { mode: "number" }).notNull(),
		planKind: text("plan_kind").$type<"base" | "addon">().notNull(),
		origin: text("origin").$type<"trial">().notNull(),
		status: text("status").$type<"active" | "expired" | "ended" | "superseded">().notNull(),
		durationUnit: text("duration_unit").$type<"day" | "month">().notNull(),
		durationCount: integer("duration_count").notNull(),
		startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
		endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
		endedAt: timestamp("ended_at", { withTimezone: true }),
		entitlementKeys: text("entitlement_keys").array().notNull().default(sql`ARRAY[]::text[]`),
		nextPeriodAt: timestamp("next_period_at", { withTimezone: true }),
		endingNotifiedAt: timestamp("ending_notified_at", { withTimezone: true }),
		supersededBySubscriptionId: uuid("superseded_by_subscription_id"),
		actor: text("actor").notNull(),
		endActor: text("end_actor"),
		endReason: text("end_reason"),
		metadata: metadataColumn(),
		idempotencyKey: text("idempotency_key").notNull(),
		requestHash: text("request_hash").notNull(),
		endIdempotencyKey: text("end_idempotency_key"),
		endRequestHash: text("end_request_hash"),
		...timestampColumns(),
	},
	(table): PgTableExtraConfigValue[] => [
		check(
			"plan_grants_duration_unit_check",
			sql`((duration_unit = ANY (ARRAY['day'::text, 'month'::text])))`,
		),
		check(
			"plan_grants_duration_count_check",
			sql`(((duration_count >= 1) AND (duration_count <= 730)))`,
		),
		check(
			"plan_grants_actor_check",
			sql`(((char_length(actor) >= 1) AND (char_length(actor) <= 200)))`,
		),
		check(
			"plan_grants_end_actor_check",
			sql`(((end_actor IS NULL) OR ((char_length(end_actor) >= 1) AND (char_length(end_actor) <= 200))))`,
		),
		check(
			"plan_grants_end_reason_check",
			sql`(((end_reason IS NULL) OR ((char_length(end_reason) >= 1) AND (char_length(end_reason) <= 500))))`,
		),
		check(
			"plan_grants_metadata_check",
			sql`(((jsonb_typeof(metadata) = 'object'::text) AND (octet_length((metadata)::text) <= 4096)))`,
		),
		check(
			"plan_grants_idempotency_key_check",
			sql`(((char_length(idempotency_key) >= 1) AND (char_length(idempotency_key) <= 255)))`,
		),
		check("plan_grants_request_hash_check", sql`((char_length(request_hash) = 64))`),
		check(
			"plan_grants_end_idempotency_key_check",
			sql`(((end_idempotency_key IS NULL) OR ((char_length(end_idempotency_key) >= 1) AND (char_length(end_idempotency_key) <= 255))))`,
		),
		check(
			"plan_grants_end_request_hash_check",
			sql`(((end_request_hash IS NULL) OR (char_length(end_request_hash) = 64)))`,
		),
		check(
			"plan_grants_bounds_check",
			sql`(((starts_at < ends_at) AND ((ended_at IS NULL) OR ((ended_at >= starts_at) AND (ended_at <= ends_at)))))`,
		),
		check(
			"plan_grants_entitlement_keys_check",
			sql`(((cardinality(entitlement_keys) <= 100) AND (array_position(entitlement_keys, NULL::text) IS NULL)))`,
		),
		check(
			"plan_grants_trial_duration_check",
			sql`(((origin <> 'trial'::text) OR (duration_unit = 'day'::text)))`,
		),
		check(
			"plan_grants_end_key_check",
			sql`(((end_idempotency_key IS NULL) = (end_request_hash IS NULL)))`,
		),
		check(
			"plan_grants_state_check",
			sql`((((status = 'active'::text) AND (ended_at IS NULL) AND (superseded_by_subscription_id IS NULL) AND (end_idempotency_key IS NULL)) OR ((status = 'expired'::text) AND (ended_at = ends_at) AND (superseded_by_subscription_id IS NULL) AND (next_period_at IS NULL)) OR ((status = 'ended'::text) AND (ended_at < ends_at) AND (end_idempotency_key IS NOT NULL) AND (superseded_by_subscription_id IS NULL) AND (next_period_at IS NULL)) OR ((status = 'superseded'::text) AND (ended_at IS NOT NULL) AND (superseded_by_subscription_id IS NOT NULL) AND (next_period_at IS NULL))))`,
		),
		unique("plan_grants_project_id_id_unique").on(table.projectId, table.id),
		unique("plan_grants_idempotency_unique").on(
			table.projectId,
			table.customerId,
			table.idempotencyKey,
		),
		foreignKey({
			name: "plan_grants_project_customer_fk",
			columns: [table.projectId, table.customerId],
			foreignColumns: [customers.projectId, customers.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "plan_grants_project_plan_fk",
			columns: [table.projectId, table.planId],
			foreignColumns: [plans.projectId, plans.id],
		}),
		foreignKey({
			name: "plan_grants_project_plan_version_fk",
			columns: [table.projectId, table.planVersionId],
			foreignColumns: [planVersions.projectId, planVersions.id],
		}),
		foreignKey({
			name: "plan_grants_project_superseding_subscription_fk",
			columns: [table.projectId, table.supersededBySubscriptionId],
			foreignColumns: [subscriptions.projectId, subscriptions.id],
		}),
		uniqueIndex("idx_billing_plan_grants_one_active_base")
			.on(table.projectId, table.customerId)
			.where(sql`${table.status} = 'active' AND ${table.planKind} = 'base'`),
		uniqueIndex("idx_billing_plan_grants_trial_once")
			.on(table.projectId, table.customerId, table.planId)
			.where(sql`${table.origin} = 'trial'`),
		index("idx_billing_plan_grants_customer_active")
			.on(table.projectId, table.customerId, table.planVersionId)
			.where(sql`${table.status} = 'active'`),
		index("idx_billing_plan_grants_due")
			.on(table.endsAt, table.id)
			.where(sql`${table.status} = 'active'`),
		index("idx_billing_plan_grants_next_period")
			.on(table.nextPeriodAt, table.id)
			.where(sql`${table.status} = 'active' AND ${table.nextPeriodAt} IS NOT NULL`),
		index("idx_billing_plan_grants_customer_created").on(
			table.projectId,
			table.customerId,
			table.createdAt.desc(),
			table.id.desc(),
		),
		index("idx_billing_plan_grants_superseding_subscription")
			.on(table.projectId, table.supersededBySubscriptionId)
			.where(sql`${table.supersededBySubscriptionId} IS NOT NULL`),
		check("plan_grants_plan_kind_check", sql`${table.planKind} IN ('base', 'addon')`),
		check("plan_grants_origin_check", sql`${table.origin} IN ('trial')`),
		check(
			"plan_grants_status_check",
			sql`${table.status} IN ('active', 'expired', 'ended', 'superseded')`,
		),
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
export type PromotionRow = typeof promotions.$inferSelect;
export type PromotionCodeRecordRow = typeof promotionCodes.$inferSelect;
export type PromotionProviderObjectRow = typeof promotionProviderObjects.$inferSelect;
export type PromotionRedemptionRow = typeof promotionRedemptions.$inferSelect;
export type PlanGrantRow = typeof planGrants.$inferSelect;
