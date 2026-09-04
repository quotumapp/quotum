import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import { decodeAdminCursor, encodeAdminCursor } from "../admin/query";
import type {
	AdminBillingReader,
	AdminCatalogProduct,
	AdminCatalogProductListInput,
	AdminCatalogStoreProduct,
	AdminCatalogStoreProductListInput,
	AdminCustomer,
	AdminCustomerDetail,
	AdminCustomerSearchInput,
	AdminCustomerSearchResult,
	AdminListResult,
	AdminProjectionJob,
	AdminProjectionJobListInput,
	AdminPurchase,
	AdminPurchaseListInput,
	AdminStatsSummary,
	AdminStatsSummaryInput,
	AdminStoreEvent,
	AdminStoreEventDetailInput,
	AdminStoreEventListInput,
	AdminSubscription,
	AdminSubscriptionListInput,
} from "../admin/types";
import { NotFoundBillingError } from "../billing/errors";
import type {
	BillingProvider,
	ProjectionPayload,
	ProjectionSyncStatus,
	StoreEventProcessingStatus,
	SubscriptionStatus,
} from "../billing/types";
import type { ProjectInstanceContext } from "../projects/context";
import { db as defaultDb } from "./client";
import { BillingRepository } from "./repository";

const customerDetailRelatedRowsLimit = 5;
const redactedRawPayloadValue = "[REDACTED]";
const activeSubscriptionStatuses = [
	"active",
	"grace_period",
	"billing_retry",
	"cancelled",
] as const satisfies readonly SubscriptionStatus[];

interface AdminRepositoryOptions {
	providerReconciliationStaleAfterMs: number;
	now?: () => Date;
}

interface QueryExecutor {
	execute<T = Record<string, unknown>>(query: DrizzleSQL): Promise<T[]>;
}

interface AdminRowIdentity {
	id: string;
	cursorCreatedAt: string;
}

export class AdminBillingRepository implements AdminBillingReader {
	constructor(
		private readonly options: AdminRepositoryOptions,
		private readonly database: QueryExecutor = defaultDb as unknown as QueryExecutor,
	) {}

