import { sql as drizzleSql } from "drizzle-orm";
import {
	databaseDecimal,
	decimalToUnits,
	sha256Hex,
	stableJson,
	unitsToDecimal,
} from "../../billing/decimal";
import { BillingError, InvalidRequestError, NotFoundBillingError } from "../../billing/errors";
import type {
	AllocationDeduction,
	ConsumeUsageResult,
	FinalizeReservationResult,
	MeteringBalance,
	MeteringDecision,
	RateCardPath,
	RateCardReceipt,
	ReservationResult,
} from "../../billing/metering";
import type { RateCardTier } from "../../billing/pricing";
import {
	calculateRateCardQuantity,
	calculateTieredUsageCharge,
	calculateUsageCharge,
} from "../../billing/pricing";
import { toIso } from "../../shared/date";
import type { ControlDenial } from "./controls-runtime";
import {
	confirmControlHolds,
	holdControls,
	recordUsageControlEntries,
	releaseControlHolds,
} from "./controls-runtime";
import { enqueueUsageProjection } from "./entitlements";
import { addUtcInterval, meterLimitWindowBounds, startOfUtcMonth } from "./meter-limit-windows";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";

export interface FeatureRow {
	id: string | number | bigint;
	key: string;
	unit: string;
	credit_scale: number;
	kind: "boolean" | "metered";
	meter_kind: "consumable" | "non_consumable" | null;
	filter_dimensions: string[];
}

export interface RateDecision {
	meter: FeatureRow;
	wallet: FeatureRow;
	path: RateCardPath;
	revision: number | null;
	revisionId: string | null;
	entryId: string | null;
	pricingModel: "flat" | "graduated";
	ratePerUnit: string;
	tiers: RateCardTier[];
}

export interface MeterLimitDecision {
	feature: FeatureRow;
	subscriptionId: string | null;
	planItemId: string | null;
	limit: string;
	overagePolicy: "blocked" | "allowed";
	overagePrice: MeteredOveragePrice | null;
	windowStartAt: Date;
	windowEndAt: Date;
}

interface MeteredOveragePrice {
	priceComponentId: string;
	pricingModel: "flat" | "graduated" | "volume";
	billingUnits: string;
	unitAmountMinor: bigint;
	currency: string;
	tiers: Array<{
		upToQuantity: string | null;
		unitAmountMinor: bigint;
		flatAmountMinor: bigint;
	}>;
}

interface UsageWindowRow {
	id: string | number | bigint;
	window_start_at: Date | string;
	window_end_at: Date | string;
	usage: unknown;
}

export interface AllocationRow {
	id: string | number | bigint;
	quantity: unknown;
	reversed_quantity: unknown;
	consumed_quantity: unknown;
	held_quantity: unknown;
	source_kind: string;
	source_key: string;
	expires_at: Date | string | null;
	created_at: Date | string;
	reversed_at: Date | string | null;
	entity_external_id: string | null;
	rollover_origin_allocation_id: string | number | bigint | null;
	rollover_policy_revision: number | null;
	period_start_at: Date | string | null;
	period_end_at: Date | string | null;
}

export interface ReservationRow {
	id: string;
	project_id: string;
	customer_id: string;
	billing_account_id: string;
	entity_id: string | number | bigint | null;
	usage_window_id: string | number | bigint | null;
	usage_window_start_at: Date | string | null;
	usage_window_end_at: Date | string | null;
	meter_feature_id: string | number | bigint;
	wallet_feature_id: string | number | bigint;
	meter_feature_key: string;
	meter_unit: string;
	meter_scale: number;
	wallet_feature_key: string;
	wallet_unit: string;
	wallet_scale: number;
	rate_card_entry_id: string | number | bigint | null;
	rate_card_revision_id: string | number | bigint | null;
	revision: number | null;
	rate_card_path: RateCardPath;
	pricing_model: "flat" | "graduated";
	rate_per_unit: unknown;
	requested_quantity: unknown;
	held_quantity: unknown;
	confirmed_quantity: unknown | null;
	status: "active" | "confirmed" | "released" | "expired";
	expires_at: Date | string;
}

interface ReservationAllocationRow {
	allocation_id: string | number | bigint;
	held_quantity: unknown;
	consumed_quantity: unknown;
}

export async function requireMeteredFeature(
	executor: QueryExecutor,
	projectId: string,
	key: string,
): Promise<FeatureRow> {
	const normalizedKey = key.trim();
	if (normalizedKey === "") {
		throw new InvalidRequestError("featureKey is required");
	}
	const row = await executeOne<FeatureRow>(
		executor,
		drizzleSql`
			SELECT id, key, unit, credit_scale, kind, meter_kind, filter_dimensions
			FROM features
			WHERE project_id = ${projectId}
				AND key = ${normalizedKey}
				AND active = true
			LIMIT 1
		`,
	);
	if (row === null || row.kind !== "metered") {
		throw new NotFoundBillingError(
			`Metered feature ${normalizedKey} was not found`,
			"FEATURE_NOT_FOUND",
		);
	}
	return row;
}

interface MeterLimitRow {
	plan_item_id: string | number | bigint;
	subscription_id: string;
	quantity: unknown;
	overage_policy: "blocked" | "allowed";
	reset_interval: "month" | "year";
	period_start_at: Date | string;
	period_end_at: Date | string | null;
}

export function queryMeterLimitRows(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
	feature: FeatureRow,
): Promise<MeterLimitRow[]> {
	if (customerId === null) return Promise.resolve([]);
	return executeRows<MeterLimitRow>(
		executor,
		drizzleSql`
			SELECT
				pi.id AS plan_item_id,
				s.id AS subscription_id,
				pi.quantity,
				pi.overage_policy,
				pi.reset_interval,
				COALESCE(s.current_period_start, s.starts_at) AS period_start_at,
				COALESCE(s.current_period_end, s.expires_at) AS period_end_at
			FROM subscriptions s
			JOIN plan_items pi
				ON pi.project_id = s.project_id
				AND pi.plan_version_id = s.plan_version_id
			WHERE s.project_id = ${projectId}
				AND s.customer_id = ${customerId}
				AND s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
				AND (s.expires_at IS NULL OR s.expires_at > now())
				AND pi.feature_id = ${featureId(feature)}
				AND pi.item_kind = 'meter_limit'
			ORDER BY s.created_at, s.id
			LIMIT 2
		`,
	);
}

export function queryMeterLimitConfigured(
	executor: QueryExecutor,
	projectId: string,
	feature: FeatureRow,
): Promise<boolean> {
	return executeOne<{ configured: boolean }>(
		executor,
		drizzleSql`
			SELECT EXISTS (
				SELECT 1
				FROM plan_items pi
				JOIN plan_versions pv
					ON pv.project_id = pi.project_id AND pv.id = pi.plan_version_id
				WHERE pi.project_id = ${projectId}
					AND pi.feature_id = ${featureId(feature)}
					AND pi.item_kind = 'meter_limit'
					AND pv.status = 'published'
			) AS configured
		`,
	).then((row) => row?.configured === true);
}

export async function resolveMeterLimit(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
	feature: FeatureRow,
): Promise<MeterLimitDecision | null> {
	const rows = await queryMeterLimitRows(executor, projectId, customerId, feature);
	return await meterLimitDecision(executor, projectId, feature, rows, () =>
		queryMeterLimitConfigured(executor, projectId, feature),
	);
}

export async function meterLimitDecision(
	executor: QueryExecutor,
	projectId: string,
	feature: FeatureRow,
	rows: readonly MeterLimitRow[],
	configured: boolean | (() => Promise<boolean>),
): Promise<MeterLimitDecision | null> {
	if (rows.length > 1) {
		throw new BillingError(
			`Multiple active meter limits apply to feature ${feature.key}`,
			"METERING_CONFIGURATION_ERROR",
			409,
			{ classification: "persistence_conflict" },
		);
	}
	const active = rows[0];
	if (active !== undefined) {
		const bounds = meterLimitWindowBounds(
			active.period_start_at,
			active.period_end_at,
			active.reset_interval,
			new Date(),
		);
		const overagePrice =
			active.overage_policy === "allowed"
				? await resolveMeteredOveragePrice(executor, projectId, String(active.plan_item_id))
				: null;
		return {
			feature,
			subscriptionId: active.subscription_id,
			planItemId: String(active.plan_item_id),
			limit: databaseDecimal(active.quantity, "meter limit", feature.credit_scale),
			overagePolicy: active.overage_policy,
			overagePrice,
			windowStartAt: bounds.start,
			windowEndAt: bounds.end,
		};
	}

	const isConfigured = typeof configured === "function" ? await configured() : configured;
	if (!isConfigured) return null;
	const start = startOfUtcMonth(new Date());
	return {
		feature,
		subscriptionId: null,
		planItemId: null,
		limit: "0",
		overagePolicy: "blocked",
		overagePrice: null,
		windowStartAt: start,
		windowEndAt: addUtcInterval(start, "month"),
	};
}

