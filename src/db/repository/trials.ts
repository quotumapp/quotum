import { sql as drizzleSql } from "drizzle-orm";
import type {
	BillingChannel,
	BillingProvider,
	ProjectionTrialEvent,
	ProjectionTrialPayload,
} from "../../billing/types";
import { executeOne, executeRows } from "./query";
import type { QueryExecutor } from "./types";
import { formatUtcTimestamp } from "./validation";

/**
 * Records a store subscription's free-trial bounds without ever clearing them. Apple renewals and
 * Play's later offer phases no longer mention the trial, so a recorded trial stays until a later,
 * separate trial replaces it (one starting at or after the recorded end, such as a win-back
 * offer) or the provider moves the same trial's end. An older trial delivered out of order
 * changes nothing. A new or moved trial owes a new ending notice.
 */
export async function recordSubscriptionTrial(
	executor: QueryExecutor,
	projectId: string,
	subscriptionId: string,
	trial: { start: Date; end: Date },
): Promise<void> {
	if (trial.end.getTime() <= trial.start.getTime()) {
		return;
	}
	const start = trial.start.toISOString();
	const end = trial.end.toISOString();
	await executeRows(
		executor,
		drizzleSql`
			UPDATE subscriptions
			SET
				trial_start_at = ${start}::timestamptz,
				trial_end_at = ${end}::timestamptz,
				trial_ending_notified_at = NULL,
				updated_at = now()
			WHERE project_id = ${projectId}
				AND id = ${subscriptionId}
				AND (
					trial_end_at IS NULL
					OR ${start}::timestamptz >= trial_end_at
					OR (trial_start_at = ${start}::timestamptz AND trial_end_at <> ${end}::timestamptz)
				)
		`,
	);
}

/** A subscription row with what a trial fact names; the notice queries return this shape. */
export interface SubscriptionTrialRow {
	provider: BillingProvider;
	channel: BillingChannel;
	external_subscription_id: string;
	product_key: string;
	plan_key: string | null;
	trial_start_at: Date | string;
	trial_end_at: Date | string;
	auto_renew: boolean;
}

export function subscriptionTrialFact(
	row: SubscriptionTrialRow,
	event: ProjectionTrialEvent,
): ProjectionTrialPayload {
	return {
		event,
		source: "subscription",
		provider: row.provider,
		channel: row.channel,
		externalSubscriptionId: row.external_subscription_id,
		productKey: row.product_key,
		...(row.plan_key === null ? {} : { planKey: row.plan_key }),
		trialStartsAt: formatUtcTimestamp(row.trial_start_at),
		trialEndsAt: formatUtcTimestamp(row.trial_end_at),
		autoRenew: row.auto_renew,
	};
}

/**
 * Claims the ending notice of the trial a Stripe `trial_will_end` event names. The stored row is
 * the judge: it must still be trialing on that same, future trial end and not yet notified, so a
 * stale, repeated or overtaken event carries no fact.
 */
export async function claimStripeTrialEndingNotice(
	executor: QueryExecutor,
	projectId: string,
	input: { subscriptionId: string; trialEnd: Date | null },
): Promise<ProjectionTrialPayload | null> {
	if (input.trialEnd === null) {
		return null;
	}
	const row = await executeOne<SubscriptionTrialRow>(
		executor,
		drizzleSql`
			UPDATE subscriptions s
			SET trial_ending_notified_at = now()
			FROM subscriptions target
			JOIN products p ON p.project_id = target.project_id AND p.id = target.product_id
			LEFT JOIN plan_versions pv
				ON pv.project_id = target.project_id AND pv.id = target.plan_version_id
			LEFT JOIN plans pl ON pl.project_id = pv.project_id AND pl.id = pv.plan_id
			WHERE target.project_id = ${projectId}
				AND target.id = ${input.subscriptionId}
				AND s.project_id = target.project_id
				AND s.id = target.id
				AND s.provider_status = 'trialing'
				AND s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
				AND s.trial_end_at = ${input.trialEnd.toISOString()}::timestamptz
				AND s.trial_end_at > now()
				AND s.trial_ending_notified_at IS NULL
			RETURNING
				s.provider,
				s.channel,
				s.external_subscription_id,
				p.key AS product_key,
				pl.key AS plan_key,
				s.trial_start_at,
				s.trial_end_at,
				s.auto_renew
		`,
	);
	return row === null ? null : subscriptionTrialFact(row, "ending");
}
