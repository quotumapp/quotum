import { sql as drizzleSql } from "drizzle-orm";
import type { EffectiveControl } from "../../billing/controls";
import { canonicalDecimal, decimalToUnits, unitsToDecimal } from "../../billing/decimal";
import { controlWindowBounds, resolveEffectiveControls } from "./controls-enterprise";
import { executeOne, executeRows } from "./query";
import type { QueryExecutor } from "./types";

export interface ControlDenial {
	kind: "spend_limit" | "usage_limit";
	source: EffectiveControl["source"];
	revision: number;
	policyId: string;
	limitValue: string;
	currentValue: string;
	requestedValue: string;
	remainingValue: string;
}

export interface ControlDeltaInput {
	projectId: string;
	customerId: string;
	entityId: string | null;
	featureId: string;
	featureKey: string;
	usageDelta: string;
	spendMinorDelta?: string;
	currency?: string | null;
	now?: Date;
}

export interface ControlConsumptionEntry {
	controlWindowId: string;
	value: string;
}

export interface ControlConsumptionResult {
	denial: ControlDenial | null;
	entries: ControlConsumptionEntry[];
}

export async function checkControls(
	executor: QueryExecutor,
	input: ControlDeltaInput,
): Promise<ControlDenial | null> {
	return (await evaluateControls(executor, input, "check", null)).denial;
}

export async function consumeControls(
	executor: QueryExecutor,
	input: ControlDeltaInput,
): Promise<ControlConsumptionResult> {
	return await evaluateControls(executor, input, "consume", null);
}

export async function holdControls(
	executor: QueryExecutor,
	input: ControlDeltaInput,
	reservationId: string,
): Promise<ControlDenial | null> {
	return (await evaluateControls(executor, input, "hold", reservationId)).denial;
}