async function resolveMeteredOveragePrice(
	executor: QueryExecutor,
	projectId: string,
	planItemId: string,
): Promise<MeteredOveragePrice> {
	const row = await executeOne<{
		id: string | number | bigint;
		pricing_model: "flat" | "graduated" | "volume";
		billing_units: unknown;
		unit_amount_minor: string | number | bigint;
		currency: string;
	}>(
		executor,
		drizzleSql`
			SELECT id, pricing_model, billing_units::text AS billing_units,
				unit_amount_minor, currency
			FROM price_components
			WHERE project_id = ${projectId}
				AND plan_item_id = ${planItemId}::bigint
				AND component_kind = 'metered_overage'
			LIMIT 1
		`,
	);
	if (row === null) {
		throw new BillingError(
			"Allowed overage has no published metered price",
			"METERING_CONFIGURATION_ERROR",
			409,
			{ classification: "persistence_conflict" },
		);
	}
	const priceComponentId = String(row.id);
	return {
		priceComponentId,
		pricingModel: row.pricing_model,
		billingUnits: databaseDecimal(row.billing_units, "overage billing units", 9),
		unitAmountMinor: BigInt(row.unit_amount_minor),
		currency: row.currency.toUpperCase(),
		tiers:
			row.pricing_model === "flat"
				? []
				: await readMeteredPriceTiers(executor, projectId, priceComponentId),
	};
}

async function readMeteredPriceTiers(
	executor: QueryExecutor,
	projectId: string,
	priceComponentId: string,
): Promise<MeteredOveragePrice["tiers"]> {
	const rows = await executeRows<{
		up_to_quantity: unknown;
		unit_amount_minor: string | number | bigint;
		flat_amount_minor: string | number | bigint;
	}>(
		executor,
		drizzleSql`
			SELECT up_to_quantity::text AS up_to_quantity, unit_amount_minor, flat_amount_minor
			FROM price_tiers
			WHERE project_id = ${projectId} AND price_component_id = ${priceComponentId}::bigint
			ORDER BY ordinal
		`,
	);
	return rows.map((tier) => ({
		upToQuantity: tier.up_to_quantity === null ? null : String(tier.up_to_quantity),
		unitAmountMinor: BigInt(tier.unit_amount_minor),
		flatAmountMinor: BigInt(tier.flat_amount_minor),
	}));
}

export function meterLimitSpendDelta(
	meterLimit: MeterLimitDecision,
	balance: MeteringBalance,
	quantity: string,
): { spendMinorDelta: string; currency: string | null } {
	if (meterLimit.overagePrice === null) {
		return { spendMinorDelta: "0", currency: null };
	}
	const scale = meterLimit.feature.credit_scale;
	const currentUnits =
		decimalToUnits(balance.consumed, scale) + decimalToUnits(balance.held, scale);
	const nextUnits = currentUnits + decimalToUnits(quantity, scale);
	const current = calculateMeteredOverageCharge(meterLimit, unitsToDecimal(currentUnits, scale));
	const next = calculateMeteredOverageCharge(meterLimit, unitsToDecimal(nextUnits, scale));
	return {
		spendMinorDelta: String(next.amountMinor - current.amountMinor),
		currency: meterLimit.overagePrice.currency,
	};
}

export function calculateMeteredOverageCharge(
	meterLimit: MeterLimitDecision,
	usageQuantity: string,
) {
	const price = meterLimit.overagePrice;
	if (price === null) {
		return calculateUsageCharge({
			usageQuantity,
			includedQuantity: meterLimit.limit,
			billingUnits: "1",
			unitAmountMinor: 0n,
			scale: meterLimit.feature.credit_scale,
		});
	}
	return price.pricingModel === "flat"
		? calculateUsageCharge({
				usageQuantity,
				includedQuantity: meterLimit.limit,
				billingUnits: price.billingUnits,
				unitAmountMinor: price.unitAmountMinor,
				scale: meterLimit.feature.credit_scale,
			})
		: calculateTieredUsageCharge({
				usageQuantity,
				includedQuantity: meterLimit.limit,
				billingUnits: price.billingUnits,
				pricingModel: price.pricingModel,
				tiers: price.tiers,
				scale: meterLimit.feature.credit_scale,
			});
}

export async function checkMeterLimit(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
	entityId: string | null,
	filterKey: string | null,
	meterLimit: MeterLimitDecision,
	quantity: string,
): Promise<MeteringDecision> {
	const balance = await readMeterLimitBalance(
		executor,
		projectId,
		customerId,
		entityId,
		filterKey,
		meterLimit,
	);
	const allowed =
		meterLimit.overagePolicy === "allowed" ||
		decimalToUnits(balance.available, balance.scale) >= decimalToUnits(quantity, balance.scale);
	return {
		allowed,
		reason: allowed ? "allowed" : "insufficient_balance",
		requestedQuantity: quantity,
		walletQuantity: quantity,
		balance,
		rateCard: rateReceipt(directRate(meterLimit.feature)),
		eligiblePurchaseActions: allowed ? [] : await purchaseActions(executor, projectId),
		control: null,
	};
}

export async function consumeMeterLimit(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		entityId: string | null;
		filterKey: string | null;
		meterLimit: MeterLimitDecision;
		quantity: string;
		occurredAt: Date | null;
		metadata: Record<string, unknown>;
		projectionKey: string;
	},
): Promise<ConsumeUsageResult> {
	const window = await upsertUsageWindow(executor, input);
	const currentBalance = meterLimitBalance(input.meterLimit, window.usage);
	const decision = await checkMeterLimitFromBalance(
		executor,
		input.projectId,
		input.meterLimit,
		input.quantity,
		currentBalance,
	);
	if (!decision.allowed) {
		return { ...decision, usageEventId: null, recordedAt: null, deductions: [] };
	}
	const updated = await executeOne<{ usage: unknown }>(
		executor,
		drizzleSql`
			UPDATE usage_windows
			SET usage = usage + ${input.quantity}::numeric, updated_at = now()
			WHERE project_id = ${input.projectId}
				AND id = ${String(window.id)}::bigint
				AND (
					${input.meterLimit.overagePolicy} = 'allowed'
					OR usage + ${input.quantity}::numeric <= ${input.meterLimit.limit}::numeric
				)
			RETURNING usage
		`,
	);
	if (updated === null) {
		throw new Error("Usage-window deduction lost its scope lock");
	}
	const rate = directRate(input.meterLimit.feature);
	const event = await insertUsageEvent(executor, {
		projectId: input.projectId,
		customerId: input.customerId,
		entityId: input.entityId,
		rate,
		operation: "consume",
		quantity: input.quantity,
		walletQuantity: input.quantity,
		occurredAt: input.occurredAt,
		reservationId: null,
		filterKey: input.filterKey,
		deductions: [],
		metadata: {
			...input.metadata,
			usageWindowId: String(window.id),
			usageWindowStartAt: toIso(window.window_start_at),
			usageWindowEndAt: toIso(window.window_end_at),
		},
	});
	await incrementRollup(executor, {
		projectId: input.projectId,
		customerId: input.customerId,
		entityId: input.entityId,
		meterFeatureId: featureId(input.meterLimit.feature),
		quantity: input.quantity,
		walletQuantity: input.quantity,
		recordedAt: event.recorded_at,
	});
	await enqueueMeteringProjection(executor, input.projectId, input.customerId, input.projectionKey);
	return {
		...decision,
		balance: meterLimitBalance(input.meterLimit, updated.usage),
		usageEventId: event.id,
		recordedAt: toIso(event.recorded_at),
		deductions: [],
	};
}

