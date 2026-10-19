import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import { sha256Hex, stableJson } from "../../billing/decimal";
import type { BillingProvider, ProjectionPayload, SubscriptionStatus } from "../../billing/types";
import type {
	AutoTopupEventData,
	DomainEventData,
	DomainEventType,
	SubscriptionEventData,
} from "../../events/types";
import { recordDomainEvent } from "./domain-events";
import { executeOne } from "./query";
import type { QueryExecutor } from "./types";
import { formatUtcTimestamp } from "./validation";

/**
 * The billing facts that become outbound events. Each recorder runs inside the transaction that
 * writes the fact, records nothing unless an enabled endpoint subscribes, and names the fact in its
 * source key so that recording it again is a no-op. Recorders that need a read to build their data
 * check for a subscriber first, so a project without webhooks pays no extra read.
 */

/** Records one typed event; the data's shape is checked at compile time, not in the transaction. */
export async function recordBillingEvent<T extends DomainEventType>(
	executor: QueryExecutor,
	projectId: string,
	input: {
		type: T;
		sourceKey: string;
		customerId: string | null;
		occurredAt: Date;
		data: DomainEventData<T>;
	},
): Promise<string | null> {
	return await recordDomainEvent(executor, projectId, {
		...input,
		data: input.data as Record<string, unknown>,
	});
}

/** Whether an enabled endpoint of the project subscribes to the type. */
export async function hasDomainEventSubscriber(
	executor: QueryExecutor,
	projectId: string,
	type: DomainEventType,
): Promise<boolean> {
	const row = await executeOne<{ subscribed: boolean }>(
		executor,
		drizzleSql`
			SELECT EXISTS (
				SELECT 1 FROM webhook_endpoints endpoint
				WHERE endpoint.project_id = ${projectId}
					AND endpoint.enabled
					AND (cardinality(endpoint.event_types) = 0 OR ${type} = ANY(endpoint.event_types))
			) AS subscribed
		`,
	);
	return row?.subscribed === true;
}

/** Whether an enabled endpoint of the project subscribes to any of the types. */
async function hasAnySubscriber(
	executor: QueryExecutor,
	projectId: string,
	types: readonly DomainEventType[],
): Promise<boolean> {
	const list = drizzleSql`ARRAY[${drizzleSql.join(
		types.map((type) => drizzleSql`${type}`),
		drizzleSql`, `,
	)}]::text[]`;
	const row = await executeOne<{ subscribed: boolean }>(
		executor,
		drizzleSql`
			SELECT EXISTS (
				SELECT 1 FROM webhook_endpoints endpoint
				WHERE endpoint.project_id = ${projectId}
					AND endpoint.enabled
					AND (cardinality(endpoint.event_types) = 0 OR endpoint.event_types && ${list})
			) AS subscribed
		`,
	);
	return row?.subscribed === true;
}

const subscriptionEventTypes = [
	"subscription.activated",
	"subscription.updated",
	"subscription.ended",
] as const satisfies readonly DomainEventType[];

const accessStatuses: ReadonlySet<SubscriptionStatus> = new Set([
	"active",
	"grace_period",
	"billing_retry",
	"cancelled",
]);

/** The attributes of a subscription whose change an event reports. */
export interface SubscriptionEventState {
	status: SubscriptionStatus;
	productId: string;
	expiresAt: string | null;
	currentPeriodEnd: string | null;
	cancelAtPeriodEnd: boolean;
	autoRenew: boolean;
}

/**
 * Records what a subscription write changed: `activated` when it starts granting access (new, or
 * back from an ended state), `ended` when it stops (expired, refunded or revoked), `updated` when a
 * tracked attribute changes while it grants access. A write that changes nothing records nothing.
 */
export async function recordSubscriptionChange(
	executor: QueryExecutor,
	projectId: string,
	change: {
		subscriptionId: string;
		customerId: string;
		before: SubscriptionEventState | null;
		after: SubscriptionEventState;
		/** Distinguishes this change from earlier ones with the same before and after. */
		changeKey: string;
	},
): Promise<void> {
	const { before, after } = change;
	const type = subscriptionEventType(before, after);
	if (type === null) return;
	if (!(await hasDomainEventSubscriber(executor, projectId, type))) return;
	const subscription = await readEventSubscription(executor, projectId, change.subscriptionId);
	const previousAttributes =
		before === null ? {} : await changedAttributes(executor, projectId, before, after);
	await recordBillingEvent(executor, projectId, {
		type,
		sourceKey: `${type}:${change.subscriptionId}:${change.changeKey}`,
		customerId: change.customerId,
		occurredAt: new Date(),
		data: { subscription, previousAttributes },
	});
}

