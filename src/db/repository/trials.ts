import { sql as drizzleSql } from "drizzle-orm";
import { executeRows } from "./query";
import type { QueryExecutor } from "./types";

/**
 * Records a store subscription's free-trial bounds without ever clearing them. Apple renewals and
 * Play's later offer phases no longer mention the trial, so a recorded trial stays until a later,
 * separate trial replaces it (one starting at or after the recorded end, such as a win-back
 * offer) or the provider moves the same trial's end. An older trial delivered out of order
 * changes nothing.
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
			SET trial_start_at = ${start}::timestamptz, trial_end_at = ${end}::timestamptz, updated_at = now()
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