export async function reserveMeterLimit(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		entityId: string | null;
		filterKey: string | null;
		meterLimit: MeterLimitDecision;
		quantity: string;
		expiresInSeconds: number;
		projectionKey: string;
	},
): Promise<ReservationResult> {
	const window = await upsertUsageWindow(executor, input);
	const held = await readActiveWindowHolds(executor, input.projectId, String(window.id), null);
	const balance = meterLimitBalance(input.meterLimit, window.usage, held);
	const decision = await checkMeterLimitFromBalance(
		executor,
		input.projectId,
		input.meterLimit,
		input.quantity,
		balance,
	);
	if (!decision.allowed) {
		return {
			...decision,
			reservationId: null,
			status: null,
			expiresAt: null,
			deductions: [],
		};
	}
	const effectiveAt = new Date();
	const expiresAt = new Date(effectiveAt.getTime() + input.expiresInSeconds * 1000);
	const reservation = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
			INSERT INTO reservations (
				project_id,
				customer_id,
				entity_id,
				usage_window_id,
				usage_window_start_at,
				usage_window_end_at,
				meter_feature_id,
				wallet_feature_id,
				rate_card_path,
				requested_quantity,
				held_quantity,
				effective_at,
				expires_at
			)
			VALUES (
				${input.projectId},
				${input.customerId},
				${input.entityId}::bigint,
				${String(window.id)}::bigint,
				${toIso(window.window_start_at)},
				${toIso(window.window_end_at)},
				${featureId(input.meterLimit.feature)},
				${featureId(input.meterLimit.feature)},
				'direct',
				${input.quantity}::numeric,
				${input.quantity}::numeric,
				${effectiveAt.toISOString()},
				${expiresAt.toISOString()}
			)
			RETURNING id
		`,
	);
	if (reservation === null) throw new Error("Meter-limit reservation could not be persisted");
	const spend = meterLimitSpendDelta(input.meterLimit, balance, input.quantity);
	const controlDenial = await holdControls(
		executor,
		{
			projectId: input.projectId,
			customerId: input.customerId,
			entityId: input.entityId,
			featureId: featureId(input.meterLimit.feature),
			featureKey: input.meterLimit.feature.key,
			usageDelta: input.quantity,
			...spend,
		},
		reservation.id,
	);
	if (controlDenial !== null) {
		await executeOne(
			executor,
			drizzleSql`
				DELETE FROM reservations
				WHERE project_id = ${input.projectId} AND id = ${reservation.id}
				RETURNING id
			`,
		);
		return {
			...controlDeniedDecision(decision, controlDenial),
			reservationId: null,
			status: null,
			expiresAt: null,
			deductions: [],
		};
	}
	await enqueueMeteringProjection(executor, input.projectId, input.customerId, input.projectionKey);
	return {
		...decision,
		balance: meterLimitBalance(
			input.meterLimit,
			window.usage,
			unitsToDecimal(
				decimalToUnits(held, input.meterLimit.feature.credit_scale) +
					decimalToUnits(input.quantity, input.meterLimit.feature.credit_scale),
				input.meterLimit.feature.credit_scale,
			),
		),
		reservationId: reservation.id,
		status: "active",
		expiresAt: expiresAt.toISOString(),
		deductions: [],
	};
}

async function checkMeterLimitFromBalance(
	executor: QueryExecutor,
	projectId: string,
	meterLimit: MeterLimitDecision,
	quantity: string,
	balance: MeteringBalance,
): Promise<MeteringDecision> {
	const allowed =
		meterLimit.overagePolicy === "allowed" ||
		decimalToUnits(balance.available, balance.scale) >= decimalToUnits(quantity, balance.scale);
	return {
		allowed,
		reason: allowed ? "allowed" : "insufficient_balance",
		requestedQuantity: quantity,
		walletQuantity: quantity,
		balance,
		rateCard: rateReceipt(directRate(meterLimit.feature)),
		eligiblePurchaseActions: allowed ? [] : await purchaseActions(executor, projectId),
		control: null,
	};
}

export async function readMeterLimitBalance(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
	entityId: string | null,
	filterKey: string | null,
	meterLimit: MeterLimitDecision,
): Promise<MeteringBalance> {
	if (customerId === null) return meterLimitBalance(meterLimit, "0");
	const row = await executeOne<{ usage: unknown; held: unknown }>(
		executor,
		drizzleSql`
			SELECT
				windows.usage,
				COALESCE(sum(reservations.held_quantity), 0)::text AS held
			FROM usage_windows windows
			LEFT JOIN reservations
				ON reservations.project_id = windows.project_id
				AND reservations.usage_window_id = windows.id
				AND reservations.status = 'active'
				AND reservations.expires_at > now()
			WHERE windows.project_id = ${projectId}
				AND windows.customer_id = ${customerId}
				AND windows.feature_id = ${featureId(meterLimit.feature)}
				AND windows.entity_id IS NOT DISTINCT FROM ${entityId}::bigint
				AND windows.filter_key IS NOT DISTINCT FROM ${filterKey}
				AND windows.window_start_at = ${meterLimit.windowStartAt.toISOString()}::timestamptz
				AND windows.window_end_at = ${meterLimit.windowEndAt.toISOString()}::timestamptz
			GROUP BY windows.id, windows.usage
		`,
	);
	return meterLimitBalance(meterLimit, row?.usage ?? "0", row?.held ?? "0");
}

async function readActiveWindowHolds(
	executor: QueryExecutor,
	projectId: string,
	windowId: string,
	excludeReservationId: string | null,
): Promise<string> {
	const row = await executeOne<{ held: unknown }>(
		executor,
		drizzleSql`
			SELECT COALESCE(sum(held_quantity), 0)::text AS held
			FROM reservations
			WHERE project_id = ${projectId}
				AND usage_window_id = ${windowId}::bigint
				AND status = 'active'
				AND expires_at > now()
				AND (${excludeReservationId}::uuid IS NULL OR id <> ${excludeReservationId}::uuid)
		`,
	);
	return databaseDecimal(row?.held ?? "0", "window holds");
}

async function upsertUsageWindow(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		entityId: string | null;
		filterKey: string | null;
		meterLimit: MeterLimitDecision;
	},
): Promise<UsageWindowRow> {
	const row = await executeOne<UsageWindowRow>(
		executor,
		drizzleSql`
			INSERT INTO usage_windows (
				project_id,
				customer_id,
				entity_id,
				feature_id,
				filter_key,
				subscription_id,
				anchor_plan_item_id,
				window_start_at,
				window_end_at,
				usage
			)
			VALUES (
				${input.projectId},
				${input.customerId},
				${input.entityId}::bigint,
				${featureId(input.meterLimit.feature)},
				${input.filterKey},
				${input.meterLimit.subscriptionId}::uuid,
				${input.meterLimit.planItemId}::bigint,
				${input.meterLimit.windowStartAt.toISOString()},
				${input.meterLimit.windowEndAt.toISOString()},
				0
			)
			ON CONFLICT (
				project_id,
				customer_id,
				feature_id,
				(COALESCE(entity_id, 0::bigint)),
				(COALESCE(filter_key, '' COLLATE "C")),
				window_start_at,
				window_end_at
			)
			DO UPDATE SET updated_at = now()
			RETURNING id, window_start_at, window_end_at, usage
		`,
	);
	if (row === null) throw new Error("Usage window could not be persisted");
	return row;
}

function meterLimitBalance(
	meterLimit: MeterLimitDecision,
	rawUsage: unknown,
	rawHeld: unknown = "0",
): MeteringBalance {
	const scale = meterLimit.feature.credit_scale;
	const limit = decimalToUnits(meterLimit.limit, scale);
	const usage = decimalToUnits(databaseDecimal(rawUsage, "window usage", scale), scale);
	const held = decimalToUnits(databaseDecimal(rawHeld, "window holds", scale), scale);
	return {
		featureKey: meterLimit.feature.key,
		unit: meterLimit.feature.unit,
		scale,
		granted: unitsToDecimal(limit, scale),
		consumed: unitsToDecimal(usage, scale),
		held: unitsToDecimal(held, scale),
		available: unitsToDecimal(limit > usage + held ? limit - usage - held : 0n, scale),
		breakdown: [],
	};
}

function directRate(feature: FeatureRow): RateDecision {
	return {
		meter: feature,
		wallet: feature,
		path: "direct",
		revision: null,
		revisionId: null,
		entryId: null,
		pricingModel: "flat",
		ratePerUnit: "1",
		tiers: [],
	};
}

interface RateCardRow {
	entry_id: string | number | bigint;
	revision_id: string | number | bigint;
	revision: number;
	pricing_model: "flat" | "graduated";
	rate_per_unit: unknown;
	wallet_id: string | number | bigint;
	wallet_key: string;
	wallet_unit: string;
	wallet_scale: number;
}

export function queryPinnedRateCards(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
	meter: FeatureRow,
): Promise<RateCardRow[]> {
	if (customerId === null) return Promise.resolve([]);
	return executeRows<RateCardRow>(
		executor,
		drizzleSql`
			SELECT DISTINCT
				rce.id AS entry_id,
				cr.id AS revision_id,
				cr.revision,
				rce.pricing_model,
				rce.rate_per_unit,
				wallet.id AS wallet_id,
				wallet.key AS wallet_key,
				wallet.unit AS wallet_unit,
				wallet.credit_scale AS wallet_scale
			FROM subscriptions s
			JOIN catalog_revisions cr
				ON cr.project_id = s.project_id
				AND cr.id = s.catalog_revision_id
			JOIN rate_card_entries rce
				ON rce.project_id = s.project_id
				AND rce.catalog_revision_id = s.catalog_revision_id
				AND rce.meter_feature_id = ${featureId(meter)}
			JOIN features wallet
				ON wallet.project_id = rce.project_id
				AND wallet.id = rce.wallet_feature_id
			WHERE s.project_id = ${projectId}
				AND s.customer_id = ${customerId}
				AND s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
				AND (s.expires_at IS NULL OR s.expires_at > now())
			ORDER BY cr.revision DESC
			LIMIT 2
		`,
	);
}

export function queryAdditiveRateCard(
	executor: QueryExecutor,
	projectId: string,
	meter: FeatureRow,
): Promise<RateCardRow | null> {
	return executeOne<RateCardRow>(
		executor,
		drizzleSql`
			SELECT
				rce.id AS entry_id,
				cr.id AS revision_id,
				cr.revision,
				rce.pricing_model,
				rce.rate_per_unit,
				wallet.id AS wallet_id,
				wallet.key AS wallet_key,
				wallet.unit AS wallet_unit,
				wallet.credit_scale AS wallet_scale
			FROM projects p
			JOIN catalog_revisions cr
				ON cr.project_id = p.id
				AND cr.id = p.published_catalog_revision_id
			JOIN rate_card_entries rce
				ON rce.project_id = cr.project_id
				AND rce.catalog_revision_id = cr.id
				AND rce.meter_feature_id = ${featureId(meter)}
			JOIN features wallet
				ON wallet.project_id = rce.project_id
				AND wallet.id = rce.wallet_feature_id
			WHERE p.id = ${projectId}
			LIMIT 1
		`,
	);
}

export function queryPurchasedRevision(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
): Promise<boolean> {
	if (customerId === null) return Promise.resolve(false);
	return executeOne<{ id: string }>(
		executor,
		drizzleSql`
            SELECT id FROM subscriptions WHERE project_id=${projectId} AND customer_id=${customerId}
            AND catalog_revision_id IS NOT NULL AND status IN ('active','grace_period','billing_retry','cancelled')
            AND (expires_at IS NULL OR expires_at>clock_timestamp()) LIMIT 1
        `,
	).then((row) => row !== null);
}

function queryDirectPricing(
	executor: QueryExecutor,
	projectId: string,
	meter: FeatureRow,
): Promise<boolean> {
	return executeOne<{ direct: boolean }>(
		executor,
		drizzleSql`
			SELECT EXISTS (
				SELECT 1
				FROM plan_items pi
				WHERE pi.project_id = ${projectId}
					AND pi.feature_id = ${featureId(meter)}
					AND pi.item_kind = 'allocation'
				UNION ALL
				SELECT 1
				FROM rate_card_entries rce
				WHERE rce.project_id = ${projectId}
					AND rce.wallet_feature_id = ${featureId(meter)}
			) AS direct
		`,
	).then((row) => row?.direct === true);
}

export async function resolveRateDecision(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
	featureKey: string,
	meter?: FeatureRow,
): Promise<RateDecision> {
	const feature = meter ?? (await requireMeteredFeature(executor, projectId, featureKey));
	return await rateDecision(executor, projectId, feature, {
		pinned: await queryPinnedRateCards(executor, projectId, customerId, feature),
		additive: () => queryAdditiveRateCard(executor, projectId, feature),
		purchased: () => queryPurchasedRevision(executor, projectId, customerId),
	});
}

/** Rate resolution from prefetched rows; lazy members are read only when the path needs them. */
export async function rateDecision(
	executor: QueryExecutor,
	projectId: string,
	meter: FeatureRow,
	prefetched: {
		pinned: readonly RateCardRow[];
		additive: RateCardRow | null | (() => Promise<RateCardRow | null>);
		purchased: boolean | (() => Promise<boolean>);
	},
): Promise<RateDecision> {
	if (prefetched.pinned.length > 1) {
		throw new BillingError(
			`Multiple pinned rate cards price feature ${meter.key}`,
			"METERING_CONFIGURATION_ERROR",
			409,
			{ classification: "persistence_conflict" },
		);
	}
	const pinned = prefetched.pinned[0];
	if (pinned !== undefined) {
		return await rateDecisionFromRow(executor, projectId, meter, pinned, "pinned");
	}
	const additive =
		typeof prefetched.additive === "function" ? await prefetched.additive() : prefetched.additive;
	if (additive !== null) {
		const purchased =
			typeof prefetched.purchased === "function"
				? await prefetched.purchased()
				: prefetched.purchased;
		if (purchased)
			throw new BillingError(
				"The purchased revision does not price this meter; activate a fixed rate revision before use",
				"METER_RATE_NOT_ACTIVATED",
				409,
			);
		return await rateDecisionFromRow(executor, projectId, meter, additive, "additive");
	}
	if (!(await queryDirectPricing(executor, projectId, meter))) {
		throw new BillingError(
			`No published rate card or wallet allocation prices feature ${meter.key}`,
			"METERING_CONFIGURATION_ERROR",
			409,
			{ classification: "persistence_conflict" },
		);
	}
	return {
		meter,
		wallet: meter,
		path: "direct",
		revision: null,
		revisionId: null,
		entryId: null,
		pricingModel: "flat",
		ratePerUnit: "1",
		tiers: [],
	};
}

async function rateDecisionFromRow(
	executor: QueryExecutor,
	projectId: string,
	meter: FeatureRow,
	row: {
		entry_id: string | number | bigint;
		revision_id: string | number | bigint;
		revision: number;
		pricing_model: "flat" | "graduated";
		rate_per_unit: unknown;
		wallet_id: string | number | bigint;
		wallet_key: string;
		wallet_unit: string;
		wallet_scale: number;
	},
	path: "pinned" | "additive",
): Promise<RateDecision> {
	const entryId = String(row.entry_id);
	return {
		meter,
		wallet: {
			id: row.wallet_id,
			key: row.wallet_key,
			unit: row.wallet_unit,
			credit_scale: row.wallet_scale,
			kind: "metered",
			meter_kind: "consumable",
			filter_dimensions: [],
		},
		path,
		revision: row.revision,
		revisionId: String(row.revision_id),
		entryId,
		pricingModel: row.pricing_model,
		ratePerUnit: databaseDecimal(row.rate_per_unit, "rate per unit", 18),
		tiers:
			row.pricing_model === "graduated"
				? await readRateCardTiers(executor, projectId, entryId)
				: [],
	};
}

async function readRateCardTiers(
	executor: QueryExecutor,
	projectId: string,
	entryId: string,
): Promise<RateCardTier[]> {
	const rows = await executeRows<{ up_to_quantity: unknown; rate_per_unit: unknown }>(
		executor,
		drizzleSql`
			SELECT up_to_quantity::text AS up_to_quantity, rate_per_unit::text AS rate_per_unit
			FROM rate_card_tiers
			WHERE project_id = ${projectId} AND rate_card_entry_id = ${entryId}::bigint
			ORDER BY ordinal
		`,
	);
	return rows.map((row) => ({
		upToQuantity: row.up_to_quantity === null ? null : String(row.up_to_quantity),
		ratePerUnit: databaseDecimal(row.rate_per_unit, "tier rate per unit", 18),
	}));
}

export async function calculateWalletQuantity(
	_executor: QueryExecutor,
	rate: RateDecision,
	quantity: string,
): Promise<string> {
	return calculateRateCardQuantity({
		quantity,
		pricingModel: rate.pricingModel,
		ratePerUnit: rate.ratePerUnit,
		tiers: rate.tiers,
		meterScale: rate.meter.credit_scale,
		walletScale: rate.wallet.credit_scale,
	});
}

export function validateFilters(
	feature: FeatureRow,
	filters: Record<string, string | number | boolean> | undefined,
): void {
	if (filters === undefined) {
		return;
	}
	const allowed = new Set(feature.filter_dimensions);
	for (const key of Object.keys(filters)) {
		if (!allowed.has(key)) {
			throw new InvalidRequestError(`Filter dimension ${key} is not declared for ${feature.key}`);
		}
	}
}

export function canonicalFilterKey(
	filters: Record<string, string | number | boolean> | undefined,
): string | null {
	return filters === undefined || Object.keys(filters).length === 0
		? null
		: sha256Hex(stableJson(filters));
}

export async function findCustomer(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
): Promise<{ id: string } | null> {
	const normalized = billingAccountId.trim();
	if (normalized === "") {
		throw new InvalidRequestError("billingAccountId is required");
	}
	return await executeOne<{ id: string }>(
		executor,
		drizzleSql`
			SELECT id
			FROM customers
			WHERE project_id = ${projectId}
				AND billing_account_id = ${normalized}
			LIMIT 1
		`,
	);
}

export async function resolveEntityId(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
	externalEntityId: string | null | undefined,
): Promise<string | null> {
	const normalized = externalEntityId?.trim();
	if (normalized === undefined || normalized === "") return null;
	if (customerId === null) {
		throw new NotFoundBillingError(
			`Entity ${normalized} was not found for the billing account`,
			"ENTITY_NOT_FOUND",
		);
	}
	const row = await executeOne<{ id: string | number | bigint }>(
		executor,
		drizzleSql`
			SELECT id
			FROM entities
			WHERE project_id = ${projectId}
				AND customer_id = ${customerId}
				AND external_id = ${normalized}
			LIMIT 1
		`,
	);
	if (row === null) {
		throw new NotFoundBillingError(
			`Entity ${normalized} was not found for the billing account`,
			"ENTITY_NOT_FOUND",
		);
	}
	return String(row.id);
}

export async function enqueueMeteringProjection(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	_projectionKey: string,
): Promise<void> {
	await enqueueUsageProjection(executor, { projectId, customerId });
}

export async function validateOccurredAt(
	executor: QueryExecutor,
	projectId: string,
	occurredAt: Date | null,
): Promise<void> {
	if (occurredAt === null) return;
	if (Number.isNaN(occurredAt.getTime())) {
		throw new InvalidRequestError("occurredAt must be a valid timestamp");
	}
	const row = await executeOne<{ allowed: boolean; max_skew_seconds: number }>(
		executor,
		drizzleSql`
			SELECT
				abs(extract(epoch FROM (${occurredAt.toISOString()}::timestamptz - now())))
					<= COALESCE(settings.occurred_at_max_skew_seconds, 300) AS allowed,
				COALESCE(settings.occurred_at_max_skew_seconds, 300) AS max_skew_seconds
			FROM (SELECT 1) singleton
			LEFT JOIN metering_settings settings ON settings.project_id = ${projectId}
		`,
	);
	if (row?.allowed !== true) {
		throw new InvalidRequestError(
			`occurredAt exceeds the configured ${row?.max_skew_seconds ?? 300} second clock skew`,
		);
	}
}

export async function readBalance(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	feature: FeatureRow,
	entityId: string | null = null,
): Promise<MeteringBalance> {
	const rows = await executeRows<AllocationRow>(
		executor,
		drizzleSql`
			SELECT allocation.id, allocation.quantity, allocation.reversed_quantity,
				allocation.consumed_quantity,
                COALESCE((SELECT sum(holds.held_quantity - holds.consumed_quantity) FROM reservation_allocations holds JOIN reservations r ON r.project_id=holds.project_id AND r.id=holds.reservation_id WHERE holds.project_id=allocation.project_id AND holds.allocation_id=allocation.id AND r.status='active' AND r.expires_at>clock_timestamp()),0) AS held_quantity,
                allocation.source_kind,
				allocation.source_key, allocation.expires_at, allocation.created_at,
				allocation.reversed_at, entity.external_id AS entity_external_id,
				allocation.rollover_origin_allocation_id, allocation.rollover_policy_revision,
				allocation.period_start_at, allocation.period_end_at
			FROM balance_allocations allocation
			LEFT JOIN entities entity
				ON entity.project_id = allocation.project_id AND entity.id = allocation.entity_id
				WHERE allocation.project_id = ${projectId}
					AND allocation.customer_id = ${customerId}
					AND allocation.feature_id = ${featureId(feature)}
					AND (allocation.entity_id IS NULL OR allocation.entity_id = ${entityId}::bigint)
				AND allocation.reversed_at IS NULL
				AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
			ORDER BY allocation.expires_at ASC NULLS LAST, allocation.created_at, allocation.id
		`,
	);
	return rows.length === 0 ? emptyBalance(feature) : balanceFromRows(feature, rows);
}

export function emptyBalance(feature: FeatureRow): MeteringBalance {
	return {
		featureKey: feature.key,
		unit: feature.unit,
		scale: feature.credit_scale,
		granted: "0",
		consumed: "0",
		held: "0",
		available: "0",
		breakdown: [],
	};
}

export async function lockAllocations(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	feature: FeatureRow,
	entityId: string | null,
): Promise<AllocationRow[]> {
	return await executeRows<AllocationRow>(
		executor,
		drizzleSql`
			SELECT
					allocation.id,
					allocation.quantity,
					allocation.reversed_quantity,
					allocation.consumed_quantity,
					allocation.held_quantity,
					allocation.source_kind,
					allocation.source_key,
					allocation.expires_at,
					allocation.created_at,
					allocation.reversed_at,
					entity.external_id AS entity_external_id,
					allocation.rollover_origin_allocation_id,
					allocation.rollover_policy_revision,
					allocation.period_start_at,
					allocation.period_end_at
				FROM balance_allocations allocation
				LEFT JOIN entities entity
					ON entity.project_id = allocation.project_id AND entity.id = allocation.entity_id
				WHERE allocation.project_id = ${projectId}
					AND allocation.customer_id = ${customerId}
					AND allocation.feature_id = ${featureId(feature)}
					AND (allocation.entity_id IS NULL OR allocation.entity_id = ${entityId}::bigint)
					AND allocation.reversed_at IS NULL
					AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
				ORDER BY allocation.expires_at ASC NULLS LAST, allocation.created_at ASC, allocation.id ASC
				FOR UPDATE OF allocation
		`,
	);
}

export async function lockAllAllocationRows(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	feature: FeatureRow,
	entityId: string | null,
): Promise<AllocationRow[]> {
	return await executeRows<AllocationRow>(
		executor,
		drizzleSql`
			SELECT
					allocation.id,
					allocation.quantity,
					allocation.reversed_quantity,
					allocation.consumed_quantity,
					allocation.held_quantity,
					allocation.source_kind,
					allocation.source_key,
					allocation.expires_at,
					allocation.created_at,
					allocation.reversed_at,
					entity.external_id AS entity_external_id,
					allocation.rollover_origin_allocation_id,
					allocation.rollover_policy_revision,
					allocation.period_start_at,
					allocation.period_end_at
				FROM balance_allocations allocation
				LEFT JOIN entities entity
					ON entity.project_id = allocation.project_id AND entity.id = allocation.entity_id
				WHERE allocation.project_id = ${projectId}
					AND allocation.customer_id = ${customerId}
					AND allocation.feature_id = ${featureId(feature)}
					AND (allocation.entity_id IS NULL OR allocation.entity_id = ${entityId}::bigint)
				ORDER BY allocation.expires_at ASC NULLS LAST, allocation.created_at ASC, allocation.id ASC
				FOR UPDATE OF allocation
		`,
	);
}

export function balanceFromRows(feature: FeatureRow, rows: AllocationRow[]): MeteringBalance {
	const scale = feature.credit_scale;
	let granted = 0n;
	let consumed = 0n;
	let held = 0n;
	for (const row of rows) {
		granted +=
			decimalToUnits(databaseDecimal(row.quantity, "allocation quantity", scale), scale) -
			decimalToUnits(databaseDecimal(row.reversed_quantity, "allocation reversed", scale), scale);
		consumed += decimalToUnits(
			databaseDecimal(row.consumed_quantity, "allocation consumed", scale),
			scale,
		);
		held += decimalToUnits(databaseDecimal(row.held_quantity, "allocation held", scale), scale);
	}
	return {
		featureKey: feature.key,
		unit: feature.unit,
		scale,
		granted: unitsToDecimal(granted, scale),
		consumed: unitsToDecimal(consumed, scale),
		held: unitsToDecimal(held, scale),
		available: unitsToDecimal(granted > consumed + held ? granted - consumed - held : 0n, scale),
		breakdown: rows.map((row) => {
			const quantity = decimalToUnits(
				databaseDecimal(row.quantity, "allocation quantity", scale),
				scale,
			);
			const reversed = decimalToUnits(
				databaseDecimal(row.reversed_quantity, "allocation reversed", scale),
				scale,
			);
			const rowConsumed = decimalToUnits(
				databaseDecimal(row.consumed_quantity, "allocation consumed", scale),
				scale,
			);
			const rowHeld = decimalToUnits(
				databaseDecimal(row.held_quantity, "allocation held", scale),
				scale,
			);
			const available = quantity - reversed - rowConsumed - rowHeld;
			return {
				allocationId: String(row.id),
				entityId: row.entity_external_id,
				sourceKind: row.source_kind,
				sourceKey: row.source_key,
				rolloverOriginAllocationId:
					row.rollover_origin_allocation_id === null
						? null
						: String(row.rollover_origin_allocation_id),
				rolloverPolicyRevision: row.rollover_policy_revision,
				quantity: unitsToDecimal(quantity, scale),
				reversed: unitsToDecimal(reversed, scale),
				consumed: unitsToDecimal(rowConsumed, scale),
				held: unitsToDecimal(rowHeld, scale),
				available: unitsToDecimal(available > 0n ? available : 0n, scale),
				periodStartAt: row.period_start_at === null ? null : toIso(row.period_start_at),
				periodEndAt: row.period_end_at === null ? null : toIso(row.period_end_at),
				expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
				createdAt: toIso(row.created_at),
			};
		}),
	};
}

/** Chooses which allocations cover the quantity, oldest expiry first, without writing. */
export function planDeductions(
	rows: readonly AllocationRow[],
	scale: number,
	quantity: string,
): AllocationDeduction[] {
	let remaining = decimalToUnits(quantity, scale);
	const deductions: AllocationDeduction[] = [];
	for (const row of rows) {
		if (remaining === 0n) break;
		const available =
			decimalToUnits(databaseDecimal(row.quantity, "allocation quantity", scale), scale) -
			decimalToUnits(databaseDecimal(row.reversed_quantity, "allocation reversed", scale), scale) -
			decimalToUnits(databaseDecimal(row.consumed_quantity, "allocation consumed", scale), scale) -
			decimalToUnits(databaseDecimal(row.held_quantity, "allocation held", scale), scale);
		const taken = available < remaining ? available : remaining;
		if (taken <= 0n) continue;
		deductions.push(allocationDeduction(row, unitsToDecimal(taken, scale)));
		remaining -= taken;
	}
	if (remaining !== 0n) {
		throw new Error("Allocation deduction did not cover the approved quantity");
	}
	return deductions;
}

/** Applies planned deductions; the rows are distinct, so the updates are issued together. */
export async function applyDeductions(
	executor: QueryExecutor,
	deductions: readonly AllocationDeduction[],
	column: "consumed_quantity" | "held_quantity",
): Promise<void> {
	await Promise.all(
		deductions.map((deduction) =>
			executeOne(
				executor,
				drizzleSql`
				UPDATE balance_allocations
				SET
					${drizzleSql.raw(column)} = ${drizzleSql.raw(column)} + ${deduction.quantity}::numeric,
					updated_at = now()
				WHERE id = ${deduction.allocationId}::bigint
				RETURNING id
			`,
			),
		),
	);
}

/** The locked rows as they stand after the deductions, for an exact post-write balance. */
export function deductedRows(
	rows: readonly AllocationRow[],
	deductions: readonly AllocationDeduction[],
	scale: number,
	column: "consumed_quantity" | "held_quantity",
): AllocationRow[] {
	const taken = new Map(
		deductions.map((deduction) => [deduction.allocationId, deduction.quantity]),
	);
	return rows.map((row) => {
		const quantity = taken.get(String(row.id));
		if (quantity === undefined) return row;
		const current = decimalToUnits(
			databaseDecimal(row[column], `allocation ${column}`, scale),
			scale,
		);
		return { ...row, [column]: unitsToDecimal(current + decimalToUnits(quantity, scale), scale) };
	});
}

function allocationDeduction(row: AllocationRow, quantity: string): AllocationDeduction {
	return {
		allocationId: String(row.id),
		quantity,
		sourceKind: row.source_kind,
		sourceKey: row.source_key,
		expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
	};
}

export async function buildDecision(
	executor: QueryExecutor,
	projectId: string,
	rate: RateDecision,
	requestedQuantity: string,
	walletQuantity: string,
	balance: MeteringBalance,
): Promise<MeteringDecision> {
	const allowed =
		decimalToUnits(balance.available, balance.scale) >=
		decimalToUnits(walletQuantity, balance.scale);
	return {
		allowed,
		reason: allowed ? "allowed" : "insufficient_balance",
		requestedQuantity,
		walletQuantity,
		balance,
		rateCard: rateReceipt(rate),
		eligiblePurchaseActions: allowed ? [] : await purchaseActions(executor, projectId),
		control: null,
	};
}

export function controlDeniedDecision(
	decision: MeteringDecision,
	denial: ControlDenial,
): MeteringDecision {
	return {
		...decision,
		allowed: false,
		reason: "control_limit_exceeded",
		eligiblePurchaseActions: [],
		control: denial,
	};
}

function rateReceipt(rate: RateDecision): RateCardReceipt {
	return {
		path: rate.path,
		revision: rate.revision,
		revisionId: rate.revisionId,
		entryId: rate.entryId,
		meterFeatureKey: rate.meter.key,
		walletFeatureKey: rate.wallet.key,
		pricingModel: rate.pricingModel,
		ratePerUnit: rate.ratePerUnit,
		tiers: rate.tiers,
	};
}

async function purchaseActions(
	executor: QueryExecutor,
	projectId: string,
): Promise<Array<{ provider: "apple" | "google" | "stripe"; action: "purchase_required" }>> {
	return await executeRows<{
		provider: "apple" | "google" | "stripe";
		action: "purchase_required";
	}>(
		executor,
		drizzleSql`
			SELECT DISTINCT sp.provider, 'purchase_required'::text AS action
			FROM store_products sp
			JOIN products p ON p.project_id = sp.project_id AND p.id = sp.product_id
			WHERE sp.project_id = ${projectId}
				AND sp.active = true
				AND p.active = true
				AND p.credit_amount > 0
			ORDER BY sp.provider
		`,
	);
}

export async function claimWorkerDelivery(
	executor: QueryExecutor,
	projectId: string,
	deliveryId: string,
	requestContextId: string,
): Promise<boolean> {
	const delivery = deliveryId.trim();
	const context = requestContextId.trim();
	if (delivery.length < 1 || delivery.length > 200) {
		throw new InvalidRequestError("Worker delivery id must contain between 1 and 200 characters");
	}
	if (context.length < 1 || context.length > 200) {
		throw new InvalidRequestError(
			"Worker request context id must contain between 1 and 200 characters",
		);
	}
	await executeRows(
		executor,
		drizzleSql`
			DELETE FROM worker_delivery_claims
			WHERE project_id = ${projectId}
				AND delivery_id = ${delivery}
				AND expires_at <= now()
		`,
	);
	const row = await executeOne<{ id: string | number | bigint }>(
		executor,
		drizzleSql`
			INSERT INTO worker_delivery_claims (
				project_id,
				delivery_id,
				request_context_id,
				expires_at
			)
			VALUES (
				${projectId},
				${delivery},
				${context},
				now() + make_interval(
					secs => COALESCE(
						(SELECT worker_delivery_ttl_seconds FROM metering_settings WHERE project_id = ${projectId}),
						86400
					)
				)
			)
			ON CONFLICT (project_id, delivery_id) DO NOTHING
			RETURNING id
		`,
	);
	return row !== null;
}

export async function insertUsageEvent(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		entityId: string | null;
		rate: RateDecision;
		operation: "consume" | "confirm";
		quantity: string;
		walletQuantity: string;
		occurredAt: Date | null;
		reservationId: string | null;
		filterKey: string | null;
		deductions: AllocationDeduction[];
		metadata: Record<string, unknown>;
		recordedAt?: Date;
	},
): Promise<{ id: string; recorded_at: Date | string }> {
	const recordedAt = input.recordedAt ?? new Date();
	const row = await executeOne<{ id: string; recorded_at: Date | string }>(
		executor,
		drizzleSql`
			INSERT INTO usage_events (
				recorded_at,
				project_id,
				customer_id,
				entity_id,
				meter_feature_id,
				wallet_feature_id,
				reservation_id,
				operation,
				quantity,
				wallet_quantity,
				occurred_at,
				effective_at,
				rate_card_entry_id,
				rate_card_revision_id,
				rate_card_path,
				rate_inputs,
				filter_key,
				deductions,
				metadata
			)
			VALUES (
				${recordedAt.toISOString()},
				${input.projectId},
				${input.customerId},
				${input.entityId},
				${featureId(input.rate.meter)},
				${featureId(input.rate.wallet)},
				${input.reservationId},
				${input.operation},
				${input.quantity}::numeric,
				${input.walletQuantity}::numeric,
				${input.occurredAt?.toISOString() ?? null},
				${recordedAt.toISOString()},
				${input.rate.entryId},
				${input.rate.revisionId},
				${input.rate.path},
					${jsonb({
						quantity: input.quantity,
						pricingModel: input.rate.pricingModel,
						ratePerUnit: input.rate.ratePerUnit,
						tiers: input.rate.tiers,
						walletQuantity: input.walletQuantity,
						walletScale: input.rate.wallet.credit_scale,
					})},
				${input.filterKey},
				${jsonb(input.deductions)},
				${jsonb(input.metadata)}
			)
			RETURNING id, recorded_at
		`,
	);
	if (row === null) {
		throw new Error("Usage event could not be persisted");
	}
	return row;
}

export async function incrementRollup(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		entityId: string | null;
		meterFeatureId: string;
		quantity: string;
		walletQuantity: string;
		recordedAt: Date | string;
	},
): Promise<void> {
	await executeOne(
		executor,
		drizzleSql`
			INSERT INTO usage_event_rollups (
				project_id,
				customer_id,
				entity_id,
				meter_feature_id,
				period_start_at,
				period_end_at,
				quantity,
				wallet_quantity,
				event_count
			)
			VALUES (
				${input.projectId},
				${input.customerId},
				${input.entityId},
				${input.meterFeatureId},
				date_trunc('month', ${toIso(input.recordedAt)}::timestamptz),
				date_trunc('month', ${toIso(input.recordedAt)}::timestamptz) + interval '1 month',
				${input.quantity}::numeric,
				${input.walletQuantity}::numeric,
				1
			)
			ON CONFLICT (
				project_id,
				customer_id,
				meter_feature_id,
				(COALESCE(entity_id, 0::bigint)),
				period_start_at
			)
			DO UPDATE SET
				quantity = usage_event_rollups.quantity + EXCLUDED.quantity,
				wallet_quantity = usage_event_rollups.wallet_quantity + EXCLUDED.wallet_quantity,
				event_count = usage_event_rollups.event_count + 1,
				updated_at = now()
			WHERE usage_event_rollups.status = 'open'
			RETURNING id
		`,
	);
}

export async function lockReservation(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	reservationId: string,
): Promise<ReservationRow> {
	const row = await executeOne<ReservationRow>(
		executor,
		drizzleSql`
			SELECT
				r.*,
				c.billing_account_id,
				meter.key AS meter_feature_key,
				meter.unit AS meter_unit,
				meter.credit_scale AS meter_scale,
				wallet.key AS wallet_feature_key,
				wallet.unit AS wallet_unit,
				wallet.credit_scale AS wallet_scale,
				cr.revision,
				COALESCE(rce.pricing_model, 'flat') AS pricing_model,
				COALESCE(rce.rate_per_unit, 1)::text AS rate_per_unit
			FROM reservations r
			JOIN customers c ON c.project_id = r.project_id AND c.id = r.customer_id
			JOIN features meter ON meter.project_id = r.project_id AND meter.id = r.meter_feature_id
			JOIN features wallet ON wallet.project_id = r.project_id AND wallet.id = r.wallet_feature_id
			LEFT JOIN rate_card_entries rce
				ON rce.project_id = r.project_id AND rce.id = r.rate_card_entry_id
			LEFT JOIN catalog_revisions cr
				ON cr.project_id = r.project_id AND cr.id = r.rate_card_revision_id
			WHERE r.project_id = ${projectId}
				AND r.customer_id = ${customerId}
				AND r.id = ${reservationId}
			FOR UPDATE OF r
		`,
	);
	if (row === null) {
		throw new NotFoundBillingError(
			`Reservation ${reservationId} was not found`,
			"RESERVATION_NOT_FOUND",
		);
	}
	return row;
}

export async function lockReservationById(
	executor: QueryExecutor,
	projectId: string,
	reservationId: string,
): Promise<ReservationRow> {
	const owner = await executeOne<{ customer_id: string }>(
		executor,
		drizzleSql`
			SELECT customer_id FROM reservations
			WHERE project_id = ${projectId} AND id = ${reservationId}
		`,
	);
	if (owner === null) {
		throw new NotFoundBillingError(
			`Reservation ${reservationId} was not found`,
			"RESERVATION_NOT_FOUND",
		);
	}
	return await lockReservation(executor, projectId, owner.customer_id, reservationId);
}

export async function rateFromReservation(
	executor: QueryExecutor,
	reservation: ReservationRow,
): Promise<RateDecision> {
	const entryId =
		reservation.rate_card_entry_id === null ? null : String(reservation.rate_card_entry_id);
	return {
		meter: {
			id: reservation.meter_feature_id,
			key: reservation.meter_feature_key,
			unit: reservation.meter_unit,
			credit_scale: reservation.meter_scale,
			kind: "metered",
			meter_kind: "consumable",
			filter_dimensions: [],
		},
		wallet: {
			id: reservation.wallet_feature_id,
			key: reservation.wallet_feature_key,
			unit: reservation.wallet_unit,
			credit_scale: reservation.wallet_scale,
			kind: "metered",
			meter_kind: "consumable",
			filter_dimensions: [],
		},
		path: reservation.rate_card_path,
		revision: reservation.revision,
		revisionId:
			reservation.rate_card_revision_id === null ? null : String(reservation.rate_card_revision_id),
		entryId,
		pricingModel: reservation.pricing_model,
		ratePerUnit: databaseDecimal(reservation.rate_per_unit, "reservation rate", 18),
		tiers:
			entryId !== null && reservation.pricing_model === "graduated"
				? await readRateCardTiers(executor, reservation.project_id, entryId)
				: [],
	};
}

export async function lockReservationAllocations(
	executor: QueryExecutor,
	projectId: string,
	reservationId: string,
): Promise<ReservationAllocationRow[]> {
	return await executeRows<ReservationAllocationRow>(
		executor,
		drizzleSql`
			SELECT allocation_id, held_quantity, consumed_quantity
			FROM reservation_allocations
			WHERE project_id = ${projectId}
				AND reservation_id = ${reservationId}
			ORDER BY allocation_id
			FOR UPDATE
		`,
	);
}

export interface ConfirmationPlan {
	changes: Array<{
		allocationId: string;
		consume: bigint;
		release: bigint;
		hasHold: boolean;
	}>;
	deductions: AllocationDeduction[];
}

/** Decides how a confirmation settles against held and free allocation quantity, without writing. */
export function planConfirmation(
	allocations: readonly AllocationRow[],
	reservationAllocations: readonly ReservationAllocationRow[],
	scale: number,
	walletQuantity: string,
): ConfirmationPlan {
	const holds = new Map(
		reservationAllocations.map((row) => [
			String(row.allocation_id),
			decimalToUnits(databaseDecimal(row.held_quantity, "reservation hold", scale), scale),
		]),
	);
	let remaining = decimalToUnits(walletQuantity, scale);
	const changes = new Map<string, { consume: bigint; release: bigint; row: AllocationRow }>();

	for (const row of allocations) {
		const held = holds.get(String(row.id)) ?? 0n;
		const consumed = held < remaining ? held : remaining;
		changes.set(String(row.id), { consume: consumed, release: held, row });
		remaining -= consumed;
	}

	if (remaining > 0n) {
		const now = Date.now();
		for (const row of allocations) {
			if (remaining === 0n) break;
			if (
				row.reversed_at !== null ||
				(row.expires_at !== null && new Date(row.expires_at).getTime() <= now)
			) {
				continue;
			}
			const free =
				decimalToUnits(databaseDecimal(row.quantity, "allocation quantity", scale), scale) -
				decimalToUnits(
					databaseDecimal(row.consumed_quantity, "allocation consumed", scale),
					scale,
				) -
				decimalToUnits(databaseDecimal(row.held_quantity, "allocation held", scale), scale);
			const extra = free < remaining ? free : remaining;
			if (extra <= 0n) continue;
			const change = changes.get(String(row.id)) ?? { consume: 0n, release: 0n, row };
			change.consume += extra;
			changes.set(String(row.id), change);
			remaining -= extra;
		}
	}

	if (remaining > 0n) {
		throw new BillingError(
			"Insufficient balance to confirm reservation",
			"INSUFFICIENT_BALANCE",
			409,
			{
				classification: "persistence_conflict",
			},
		);
	}

	const plan: ConfirmationPlan = { changes: [], deductions: [] };
	for (const [allocationId, { consume, release, row }] of changes) {
		if (consume === 0n && release === 0n) continue;
		plan.changes.push({ allocationId, consume, release, hasHold: holds.has(allocationId) });
		if (consume > 0n)
			plan.deductions.push(allocationDeduction(row, unitsToDecimal(consume, scale)));
	}
	return plan;
}

/** Writes a confirmation plan; rows are distinct, so the updates are issued together. */
export async function applyConfirmation(
	executor: QueryExecutor,
	projectId: string,
	reservationId: string,
	plan: ConfirmationPlan,
	scale: number,
): Promise<void> {
	await Promise.all(
		plan.changes.flatMap(({ allocationId, consume, release, hasHold }) => {
			const statements = [
				executeOne(
					executor,
					drizzleSql`
				UPDATE balance_allocations
				SET
					consumed_quantity = consumed_quantity + ${unitsToDecimal(consume, scale)}::numeric,
					held_quantity = held_quantity - ${unitsToDecimal(release, scale)}::numeric,
					updated_at = now()
				WHERE id = ${allocationId}::bigint
				RETURNING id
			`,
				),
			];
			if (hasHold) {
				// Scoped to this reservation: other reservations may hold the same allocation.
				statements.push(
					executeOne(
						executor,
						drizzleSql`
					UPDATE reservation_allocations
					SET consumed_quantity = ${unitsToDecimal(consume > release ? release : consume, scale)}::numeric
					WHERE project_id = ${projectId}
						AND reservation_id = ${reservationId}
						AND allocation_id = ${allocationId}::bigint
					RETURNING allocation_id
				`,
					),
				);
			}
			return statements;
		}),
	);
}

export async function confirmMeterLimitReservation(
	executor: QueryExecutor,
	reservation: ReservationRow,
	quantity: string,
	context: { occurredAt: Date | null; metadata: Record<string, unknown> },
): Promise<FinalizeReservationResult> {
	if (
		reservation.usage_window_id === null ||
		reservation.usage_window_start_at === null ||
		reservation.usage_window_end_at === null
	) {
		throw new Error("Meter-limit reservation lost its window identity");
	}
	const window = await executeOne<UsageWindowRow & { filter_key: string | null }>(
		executor,
		drizzleSql`
			SELECT id, window_start_at, window_end_at, usage, filter_key
			FROM usage_windows
			WHERE project_id = ${reservation.project_id}
				AND id = ${String(reservation.usage_window_id)}::bigint
			FOR UPDATE
		`,
	);
	if (window === null) throw new Error("Meter-limit reservation window was not found");
	const feature: FeatureRow = {
		id: reservation.meter_feature_id,
		key: reservation.meter_feature_key,
		unit: reservation.meter_unit,
		credit_scale: reservation.meter_scale,
		kind: "metered",
		meter_kind: "consumable",
		filter_dimensions: [],
	};
	const meterLimit = (await resolveMeterLimit(
		executor,
		reservation.project_id,
		reservation.customer_id,
		feature,
	)) ?? {
		feature,
		subscriptionId: null,
		planItemId: null,
		limit: "0",
		overagePolicy: "blocked" as const,
		overagePrice: null,
		windowStartAt: new Date(window.window_start_at),
		windowEndAt: new Date(window.window_end_at),
	};
	const scale = feature.credit_scale;
	const reserved = decimalToUnits(
		databaseDecimal(reservation.held_quantity, "reservation held", scale),
		scale,
	);
	const confirmed = decimalToUnits(quantity, scale);
	const sameWindow =
		toIso(window.window_start_at) === toIso(reservation.usage_window_start_at) &&
		toIso(window.window_end_at) === toIso(reservation.usage_window_end_at);
	const otherHolds = await readActiveWindowHolds(
		executor,
		reservation.project_id,
		String(window.id),
		reservation.id,
	);
	if (confirmed > reserved) {
		if (!sameWindow) {
			return await insufficientMeterLimitConfirmation(
				executor,
				reservation,
				meterLimit,
				window.filter_key,
			);
		}
		const used = decimalToUnits(databaseDecimal(window.usage, "window usage", scale), scale);
		const held = decimalToUnits(otherHolds, scale);
		const limit = decimalToUnits(meterLimit.limit, scale);
		if (meterLimit.overagePolicy === "blocked" && used + held + confirmed > limit) {
			return await insufficientMeterLimitConfirmation(
				executor,
				reservation,
				meterLimit,
				window.filter_key,
			);
		}
	}
	const spend = meterLimitSpendDelta(
		meterLimit,
		meterLimitBalance(meterLimit, window.usage, otherHolds),
		quantity,
	);
	const controls = await confirmControlHolds(executor, {
		projectId: reservation.project_id,
		customerId: reservation.customer_id,
		entityId: reservation.entity_id === null ? null : String(reservation.entity_id),
		featureId: featureId(feature),
		featureKey: feature.key,
		usageDelta: quantity,
		...spend,
		reservationId: reservation.id,
	});
	if (controls.denial !== null) {
		return {
			allowed: false,
			reason: "control_limit_exceeded",
			reservationId: reservation.id,
			status: "active",
			usageEventId: null,
			recordedAt: null,
			balance: await readMeterLimitBalance(
				executor,
				reservation.project_id,
				reservation.customer_id,
				reservation.entity_id === null ? null : String(reservation.entity_id),
				window.filter_key,
				meterLimit,
			),
			deductions: [],
			control: controls.denial,
		};
	}
	if (sameWindow) {
		await executeOne(
			executor,
			drizzleSql`
				UPDATE usage_windows
				SET usage = usage + ${quantity}::numeric, updated_at = now()
				WHERE project_id = ${reservation.project_id}
					AND id = ${String(window.id)}::bigint
				RETURNING id
			`,
		);
	}
	const rate = directRate(feature);
	const event = await insertUsageEvent(executor, {
		projectId: reservation.project_id,
		customerId: reservation.customer_id,
		entityId: reservation.entity_id === null ? null : String(reservation.entity_id),
		rate,
		operation: "confirm",
		quantity,
		walletQuantity: quantity,
		occurredAt: context.occurredAt,
		reservationId: reservation.id,
		filterKey: window.filter_key,
		deductions: [],
		metadata: {
			...context.metadata,
			usageWindowId: String(window.id),
			usageWindowStartAt: toIso(reservation.usage_window_start_at),
			usageWindowEndAt: toIso(reservation.usage_window_end_at),
			lateAdjustment: !sameWindow,
		},
	});
	await recordUsageControlEntries(executor, {
		projectId: reservation.project_id,
		usageEventId: event.id,
		usageEventRecordedAt: event.recorded_at,
		entries: controls.entries,
	});
	await executeOne(
		executor,
		drizzleSql`
			UPDATE reservations
			SET
				status = 'confirmed',
				confirmed_quantity = ${quantity}::numeric,
				finalized_at = now(),
				updated_at = now()
			WHERE project_id = ${reservation.project_id}
				AND id = ${reservation.id}
				AND status = 'active'
			RETURNING id
		`,
	);
	await incrementRollup(executor, {
		projectId: reservation.project_id,
		customerId: reservation.customer_id,
		entityId: reservation.entity_id === null ? null : String(reservation.entity_id),
		meterFeatureId: featureId(feature),
		quantity,
		walletQuantity: quantity,
		recordedAt: event.recorded_at,
	});
	return {
		allowed: true,
		reason: "allowed",
		reservationId: reservation.id,
		status: "confirmed",
		usageEventId: event.id,
		recordedAt: toIso(event.recorded_at),
		balance: await readMeterLimitBalance(
			executor,
			reservation.project_id,
			reservation.customer_id,
			reservation.entity_id === null ? null : String(reservation.entity_id),
			window.filter_key,
			meterLimit,
		),
		deductions: [],
	};
}

async function insufficientMeterLimitConfirmation(
	executor: QueryExecutor,
	reservation: ReservationRow,
	meterLimit: MeterLimitDecision,
	filterKey: string | null,
): Promise<FinalizeReservationResult> {
	return {
		allowed: false,
		reason: "insufficient_balance",
		reservationId: reservation.id,
		status: "active",
		usageEventId: null,
		recordedAt: null,
		balance: await readMeterLimitBalance(
			executor,
			reservation.project_id,
			reservation.customer_id,
			reservation.entity_id === null ? null : String(reservation.entity_id),
			filterKey,
			meterLimit,
		),
		deductions: [],
	};
}

/** Reclaim a subject's expired holds before authorization, independent of worker timing. */
export async function expireSubjectReservations(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
): Promise<void> {
	const rows = await executeRows<{ id: string; customer_id: string }>(
		executor,
		drizzleSql`
  SELECT r.id,r.customer_id FROM reservations r JOIN customers c ON c.project_id=r.project_id AND c.id=r.customer_id
  WHERE r.project_id=${projectId} AND c.billing_account_id=${billingAccountId} AND r.status='active' AND r.expires_at<=clock_timestamp()
  ORDER BY r.id FOR UPDATE OF r
 `,
	);
	for (const row of rows) {
		const reservation = await lockReservation(executor, projectId, row.customer_id, row.id);
		if (reservation.status === "active")
			await releaseReservationHolds(executor, reservation, "expired");
	}
}

export async function releaseReservationHolds(
	executor: QueryExecutor,
	reservation: ReservationRow,
	status: "released" | "expired",
): Promise<void> {
	await releaseControlHolds(executor, reservation.project_id, reservation.id);
	const reservationRows = await lockReservationAllocations(
		executor,
		reservation.project_id,
		reservation.id,
	);
	for (const row of reservationRows) {
		const remaining =
			decimalToUnits(
				databaseDecimal(row.held_quantity, "reservation held", reservation.wallet_scale),
				reservation.wallet_scale,
			) -
			decimalToUnits(
				databaseDecimal(row.consumed_quantity, "reservation consumed", reservation.wallet_scale),
				reservation.wallet_scale,
			);
		if (remaining <= 0n) continue;
		await executeOne(
			executor,
			drizzleSql`
				UPDATE balance_allocations
				SET
					held_quantity = held_quantity - ${unitsToDecimal(remaining, reservation.wallet_scale)}::numeric,
					updated_at = now()
				WHERE project_id = ${reservation.project_id}
					AND id = ${String(row.allocation_id)}::bigint
				RETURNING id
			`,
		);
	}
	await executeOne(
		executor,
		drizzleSql`
			UPDATE reservations
			SET status = ${status}, finalized_at = CASE WHEN ${status}='expired' THEN expires_at ELSE clock_timestamp() END, updated_at = now()
			WHERE project_id = ${reservation.project_id}
				AND id = ${reservation.id}
				AND status = 'active'
			RETURNING id
		`,
	);
}

export async function finalizedReservationResult(
	executor: QueryExecutor,
	reservation: ReservationRow,
): Promise<FinalizeReservationResult> {
	const wallet: FeatureRow = {
		id: reservation.wallet_feature_id,
		key: reservation.wallet_feature_key,
		unit: reservation.wallet_unit,
		credit_scale: reservation.wallet_scale,
		kind: "metered",
		meter_kind: "consumable",
		filter_dimensions: [],
	};
	const event =
		reservation.status === "confirmed"
			? await executeOne<{
					id: string;
					recorded_at: Date | string;
					deductions: AllocationDeduction[];
				}>(
					executor,
					drizzleSql`
					SELECT id, recorded_at, deductions
					FROM usage_events
					WHERE project_id = ${reservation.project_id}
						AND reservation_id = ${reservation.id}
						AND operation = 'confirm'
					ORDER BY recorded_at DESC
					LIMIT 1
				`,
				)
			: null;
	let balance: MeteringBalance;
	if (reservation.usage_window_id !== null) {
		const window = await executeOne<{ filter_key: string | null }>(
			executor,
			drizzleSql`
				SELECT filter_key
				FROM usage_windows
				WHERE project_id = ${reservation.project_id}
					AND id = ${String(reservation.usage_window_id)}::bigint
			`,
		);
		const feature: FeatureRow = {
			id: reservation.meter_feature_id,
			key: reservation.meter_feature_key,
			unit: reservation.meter_unit,
			credit_scale: reservation.meter_scale,
			kind: "metered",
			meter_kind: "consumable",
			filter_dimensions: [],
		};
		const meterLimit = (await resolveMeterLimit(
			executor,
			reservation.project_id,
			reservation.customer_id,
			feature,
		)) ?? {
			feature,
			subscriptionId: null,
			planItemId: null,
			limit: "0",
			overagePolicy: "blocked" as const,
			overagePrice: null,
			windowStartAt: new Date(reservation.usage_window_start_at ?? reservation.expires_at),
			windowEndAt: new Date(reservation.usage_window_end_at ?? reservation.expires_at),
		};
		balance = await readMeterLimitBalance(
			executor,
			reservation.project_id,
			reservation.customer_id,
			reservation.entity_id === null ? null : String(reservation.entity_id),
			window?.filter_key ?? null,
			meterLimit,
		);
	} else {
		balance = await readBalance(
			executor,
			reservation.project_id,
			reservation.customer_id,
			wallet,
			reservation.entity_id === null ? null : String(reservation.entity_id),
		);
	}
	return {
		allowed: reservation.status !== "expired",
		reason: reservation.status === "expired" ? "reservation_expired" : "allowed",
		reservationId: reservation.id,
		status: reservation.status,
		usageEventId: event?.id ?? null,
		recordedAt: event === null ? null : toIso(event.recorded_at),
		balance,
		deductions: event?.deductions ?? [],
	};
}

export function featureId(feature: FeatureRow): string {
	return String(feature.id);
}

export function toTimestamp(value: Date | string | null): number | undefined {
	return value === null ? undefined : new Date(value).getTime();
}
