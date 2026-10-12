import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";

/**
 * The oldest raw usage events past their project's retention, at most `limit` of them across all
 * projects. It is a function of its own so a test can plan the statement the maintenance worker
 * runs.
 *
 * The cutoff depends on the project (`metering_settings.raw_usage_retention_days`, 400 days
 * without a row), so a scan ordered by `recorded_at` cannot stop early: it would read every
 * partition's primary key to find nothing. Probing each project's own `(project_id, recorded_at)`
 * index range costs a few buffers per project and nothing per retained event.
 *
 * An event that a usage invoice adjustment references is kept: the adjustment's foreign key is
 * `ON DELETE RESTRICT`, and one such row would otherwise fail every sweep forever.
 */
export function expiredRawUsageSql(limit: number): DrizzleSQL {
	return drizzleSql`
		SELECT expired.project_id, expired.recorded_at, expired.id
		FROM projects p
		LEFT JOIN metering_settings settings ON settings.project_id = p.id
		CROSS JOIN LATERAL (
			SELECT events.project_id, events.recorded_at, events.id
			FROM usage_events events
			WHERE events.project_id = p.id
				AND events.recorded_at < now() - make_interval(
					days => COALESCE(settings.raw_usage_retention_days, 400)
				)
				AND NOT EXISTS (
					SELECT 1
					FROM usage_invoice_adjustments adjustment
					WHERE adjustment.project_id = events.project_id
						AND adjustment.usage_event_recorded_at = events.recorded_at
						AND adjustment.usage_event_id = events.id
				)
			ORDER BY events.recorded_at, events.id
			LIMIT ${limit}
		) expired
		ORDER BY expired.recorded_at, expired.id
		LIMIT ${limit}
	`;
}

/** Deletes the events `expiredRawUsageSql` selects and returns their ids. */
export function deleteExpiredRawUsageSql(limit: number): DrizzleSQL {
	return drizzleSql`
		WITH targets AS (${expiredRawUsageSql(limit)})
		DELETE FROM usage_events events
		USING targets
		WHERE events.project_id = targets.project_id
			AND events.recorded_at = targets.recorded_at
			AND events.id = targets.id
		RETURNING events.id
	`;
}
