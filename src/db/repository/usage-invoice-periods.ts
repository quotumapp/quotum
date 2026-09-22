import { sql as drizzleSql } from "drizzle-orm";
import {
	databaseDecimal,
	decimalToUnits,
	signedDecimalToUnits,
	unitsToDecimal,
} from "../../billing/decimal";
import { calculateTieredUsageCharge, calculateUsageCharge } from "../../billing/pricing";
import type { BillingProvider } from "../../billing/types";
import { executeOne, executeRows } from "./query";
import type { QueryExecutor } from "./types";

/** One usage invoice period: every filter and entity window of a plan item in one billing window. */
export interface UsageInvoicePeriodKey {
	projectId: string;
	subscriptionId: string;
	planItemId: string;
	/** The window bounds exactly as stored, so a text rendering keeps sub-millisecond precision. */
	periodStartAt: Date | string;
	periodEndAt: Date | string;
}

export interface UsageInvoicePeriodRow {
	id: string;
	customer_id: string;
	price_component_id: string | number | bigint;
	usage_quantity: unknown;
	included_quantity: unknown;
	billing_units: unknown;
	unit_amount_minor: string | number;
	amount_minor: string | number;
	currency: string;
	status: string;
}

export interface MaterializedUsageInvoicePeriod {
	/** False when the period already existed; its stored quantities are then the invoiced facts. */
	inserted: boolean;
	pricingModel: "flat" | "graduated" | "volume";
	period: UsageInvoicePeriodRow;
}

/**
 * Materializes one closed usage period from every window that shares its identity. The windows are
 * locked in id order before the aggregate is read, so a concurrent confirmation or correction
 * either lands in the invoiced quantity or sees the period afterwards. The recurring worker and
 * closed-period corrections both go through here, which keeps a correction from creating a period
 * out of a single filter window that the worker could never complete.
 *
 * Returns null when the period is not invoiceable: the window is still open, the plan item does
 * not allow overage, or it has no metered overage price.
 */