async function evaluateControls(
	executor: QueryExecutor,
	input: ControlDeltaInput,
	mode: "check" | "consume" | "hold",
	reservationId: string | null,
): Promise<ControlConsumptionResult> {
	const now = input.now ?? new Date();
	if (mode !== "check") {
		await lockCustomerControls(executor, input.projectId, input.customerId);
	}
	const controls = (
		await resolveEffectiveControls(executor, {
			projectId: input.projectId,
			customerId: input.customerId,
			entityId: input.entityId,
			now,
		})
	)
		.filter(
			(control) =>
				(control.controlKind === "usage_limit" && control.featureKey === input.featureKey) ||
				(control.controlKind === "spend_limit" &&
					input.currency !== undefined &&
					input.currency !== null &&
					control.currency === input.currency.toUpperCase()),
		)
		.sort((left, right) => (BigInt(left.policyId) < BigInt(right.policyId) ? -1 : 1));
	const locked: Array<{
		control: EffectiveControl;
		windowId: string;
		consumed: string;
		held: string;
		delta: string;
	}> = [];
	for (const control of controls) {
		const delta =
			control.controlKind === "usage_limit"
				? canonicalDecimal(input.usageDelta, "usage control delta", 9)
				: canonicalDecimal(input.spendMinorDelta ?? "0", "spend control delta", 9);
		if (decimalToUnits(delta, 9) === 0n) continue;
		const bounds = controlWindowBounds(control.interval, now);
		let window: {
			id: string | number | bigint;
			consumed_value: unknown;
			held_value: unknown;
		} | null;
		if (mode === "check") {
			window = await executeOne(
				executor,
				drizzleSql`
				SELECT id, consumed_value::text AS consumed_value, held_value::text AS held_value
				FROM control_windows
				WHERE project_id = ${input.projectId}
					AND control_policy_id = ${control.policyId}::bigint
					AND customer_id = ${input.customerId}
					AND window_start_at = ${bounds.start.toISOString()}
			`,
			);
		} else {
			await executeRows(
				executor,
				drizzleSql`
				INSERT INTO control_windows (
					project_id, control_policy_id, customer_id, entity_id, window_start_at, window_end_at
				) VALUES (
					${input.projectId}, ${control.policyId}::bigint, ${input.customerId},
					${input.entityId}::bigint, ${bounds.start.toISOString()}, ${bounds.end?.toISOString() ?? null}
				) ON CONFLICT (project_id, control_policy_id, customer_id, window_start_at) DO NOTHING
			`,
			);
			window = await executeOne(
				executor,
				drizzleSql`
				SELECT id, consumed_value::text AS consumed_value, held_value::text AS held_value
				FROM control_windows
				WHERE project_id = ${input.projectId}
					AND control_policy_id = ${control.policyId}::bigint
					AND customer_id = ${input.customerId}
					AND window_start_at = ${bounds.start.toISOString()}
				FOR UPDATE
			`,
			);
		}
		const consumed = canonicalDecimal(String(window?.consumed_value ?? "0"), "control consumed", 9);
		const held = canonicalDecimal(String(window?.held_value ?? "0"), "control held", 9);
		const limitUnits = decimalToUnits(control.limitValue, 9);
		const consumedUnits = decimalToUnits(consumed, 9);
		const heldUnits = decimalToUnits(held, 9);
		const deltaUnits = decimalToUnits(delta, 9);
		if (consumedUnits + heldUnits + deltaUnits > limitUnits) {
			const remaining = limitUnits - consumedUnits - heldUnits;
			return {
				denial: {
					kind: control.controlKind,
					source: control.source,
					revision: control.revision,
					policyId: control.policyId,
					limitValue: control.limitValue,
					currentValue: unitsToDecimal(consumedUnits + heldUnits, 9),
					requestedValue: delta,
					remainingValue: unitsToDecimal(remaining > 0n ? remaining : 0n, 9),
				},
				entries: [],
			};
		}
		if (window !== null) {
			locked.push({
				control,
				windowId: String(window.id),
				consumed,
				held,
				delta,
			});
		}
	}
	if (mode === "check") return { denial: null, entries: [] };
	const entries: ControlConsumptionEntry[] = [];
	for (const item of locked) {
		await executeOne(
			executor,
			mode === "consume"
				? drizzleSql`
				UPDATE control_windows SET consumed_value = consumed_value + ${item.delta}::numeric,
					updated_at = now()
				WHERE project_id = ${input.projectId} AND id = ${item.windowId}::bigint RETURNING id
			`
				: drizzleSql`
				UPDATE control_windows SET held_value = held_value + ${item.delta}::numeric,
					updated_at = now()
				WHERE project_id = ${input.projectId} AND id = ${item.windowId}::bigint RETURNING id
			`,
		);
		if (mode === "hold" && reservationId !== null) {
			await executeOne(
				executor,
				drizzleSql`
				INSERT INTO reservation_control_holds (
					project_id, reservation_id, control_window_id, held_value
				) VALUES (
					${input.projectId}, ${reservationId}, ${item.windowId}::bigint, ${item.delta}::numeric
				) RETURNING reservation_id
			`,
			);
		}
		if (mode === "consume") {
			entries.push({ controlWindowId: item.windowId, value: item.delta });
		}
	}
	return { denial: null, entries };
}