	async getCustomerByBillingAccountId(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<AdminCustomerDetail> {
		const customer = await this.getCustomer(
			project,
			drizzleSql`c.billing_account_id = ${billingAccountId}`,
		);
		return await this.customerDetail(project, customer);
	}

	async getCustomerById(
		project: ProjectInstanceContext,
		customerId: string,
	): Promise<AdminCustomerDetail> {
		const customer = await this.getCustomer(project, drizzleSql`c.id = ${customerId}`);
		return await this.customerDetail(project, customer);
	}

	async searchCustomers(
		project: ProjectInstanceContext,
		input: AdminCustomerSearchInput,
	): Promise<AdminListResult<AdminCustomerSearchResult>> {
		const cursor = input.cursor === null ? null : decodeAdminCursor(input.cursor);
		const query = `${escapeLike(input.query)}%`;
		const customerProject = projectFilter(project, "c");
		const rows = await executeRows<AdminCustomerSearchResult & AdminRowIdentity>(
			this.database,
			drizzleSql`
				WITH matches AS (
					SELECT
						c.id,
						c.created_at,
						jsonb_build_object(
							'id', c.id,
							'projectKey', (SELECT projects.key FROM projects projects WHERE projects.id = c.project_id),
							'billingAccountId', c.billing_account_id,
							'email', c.email,
							'metadata', c.metadata,
							'createdAt', c.created_at,
							'updatedAt', c.updated_at
						) AS customer,
						'billing_account_id'::text AS "matchType",
						c.billing_account_id AS "matchedValue"
					FROM customers c
					WHERE ${customerProject}
						AND c.billing_account_id ILIKE ${query}

					UNION ALL

					SELECT
						c.id,
						c.created_at,
						jsonb_build_object(
							'id', c.id,
							'projectKey', (SELECT projects.key FROM projects projects WHERE projects.id = c.project_id),
							'billingAccountId', c.billing_account_id,
							'email', c.email,
							'metadata', c.metadata,
							'createdAt', c.created_at,
							'updatedAt', c.updated_at
						) AS customer,
						'customer_id'::text AS "matchType",
						c.id::text AS "matchedValue"
					FROM customers c
					WHERE ${customerProject}
						AND c.id::text ILIKE ${query}

					UNION ALL

					SELECT
						c.id,
						c.created_at,
						jsonb_build_object(
							'id', c.id,
							'projectKey', (SELECT projects.key FROM projects projects WHERE projects.id = c.project_id),
							'billingAccountId', c.billing_account_id,
							'email', c.email,
							'metadata', c.metadata,
							'createdAt', c.created_at,
							'updatedAt', c.updated_at
						) AS customer,
						'provider_customer'::text AS "matchType",
						pc.external_customer_id AS "matchedValue"
					FROM provider_customers pc
					JOIN customers c ON c.id = pc.customer_id AND c.project_id = pc.project_id
					WHERE ${customerProject}
						AND pc.external_customer_id ILIKE ${query}

					UNION ALL

					SELECT
						c.id,
						c.created_at,
						jsonb_build_object(
							'id', c.id,
							'projectKey', (SELECT projects.key FROM projects projects WHERE projects.id = c.project_id),
							'billingAccountId', c.billing_account_id,
							'email', c.email,
							'metadata', c.metadata,
							'createdAt', c.created_at,
							'updatedAt', c.updated_at
						) AS customer,
						'transaction_id'::text AS "matchType",
						pu.transaction_id AS "matchedValue"
					FROM purchases pu
					JOIN customers c ON c.id = pu.customer_id AND c.project_id = pu.project_id
					WHERE ${customerProject}
						AND pu.transaction_id ILIKE ${query}

					UNION ALL

					SELECT
						c.id,
						c.created_at,
						jsonb_build_object(
							'id', c.id,
							'projectKey', (SELECT projects.key FROM projects projects WHERE projects.id = c.project_id),
							'billingAccountId', c.billing_account_id,
							'email', c.email,
							'metadata', c.metadata,
							'createdAt', c.created_at,
							'updatedAt', c.updated_at
						) AS customer,
						'original_transaction_id'::text AS "matchType",
						pu.original_transaction_id AS "matchedValue"
					FROM purchases pu
					JOIN customers c ON c.id = pu.customer_id AND c.project_id = pu.project_id
					WHERE ${customerProject}
						AND pu.original_transaction_id ILIKE ${query}

					UNION ALL

					SELECT
						c.id,
						c.created_at,
						jsonb_build_object(
							'id', c.id,
							'projectKey', (SELECT projects.key FROM projects projects WHERE projects.id = c.project_id),
							'billingAccountId', c.billing_account_id,
							'email', c.email,
							'metadata', c.metadata,
							'createdAt', c.created_at,
							'updatedAt', c.updated_at
						) AS customer,
						'order_id'::text AS "matchType",
						CASE
							WHEN pu.raw_payload->>'orderId' ILIKE ${query} THEN pu.raw_payload->>'orderId'
							ELSE pu.raw_payload->>'latestOrderId'
						END AS "matchedValue"
					FROM purchases pu
					JOIN customers c ON c.id = pu.customer_id AND c.project_id = pu.project_id
					WHERE ${customerProject}
						AND (
							pu.raw_payload->>'orderId' ILIKE ${query}
							OR pu.raw_payload->>'latestOrderId' ILIKE ${query}
						)

					UNION ALL

					SELECT
						c.id,
						c.created_at,
						jsonb_build_object(
							'id', c.id,
							'projectKey', (SELECT projects.key FROM projects projects WHERE projects.id = c.project_id),
							'billingAccountId', c.billing_account_id,
							'email', c.email,
							'metadata', c.metadata,
							'createdAt', c.created_at,
							'updatedAt', c.updated_at
						) AS customer,
						'entitlement_key'::text AS "matchType",
						e.entitlement_key AS "matchedValue"
					FROM entitlements e
					JOIN customers c ON c.id = e.customer_id AND c.project_id = e.project_id
					WHERE ${customerProject}
						AND e.entitlement_key ILIKE ${query}
				), unique_matches AS (
					SELECT DISTINCT ON (id)
						customer,
						"matchType",
						"matchedValue",
						id,
						created_at
					FROM matches
					ORDER BY id, "matchType", "matchedValue"
				)
				SELECT
					customer,
					"matchType",
					"matchedValue",
					id,
					${cursorTimestamp("unique_matches")} AS "cursorCreatedAt"
				FROM unique_matches
				${cursorCondition(cursor)}
				ORDER BY created_at DESC, id DESC
				LIMIT ${input.limit + 1}
			`,
		);
		return paginate(rows, input.limit, (row) => ({
			customer: normalizeCustomer(row.customer as AdminCustomer),
			matchType: row.matchType,
			matchedValue: row.matchedValue,
		}));
	}

	async listPurchases(
		project: ProjectInstanceContext,
		input: AdminPurchaseListInput,
	): Promise<AdminListResult<AdminPurchase>> {
		const rows = await executeRows<AdminPurchase & AdminRowIdentity>(
			this.database,
			drizzleSql`
				SELECT
					pu.id,
					pu.customer_id AS "customerId",
					c.billing_account_id AS "billingAccountId",
					pu.provider,
					pu.channel,
					pu.purchase_kind AS "purchaseKind",
					pu.status,
					pu.transaction_id AS "transactionId",
					pu.original_transaction_id AS "originalTransactionId",
					p.key AS "productKey",
					p.entitlement_key AS "entitlementKey",
					sp.external_product_id AS "externalProductId",
					sp.external_price_id AS "externalPriceId",
					pu.purchased_at AS "purchasedAt",
					pu.invalidated_at AS "invalidatedAt",
					pu.invalidation_reason AS "invalidationReason",
					pu.created_at AS "createdAt",
					${cursorTimestamp("pu")} AS "cursorCreatedAt"
				FROM purchases pu
				JOIN customers c ON c.id = pu.customer_id AND c.project_id = pu.project_id
				JOIN products p ON p.id = pu.product_id AND p.project_id = pu.project_id
				LEFT JOIN store_products sp ON sp.id = pu.store_product_id AND sp.project_id = pu.project_id
				${where([
					projectFilter(project, "pu"),
					commonFilters(input, "pu", "c", "p"),
					input.purchaseKind === undefined
						? null
						: drizzleSql`pu.purchase_kind = ${input.purchaseKind}`,
					input.status === undefined ? null : drizzleSql`pu.status = ${input.status}`,
					input.transactionId === undefined
						? null
						: drizzleSql`pu.transaction_id = ${input.transactionId}`,
					input.orderId === undefined
						? null
						: drizzleSql`(pu.raw_payload->>'orderId' = ${input.orderId} OR pu.raw_payload->>'latestOrderId' = ${input.orderId})`,
					cursorFilter(input.cursor, "pu"),
				])}
				ORDER BY pu.created_at DESC, pu.id DESC
				LIMIT ${input.limit + 1}
			`,
		);
		return paginate(rows, input.limit, normalizePurchase);
	}

	async listSubscriptions(
		project: ProjectInstanceContext,
		input: AdminSubscriptionListInput & { statuses?: readonly SubscriptionStatus[] },
	): Promise<AdminListResult<AdminSubscription>> {
		const staleBefore = input.staleBefore ?? this.defaultStaleBefore();
		const rows = await executeRows<AdminSubscription & AdminRowIdentity>(
			this.database,
			drizzleSql`
				SELECT
					s.id,
					s.customer_id AS "customerId",
					c.billing_account_id AS "billingAccountId",
					s.provider,
					s.channel,
					s.status,
					s.external_subscription_id AS "externalSubscriptionId",
					s.external_product_id AS "externalProductId",
					s.external_price_id AS "externalPriceId",
					p.key AS "productKey",
					p.entitlement_key AS "entitlementKey",
					s.starts_at AS "startsAt",
					s.expires_at AS "expiresAt",
					s.auto_renew AS "autoRenew",
					s.latest_transaction_id AS "latestTransactionId",
					s.provider_reconciliation_attempts AS "providerReconciliationAttempts",
					s.provider_reconciliation_error AS "providerReconciliationError",
					s.provider_reconciliation_next_attempt_at AS "providerReconciliationNextAttemptAt",
					s.provider_reconciled_at AS "providerReconciledAt",
					${needsAttentionCondition("s", staleBefore)} AS "needsAttention",
					s.created_at AS "createdAt",
					s.updated_at AS "updatedAt",
					${cursorTimestamp("s")} AS "cursorCreatedAt"
				FROM subscriptions s
				JOIN customers c ON c.id = s.customer_id AND c.project_id = s.project_id
				JOIN products p ON p.id = s.product_id AND p.project_id = s.project_id
				${where([
					projectFilter(project, "s"),
					commonFilters(input, "s", "c", "p"),
					input.status !== undefined
						? drizzleSql`s.status = ${input.status}`
						: subscriptionStatusesFilter(input.statuses, "s"),
					input.needsAttention === undefined
						? null
						: input.needsAttention
							? needsAttentionCondition("s", staleBefore)
							: drizzleSql`NOT ${needsAttentionCondition("s", staleBefore)}`,
					cursorFilter(input.cursor, "s"),
				])}
				ORDER BY s.created_at DESC, s.id DESC
				LIMIT ${input.limit + 1}
			`,
		);
		return paginate(rows, input.limit, normalizeSubscription);
	}

	async listStoreEvents(
		project: ProjectInstanceContext,
		input: AdminStoreEventListInput,
	): Promise<AdminListResult<AdminStoreEvent>> {
		const rows = await executeRows<AdminStoreEvent & AdminRowIdentity>(
			this.database,
			drizzleSql`
				SELECT
					se.id,
					se.provider,
					se.channel,
					se.external_event_id AS "externalEventId",
					se.event_type AS "eventType",
					se.customer_id AS "customerId",
					c.billing_account_id AS "billingAccountId",
					se.store_product_id AS "storeProductId",
					se.transaction_id AS "transactionId",
					se.purchase_kind AS "purchaseKind",
					se.processing_status AS "processingStatus",
					se.processing_error AS "processingError",
					se.attempts,
					se.next_attempt_at AS "nextAttemptAt",
					se.processed_at AS "processedAt",
					se.created_at AS "createdAt",
					se.updated_at AS "updatedAt",
					${cursorTimestamp("se")} AS "cursorCreatedAt"
				FROM store_events se
				LEFT JOIN customers c ON c.id = se.customer_id AND c.project_id = se.project_id
				LEFT JOIN store_products sp ON sp.id = se.store_product_id AND sp.project_id = se.project_id
				LEFT JOIN products p ON p.id = sp.product_id AND p.project_id = sp.project_id
				${where([
					projectFilter(project, "se"),
					commonFilters(input, "se", "c", "p"),
					input.processingStatus === undefined
						? null
						: drizzleSql`se.processing_status = ${input.processingStatus}`,
					input.eventType === undefined ? null : drizzleSql`se.event_type = ${input.eventType}`,
					input.externalEventId === undefined
						? null
						: drizzleSql`se.external_event_id = ${input.externalEventId}`,
					cursorFilter(input.cursor, "se"),
				])}
				ORDER BY se.created_at DESC, se.id DESC
				LIMIT ${input.limit + 1}
			`,
		);
		return paginate(rows, input.limit, normalizeStoreEvent);
	}

	async getStoreEvent(
		project: ProjectInstanceContext,
		input: AdminStoreEventDetailInput,
	): Promise<AdminStoreEvent> {
		const row = await executeOne<AdminStoreEvent & { rawPayload?: Record<string, unknown> }>(
			this.database,
			drizzleSql`
				SELECT
					se.id,
					se.provider,
					se.channel,
					se.external_event_id AS "externalEventId",
					se.event_type AS "eventType",
					se.customer_id AS "customerId",
					c.billing_account_id AS "billingAccountId",
					se.store_product_id AS "storeProductId",
					se.transaction_id AS "transactionId",
					se.purchase_kind AS "purchaseKind",
					se.processing_status AS "processingStatus",
					se.processing_error AS "processingError",
					se.attempts,
					se.next_attempt_at AS "nextAttemptAt",
					se.processed_at AS "processedAt",
					se.created_at AS "createdAt",
					se.updated_at AS "updatedAt",
					CASE WHEN ${input.includeRawPayload} THEN se.raw_payload ELSE NULL END AS "rawPayload"
				FROM store_events se
				LEFT JOIN customers c ON c.id = se.customer_id AND c.project_id = se.project_id
				WHERE se.id = ${input.eventId}
					AND ${projectFilter(project, "se")}
				LIMIT 1
			`,
		);
		if (row === null) {
			throw new NotFoundBillingError(`Store event ${input.eventId} was not found`);
		}
		return normalizeStoreEvent(row);
	}

	async listProjectionJobs(
		project: ProjectInstanceContext,
		input: AdminProjectionJobListInput,
	): Promise<AdminListResult<AdminProjectionJob>> {
		const rows = await executeRows<AdminProjectionJob & AdminRowIdentity>(
			this.database,
			drizzleSql`
				SELECT
					jobs.id,
					jobs.customer_id AS "customerId",
					c.billing_account_id AS "billingAccountId",
					jobs.idempotency_key AS "idempotencyKey",
					jobs.reason,
					jobs.status,
					jobs.attempts,
					jobs.last_error AS "lastError",
					jobs.next_attempt_at AS "nextAttemptAt",
					jobs.locked_at AS "lockedAt",
					jobs.locked_by AS "lockedBy",
					jobs.payload,
					jobs.created_at AS "createdAt",
					jobs.updated_at AS "updatedAt",
					${cursorTimestamp("jobs")} AS "cursorCreatedAt"
				FROM projection_sync_jobs jobs
				JOIN customers c ON c.id = jobs.customer_id AND c.project_id = jobs.project_id
				${where([
					projectFilter(project, "jobs"),
					commonFilters(input, "jobs", "c", null),
					input.status === undefined ? null : drizzleSql`jobs.status = ${input.status}`,
					input.reason === undefined ? null : drizzleSql`jobs.reason = ${input.reason}`,
					input.productKey === undefined
						? null
						: drizzleSql`(
							jobs.payload->'purchase'->>'productKey' = ${input.productKey}
							OR jobs.payload->'reversal'->>'productKey' = ${input.productKey}
						)`,
					cursorFilter(input.cursor, "jobs"),
				])}
				ORDER BY jobs.created_at DESC, jobs.id DESC
				LIMIT ${input.limit + 1}
			`,
		);
		return paginate(rows, input.limit, normalizeProjectionJob);
	}

	async listCatalogProducts(
		project: ProjectInstanceContext,
		input: AdminCatalogProductListInput,
	): Promise<AdminListResult<AdminCatalogProduct>> {
		const rows = await executeRows<AdminCatalogProduct & AdminRowIdentity>(
			this.database,
			drizzleSql`
				SELECT
					p.id,
					p.key,
					p.entitlement_key AS "entitlementKey",
					p.credit_amount AS "creditAmount",
					p.name,
					p.description,
					p.type,
					p.active,
					p.metadata,
					p.created_at AS "createdAt",
					p.updated_at AS "updatedAt",
					${cursorTimestamp("p")} AS "cursorCreatedAt"
				FROM products p
				${where([projectFilter(project, "p"), cursorFilter(input.cursor, "p")])}
				ORDER BY p.created_at DESC, p.id DESC
				LIMIT ${input.limit + 1}
			`,
		);
		return paginate(rows, input.limit, normalizeCatalogProduct);
	}

	async listCatalogStoreProducts(
		project: ProjectInstanceContext,
		input: AdminCatalogStoreProductListInput,
	): Promise<AdminListResult<AdminCatalogStoreProduct>> {
		const rows = await executeRows<AdminCatalogStoreProduct & AdminRowIdentity>(
			this.database,
			drizzleSql`
				SELECT
					sp.id,
					sp.product_id AS "productId",
					p.key AS "productKey",
					sp.provider,
					sp.channel,
					sp.external_product_id AS "externalProductId",
					sp.external_price_id AS "externalPriceId",
					sp.billing_period AS "billingPeriod",
					sp.currency,
					sp.price_amount AS "priceAmount",
					sp.active,
					sp.metadata,
					sp.created_at AS "createdAt",
					sp.updated_at AS "updatedAt",
					${cursorTimestamp("sp")} AS "cursorCreatedAt"
				FROM store_products sp
				JOIN products p ON p.id = sp.product_id AND p.project_id = sp.project_id
				${where([
					projectFilter(project, "sp"),
					input.provider === undefined ? null : drizzleSql`sp.provider = ${input.provider}`,
					input.channel === undefined ? null : drizzleSql`sp.channel = ${input.channel}`,
					input.productKey === undefined ? null : drizzleSql`p.key = ${input.productKey}`,
					cursorFilter(input.cursor, "sp"),
				])}
				ORDER BY sp.created_at DESC, sp.id DESC
				LIMIT ${input.limit + 1}
			`,
		);
		return paginate(rows, input.limit, normalizeCatalogStoreProduct);
	}

	async getStatsSummary(
		project: ProjectInstanceContext,
		input: AdminStatsSummaryInput,
	): Promise<AdminStatsSummary> {
		const staleBefore = this.defaultStaleBefore();

		const [storeEventRows, projectionJobRows, subscriptionCounts, providerRows, recentStoreEvents] =
			await Promise.all([
				executeRows<{ status: StoreEventProcessingStatus; count: number }>(
					this.database,
					drizzleSql`
						SELECT se.processing_status AS "status", COUNT(*)::int AS "count"
						FROM store_events se
						${where([projectFilter(project, "se"), statsFilters(input, "se")])}
						GROUP BY se.processing_status
					`,
				),
				executeRows<{ status: ProjectionSyncStatus; count: number }>(
					this.database,
					drizzleSql`
						SELECT jobs.status AS "status", COUNT(*)::int AS "count"
						FROM projection_sync_jobs jobs
						${where([projectFilter(project, "jobs"), windowFilter(input, "jobs")])}
						GROUP BY jobs.status
					`,
				),
				executeOne<{ active: number; gracePeriod: number; needsAttention: number }>(
					this.database,
					drizzleSql`
						SELECT
							COUNT(*) FILTER (WHERE s.status = 'active')::int AS "active",
							COUNT(*) FILTER (WHERE s.status = 'grace_period')::int AS "gracePeriod",
							COUNT(*) FILTER (WHERE ${needsAttentionCondition("s", staleBefore)})::int AS "needsAttention"
						FROM subscriptions s
						${where([projectFilter(project, "s"), windowFilter(input, "s")])}
					`,
				),
				executeRows<{ provider: BillingProvider; lastEventAt: string | null }>(
					this.database,
					drizzleSql`
						SELECT se.provider, MAX(se.created_at) AS "lastEventAt"
						FROM store_events se
						${where([projectFilter(project, "se"), statsFilters(input, "se")])}
						GROUP BY se.provider
					`,
				),
				this.listStoreEvents(project, { ...input, limit: 10, cursor: null }).then(
					(result) => result.items,
				),
			]);

		const storeEvents: Record<StoreEventProcessingStatus, number> = {
			pending: 0,
			processing: 0,
			processed: 0,
			skipped: 0,
			failed: 0,
		};
		for (const row of storeEventRows) {
			storeEvents[row.status] = row.count;
		}

		const projectionJobs: Record<ProjectionSyncStatus, number> = {
			pending: 0,
			processing: 0,
			succeeded: 0,
			failed: 0,
		};
		for (const row of projectionJobRows) {
			projectionJobs[row.status] = row.count;
		}

		const providers: AdminStatsSummary["providers"] = {};
		for (const row of providerRows) {
			providers[row.provider] = { lastEventAt: nullableIso(row.lastEventAt) };
		}

		return {
			storeEvents,
			projectionJobs,
			subscriptions: {
				active: subscriptionCounts?.active ?? 0,
				gracePeriod: subscriptionCounts?.gracePeriod ?? 0,
				needsAttention: subscriptionCounts?.needsAttention ?? 0,
			},
			providers,
			recentStoreEvents,
		};
	}

	private async getCustomer(
		project: ProjectInstanceContext,
		condition: DrizzleSQL,
	): Promise<AdminCustomer> {
		const row = await executeOne<AdminCustomer>(
			this.database,
			drizzleSql`
			SELECT
				c.id,
				p.key AS "projectKey",
				c.billing_account_id AS "billingAccountId",
				c.email,
				c.metadata,
				c.created_at AS "createdAt",
				c.updated_at AS "updatedAt"
			FROM customers c
			JOIN projects p ON p.id = c.project_id
			WHERE ${projectFilter(project, "c")}
				AND ${condition}
			LIMIT 1
		`,
		);
		if (row === null) {
			throw new NotFoundBillingError("Billing customer was not found");
		}
		return normalizeCustomer(row);
	}

	private async customerDetail(
		project: ProjectInstanceContext,
		customer: AdminCustomer,
	): Promise<AdminCustomerDetail> {
		const repository = new BillingRepository(this.database as never);
		const [
			providerCustomers,
			activeSubscriptions,
			recentPurchases,
			recentStoreEvents,
			recentProjectionJobs,
		] = await Promise.all([
			executeRows<AdminCustomerDetail["providerCustomers"][number]>(
				this.database,
				drizzleSql`
						SELECT
							pc.provider,
							pc.external_customer_id AS "externalCustomerId",
							pc.created_at AS "createdAt"
						FROM provider_customers pc
						WHERE pc.project_id = ${project.projectInstanceId}
							AND pc.customer_id = ${customer.id}
						ORDER BY pc.created_at DESC
						LIMIT ${customerDetailRelatedRowsLimit}
					`,
			),
			this.listSubscriptions(project, {
				customerId: customer.id,
				limit: customerDetailRelatedRowsLimit,
				cursor: null,
				needsAttention: undefined,
				staleBefore: this.defaultStaleBefore(),
				statuses: activeSubscriptionStatuses,
			}).then((result) => result.items),
			this.listPurchases(project, {
				customerId: customer.id,
				limit: customerDetailRelatedRowsLimit,
				cursor: null,
			}).then((result) => result.items),
			this.listStoreEvents(project, {
				customerId: customer.id,
				limit: customerDetailRelatedRowsLimit,
				cursor: null,
			}).then((result) => result.items),
			this.listProjectionJobs(project, {
				customerId: customer.id,
				limit: customerDetailRelatedRowsLimit,
				cursor: null,
			}).then((result) => result.items),
		]);

		return {
			customer,
			entitlementSnapshot: await repository.getEntitlementSnapshot(
				project,
				customer.billingAccountId,
			),
			providerCustomers: providerCustomers.map((row) => ({
				...row,
				createdAt: iso(row.createdAt),
			})),
			activeSubscriptions,
			recentPurchases,
			recentStoreEvents,
			recentProjectionJobs,
		};
	}

	private defaultStaleBefore(): string {
		const now = this.options.now?.() ?? new Date();
		return new Date(now.getTime() - this.options.providerReconciliationStaleAfterMs).toISOString();
	}
}

async function executeRows<T = Record<string, unknown>>(
	executor: QueryExecutor,
	query: DrizzleSQL,
): Promise<T[]> {
	return (await executor.execute<T>(query)) as T[];
}

async function executeOne<T = Record<string, unknown>>(
	executor: QueryExecutor,
	query: DrizzleSQL,
): Promise<T | null> {
	const rows = await executeRows<T>(executor, query);
	return rows[0] ?? null;
}

function where(conditions: Array<DrizzleSQL | null>): DrizzleSQL {
	const present = conditions.filter((condition): condition is DrizzleSQL => condition !== null);
	if (present.length === 0) {
		return drizzleSql``;
	}
	return drizzleSql`WHERE ${drizzleSql.join(present, drizzleSql` AND `)}`;
}

function projectFilter(project: ProjectInstanceContext, tableAlias: string): DrizzleSQL {
	return drizzleSql`${drizzleSql.identifier(tableAlias)}.project_id = ${project.projectInstanceId}`;
}

function commonFilters(
	input: {
		provider?: string;
		channel?: string;
		billingAccountId?: string;
		customerId?: string;
		productKey?: string;
		entitlementKey?: string;
		from?: string;
		to?: string;
	},
	tableAlias: string,
	customerAlias: string,
	productAlias: string | null,
): DrizzleSQL | null {
	const conditions: DrizzleSQL[] = [];
	const table = drizzleSql.identifier(tableAlias);
	const customer = drizzleSql.identifier(customerAlias);
	const product = productAlias === null ? null : drizzleSql.identifier(productAlias);

	if (input.provider !== undefined) {
		conditions.push(drizzleSql`${table}.provider = ${input.provider}`);
	}
	if (input.channel !== undefined) {
		conditions.push(drizzleSql`${table}.channel = ${input.channel}`);
	}
	if (input.billingAccountId !== undefined) {
		conditions.push(drizzleSql`${customer}.billing_account_id = ${input.billingAccountId}`);
	}
	if (input.customerId !== undefined) {
		conditions.push(drizzleSql`${table}.customer_id = ${input.customerId}`);
	}
	if (product !== null && input.productKey !== undefined) {
		conditions.push(drizzleSql`${product}.key = ${input.productKey}`);
	}
	if (product !== null && input.entitlementKey !== undefined) {
		conditions.push(drizzleSql`${product}.entitlement_key = ${input.entitlementKey}`);
	}
	if (input.from !== undefined) {
		conditions.push(drizzleSql`${table}.created_at >= ${input.from}`);
	}
	if (input.to !== undefined) {
		conditions.push(drizzleSql`${table}.created_at <= ${input.to}`);
	}

	return conditions.length === 0 ? null : drizzleSql.join(conditions, drizzleSql` AND `);
}

function needsAttentionCondition(tableAlias: string, staleBefore: string): DrizzleSQL {
	const table = drizzleSql.identifier(tableAlias);
	return drizzleSql`(
		${table}.provider_reconciliation_error IS NOT NULL
		OR ${table}.provider_reconciled_at IS NULL
		OR ${table}.provider_reconciled_at <= ${staleBefore}
		OR ${table}.expires_at <= now() + INTERVAL '1 hour'
	)`;
}

function statsFilters(
	input: { provider?: string; channel?: string; from?: string; to?: string },
	tableAlias: string,
): DrizzleSQL | null {
	const conditions: DrizzleSQL[] = [];
	const table = drizzleSql.identifier(tableAlias);
	if (input.provider !== undefined) {
		conditions.push(drizzleSql`${table}.provider = ${input.provider}`);
	}
	if (input.channel !== undefined) {
		conditions.push(drizzleSql`${table}.channel = ${input.channel}`);
	}
	if (input.from !== undefined) {
		conditions.push(drizzleSql`${table}.created_at >= ${input.from}`);
	}
	if (input.to !== undefined) {
		conditions.push(drizzleSql`${table}.created_at <= ${input.to}`);
	}
	return conditions.length === 0 ? null : drizzleSql.join(conditions, drizzleSql` AND `);
}

function windowFilter(
	input: { from?: string; to?: string },
	tableAlias: string,
): DrizzleSQL | null {
	const conditions: DrizzleSQL[] = [];
	const table = drizzleSql.identifier(tableAlias);
	if (input.from !== undefined) {
		conditions.push(drizzleSql`${table}.created_at >= ${input.from}`);
	}
	if (input.to !== undefined) {
		conditions.push(drizzleSql`${table}.created_at <= ${input.to}`);
	}
	return conditions.length === 0 ? null : drizzleSql.join(conditions, drizzleSql` AND `);
}

function cursorFilter(cursor: string | null | undefined, tableAlias: string): DrizzleSQL | null {
	if (cursor === null || cursor === undefined) {
		return null;
	}
	const decoded = decodeAdminCursor(cursor);
	const table = drizzleSql.identifier(tableAlias);
	return drizzleSql`(${table}.created_at, ${table}.id) < (${decoded.createdAt}, ${decoded.id})`;
}

function cursorCondition(cursor: { createdAt: string; id: string } | null): DrizzleSQL {
	if (cursor === null) {
		return drizzleSql``;
	}
	return drizzleSql`WHERE (created_at, id) < (${cursor.createdAt}, ${cursor.id})`;
}

function cursorTimestamp(tableAlias: string): DrizzleSQL {
	const table = drizzleSql.identifier(tableAlias);
	return drizzleSql`to_char(
		${table}.created_at AT TIME ZONE 'UTC',
		'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
	)`;
}

function subscriptionStatusesFilter(
	statuses: readonly SubscriptionStatus[] | undefined,
	tableAlias: string,
): DrizzleSQL | null {
	if (statuses === undefined) {
		return null;
	}
	if (statuses.length === 0) {
		return drizzleSql`false`;
	}
	const table = drizzleSql.identifier(tableAlias);
	return drizzleSql`${table}.status IN (${drizzleSql.join(
		statuses.map((status) => drizzleSql`${status}`),
		drizzleSql`, `,
	)})`;
}

function paginate<T extends AdminRowIdentity, U>(
	rows: T[],
	limit: number,
	mapper: (row: T) => U,
): AdminListResult<U> {
	const items = rows.slice(0, limit).map(mapper);
	const nextCursor =
		rows.length > limit && rows[limit - 1] !== undefined
			? encodeAdminCursor({
					createdAt: rows[limit - 1].cursorCreatedAt,
					id: rows[limit - 1].id,
				})
			: null;
	return { items, nextCursor };
}

function normalizeCustomer(row: AdminCustomer): AdminCustomer {
	return {
		...row,
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt),
	};
}