export async function materializeUsageInvoicePeriod(
	executor: QueryExecutor,
	key: UsageInvoicePeriodKey,
): Promise<MaterializedUsageInvoicePeriod | null> {
	const pricing = await executeOne<{
		customer_id: string;
		provider: BillingProvider;
		provider_account_id: string | null;
		price_component_id: string | number | bigint;
		included_quantity: unknown;
		billing_units: unknown;
		unit_amount_minor: string | number;
		currency: string;
		pricing_model: "flat" | "graduated" | "volume";
	}>(
		executor,
		drizzleSql`
			SELECT
				subscription.customer_id, subscription.provider, subscription.provider_account_id,
				price.id AS price_component_id, item.quantity::text AS included_quantity,
				price.billing_units::text AS billing_units, price.unit_amount_minor, price.currency,
				price.pricing_model
			FROM subscriptions subscription
			JOIN plan_items item
				ON item.project_id = subscription.project_id
				AND item.id = ${key.planItemId}::bigint
			JOIN price_components price
				ON price.project_id = item.project_id AND price.plan_item_id = item.id
				AND price.component_kind = 'metered_overage'
			WHERE subscription.project_id = ${key.projectId}
				AND subscription.id = ${key.subscriptionId}
				AND item.overage_policy = 'allowed'
		`,
	);
	if (pricing === null) return null;
	const periodStartAt = timestamptz(key.periodStartAt);
	const periodEndAt = timestamptz(key.periodEndAt);
	const windows = await executeRows<{ usage: unknown }>(
		executor,
		drizzleSql`
			SELECT usage::text AS usage
			FROM usage_windows
			WHERE project_id = ${key.projectId}
				AND subscription_id = ${key.subscriptionId}
				AND anchor_plan_item_id = ${key.planItemId}::bigint
				AND window_start_at = ${periodStartAt}::timestamptz
				AND window_end_at = ${periodEndAt}::timestamptz
				AND window_end_at <= now()
			ORDER BY id
			FOR UPDATE
		`,
	);
	if (windows.length === 0) return null;
	const usageUnits = windows.reduce(
		(total, window) => total + decimalToUnits(String(window.usage), 9),
		0n,
	);
	const commonCharge = {
		usageQuantity: unitsToDecimal(usageUnits, 9),
		includedQuantity: String(pricing.included_quantity),
		billingUnits: String(pricing.billing_units),
	};
	const charge =
		pricing.pricing_model === "flat"
			? calculateUsageCharge({
					...commonCharge,
					unitAmountMinor: BigInt(pricing.unit_amount_minor),
				})
			: calculateTieredUsageCharge({
					...commonCharge,
					pricingModel: pricing.pricing_model,
					tiers: await readPriceTiers(executor, key.projectId, String(pricing.price_component_id)),
				});
	const inserted = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
			INSERT INTO usage_invoice_periods (
				project_id, customer_id, subscription_id, provider, provider_account_id,
				plan_item_id, price_component_id, period_start_at, period_end_at, usage_quantity,
				included_quantity, billable_quantity, billing_units, unit_amount_minor,
				amount_minor, currency, status, invoiced_at
			)
			VALUES (
				${key.projectId}, ${pricing.customer_id}, ${key.subscriptionId},
				${pricing.provider}, ${pricing.provider_account_id},
				${key.planItemId}::bigint, ${String(pricing.price_component_id)}::bigint,
				${periodStartAt}::timestamptz, ${periodEndAt}::timestamptz,
				${charge.usageQuantity}::numeric, ${charge.includedQuantity}::numeric,
				${charge.billableQuantity}::numeric, ${String(pricing.billing_units)}::numeric,
				${pricing.unit_amount_minor}, ${charge.amountMinor.toString()}, ${pricing.currency},
				${charge.amountMinor === 0n ? "credited" : "pending"},
				${charge.amountMinor === 0n ? new Date().toISOString() : null}
			)
			ON CONFLICT (project_id, subscription_id, plan_item_id, period_start_at, period_end_at)
			DO NOTHING
			RETURNING id
		`,
	);
	const period = await executeOne<UsageInvoicePeriodRow>(
		executor,
		drizzleSql`
			SELECT id, customer_id, price_component_id, usage_quantity, included_quantity,
				billing_units, unit_amount_minor, amount_minor, currency, status
			FROM usage_invoice_periods
			WHERE project_id = ${key.projectId}
				AND subscription_id = ${key.subscriptionId}
				AND plan_item_id = ${key.planItemId}::bigint
				AND period_start_at = ${periodStartAt}::timestamptz
				AND period_end_at = ${periodEndAt}::timestamptz
			FOR UPDATE
		`,
	);
	if (period === null) throw new Error("Closed usage period could not be materialized");
	return { inserted: inserted !== null, pricingModel: pricing.pricing_model, period };
}

/**
 * Locks an already materialized period without creating one. A confirmation that lands on a closed
 * window records its usage against the period only when the period exists; otherwise the recurring
 * worker invoices the window's final usage once no reservation is outstanding.
 */
export async function lockUsageInvoicePeriod(
	executor: QueryExecutor,
	key: UsageInvoicePeriodKey,
): Promise<{
	pricingModel: "flat" | "graduated" | "volume";
	period: UsageInvoicePeriodRow;
} | null> {
	const row = await executeOne<
		UsageInvoicePeriodRow & { pricing_model: "flat" | "graduated" | "volume" }
	>(
		executor,
		drizzleSql`
			SELECT period.id, period.customer_id, period.price_component_id, period.usage_quantity,
				period.included_quantity, period.billing_units, period.unit_amount_minor,
				period.amount_minor, period.currency, period.status, price.pricing_model
			FROM usage_invoice_periods period
			JOIN price_components price
				ON price.project_id = period.project_id AND price.id = period.price_component_id
			WHERE period.project_id = ${key.projectId}
				AND period.subscription_id = ${key.subscriptionId}
				AND period.plan_item_id = ${key.planItemId}::bigint
				AND period.period_start_at = ${timestamptz(key.periodStartAt)}::timestamptz
				AND period.period_end_at = ${timestamptz(key.periodEndAt)}::timestamptz
			FOR UPDATE OF period
		`,
	);
	if (row === null) return null;
	const { pricing_model: pricingModel, ...period } = row;
	return { pricingModel, period };
}

export interface UsageInvoicePeriodAdjustmentInput {
	projectId: string;
	period: UsageInvoicePeriodRow;
	pricingModel: "flat" | "graduated" | "volume";
	usageEventId: string;
	/** The event's recorded_at exactly as stored, so the adjustment's event reference matches. */
	usageEventRecordedAtExact: string;
	/** Signed: negative for a correction, positive for a confirmation after the period closed. */
	quantityDelta: string;
}

/**
 * Appends a rated adjustment to a materialized period. The period's stored usage plus every prior
 * adjustment is the invoiced usage; the delta is priced as the difference between the charge for
 * that usage and the charge after the change, so tiered prices settle exactly.
 */
export async function recordUsageInvoicePeriodAdjustment(
	executor: QueryExecutor,
	input: UsageInvoicePeriodAdjustmentInput,
): Promise<{ amountDelta: bigint; currency: string }> {
	const { period } = input;
	const prior = await executeOne<{ quantity: unknown }>(
		executor,
		drizzleSql`
			SELECT COALESCE(sum(quantity), 0)::text AS quantity
			FROM usage_invoice_adjustments
			WHERE project_id = ${input.projectId} AND closed_period_id = ${period.id}
		`,
	);
	const effectiveUsageUnits =
		decimalToUnits(databaseDecimal(period.usage_quantity, "closed period usage", 9), 9) +
		signedDecimalToUnits(String(prior?.quantity ?? "0"), 9);
	const adjustedUsageUnits = effectiveUsageUnits + signedDecimalToUnits(input.quantityDelta, 9);
	if (adjustedUsageUnits < 0n) {
		throw new Error("Closed-period correction exceeds invoiceable usage");
	}
	const commonPrice = {
		projectId: input.projectId,
		priceComponentId: String(period.price_component_id),
		pricingModel: input.pricingModel,
		includedQuantity: String(period.included_quantity),
		billingUnits: String(period.billing_units),
		unitAmountMinor: BigInt(period.unit_amount_minor),
	};
	const before = await calculatePersistedPriceCharge(executor, {
		...commonPrice,
		usageQuantity: unitsToDecimal(effectiveUsageUnits, 9),
	});
	const after = await calculatePersistedPriceCharge(executor, {
		...commonPrice,
		usageQuantity: unitsToDecimal(adjustedUsageUnits, 9),
	});
	const amountDelta = after.amountMinor - before.amountMinor;
	await executeRows(
		executor,
		drizzleSql`
			INSERT INTO usage_invoice_adjustments (
				project_id, closed_period_id, usage_event_id, usage_event_recorded_at,
				quantity, amount_minor, currency, status, invoiced_at
			)
			VALUES (
				${input.projectId}, ${period.id}, ${input.usageEventId},
				${input.usageEventRecordedAtExact}::timestamptz,
				${input.quantityDelta}::numeric, ${amountDelta.toString()},
				${period.currency}, ${amountDelta === 0n ? "credited" : "pending"},
				${amountDelta === 0n ? new Date().toISOString() : null}
			)
			ON CONFLICT (project_id, usage_event_recorded_at, usage_event_id) DO NOTHING
		`,
	);
	return { amountDelta, currency: period.currency };
}

export async function calculatePersistedPriceCharge(
	executor: QueryExecutor,
	input: {
		projectId: string;
		priceComponentId: string;
		pricingModel: "flat" | "graduated" | "volume";
		usageQuantity: string;
		includedQuantity: string;
		billingUnits: string;
		unitAmountMinor: bigint;
	},
) {
	if (input.pricingModel === "flat") return calculateUsageCharge(input);
	return calculateTieredUsageCharge({
		usageQuantity: input.usageQuantity,
		includedQuantity: input.includedQuantity,
		billingUnits: input.billingUnits,
		pricingModel: input.pricingModel,
		tiers: await readPriceTiers(executor, input.projectId, input.priceComponentId),
	});
}

function timestamptz(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : value;
}

export async function readPriceTiers(
	executor: QueryExecutor,
	projectId: string,
	priceComponentId: string,
): Promise<
	Array<{ upToQuantity: string | null; unitAmountMinor: bigint; flatAmountMinor: bigint }>
> {
	const rows = await executeRows<{
		up_to_quantity: unknown;
		unit_amount_minor: string | number;
		flat_amount_minor: string | number;
	}>(
		executor,
		drizzleSql`
			SELECT up_to_quantity::text AS up_to_quantity, unit_amount_minor, flat_amount_minor
			FROM price_tiers
			WHERE project_id = ${projectId} AND price_component_id = ${priceComponentId}::bigint
			ORDER BY ordinal
		`,
	);
	return rows.map((row) => ({
		upToQuantity: row.up_to_quantity === null ? null : String(row.up_to_quantity),
		unitAmountMinor: BigInt(row.unit_amount_minor),
		flatAmountMinor: BigInt(row.flat_amount_minor),
	}));
}