function subscriptionEventType(
	before: SubscriptionEventState | null,
	after: SubscriptionEventState,
): "subscription.activated" | "subscription.updated" | "subscription.ended" | null {
	const grants = accessStatuses.has(after.status);
	const granted = before !== null && accessStatuses.has(before.status);
	if (!grants) return granted ? "subscription.ended" : null;
	if (!granted) return "subscription.activated";
	return trackedAttributesDiffer(before, after) ? "subscription.updated" : null;
}

function trackedAttributesDiffer(before: SubscriptionEventState, after: SubscriptionEventState) {
	return (
		before.status !== after.status ||
		before.productId !== after.productId ||
		before.expiresAt !== after.expiresAt ||
		before.currentPeriodEnd !== after.currentPeriodEnd ||
		before.cancelAtPeriodEnd !== after.cancelAtPeriodEnd ||
		before.autoRenew !== after.autoRenew
	);
}

/** Names one write's change: its time and the state it produced. */
export function subscriptionChangeKey(
	updatedAt: Date | string,
	state: SubscriptionEventState,
): string {
	return `${formatUtcTimestamp(updatedAt)}:${sha256Hex(stableJson(state)).slice(0, 16)}`;
}

interface SubscriptionStateRow {
	id: string;
	customer_id: string;
	status: SubscriptionStatus;
	product_id: string;
	expires_at: Date | string | null;
	current_period_end: Date | string | null;
	cancel_at_period_end: boolean;
	auto_renew: boolean;
	updated_at: Date | string;
}

async function readSubscriptionState(
	executor: QueryExecutor,
	projectId: string,
	where: DrizzleSQL,
): Promise<SubscriptionStateRow | null> {
	return await executeOne<SubscriptionStateRow>(
		executor,
		drizzleSql`
			SELECT id, customer_id, status, product_id, expires_at, current_period_end,
				cancel_at_period_end, auto_renew, updated_at
			FROM subscriptions
			WHERE project_id = ${projectId} AND ${where}
			FOR NO KEY UPDATE
		`,
	);
}

function stateOf(row: SubscriptionStateRow): SubscriptionEventState {
	return {
		status: row.status,
		productId: row.product_id,
		expiresAt: eventTimestamp(row.expires_at),
		currentPeriodEnd: eventTimestamp(row.current_period_end),
		cancelAtPeriodEnd: row.cancel_at_period_end,
		autoRenew: row.auto_renew,
	};
}

/**
 * Runs a write that changes one existing subscription outside the shared upsert and records what
 * it changed. Without a subscriber it only runs the write, so it costs one existence check.
 */
export async function trackSubscriptionChange(
	executor: QueryExecutor,
	projectId: string,
	target:
		| { subscriptionId: string }
		| { provider: BillingProvider; externalSubscriptionId: string },
	write: () => Promise<void>,
): Promise<void> {
	if (!(await hasAnySubscriber(executor, projectId, subscriptionEventTypes))) {
		await write();
		return;
	}
	const before = await readSubscriptionState(
		executor,
		projectId,
		"subscriptionId" in target
			? drizzleSql`id = ${target.subscriptionId}`
			: drizzleSql`provider = ${target.provider} AND external_subscription_id = ${target.externalSubscriptionId}`,
	);
	await write();
	if (before === null) return;
	const after = await readSubscriptionState(executor, projectId, drizzleSql`id = ${before.id}`);
	if (after === null) return;
	const state = stateOf(after);
	await recordSubscriptionChange(executor, projectId, {
		subscriptionId: before.id,
		customerId: before.customer_id,
		before: stateOf(before),
		after: state,
		changeKey: subscriptionChangeKey(after.updated_at, state),
	});
}

async function changedAttributes(
	executor: QueryExecutor,
	projectId: string,
	before: SubscriptionEventState,
	after: SubscriptionEventState,
): Promise<SubscriptionEventData["previousAttributes"]> {
	return {
		...(before.status === after.status ? {} : { status: before.status }),
		...(before.productId === after.productId
			? {}
			: { productKey: await productKey(executor, projectId, before.productId) }),
		...(before.expiresAt === after.expiresAt ? {} : { expiresAt: before.expiresAt }),
		...(before.currentPeriodEnd === after.currentPeriodEnd
			? {}
			: { currentPeriodEnd: before.currentPeriodEnd }),
		...(before.cancelAtPeriodEnd === after.cancelAtPeriodEnd
			? {}
			: { cancelAtPeriodEnd: before.cancelAtPeriodEnd }),
		...(before.autoRenew === after.autoRenew ? {} : { autoRenew: before.autoRenew }),
	};
}