function normalizePurchase(row: AdminPurchase & AdminRowIdentity): AdminPurchase {
	return {
		...withoutCursorTimestamp(row),
		purchasedAt: iso(row.purchasedAt),
		invalidatedAt: nullableIso(row.invalidatedAt),
		createdAt: iso(row.createdAt),
	};
}

function normalizeSubscription(row: AdminSubscription & AdminRowIdentity): AdminSubscription {
	return {
		...withoutCursorTimestamp(row),
		startsAt: iso(row.startsAt),
		expiresAt: nullableIso(row.expiresAt),
		providerReconciliationNextAttemptAt: nullableIso(row.providerReconciliationNextAttemptAt),
		providerReconciledAt: nullableIso(row.providerReconciledAt),
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt),
	};
}

function normalizeStoreEvent(
	row: AdminStoreEvent & { rawPayload?: Record<string, unknown> | null },
): AdminStoreEvent {
	const normalized: AdminStoreEvent = {
		...withoutCursorTimestamp(row),
		nextAttemptAt: nullableIso(row.nextAttemptAt),
		processedAt: nullableIso(row.processedAt),
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt),
	};
	if (row.rawPayload === null) {
		delete normalized.rawPayload;
	} else if (row.rawPayload !== undefined) {
		normalized.rawPayload = redactRawPayload(row.rawPayload) as Record<string, unknown>;
	}
	return normalized;
}