export async function confirmControlHolds(
	executor: QueryExecutor,
	input: ControlDeltaInput & { reservationId: string },
): Promise<ControlConsumptionResult> {
	await lockCustomerControls(executor, input.projectId, input.customerId);
	const existingHolds = await executeRows<{
		control_window_id: string | number | bigint;
		control_policy_id: string | number | bigint;
		held_value: unknown;
		consumed_value: unknown;
		window_held_value: unknown;
		control_kind: "spend_limit" | "usage_limit";
		currency: string | null;
		limit_value: unknown;
		source_type: EffectiveControl["source"];
		revision: number;
	}>(
		executor,
		drizzleSql`
		SELECT hold.control_window_id, control_window.control_policy_id,
			hold.held_value::text AS held_value, hold.consumed_value::text AS consumed_value,
			control_window.held_value::text AS window_held_value, policy.control_kind, policy.currency,
			policy.limit_value::text AS limit_value, policy.source_type, policy.revision
		FROM reservation_control_holds hold
		JOIN control_windows control_window
			ON control_window.project_id = hold.project_id AND control_window.id = hold.control_window_id
		JOIN control_policies policy
			ON policy.project_id = control_window.project_id AND policy.id = control_window.control_policy_id
		WHERE hold.project_id = ${input.projectId} AND hold.reservation_id = ${input.reservationId}
		ORDER BY hold.control_window_id FOR UPDATE OF control_window, hold
	`,
	);
	const activeControls = (
		await resolveEffectiveControls(executor, {
			projectId: input.projectId,
			customerId: input.customerId,
			entityId: input.entityId,
			now: input.now,
		})
	).filter(
		(control) =>
			(control.controlKind === "usage_limit" && control.featureKey === input.featureKey) ||
			(control.controlKind === "spend_limit" &&
				input.currency !== undefined &&
				input.currency !== null &&
				control.currency === input.currency.toUpperCase()),
	);
	const existingPolicyIds = new Set(existingHolds.map((hold) => String(hold.control_policy_id)));
	for (const control of activeControls) {
		if (existingPolicyIds.has(control.policyId)) continue;
		const bounds = controlWindowBounds(control.interval, input.now ?? new Date());
		await executeRows(
			executor,
			drizzleSql`
			INSERT INTO control_windows (
				project_id, control_policy_id, customer_id, entity_id, window_start_at, window_end_at
			) VALUES (
				${input.projectId}, ${control.policyId}::bigint, ${input.customerId},
				${input.entityId}::bigint, ${bounds.start.toISOString()}, ${bounds.end?.toISOString() ?? null}
			) ON CONFLICT (project_id, control_policy_id, customer_id, window_start_at) DO NOTHING
		`,
		);
		const window = await executeOne<{
			id: string | number | bigint;
			held_value: unknown;
		}>(
			executor,
			drizzleSql`
			SELECT id, held_value::text AS held_value FROM control_windows
			WHERE project_id = ${input.projectId} AND control_policy_id = ${control.policyId}::bigint
				AND customer_id = ${input.customerId} AND window_start_at = ${bounds.start.toISOString()}
			FOR UPDATE
		`,
		);
		if (window === null) throw new Error("Control window could not be locked for confirmation");
		existingHolds.push({
			control_window_id: window.id,
			control_policy_id: control.policyId,
			held_value: "0",
			consumed_value: "0",
			window_held_value: window.held_value,
			control_kind: control.controlKind,
			currency: control.currency,
			limit_value: control.limitValue,
			source_type: control.source,
			revision: control.revision,
		});
	}
	const changes: Array<{ windowId: string; held: string; target: string; hasHold: boolean }> = [];
	for (const hold of existingHolds.sort((left, right) =>
		BigInt(left.control_policy_id) < BigInt(right.control_policy_id) ? -1 : 1,
	)) {
		const target = canonicalDecimal(
			hold.control_kind === "usage_limit" ? input.usageDelta : (input.spendMinorDelta ?? "0"),
			"confirmed control value",
			9,
		);
		const ownHeld = decimalToUnits(String(hold.held_value), 9);
		const totalHeld = decimalToUnits(String(hold.window_held_value), 9);
		const targetUnits = decimalToUnits(target, 9);
		const consumed = await executeOne<{ consumed_value: unknown }>(
			executor,
			drizzleSql`
			SELECT consumed_value::text AS consumed_value FROM control_windows
			WHERE project_id = ${input.projectId} AND id = ${String(hold.control_window_id)}::bigint
		`,
		);
		if (consumed === null) throw new Error("Control window disappeared during confirmation");
		const consumedUnits = decimalToUnits(String(consumed.consumed_value), 9);
		const limitUnits = decimalToUnits(String(hold.limit_value), 9);
		const nextExposure =
			consumedUnits + (totalHeld > ownHeld ? totalHeld - ownHeld : 0n) + targetUnits;
		if (nextExposure > limitUnits) {
			const remaining =
				limitUnits - consumedUnits - (totalHeld > ownHeld ? totalHeld - ownHeld : 0n);
			return {
				denial: {
					kind: hold.control_kind,
					source: hold.source_type,
					revision: hold.revision,
					policyId: String(hold.control_policy_id),
					limitValue: canonicalDecimal(String(hold.limit_value), "control limit", 9),
					currentValue: unitsToDecimal(consumedUnits + totalHeld, 9),
					requestedValue: target,
					remainingValue: unitsToDecimal(remaining > 0n ? remaining : 0n, 9),
				},
				entries: [],
			};
		}
		changes.push({
			windowId: String(hold.control_window_id),
			held: canonicalDecimal(String(hold.held_value), "held control value", 9),
			target,
			hasHold: ownHeld > 0n,
		});
	}
	for (const change of changes) {
		await executeOne(
			executor,
			drizzleSql`
			UPDATE control_windows control_window SET
				held_value = GREATEST(control_window.held_value - ${change.held}::numeric, 0),
				consumed_value = control_window.consumed_value + ${change.target}::numeric,
				updated_at = now()
			WHERE control_window.project_id = ${input.projectId}
				AND control_window.id = ${change.windowId}::bigint
			RETURNING id
		`,
		);
		if (change.hasHold) {
			await executeOne(
				executor,
				drizzleSql`
				UPDATE reservation_control_holds SET consumed_value = ${change.target}::numeric
				WHERE project_id = ${input.projectId} AND reservation_id = ${input.reservationId}
					AND control_window_id = ${change.windowId}::bigint
				RETURNING reservation_id
			`,
			);
		}
	}
	return {
		denial: null,
		entries: changes
			.filter((change) => decimalToUnits(change.target, 9) > 0n)
			.map((change) => ({ controlWindowId: change.windowId, value: change.target })),
	};
}