async function productKey(
	executor: QueryExecutor,
	projectId: string,
	productId: string,
): Promise<string> {
	const row = await executeOne<{ key: string }>(
		executor,
		drizzleSql`SELECT key FROM products WHERE project_id = ${projectId} AND id = ${productId}`,
	);
	if (row === null) throw new Error(`product ${productId} was not found`);
	return row.key;
}

const utc = (column: ReturnType<typeof drizzleSql.raw>) =>
	drizzleSql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

async function readEventSubscription(
	executor: QueryExecutor,
	projectId: string,
	subscriptionId: string,
): Promise<SubscriptionEventData["subscription"]> {
	const row = await executeOne<{ subscription: SubscriptionEventData["subscription"] }>(
		executor,
		drizzleSql`
			SELECT jsonb_build_object(
				'id', s.id, 'externalSubscriptionId', s.external_subscription_id,
				'provider', s.provider, 'channel', s.channel, 'productKey', p.key, 'status', s.status,
				'providerStatus', s.provider_status,
				'startsAt', ${utc(drizzleSql.raw("s.starts_at"))},
				'expiresAt', ${utc(drizzleSql.raw("s.expires_at"))},
				'currentPeriodStart', ${utc(drizzleSql.raw("s.current_period_start"))},
				'currentPeriodEnd', ${utc(drizzleSql.raw("s.current_period_end"))},
				'cancelAtPeriodEnd', s.cancel_at_period_end, 'autoRenew', s.auto_renew
			) AS subscription
			FROM subscriptions s
			JOIN products p ON p.project_id = s.project_id AND p.id = s.product_id
			WHERE s.project_id = ${projectId} AND s.id = ${subscriptionId}
		`,
	);
	if (row === null) throw new Error(`subscription ${subscriptionId} was not found`);
	return row.subscription;
}

/** Normalizes a timestamp the way the event data spells it, or keeps null. */
export function eventTimestamp(value: Date | string | null | undefined): string | null {
	return value === null || value === undefined ? null : formatUtcTimestamp(value);
}

/** An invoice event from a provider's invoice notification. */
export async function recordInvoiceEvent(
	executor: QueryExecutor,
	projectId: string,
	event: {
		type: "invoice.paid" | "invoice.payment_failed";
		sourceKey: string;
		customerId: string;
		occurredAt: Date;
		invoice: DomainEventData<"invoice.paid">["invoice"];
	},
): Promise<void> {
	await recordBillingEvent(executor, projectId, {
		type: event.type,
		sourceKey: event.sourceKey,
		customerId: event.customerId,
		occurredAt: event.occurredAt,
		data: { invoice: event.invoice },
	});
}

/**
 * The refund, dispute, trial and plan-grant facts a projection job carries, re-emitted as events
 * from the same recorded fact: one rule decides both, so a receiver of either sees the same facts.
 */
export async function recordProjectionFactEvents(
	executor: QueryExecutor,
	projectId: string,
	job: {
		customerId: string;
		idempotencyKey: string;
		payload: Pick<ProjectionPayload, "reversal" | "trial" | "planGrant" | "subscription">;
	},
): Promise<void> {
	const { reversal, trial, planGrant, subscription } = job.payload;
	const record = async <T extends DomainEventType>(
		type: T,
		occurredAt: Date,
		data: DomainEventData<T>,
	) =>
		await recordBillingEvent(executor, projectId, {
			type,
			sourceKey: `${type}:${job.idempotencyKey}`,
			customerId: job.customerId,
			occurredAt,
			data,
		});
	if (reversal !== undefined) {
		await record(
			reversal.reason === "dispute" ? "dispute.recorded" : "refund.recorded",
			new Date(reversal.reversedAt),
			{ reversal, ...(subscription === undefined ? {} : { subscription }) },
		);
	}
	if (trial !== undefined) {
		await record(
			trial.event === "ended" ? "trial.ended" : "trial.ending",
			trial.event === "ended" ? new Date(trial.trialEndsAt) : new Date(),
			{ trial },
		);
	}
	if (planGrant !== undefined) {
		await record(
			planGrant.event === "ended" ? "plan_grant.ended" : "plan_grant.ending",
			planGrant.event === "ended" ? new Date(planGrant.endsAt) : new Date(),
			{ planGrant },
		);
	}
}

