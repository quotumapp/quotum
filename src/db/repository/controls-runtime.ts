import { sql as drizzleSql } from "drizzle-orm";
import type { ControlInterval, EffectiveControl } from "../../billing/controls";
import {
	canonicalDecimal,
	canonicalSignedDecimal,
	decimalToUnits,
	signedDecimalToUnits,
	unitsToDecimal,
} from "../../billing/decimal";
import type { BillingProvider } from "../../billing/types";
import { type ProviderCapabilityLookup, providersImplementing } from "../../providers/capabilities";
import {
	carriedControlConsumptionSql,
	controlIdentityHeldSql,
	controlIdentityWindowsSql,
	controlWindowBounds,
	readControlClock,
	resolveEffectiveControls,
	sameControlWindow,
} from "./controls-enterprise";
import { executeOne, executeRows, jsonb } from "./query";
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
	input: Omit<ControlDeltaInput, "customerId"> & { customerId: string | null },
	mode: "check" | "consume" | "hold",
	reservationId: string | null,
): Promise<ControlConsumptionResult> {
	const now = await readControlClock(executor, input.now);
	const customerId = input.customerId;
	if (customerId === null && mode !== "check") {
		throw new Error("Only a check evaluates controls for an account that is not recorded");
	}
	// The customer lock is issued first, so it executes before the pipelined control read.
	const [, effectiveControls] = await Promise.all([
		mode === "check" || customerId === null
			? Promise.resolve()
			: lockCustomerControls(executor, input.projectId, customerId),
		resolveEffectiveControls(executor, {
			projectId: input.projectId,
			customerId,
			entityId: input.entityId,
			now,
		}),
	]);
	const controls = effectiveControls
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
		// Spend deltas are signed: volume pricing can lower the total charge at a tier boundary. A
		// falling charge is never denied; only a consume records the lower exposure.
		const delta =
			control.controlKind === "usage_limit"
				? canonicalDecimal(input.usageDelta, "usage control delta", 9)
				: canonicalSignedDecimal(input.spendMinorDelta ?? "0", "spend control delta", 9);
		const deltaUnits = signedDecimalToUnits(delta, 9);
		if (deltaUnits <= 0n && mode !== "consume") continue;
		const bounds = controlWindowBounds(control.interval, control.intervalCount, now);
		let window: {
			id: string | number | bigint;
			consumed_value: unknown;
			held_value: unknown;
		} | null;
		const scope = {
			projectId: input.projectId,
			policyId: control.policyId,
			customerId: input.customerId,
			windowStartAt: bounds.start.toISOString(),
			windowEndAt: bounds.end?.toISOString() ?? null,
		};
		if (mode === "check") {
			// A check reads what the window counted, carried over from a replaced control if this one
			// has no window yet, as a write would record it, and the open holds in the window
			// wherever they were placed.
			window = await executeOne(
				executor,
				drizzleSql`
				SELECT own.id,
					GREATEST(COALESCE(own.consumed_value, 0), ${carriedControlConsumptionSql(scope)})::text
						AS consumed_value,
					COALESCE((
						SELECT sum(hold.held_value)
						FROM reservation_control_holds hold
						JOIN reservations r ON r.project_id = hold.project_id AND r.id = hold.reservation_id
						WHERE hold.project_id = ${input.projectId}
							AND hold.control_window_id IN ${controlIdentityWindowsSql(scope)}
							AND r.status = 'active'
							AND r.expires_at > clock_timestamp()
					), 0)::text AS held_value
				FROM (SELECT 1) AS single
				LEFT JOIN control_windows own ON own.project_id = ${input.projectId}
					AND own.control_policy_id = ${control.policyId}::bigint
					AND own.customer_id = ${input.customerId}
					AND own.window_start_at = ${bounds.start.toISOString()}
			`,
			);
		} else {
			// A new window starts from what a replaced control counted in it; a window that fell
			// behind a control which counted in its place catches up.
			await executeRows(
				executor,
				drizzleSql`
				INSERT INTO control_windows (
					project_id, control_policy_id, customer_id, entity_id, window_start_at, window_end_at,
					consumed_value
				) VALUES (
					${input.projectId}, ${control.policyId}::bigint, ${input.customerId},
					${input.entityId}::bigint, ${bounds.start.toISOString()}, ${bounds.end?.toISOString() ?? null},
					${carriedControlConsumptionSql(scope)}
				) ON CONFLICT (project_id, control_policy_id, customer_id, window_start_at) DO UPDATE
				SET consumed_value = GREATEST(control_windows.consumed_value, EXCLUDED.consumed_value)
				WHERE EXCLUDED.consumed_value > control_windows.consumed_value
			`,
			);
			window = await executeOne(
				executor,
				drizzleSql`
				SELECT id, consumed_value::text AS consumed_value,
					${controlIdentityHeldSql(scope)}::text AS held_value
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
		if (deltaUnits > 0n && consumedUnits + heldUnits + deltaUnits > limitUnits) {
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
		if (mode === "consume") {
			// Exposure never drops below zero: a falling charge only reverses what this window holds.
			const updated = await executeOne<{ consumed_value: unknown }>(
				executor,
				drizzleSql`
				UPDATE control_windows
				SET consumed_value = GREATEST(consumed_value + ${item.delta}::numeric, 0),
					updated_at = now()
				WHERE project_id = ${input.projectId} AND id = ${item.windowId}::bigint
				RETURNING consumed_value::text AS consumed_value
			`,
			);
			if (updated === null) throw new Error("Control window disappeared during consumption");
			const applied =
				decimalToUnits(String(updated.consumed_value), 9) - decimalToUnits(item.consumed, 9);
			if (applied !== 0n || item.control.controlKind === "spend_limit") {
				entries.push({ controlWindowId: item.windowId, value: unitsToDecimal(applied, 9) });
			}
			continue;
		}
		await executeOne(
			executor,
			drizzleSql`
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
	}
	return { denial: null, entries };
}

interface ConfirmedHoldRow {
	control_window_id: string | number | bigint;
	control_policy_id: string | number | bigint;
	held_value: unknown;
	window_start_at: Date | string;
	window_end_at: Date | string | null;
	control_kind: "spend_limit" | "usage_limit";
	feature_id: string | number | bigint | null;
	currency: string | null;
	entity_id: string | number | bigint | null;
	limit_value: unknown;
	source_type: EffectiveControl["source"];
	revision: number;
}

interface ControlIdentityRow {
	control_kind: "spend_limit" | "usage_limit";
	feature_id: string | number | bigint | null;
	currency: string | null;
	entity_id: string | number | bigint | null;
}

/** Controls of one kind, feature, currency and entity scope count the same usage. */
function controlIdentityKey(row: ControlIdentityRow): string {
	return [
		row.control_kind,
		String(row.feature_id ?? ""),
		row.currency ?? "",
		String(row.entity_id ?? ""),
	].join(":");
}

function sameInstant(left: Date | string | null, right: Date | null): boolean {
	if (left === null || right === null) return left === null && right === null;
	return new Date(left).getTime() === right.getTime();
}

/**
 * One settlement of a confirmation: the window the confirmed value is counted in, the holds it
 * settles and the control whose limit it must fit.
 */
interface ConfirmationGroup {
	windowId: string;
	policyId: string;
	windowStartAt: string;
	windowEndAt: string | null;
	kind: "spend_limit" | "usage_limit";
	source: EffectiveControl["source"];
	revision: number;
	limitValue: string;
	holds: ConfirmedHoldRow[];
}

export async function confirmControlHolds(
	executor: QueryExecutor,
	input: ControlDeltaInput & { reservationId: string },
): Promise<ControlConsumptionResult> {
	const now = await readControlClock(executor, input.now);
	// The customer lock is issued first; the hold and control reads behind it are pipelined.
	const [, existingHolds, resolvedControls] = await Promise.all([
		lockCustomerControls(executor, input.projectId, input.customerId),
		executeRows<ConfirmedHoldRow>(
			executor,
			drizzleSql`
		SELECT hold.control_window_id, control_window.control_policy_id,
			hold.held_value::text AS held_value, control_window.window_start_at,
			control_window.window_end_at, policy.control_kind, policy.feature_id, policy.currency,
			policy.entity_id, policy.limit_value::text AS limit_value, policy.source_type, policy.revision
		FROM reservation_control_holds hold
		JOIN control_windows control_window
			ON control_window.project_id = hold.project_id AND control_window.id = hold.control_window_id
		JOIN control_policies policy
			ON policy.project_id = control_window.project_id AND policy.id = control_window.control_policy_id
		WHERE hold.project_id = ${input.projectId} AND hold.reservation_id = ${input.reservationId}
		ORDER BY hold.control_window_id FOR UPDATE OF control_window, hold
	`,
		),
		resolveEffectiveControls(executor, {
			projectId: input.projectId,
			customerId: input.customerId,
			entityId: input.entityId,
			now: now,
		}),
	]);
	const activeControls = resolvedControls
		.filter(
			(control) =>
				(control.controlKind === "usage_limit" && control.featureKey === input.featureKey) ||
				(control.controlKind === "spend_limit" &&
					input.currency !== undefined &&
					input.currency !== null &&
					control.currency === input.currency.toUpperCase()),
		)
		.sort((left, right) => (BigInt(left.policyId) < BigInt(right.policyId) ? -1 : 1));
	const activeIdentities =
		activeControls.length === 0
			? []
			: await executeRows<ControlIdentityRow & { id: string | number | bigint }>(
					executor,
					drizzleSql`
			SELECT id, control_kind, feature_id, currency, entity_id FROM control_policies
			WHERE project_id = ${input.projectId}
				AND id IN (SELECT jsonb_array_elements_text(${jsonb(
					activeControls.map((control) => control.policyId),
				)})::bigint)
		`,
				);
	const identityOf = new Map(
		activeIdentities.map((row) => [String(row.id), controlIdentityKey(row)] as const),
	);
	// Whatever window a hold was placed in, the active control of its kind, feature, currency and
	// scope settles it once: in that control's current window when the hold is in the same window
	// of usage, or else in the window that held it. A control the reservation holds nothing under
	// still counts the confirmed value.
	const heldIdentities = new Set(existingHolds.map((hold) => controlIdentityKey(hold)));
	const adopted = new Set<ConfirmedHoldRow>();
	const groups: ConfirmationGroup[] = [];
	for (const control of activeControls) {
		const identity = identityOf.get(control.policyId);
		const bounds = controlWindowBounds(control.interval, control.intervalCount, now);
		const holds = existingHolds.filter(
			(hold) =>
				controlIdentityKey(hold) === identity &&
				sameInstant(hold.window_start_at, bounds.start) &&
				sameInstant(hold.window_end_at, bounds.end),
		);
		if (holds.length === 0 && identity !== undefined && heldIdentities.has(identity)) continue;
		const windowStartAt = bounds.start.toISOString();
		const windowEndAt = bounds.end?.toISOString() ?? null;
		await executeRows(
			executor,
			drizzleSql`
			INSERT INTO control_windows (
				project_id, control_policy_id, customer_id, entity_id, window_start_at, window_end_at,
				consumed_value
			) VALUES (
				${input.projectId}, ${control.policyId}::bigint, ${input.customerId},
				${input.entityId}::bigint, ${windowStartAt}, ${windowEndAt},
				${carriedControlConsumptionSql({
					projectId: input.projectId,
					policyId: control.policyId,
					customerId: input.customerId,
					windowStartAt,
					windowEndAt,
				})}
			) ON CONFLICT (project_id, control_policy_id, customer_id, window_start_at) DO UPDATE
			SET consumed_value = GREATEST(control_windows.consumed_value, EXCLUDED.consumed_value)
			WHERE EXCLUDED.consumed_value > control_windows.consumed_value
		`,
		);
		const window = await executeOne<{ id: string | number | bigint }>(
			executor,
			drizzleSql`
			SELECT id FROM control_windows
			WHERE project_id = ${input.projectId} AND control_policy_id = ${control.policyId}::bigint
				AND customer_id = ${input.customerId} AND window_start_at = ${windowStartAt}
			FOR UPDATE
		`,
		);
		if (window === null) throw new Error("Control window could not be locked for confirmation");
		for (const hold of holds) adopted.add(hold);
		groups.push({
			windowId: String(window.id),
			policyId: control.policyId,
			windowStartAt,
			windowEndAt,
			kind: control.controlKind,
			source: control.source,
			revision: control.revision,
			limitValue: control.limitValue,
			holds,
		});
	}
	for (const hold of existingHolds) {
		if (adopted.has(hold)) continue;
		groups.push({
			windowId: String(hold.control_window_id),
			policyId: String(hold.control_policy_id),
			windowStartAt: new Date(hold.window_start_at).toISOString(),
			windowEndAt: hold.window_end_at === null ? null : new Date(hold.window_end_at).toISOString(),
			kind: hold.control_kind,
			source: hold.source_type,
			revision: hold.revision,
			limitValue: canonicalDecimal(String(hold.limit_value), "control limit", 9),
			holds: [hold],
		});
	}
	const changes: Array<{
		group: ConfirmationGroup;
		target: string;
		consumed: bigint;
	}> = [];
	for (const group of groups.sort((left, right) =>
		BigInt(left.policyId) < BigInt(right.policyId) ? -1 : 1,
	)) {
		// A confirmed spend target is signed for the same reason as a consume delta.
		const target =
			group.kind === "usage_limit"
				? canonicalDecimal(input.usageDelta, "confirmed control value", 9)
				: canonicalSignedDecimal(input.spendMinorDelta ?? "0", "confirmed control value", 9);
		const ownHeld = group.holds.reduce(
			(sum, hold) => sum + decimalToUnits(String(hold.held_value), 9),
			0n,
		);
		const targetUnits = signedDecimalToUnits(target, 9);
		const exposure = await executeOne<{ consumed_value: unknown; held_value: unknown }>(
			executor,
			drizzleSql`
			SELECT consumed_value::text AS consumed_value, ${controlIdentityHeldSql({
				projectId: input.projectId,
				policyId: group.policyId,
				customerId: input.customerId,
				windowStartAt: group.windowStartAt,
				windowEndAt: group.windowEndAt,
			})}::text AS held_value
			FROM control_windows
			WHERE project_id = ${input.projectId} AND id = ${group.windowId}::bigint
		`,
		);
		if (exposure === null) throw new Error("Control window disappeared during confirmation");
		const consumedUnits = decimalToUnits(String(exposure.consumed_value), 9);
		const totalHeld = decimalToUnits(String(exposure.held_value), 9);
		const otherHeld = totalHeld > ownHeld ? totalHeld - ownHeld : 0n;
		const limitUnits = decimalToUnits(group.limitValue, 9);
		if (targetUnits > 0n && consumedUnits + otherHeld + targetUnits > limitUnits) {
			const remaining = limitUnits - consumedUnits - otherHeld;
			return {
				denial: {
					kind: group.kind,
					source: group.source,
					revision: group.revision,
					policyId: group.policyId,
					limitValue: group.limitValue,
					currentValue: unitsToDecimal(consumedUnits + totalHeld, 9),
					requestedValue: target,
					remainingValue: unitsToDecimal(remaining > 0n ? remaining : 0n, 9),
				},
				entries: [],
			};
		}
		changes.push({ group, target, consumed: consumedUnits });
	}
	const entries: ControlConsumptionEntry[] = [];
	for (const { group, target, consumed } of changes) {
		for (const hold of group.holds) {
			await executeOne(
				executor,
				drizzleSql`
				UPDATE control_windows
				SET held_value = GREATEST(held_value - ${String(hold.held_value)}::numeric, 0),
					updated_at = now()
				WHERE project_id = ${input.projectId} AND id = ${String(hold.control_window_id)}::bigint
				RETURNING id
			`,
			);
		}
		const updated = await executeOne<{ consumed_value: unknown }>(
			executor,
			drizzleSql`
			UPDATE control_windows control_window SET
				consumed_value = GREATEST(control_window.consumed_value + ${target}::numeric, 0),
				updated_at = now()
			WHERE control_window.project_id = ${input.projectId}
				AND control_window.id = ${group.windowId}::bigint
			RETURNING consumed_value::text AS consumed_value
		`,
		);
		if (updated === null) throw new Error("Control window disappeared during confirmation");
		const applied = decimalToUnits(String(updated.consumed_value), 9) - consumed;
		// Each hold row records what it turned into; a falling charge converts nothing.
		for (const [index, hold] of group.holds.entries()) {
			await executeOne(
				executor,
				drizzleSql`
				UPDATE reservation_control_holds
				SET consumed_value = ${unitsToDecimal(index === 0 && applied > 0n ? applied : 0n, 9)}::numeric
				WHERE project_id = ${input.projectId} AND reservation_id = ${input.reservationId}
					AND control_window_id = ${String(hold.control_window_id)}::bigint
				RETURNING reservation_id
			`,
			);
		}
		if (applied !== 0n || group.kind === "spend_limit") {
			entries.push({ controlWindowId: group.windowId, value: unitsToDecimal(applied, 9) });
		}
	}
	return { denial: null, entries };
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
		// Keep even a zero spend delta: after later usage, correcting this event can change the
		// total charge. The event must retain its control-window association for that rerating.
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
	// A replaced control's window and its replacement's count the same usage: the replacement
	// carried what the replaced one had counted. A correction lowers every window that counts it, so
	// the highest of them stays the window's usage. Each set of such windows is corrected once.
	const windows = await executeRows<{
		entry_window_id: string | number | bigint;
		control_window_id: string | number | bigint;
		consumed_value: unknown;
		control_kind: "usage_limit" | "spend_limit";
		currency: string | null;
	}>(
		executor,
		drizzleSql`
		SELECT entry.control_window_id AS entry_window_id, identity_window.id AS control_window_id,
			identity_window.consumed_value::text AS consumed_value, policy.control_kind, policy.currency
		FROM usage_event_control_entries entry
		JOIN control_windows control_window
			ON control_window.project_id = entry.project_id
			AND control_window.id = entry.control_window_id
		JOIN control_policies policy
			ON policy.project_id = control_window.project_id
			AND policy.id = control_window.control_policy_id
		JOIN control_policies identity_policy
			ON identity_policy.project_id = policy.project_id
			AND identity_policy.control_kind = policy.control_kind
			AND identity_policy.feature_id IS NOT DISTINCT FROM policy.feature_id
			AND identity_policy.currency IS NOT DISTINCT FROM policy.currency
			AND identity_policy.entity_id IS NOT DISTINCT FROM policy.entity_id
		JOIN control_windows identity_window
			ON identity_window.project_id = identity_policy.project_id
			AND identity_window.control_policy_id = identity_policy.id
			AND identity_window.customer_id = control_window.customer_id
			AND identity_window.window_start_at = control_window.window_start_at
			AND identity_window.window_end_at IS NOT DISTINCT FROM control_window.window_end_at
		WHERE entry.project_id = ${input.projectId}
			AND entry.usage_event_id = ${input.originalUsageEventId}
			AND entry.usage_event_recorded_at = ${new Date(input.originalUsageEventRecordedAt).toISOString()}
		ORDER BY identity_window.id, entry.control_window_id
		FOR UPDATE OF identity_window
	`,
	);
	const corrected = new Set<string>();
	for (const window of windows) {
		const windowId = String(window.control_window_id);
		if (corrected.has(windowId)) continue;
		corrected.add(windowId);
		const reductionUnits =
			window.control_kind === "usage_limit"
				? decimalToUnits(input.usageReduction, 9)
				: window.currency === input.currency
					? signedDecimalToUnits(input.spendMinorReduction, 9)
					: 0n;
		if (reductionUnits === 0n) continue;
		const currentUnits = decimalToUnits(String(window.consumed_value), 9);
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
			WHERE project_id = ${input.projectId} AND id = ${windowId}::bigint
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
				${input.correctionUsageEventId}, ${windowId}::bigint, ${renderedDelta}::numeric
			) ON CONFLICT (project_id, usage_event_recorded_at, usage_event_id, control_window_id)
			DO NOTHING
		`,
		);
	}
}

export interface UsageAlertRow {
	id: string | number | bigint;
	entity_id: string | number | bigint | null;
	interval: ControlInterval;
	interval_count: number;
	threshold_type: "absolute" | "percentage";
	threshold_value: unknown;
	feature_key: string;
}

/** Active alerts for one customer and feature; callers may prefetch this in a pipelined batch. */
export function queryUsageAlerts(
	executor: QueryExecutor,
	input: { projectId: string; customerId: string; entityId: string | null; featureId: string },
): Promise<UsageAlertRow[]> {
	return executeRows<UsageAlertRow>(
		executor,
		drizzleSql`
		SELECT alert.id, alert.entity_id, alert.interval, alert.interval_count, alert.threshold_type,
			alert.threshold_value::text AS threshold_value, feature.key AS feature_key
		FROM usage_alerts alert
		JOIN features feature ON feature.project_id = alert.project_id AND feature.id = alert.feature_id
		WHERE alert.project_id = ${input.projectId} AND alert.customer_id = ${input.customerId}
			AND alert.feature_id = ${input.featureId}::bigint AND alert.active = true
			AND (alert.entity_id IS NULL OR alert.entity_id = ${input.entityId}::bigint)
		ORDER BY alert.id
	`,
	);
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
		alerts?: readonly UsageAlertRow[];
		/**
		 * A correction passes when the usage it corrects was recorded: the delta counts in that
		 * usage's window, and only while the alert still counts that window.
		 */
		correctsRecordedAt?: Date | string;
	},
): Promise<void> {
	const deltaUnits = signedDecimalToUnits(input.delta, 9);
	if (deltaUnits === 0n) return;
	const now = input.now ?? new Date();
	const correcting = input.correctsRecordedAt !== undefined;
	const countedAt =
		input.correctsRecordedAt === undefined ? now : new Date(input.correctsRecordedAt);
	const alerts = input.alerts ?? (await queryUsageAlerts(executor, input));
	for (const alert of alerts) {
		const bounds = controlWindowBounds(alert.interval, alert.interval_count, countedAt);
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
					control.controlKind === "usage_limit" &&
					control.featureKey === alert.feature_key &&
					sameControlWindow(
						control,
						alert.interval,
						alert.interval === "lifetime"
							? null
							: { unit: alert.interval, count: alert.interval_count },
					),
			);
			if (limit === undefined) continue;
			threshold = unitsToDecimal(
				(decimalToUnits(limit.limitValue, 9) * decimalToUnits(threshold, 9)) / (100n * 10n ** 9n),
				9,
			);
		}
		if (!correcting) {
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
		}
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
		// The alert keeps no count for a window it has left, so a correction of its usage changes nothing.
		if (correcting && !sameWindow) continue;
		const currentUnits = sameWindow ? signedDecimalToUnits(String(state.current_value), 9) : 0n;
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

/** Providers Quotum can charge on its own, read from their declarations: `{stripe}` today. */
const declaredAutomaticTopupProviders: ReadonlySet<BillingProvider> = new Set(
	providersImplementing("topup.automatic"),
);

/** The declared set, resolved once for the consume path and re-derived only for an injection. */
function automaticTopupProviders(
	capabilities: ProviderCapabilityLookup | undefined,
): ReadonlySet<BillingProvider> {
	return capabilities === undefined
		? declaredAutomaticTopupProviders
		: new Set(providersImplementing("topup.automatic", capabilities));
}

export interface AutoTopupPolicyRow {
	id: string | number | bigint;
	/** Null for the account's policy, which covers the shared pool. */
	entity_id: string | number | bigint | null;
	provider: BillingProvider;
	provider_account_id: string | null;
	threshold_quantity: unknown;
	cooldown_seconds: number;
	limit_interval_seconds: number;
	max_purchases_per_interval: number;
	max_spend_minor: number | string | null;
	amount_minor: number | string | null;
	currency: string | null;
	store_product_id: string;
}

/**
 * The active automatic top-up policies a usage write on one wallet feature can trigger: the
 * account's and, for usage tagged with an entity, that entity's. Safe to prefetch; in id order,
 * the order their states are locked.
 */
export function queryAutoTopupPolicies(
	executor: QueryExecutor,
	input: { projectId: string; customerId: string; entityId: string | null; featureId: string },
): Promise<AutoTopupPolicyRow[]> {
	return executeRows<AutoTopupPolicyRow>(
		executor,
		drizzleSql`
		SELECT policy.id, policy.entity_id, policy.provider,
			(
				SELECT provider_customer.provider_account_id
				FROM provider_customers provider_customer
				WHERE provider_customer.project_id = policy.project_id
					AND provider_customer.customer_id = policy.customer_id
					AND provider_customer.provider = policy.provider
				ORDER BY provider_customer.created_at, provider_customer.id
				LIMIT 1
			) AS provider_account_id,
			policy.threshold_quantity::text AS threshold_quantity,
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
			AND (policy.entity_id IS NULL OR policy.entity_id = ${input.entityId}::bigint)
		ORDER BY policy.id
	`,
	);
}

/** Schedules a top-up for each triggered policy, one at a time so their states lock in order. */
export async function scheduleAutoTopups(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		triggerKey: string;
		triggers: ReadonlyArray<{ policy: AutoTopupPolicyRow; availableQuantity: string }>;
	},
): Promise<void> {
	for (const trigger of input.triggers) {
		await scheduleAutoTopupIfNeeded(executor, {
			projectId: input.projectId,
			customerId: input.customerId,
			triggerKey: input.triggerKey,
			...trigger,
		});
	}
}

export async function scheduleAutoTopupIfNeeded(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		/** What the policy's scope can still spend after the write. */
		availableQuantity: string;
		triggerKey: string;
		policy: AutoTopupPolicyRow;
		/** Overrides the declarations the chargeable providers are derived from; for tests. */
		capabilities?: ProviderCapabilityLookup;
	},
): Promise<void> {
	const policy = input.policy;
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
	const supported = automaticTopupProviders(input.capabilities).has(policy.provider);
	if (supported && (!Number.isSafeInteger(amount) || amount <= 0 || policy.currency === null))
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
	await executeOne(
		executor,
		drizzleSql`
		INSERT INTO auto_topup_jobs (
			project_id, policy_id, customer_id, store_product_id, trigger_key, provider,
			provider_account_id, status, amount_minor, currency, last_error, completed_at
		) VALUES (
			${input.projectId}, ${String(policy.id)}::bigint, ${input.customerId},
			${policy.store_product_id}, ${input.triggerKey},
			${policy.provider}, ${policy.provider_account_id},
			${supported ? "pending" : "provider_action_required"},
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