export async function recordUsageControlEntries(
	executor: QueryExecutor,
	input: {
		projectId: string;
		usageEventId: string;
		usageEventRecordedAt: Date | string;
		entries: ControlConsumptionEntry[];
	},
): Promise<void> {
	for (const entry of input.entries) {
		if (decimalToUnits(entry.value, 9) === 0n) continue;
		await executeRows(
			executor,
			drizzleSql`
			INSERT INTO usage_event_control_entries (
				project_id, usage_event_recorded_at, usage_event_id, control_window_id, value
			) VALUES (
				${input.projectId}, ${new Date(input.usageEventRecordedAt).toISOString()},
				${input.usageEventId}, ${entry.controlWindowId}::bigint, ${entry.value}::numeric
			) ON CONFLICT (project_id, usage_event_recorded_at, usage_event_id, control_window_id)
			DO NOTHING
		`,
		);
	}
}

export async function releaseControlHolds(
	executor: QueryExecutor,
	projectId: string,
	reservationId: string,
): Promise<void> {
	const reservation = await executeOne<{ customer_id: string }>(
		executor,
		drizzleSql`
		SELECT customer_id FROM reservations
		WHERE project_id = ${projectId} AND id = ${reservationId}
	`,
	);
	if (reservation !== null) {
		await lockCustomerControls(executor, projectId, reservation.customer_id);
	}
	const holds = await executeRows<{
		control_window_id: string | number | bigint;
		held_value: unknown;
	}>(
		executor,
		drizzleSql`
		SELECT hold.control_window_id, hold.held_value::text AS held_value
		FROM reservation_control_holds hold
		JOIN control_windows control_window
			ON control_window.project_id = hold.project_id AND control_window.id = hold.control_window_id
		WHERE hold.project_id = ${projectId} AND hold.reservation_id = ${reservationId}
		ORDER BY hold.control_window_id FOR UPDATE OF control_window, hold
	`,
	);
	for (const hold of holds) {
		await executeOne(
			executor,
			drizzleSql`
			UPDATE control_windows SET held_value = GREATEST(held_value - ${String(hold.held_value)}::numeric, 0),
				updated_at = now()
			WHERE project_id = ${projectId} AND id = ${String(hold.control_window_id)}::bigint RETURNING id
		`,
		);
	}
}