function redactRawPayload(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value !== "object" || value === null) {
		return value;
	}
	if (seen.has(value)) {
		return "[Circular]";
	}
	seen.add(value);
	if (Array.isArray(value)) {
		return value.map((entry) => redactRawPayload(entry, seen));
	}

	const redacted: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		redacted[key] = shouldRedactRawPayloadKey(key)
			? redactedRawPayloadValue
			: redactRawPayload(entry, seen);
	}
	return redacted;
}

function shouldRedactRawPayloadKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	return (
		normalized.includes("secret") ||
		normalized.includes("signature") ||
		normalized.includes("signedpayload") ||
		normalized.includes("token")
	);
}

function normalizeProjectionJob(row: AdminProjectionJob & AdminRowIdentity): AdminProjectionJob {
	return {
		...withoutCursorTimestamp(row),
		payload: row.payload as ProjectionPayload,
		nextAttemptAt: nullableIso(row.nextAttemptAt),
		lockedAt: nullableIso(row.lockedAt),
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt),
	};
}

function normalizeCatalogProduct(row: AdminCatalogProduct & AdminRowIdentity): AdminCatalogProduct {
	return {
		...withoutCursorTimestamp(row),
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt),
	};
}

function normalizeCatalogStoreProduct(
	row: AdminCatalogStoreProduct & AdminRowIdentity,
): AdminCatalogStoreProduct {
	return {
		...withoutCursorTimestamp(row),
		priceAmount: row.priceAmount === null ? null : Number(row.priceAmount),
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt),
	};
}

function withoutCursorTimestamp<T extends object>(row: T): T {
	const normalized = { ...row };
	delete (normalized as T & { cursorCreatedAt?: string }).cursorCreatedAt;
	return normalized;
}

function iso(value: unknown): string {
	if (value instanceof Date) {
		return value.toISOString();
	}
	return String(value);
}

function nullableIso(value: unknown): string | null {
	if (value === null || value === undefined) {
		return null;
	}
	return iso(value);
}

function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
