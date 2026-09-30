import { sql as drizzleSql } from "drizzle-orm";
import {
	databaseDecimal,
	decimalToUnits,
	signedDecimalToUnits,
	unitsToDecimal,
} from "../../billing/decimal";
import { NotFoundBillingError } from "../../billing/errors";
import type {
	AvailableActionFacts,
	CustomerBillingSummary,
	ProjectUsageEventItem,
	ProjectUsageEventListInput,
	ProjectUsageEventPage,
	UsageEventItem,
	UsageEventListInput,
	UsageEventPage,
	UsageSeriesInput,
	UsageSeriesPoint,
} from "../../billing/insights";
import type { BillingChannel, BillingProvider, SubscriptionStatus } from "../../billing/types";
import type { ProjectInstanceContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import { defaultPlanAllowanceEndingSql } from "./default-plan-sql";
import { type PendingAllowance, readPendingAllowances } from "./plan-grant-windows";
import { executeOne, executeRows } from "./query";
import type { QueryExecutor } from "./types";

interface CustomerRow {
	id: string;
}

export class BillingInsightsRepository extends RepositoryModule {
	async listUsageEvents(
		project: ProjectInstanceContext,
		input: UsageEventListInput,
	): Promise<UsageEventPage> {
		const projectId = project.projectInstanceId;
		const customer = await requireCustomer(this.database, projectId, input.billingAccountId);
		const rows = await queryUsageEventRows(this.database, projectId, input, customer.id);
		const hasMore = rows.length > input.limit;
		const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
		const items: UsageEventItem[] = pageRows.map((row) => ({
			id: row.id,
			recordedAt: iso(row.recorded_at),
			occurredAt: row.occurred_at === null ? null : iso(row.occurred_at),
			effectiveAt: iso(row.effective_at),
			operation: row.operation,
			featureKey: row.feature_key,
			featureUnit: row.feature_unit,
			entityId: row.entity_external_id,
			quantity: signedDecimal(row.quantity, "usage event quantity"),
			walletQuantity: signedDecimal(row.wallet_quantity, "usage event wallet quantity"),
			filterKey: row.filter_key,
			metadata: row.metadata,
		}));
		const last = items.at(-1);
		return {
			items,
			nextCursor:
				hasMore && last !== undefined ? { recordedAt: last.recordedAt, id: last.id } : null,
		};
	}

	async listProjectUsageEvents(
		project: ProjectInstanceContext,
		input: ProjectUsageEventListInput,
	): Promise<ProjectUsageEventPage> {
		const projectId = project.projectInstanceId;
		let customerId: string | null = null;
		if (input.billingAccountId !== undefined) {
			const customer = await executeOne<CustomerRow>(
				this.database,
				drizzleSql`
					SELECT id FROM customers
					WHERE project_id = ${projectId} AND billing_account_id = ${input.billingAccountId}
				`,
			);
			if (customer === null) {
				return { items: [], nextCursor: null };
			}
			customerId = customer.id;
		}
		const rows = await queryUsageEventRows(this.database, projectId, input, customerId);
		const hasMore = rows.length > input.limit;
		const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
		const items: ProjectUsageEventItem[] = pageRows.map((row) => ({
			id: row.id,
			recordedAt: iso(row.recorded_at),
			occurredAt: row.occurred_at === null ? null : iso(row.occurred_at),
			effectiveAt: iso(row.effective_at),
			operation: row.operation,
			featureKey: row.feature_key,
			featureUnit: row.feature_unit,
			entityId: row.entity_external_id,
			quantity: signedDecimal(row.quantity, "usage event quantity"),
			walletQuantity: signedDecimal(row.wallet_quantity, "usage event wallet quantity"),
			filterKey: row.filter_key,
			metadata: row.metadata,
			customerId: row.customer_id,
			billingAccountId: row.billing_account_id,
			customerEmail: row.customer_email,
		}));
		const last = items.at(-1);
		return {
			items,
			nextCursor:
				hasMore && last !== undefined ? { recordedAt: last.recordedAt, id: last.id } : null,
		};
	}

	async getUsageSeries(
		project: ProjectInstanceContext,
		input: UsageSeriesInput,
	): Promise<UsageSeriesPoint[]> {
		const projectId = project.projectInstanceId;
		const customer = await requireCustomer(this.database, projectId, input.billingAccountId);
		const rows = await executeRows<{
			period_start: Date | string;
			feature_key: string;
			feature_unit: string;
			quantity: unknown;
			wallet_quantity: unknown;
			event_count: string | number;
		}>(
			this.database,
			drizzleSql`
				SELECT
					date_trunc(${input.interval}, event.recorded_at) AS period_start,
					feature.key AS feature_key, feature.unit AS feature_unit,
					sum(event.quantity)::text AS quantity,
					sum(event.wallet_quantity)::text AS wallet_quantity,
					count(*)::text AS event_count
				FROM usage_events event
				JOIN features feature
					ON feature.project_id = event.project_id AND feature.id = event.meter_feature_id
				WHERE event.project_id = ${projectId} AND event.customer_id = ${customer.id}
					AND event.recorded_at >= ${input.from.toISOString()}
					AND event.recorded_at < ${input.to.toISOString()}
					${input.featureKey === undefined ? drizzleSql`` : drizzleSql`AND feature.key = ${input.featureKey}`}
				GROUP BY period_start, feature.key, feature.unit
				ORDER BY period_start, feature.key
			`,
		);
		return rows.map((row) => ({
			periodStart: iso(row.period_start),
			featureKey: row.feature_key,
			featureUnit: row.feature_unit,
			quantity: signedDecimal(row.quantity, "usage series quantity"),
			walletQuantity: signedDecimal(row.wallet_quantity, "usage series wallet quantity"),
			eventCount: Number(row.event_count),
		}));
	}

	async getCustomerBillingSummary(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<CustomerBillingSummary> {
		const projectId = project.projectInstanceId;
		const customer = await executeOne<CustomerRow>(
			this.database,
			drizzleSql`
				SELECT id FROM customers
				WHERE project_id = ${projectId} AND billing_account_id = ${billingAccountId}
			`,
		);
		if (customer === null) {
			// An account Quotum has not recorded holds only the default plan its first write starts,
			// so it reads as holding it, as balance reads do.
			const pending = await readPendingAllowances(this.database, projectId, null, null);
			return {
				...emptySummary(billingAccountId),
				balances: summaryBalances(withPendingBalances([], pending)),
			};
		}
		const [subscriptions, allocationBalances, usage, invoices, pending] = await Promise.all([
			executeRows<{
				id: string;
				provider: BillingProvider;
				plan_key: string | null;
				status: string;
				current_period_start: Date | string | null;
				current_period_end: Date | string | null;
				cancel_at_period_end: boolean;
			}>(
				this.database,
				drizzleSql`
					SELECT subscription.external_subscription_id AS id, subscription.provider,
						plan.key AS plan_key, subscription.status, subscription.current_period_start,
						subscription.current_period_end, subscription.cancel_at_period_end
					FROM subscriptions subscription
					LEFT JOIN plan_versions version
						ON version.project_id = subscription.project_id AND version.id = subscription.plan_version_id
					LEFT JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
					WHERE subscription.project_id = ${projectId} AND subscription.customer_id = ${customer.id}
					ORDER BY subscription.created_at DESC
				`,
			),
			executeRows<{
				feature_key: string;
				unit: string;
				available: unknown;
				held: unknown;
				expires_at: Date | string | null;
			}>(
				this.database,
				drizzleSql`
					SELECT feature.key AS feature_key, feature.unit,
						sum(allocation.quantity - allocation.reversed_quantity
							- allocation.consumed_quantity - allocation.held_quantity)::text AS available,
						sum(allocation.held_quantity)::text AS held, max(allocation.expires_at) AS expires_at
					FROM balance_allocations allocation
					JOIN features feature
						ON feature.project_id = allocation.project_id AND feature.id = allocation.feature_id
					WHERE allocation.project_id = ${projectId} AND allocation.customer_id = ${customer.id}
						AND allocation.reversed_at IS NULL
						AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
						AND NOT ${defaultPlanAllowanceEndingSql(projectId, drizzleSql`allocation`)}
					GROUP BY feature.key, feature.unit
					ORDER BY feature.key
				`,
			),
			executeRows<{
				feature_key: string;
				unit: string;
				quantity: unknown;
				window_start_at: Date | string;
				window_end_at: Date | string;
			}>(
				this.database,
				drizzleSql`
					SELECT feature.key AS feature_key, feature.unit,
						sum(usage_window.usage)::text AS quantity,
						min(usage_window.window_start_at) AS window_start_at,
						max(usage_window.window_end_at) AS window_end_at
					FROM usage_windows usage_window
					JOIN features feature
						ON feature.project_id = usage_window.project_id
						AND feature.id = usage_window.feature_id
					WHERE usage_window.project_id = ${projectId}
						AND usage_window.customer_id = ${customer.id}
						AND usage_window.window_end_at > now()
					GROUP BY feature.key, feature.unit
					ORDER BY feature.key
				`,
			),
			executeRows<{
				id: string;
				external_invoice_id: string;
				status: string;
				amount_paid: string | number;
				currency: string;
				paid_at: Date | string | null;
				created_at: Date | string;
			}>(
				this.database,
				drizzleSql`
					SELECT id, external_invoice_id, status, amount_paid, currency, paid_at, created_at
					FROM billing_invoices
					WHERE project_id = ${projectId} AND customer_id = ${customer.id}
					ORDER BY provider_created_at DESC, id DESC
					LIMIT 12
				`,
			),
			readPendingAllowances(this.database, projectId, customer.id, null),
		]);
		const balances = withPendingBalances(allocationBalances, pending);
		return {
			schemaVersion: 1,
			billingAccountId,
			customerExists: true,
			generatedAt: new Date().toISOString(),
			subscriptions: subscriptions.map((row) => ({
				id: row.id,
				provider: row.provider,
				planKey: row.plan_key,
				status: row.status,
				currentPeriodStart:
					row.current_period_start === null ? null : iso(row.current_period_start),
				currentPeriodEnd: row.current_period_end === null ? null : iso(row.current_period_end),
				cancelAtPeriodEnd: row.cancel_at_period_end,
			})),
			balances: summaryBalances(balances),
			usage: usage.map((row) => ({
				featureKey: row.feature_key,
				unit: row.unit,
				quantity: databaseDecimal(row.quantity, "window usage"),
				windowStart: iso(row.window_start_at),
				windowEnd: iso(row.window_end_at),
			})),
			recentInvoices: invoices.map((row) => ({
				id: row.id,
				externalInvoiceId: row.external_invoice_id,
				status: row.status,
				amountPaidMinor: Number(row.amount_paid),
				currency: row.currency,
				paidAt: row.paid_at === null ? null : iso(row.paid_at),
				createdAt: iso(row.created_at),
			})),
		};
	}

	async getAvailableActionFacts(
		project: ProjectInstanceContext,
		billingAccountId: string,
	): Promise<AvailableActionFacts> {
		const projectId = project.projectInstanceId;
		const customer = await executeOne<CustomerRow>(
			this.database,
			drizzleSql`
				SELECT id FROM customers
				WHERE project_id = ${projectId} AND billing_account_id = ${billingAccountId}
			`,
		);
		if (customer === null) {
			return { customerExists: false, subscriptions: [] };
		}
		// idx_billing_subscription_changes_pending_scope allows one pending or processing change per
		// subscription, so the change join never multiplies rows.
		const rows = await executeRows<{
			external_subscription_id: string;
			provider: BillingProvider;
			channel: BillingChannel;
			status: SubscriptionStatus;
			plan_key: string | null;
			current_period_end: Date | string | null;
			cancel_at_period_end: boolean;
			change_id: string | null;
			change_status: "pending" | "processing" | null;
			effective_mode: "immediate" | "period_end" | null;
			effective_at: Date | string | null;
		}>(
			this.database,
			drizzleSql`
				SELECT subscription.external_subscription_id, subscription.provider, subscription.channel,
					subscription.status, plan.key AS plan_key, subscription.current_period_end,
					subscription.cancel_at_period_end, pending_change.id AS change_id,
					pending_change.status AS change_status, pending_change.effective_mode,
					pending_change.effective_at
				FROM subscriptions subscription
				LEFT JOIN plan_versions version
					ON version.project_id = subscription.project_id AND version.id = subscription.plan_version_id
				LEFT JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
				LEFT JOIN subscription_changes pending_change
					ON pending_change.project_id = subscription.project_id
					AND pending_change.subscription_id = subscription.id
					AND pending_change.status IN ('pending', 'processing')
				WHERE subscription.project_id = ${projectId} AND subscription.customer_id = ${customer.id}
					AND subscription.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
					AND (subscription.expires_at IS NULL OR subscription.expires_at > now())
				ORDER BY subscription.created_at DESC, subscription.id
			`,
		);
		return {
			customerExists: true,
			subscriptions: rows.map((row) => ({
				externalSubscriptionId: row.external_subscription_id,
				provider: row.provider,
				channel: row.channel,
				status: row.status,
				planKey: row.plan_key,
				currentPeriodEnd: row.current_period_end === null ? null : iso(row.current_period_end),
				cancelAtPeriodEnd: row.cancel_at_period_end,
				pendingChange:
					row.change_id === null ||
					row.change_status === null ||
					row.effective_mode === null ||
					row.effective_at === null
						? null
						: {
								changeId: row.change_id,
								status: row.change_status,
								effectiveMode: row.effective_mode,
								effectiveAt: iso(row.effective_at),
							},
			})),
		};
	}
}

interface UsageEventRow {
	id: string;
	recorded_at: Date | string;
	occurred_at: Date | string | null;
	effective_at: Date | string;
	operation: "consume" | "confirm" | "correction";
	feature_key: string;
	feature_unit: string;
	entity_external_id: string | null;
	quantity: unknown;
	wallet_quantity: unknown;
	filter_key: string | null;
	metadata: Record<string, unknown>;
	customer_id: string;
	billing_account_id: string;
	customer_email: string | null;
}

async function queryUsageEventRows(
	executor: QueryExecutor,
	projectId: string,
	input: {
		featureKey?: string;
		entityId?: string;
		operation?: "consume" | "confirm" | "correction";
		from: Date;
		to: Date;
		limit: number;
		cursor: { recordedAt: string; id: string } | null;
	},
	customerId: string | null,
): Promise<UsageEventRow[]> {
	return await executeRows<UsageEventRow>(
		executor,
		drizzleSql`
			SELECT event.id, event.recorded_at, event.occurred_at, event.effective_at,
				event.operation, feature.key AS feature_key, feature.unit AS feature_unit,
				entity.external_id AS entity_external_id, event.quantity::text AS quantity,
				event.wallet_quantity::text AS wallet_quantity, event.filter_key, event.metadata,
				customer.id AS customer_id, customer.billing_account_id, customer.email AS customer_email
			FROM usage_events event
			JOIN features feature
				ON feature.project_id = event.project_id AND feature.id = event.meter_feature_id
			LEFT JOIN entities entity
				ON entity.project_id = event.project_id AND entity.id = event.entity_id
			JOIN customers customer
				ON customer.project_id = event.project_id AND customer.id = event.customer_id
			WHERE event.project_id = ${projectId}
				${customerId === null ? drizzleSql`` : drizzleSql`AND event.customer_id = ${customerId}`}
				AND event.recorded_at >= ${input.from.toISOString()}
				AND event.recorded_at < ${input.to.toISOString()}
				${input.featureKey === undefined ? drizzleSql`` : drizzleSql`AND feature.key = ${input.featureKey}`}
				${input.entityId === undefined ? drizzleSql`` : drizzleSql`AND entity.external_id = ${input.entityId}`}
				${input.operation === undefined ? drizzleSql`` : drizzleSql`AND event.operation = ${input.operation}`}
				${
					input.cursor === null
						? drizzleSql``
						: drizzleSql`AND (event.recorded_at, event.id) < (${input.cursor.recordedAt}, ${input.cursor.id}::uuid)`
				}
			ORDER BY event.recorded_at DESC, event.id DESC
			LIMIT ${input.limit + 1}
		`,
	);
}

async function requireCustomer(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
): Promise<CustomerRow> {
	const customer = await executeOne<CustomerRow>(
		executor,
		drizzleSql`
			SELECT id FROM customers
			WHERE project_id = ${projectId} AND billing_account_id = ${billingAccountId}
		`,
	);
	if (customer === null) {
		throw new NotFoundBillingError("Billing account was not found", "BILLING_ACCOUNT_NOT_FOUND");
	}
	return customer;
}

function summaryBalances(
	balances: ReturnType<typeof withPendingBalances>,
): CustomerBillingSummary["balances"] {
	return balances.map((row) => ({
		featureKey: row.feature_key,
		unit: row.unit,
		available: signedDecimal(row.available, "available balance"),
		held: databaseDecimal(row.held, "held balance"),
		expiresAt: row.expires_at === null ? null : iso(row.expires_at),
	}));
}

function emptySummary(billingAccountId: string): CustomerBillingSummary {
	return {
		schemaVersion: 1,
		billingAccountId,
		customerExists: false,
		generatedAt: new Date().toISOString(),
		subscriptions: [],
		balances: [],
		usage: [],
		recentInvoices: [],
	};
}

interface BalanceRow {
	feature_key: string;
	unit: string;
	available: unknown;
	held: unknown;
	expires_at: Date | string | null;
}

/**
 * Adds what the account's plan grants give in windows no write has created yet to its per-feature
 * allocation totals, which, like those totals, are not clamped at zero.
 */
function withPendingBalances(
	rows: readonly BalanceRow[],
	pending: readonly PendingAllowance[],
): BalanceRow[] {
	if (pending.length === 0) return [...rows];
	const scale = 9;
	const byFeature = new Map(
		rows.map((row) => [
			row.feature_key,
			{
				...row,
				available: signedDecimalToUnits(signedDecimal(row.available, "available balance"), scale),
				held: decimalToUnits(databaseDecimal(row.held, "held balance"), scale),
			},
		]),
	);
	for (const allowance of pending) {
		const units = (value: string) =>
			decimalToUnits(databaseDecimal(value, "pending allowance"), scale);
		const current = byFeature.get(allowance.featureKey) ?? {
			feature_key: allowance.featureKey,
			unit: allowance.unit,
			available: 0n,
			held: 0n,
			expires_at: null,
		};
		current.available +=
			units(allowance.quantity) -
			units(allowance.reversed) -
			units(allowance.consumed) -
			units(allowance.held);
		current.held += units(allowance.held);
		if (
			allowance.expiresAt !== null &&
			(current.expires_at === null || allowance.expiresAt > new Date(current.expires_at))
		) {
			current.expires_at = allowance.expiresAt;
		}
		byFeature.set(allowance.featureKey, current);
	}
	return [...byFeature.values()]
		.sort((left, right) =>
			left.feature_key < right.feature_key ? -1 : left.feature_key > right.feature_key ? 1 : 0,
		)
		.map((row) => ({
			...row,
			available: unitsToDecimal(row.available, scale),
			held: unitsToDecimal(row.held, scale),
		}));
}

function iso(value: Date | string): string {
	return new Date(value).toISOString();
}

function signedDecimal(value: unknown, field: string): string {
	if (typeof value !== "string") return databaseDecimal(value, field);
	if (value.startsWith("-")) return `-${databaseDecimal(value.slice(1), field)}`;
	return databaseDecimal(value, field);
}