export async function correctControlConsumption(
	executor: QueryExecutor,
	input: {
		projectId: string;
		originalUsageEventId: string;
		originalUsageEventRecordedAt: Date | string;
		correctionUsageEventId: string;
		correctionUsageEventRecordedAt: Date | string;
		usageReduction: string;
		spendMinorReduction: string;
		currency: string | null;
	},
): Promise<void> {
	const customers = await executeRows<{ customer_id: string }>(
		executor,
		drizzleSql`
		SELECT DISTINCT control_window.customer_id
		FROM usage_event_control_entries entry
		JOIN control_windows control_window
			ON control_window.project_id = entry.project_id
			AND control_window.id = entry.control_window_id
		WHERE entry.project_id = ${input.projectId}
			AND entry.usage_event_id = ${input.originalUsageEventId}
			AND entry.usage_event_recorded_at = ${new Date(input.originalUsageEventRecordedAt).toISOString()}
		ORDER BY control_window.customer_id
	`,
	);
	for (const customer of customers) {
		await lockCustomerControls(executor, input.projectId, customer.customer_id);
	}
	const entries = await executeRows<{
		control_window_id: string | number | bigint;
		value: unknown;
		consumed_value: unknown;
		control_kind: "usage_limit" | "spend_limit";
		currency: string | null;
	}>(
		executor,
		drizzleSql`
		SELECT entry.control_window_id, entry.value::text AS value,
			control_window.consumed_value::text AS consumed_value, policy.control_kind, policy.currency
		FROM usage_event_control_entries entry
		JOIN control_windows control_window
			ON control_window.project_id = entry.project_id
			AND control_window.id = entry.control_window_id
		JOIN control_policies policy
			ON policy.project_id = control_window.project_id
			AND policy.id = control_window.control_policy_id
		WHERE entry.project_id = ${input.projectId}
			AND entry.usage_event_id = ${input.originalUsageEventId}
			AND entry.usage_event_recorded_at = ${new Date(input.originalUsageEventRecordedAt).toISOString()}
		ORDER BY entry.control_window_id
		FOR UPDATE OF control_window
	`,
	);
	for (const entry of entries) {
		const reductionUnits =
			entry.control_kind === "usage_limit"
				? decimalToUnits(input.usageReduction, 9)
				: entry.currency === input.currency
					? signedUnits(input.spendMinorReduction, 9)
					: 0n;
		if (reductionUnits === 0n) continue;
		const currentUnits = decimalToUnits(String(entry.consumed_value), 9);
		const desiredNext = currentUnits - reductionUnits;
		const nextUnits = desiredNext > 0n ? desiredNext : 0n;
		const appliedDelta = nextUnits - currentUnits;
		if (appliedDelta === 0n) continue;
		const renderedNext = unitsToDecimal(nextUnits, 9);
		const renderedDelta = unitsToDecimal(appliedDelta, 9);
		await executeOne(
			executor,
			drizzleSql`
			UPDATE control_windows SET consumed_value = ${renderedNext}::numeric, updated_at = now()
			WHERE project_id = ${input.projectId}
				AND id = ${String(entry.control_window_id)}::bigint
			RETURNING id
		`,
		);
		await executeRows(
			executor,
			drizzleSql`
			INSERT INTO usage_event_control_entries (
				project_id, usage_event_recorded_at, usage_event_id, control_window_id, value
			) VALUES (
				${input.projectId}, ${new Date(input.correctionUsageEventRecordedAt).toISOString()},
				${input.correctionUsageEventId}, ${String(entry.control_window_id)}::bigint,
				${renderedDelta}::numeric
			) ON CONFLICT (project_id, usage_event_recorded_at, usage_event_id, control_window_id)
			DO NOTHING
		`,
		);
	}
}