/** A usage alert crossing its threshold in a window. */
export async function recordUsageAlertTriggered(
	executor: QueryExecutor,
	projectId: string,
	crossing: {
		customerId: string;
		alertId: string;
		featureKey: string;
		entityId: string | null;
		thresholdType: "absolute" | "percentage";
		thresholdValue: string;
		interval: DomainEventData<"usage_alert.triggered">["alert"]["interval"];
		intervalCount: number | null;
		window: { start: Date; end: Date | null };
		threshold: string;
		currentValue: string;
		crossing: number;
	},
): Promise<void> {
	const type = "usage_alert.triggered";
	if (!(await hasDomainEventSubscriber(executor, projectId, type))) return;
	const entity =
		crossing.entityId === null
			? null
			: await executeOne<{ external_id: string }>(
					executor,
					drizzleSql`
						SELECT external_id FROM entities
						WHERE project_id = ${projectId} AND id = ${crossing.entityId}::bigint
					`,
				);
	await recordBillingEvent(executor, projectId, {
		type,
		sourceKey: `${type}:${crossing.alertId}:${crossing.window.start.toISOString()}:${crossing.crossing}`,
		customerId: crossing.customerId,
		occurredAt: new Date(),
		data: {
			alert: {
				id: crossing.alertId,
				featureKey: crossing.featureKey,
				entityId: entity?.external_id ?? null,
				thresholdType: crossing.thresholdType,
				thresholdValue: crossing.thresholdValue,
				interval: crossing.interval,
				intervalCount: crossing.interval === "lifetime" ? null : crossing.intervalCount,
			},
			window: {
				startsAt: crossing.window.start.toISOString(),
				endsAt: crossing.window.end?.toISOString() ?? null,
			},
			threshold: crossing.threshold,
			currentValue: crossing.currentValue,
			crossing: crossing.crossing,
		},
	});
}

/** The outcome of an automatic top-up: charged, failed for good, or waiting for the customer. */
export async function recordAutoTopupOutcome(
	executor: QueryExecutor,
	projectId: string,
	outcome: {
		type: "auto_topup.succeeded" | "auto_topup.failed" | "auto_topup.action_required";
		customerId: string;
		policyId: string;
		jobId: string;
		provider: BillingProvider;
		amountMinor: number;
		chargedAmountMinor: number | null;
		currency: string | null;
		externalInvoiceId: string | null;
		externalPaymentId: string | null;
		error: string | null;
	},
): Promise<void> {
	if (!(await hasDomainEventSubscriber(executor, projectId, outcome.type))) return;
	const policy = await executeOne<{
		feature_key: string;
		topup_key: string;
		entity_id: string | null;
	}>(
		executor,
		drizzleSql`
			SELECT feature.key AS feature_key, topup.key AS topup_key, entity.external_id AS entity_id
			FROM auto_topup_policies policy
			JOIN features feature
				ON feature.project_id = policy.project_id AND feature.id = policy.feature_id
			JOIN topup_options topup
				ON topup.project_id = policy.project_id AND topup.id = policy.topup_option_id
			LEFT JOIN entities entity
				ON entity.project_id = policy.project_id AND entity.id = policy.entity_id
			WHERE policy.project_id = ${projectId} AND policy.id = ${outcome.policyId}::bigint
		`,
	);
	if (policy === null) throw new Error(`auto top-up policy ${outcome.policyId} was not found`);
	const autoTopup: AutoTopupEventData = {
		jobId: outcome.jobId,
		policyId: outcome.policyId,
		featureKey: policy.feature_key,
		topupKey: policy.topup_key,
		entityId: policy.entity_id,
		provider: outcome.provider,
		amountMinor: outcome.amountMinor,
		chargedAmountMinor: outcome.chargedAmountMinor,
		currency: outcome.currency,
		externalInvoiceId: outcome.externalInvoiceId,
		externalPaymentId: outcome.externalPaymentId,
		error: outcome.error,
	};
	await recordBillingEvent(executor, projectId, {
		type: outcome.type,
		sourceKey: `${outcome.type}:${outcome.jobId}`,
		customerId: outcome.customerId,
		occurredAt: new Date(),
		data: { autoTopup },
	});
}