export async function recordUsageAlertDelta(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		entityId: string | null;
		featureId: string;
		delta: string;
		now?: Date;
	},
): Promise<void> {
	const deltaUnits = signedUnits(input.delta, 9);
	if (deltaUnits === 0n) return;
	const now = input.now ?? new Date();
	const alerts = await executeRows<{
		id: string | number | bigint;
		entity_id: string | number | bigint | null;
		interval: "month" | "year" | "lifetime";
		threshold_type: "absolute" | "percentage";
		threshold_value: unknown;
		feature_key: string;
	}>(
		executor,
		drizzleSql`
		SELECT alert.id, alert.entity_id, alert.interval, alert.threshold_type,
			alert.threshold_value::text AS threshold_value, feature.key AS feature_key
		FROM usage_alerts alert
		JOIN features feature ON feature.project_id = alert.project_id AND feature.id = alert.feature_id
		WHERE alert.project_id = ${input.projectId} AND alert.customer_id = ${input.customerId}
			AND alert.feature_id = ${input.featureId}::bigint AND alert.active = true
			AND (alert.entity_id IS NULL OR alert.entity_id = ${input.entityId}::bigint)
		ORDER BY alert.id
	`,
	);
	for (const alert of alerts) {
		const bounds = controlWindowBounds(alert.interval, now);
		let threshold = canonicalDecimal(String(alert.threshold_value), "alert threshold", 9);
		if (alert.threshold_type === "percentage") {
			const controls = await resolveEffectiveControls(executor, {
				projectId: input.projectId,
				customerId: input.customerId,
				entityId: alert.entity_id === null ? null : String(alert.entity_id),
				now,
			});
			const limit = controls.find(
				(control) =>
					control.controlKind === "usage_limit" && control.featureKey === alert.feature_key,
			);
			if (limit === undefined) continue;
			threshold = unitsToDecimal(
				(decimalToUnits(limit.limitValue, 9) * decimalToUnits(threshold, 9)) / (100n * 10n ** 9n),
				9,
			);
		}
		await executeRows(
			executor,
			drizzleSql`
			INSERT INTO usage_alert_states (
				project_id, alert_id, window_start_at, window_end_at, threshold_value
			) VALUES (
				${input.projectId}, ${String(alert.id)}::bigint, ${bounds.start.toISOString()},
				${bounds.end?.toISOString() ?? null}, ${threshold}::numeric
			) ON CONFLICT (project_id, alert_id) DO NOTHING
		`,
		);
		const state = await executeOne<{
			window_start_at: Date | string;
			current_value: unknown;
			threshold_value: unknown;
			crossed: boolean;
			crossing_sequence: number;
		}>(
			executor,
			drizzleSql`
			SELECT window_start_at, current_value::text AS current_value,
				threshold_value::text AS threshold_value, crossed, crossing_sequence
			FROM usage_alert_states
			WHERE project_id = ${input.projectId} AND alert_id = ${String(alert.id)}::bigint
			FOR UPDATE
		`,
		);
		if (state === null) continue;
		const sameWindow = new Date(state.window_start_at).getTime() === bounds.start.getTime();
		const currentUnits = sameWindow ? signedUnits(String(state.current_value), 9) : 0n;
		const nextUnits = currentUnits + deltaUnits > 0n ? currentUnits + deltaUnits : 0n;
		const thresholdUnits = decimalToUnits(threshold, 9);
		const nextCrossed = nextUnits >= thresholdUnits;
		const priorCrossed = sameWindow && state.crossed;
		let sequence = sameWindow ? state.crossing_sequence : 0;
		let eventType: "threshold_crossed" | "threshold_rearmed" | null = null;
		if (!priorCrossed && nextCrossed) {
			sequence += 1;
			eventType = "threshold_crossed";
		} else if (priorCrossed && !nextCrossed) {
			eventType = "threshold_rearmed";
		}
		await executeOne(
			executor,
			drizzleSql`
			UPDATE usage_alert_states SET window_start_at = ${bounds.start.toISOString()},
				window_end_at = ${bounds.end?.toISOString() ?? null}, current_value = ${unitsToDecimal(nextUnits, 9)}::numeric,
				threshold_value = ${threshold}::numeric, crossed = ${nextCrossed}, crossing_sequence = ${sequence},
				last_evaluated_at = now()
			WHERE project_id = ${input.projectId} AND alert_id = ${String(alert.id)}::bigint RETURNING alert_id
		`,
		);
		if (eventType !== null) {
			await executeRows(
				executor,
				drizzleSql`
				INSERT INTO usage_alert_events (
					project_id, alert_id, customer_id, entity_id, feature_id, window_start_at,
					crossing_sequence, current_value, threshold_value, event_type
				) VALUES (
					${input.projectId}, ${String(alert.id)}::bigint, ${input.customerId},
					${alert.entity_id === null ? null : String(alert.entity_id)}::bigint,
					${input.featureId}::bigint, ${bounds.start.toISOString()}, ${sequence},
					${unitsToDecimal(nextUnits, 9)}::numeric, ${threshold}::numeric, ${eventType}
				) ON CONFLICT DO NOTHING
			`,
			);
		}
	}
}

export async function scheduleAutoTopupIfNeeded(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		entityId: string | null;
		featureId: string;
		availableQuantity: string;
		triggerKey: string;
	},
): Promise<void> {
	const policy = await executeOne<{
		id: string | number | bigint;
		provider: "apple" | "google" | "stripe";
		threshold_quantity: unknown;
		cooldown_seconds: number;
		limit_interval_seconds: number;
		max_purchases_per_interval: number;
		max_spend_minor: number | string | null;
		amount_minor: number | string | null;
		currency: string | null;
		store_product_id: string;
	}>(
		executor,
		drizzleSql`
		SELECT policy.id, policy.provider, policy.threshold_quantity::text AS threshold_quantity,
			policy.cooldown_seconds, policy.limit_interval_seconds, policy.max_purchases_per_interval,
			policy.max_spend_minor, store.price_amount AS amount_minor, store.currency,
			store.id AS store_product_id
		FROM auto_topup_policies policy
		JOIN provider_topup_bindings binding ON binding.project_id = policy.project_id
			AND binding.topup_option_id = policy.topup_option_id AND binding.provider = policy.provider
			AND binding.status = 'published'
		JOIN store_products store ON store.project_id = binding.project_id AND store.id = binding.store_product_id
		WHERE policy.project_id = ${input.projectId} AND policy.customer_id = ${input.customerId}
			AND policy.feature_id = ${input.featureId}::bigint AND policy.active = true
			AND policy.entity_id IS NOT DISTINCT FROM ${input.entityId}::bigint
		LIMIT 1
	`,
	);
	if (policy === null) return;
	if (
		decimalToUnits(input.availableQuantity, 9) >
		decimalToUnits(String(policy.threshold_quantity), 9)
	)
		return;
	const state = await executeOne<{
		status: "ready" | "cooldown" | "suspended";
		interval_started_at: Date | string;
		purchases_in_interval: number;
		spend_minor_in_interval: number | string;
		cooldown_until: Date | string | null;
	}>(
		executor,
		drizzleSql`
		SELECT status, interval_started_at, purchases_in_interval, spend_minor_in_interval, cooldown_until
		FROM auto_topup_states WHERE project_id = ${input.projectId} AND policy_id = ${String(policy.id)}::bigint
		FOR UPDATE
	`,
	);
	if (state === null || state.status === "suspended") return;
	const now = new Date();
	let purchases = state.purchases_in_interval;
	let spend = Number(state.spend_minor_in_interval);
	if (
		new Date(state.interval_started_at).getTime() + policy.limit_interval_seconds * 1000 <=
		now.getTime()
	) {
		purchases = 0;
		spend = 0;
		await executeOne(
			executor,
			drizzleSql`
			UPDATE auto_topup_states SET interval_started_at = now(), purchases_in_interval = 0,
				spend_minor_in_interval = 0, status = 'ready', cooldown_until = NULL, updated_at = now()
			WHERE project_id = ${input.projectId} AND policy_id = ${String(policy.id)}::bigint RETURNING policy_id
		`,
		);
	}
	if (state.cooldown_until !== null && new Date(state.cooldown_until) > now) return;
	if (purchases >= policy.max_purchases_per_interval) return;
	const amount = Number(policy.amount_minor ?? 0);
	if (
		policy.provider === "stripe" &&
		(!Number.isSafeInteger(amount) || amount <= 0 || policy.currency === null)
	)
		return;
	if (policy.max_spend_minor !== null && spend + amount > Number(policy.max_spend_minor)) return;
	const pending = await executeOne<{ pending: boolean }>(
		executor,
		drizzleSql`
		SELECT EXISTS (
			SELECT 1 FROM auto_topup_jobs WHERE project_id = ${input.projectId}
				AND policy_id = ${String(policy.id)}::bigint AND status IN ('pending', 'processing')
		) AS pending
	`,
	);
	if (pending?.pending === true) return;
	const supported = policy.provider === "stripe";
	await executeOne(
		executor,
		drizzleSql`
		INSERT INTO auto_topup_jobs (
			project_id, policy_id, customer_id, store_product_id, trigger_key, provider, status,
			amount_minor, currency, last_error, completed_at
		) VALUES (
			${input.projectId}, ${String(policy.id)}::bigint, ${input.customerId},
			${policy.store_product_id}, ${input.triggerKey},
			${policy.provider}, ${supported ? "pending" : "provider_action_required"},
			${amount}, ${policy.currency?.toUpperCase() ?? null},
			${supported ? null : "Provider-native purchase action is required"},
			${supported ? null : now.toISOString()}
		) ON CONFLICT (project_id, policy_id, trigger_key) DO NOTHING RETURNING id
	`,
	);
	await executeOne(
		executor,
		drizzleSql`
		UPDATE auto_topup_states SET status = 'cooldown',
			cooldown_until = now() + (${policy.cooldown_seconds}::text || ' seconds')::interval,
			updated_at = now()
		WHERE project_id = ${input.projectId} AND policy_id = ${String(policy.id)}::bigint RETURNING policy_id
	`,
	);
}

function signedUnits(value: string, scale: number): bigint {
	return value.startsWith("-")
		? -decimalToUnits(value.slice(1), scale)
		: decimalToUnits(value, scale);
}

async function lockCustomerControls(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
): Promise<void> {
	await executeRows(
		executor,
		drizzleSql`
			SELECT pg_advisory_xact_lock(
				hashtextextended(${`billing-controls:${projectId}:${customerId}`}, 0)
			)
		`,
	);
}
