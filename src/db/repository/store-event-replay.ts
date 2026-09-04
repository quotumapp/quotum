import { sql as drizzleSql } from "drizzle-orm";
import type { ProjectInstanceContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import { parseStoreEventReplayJobRow } from "./parsers";
import { assertUpdated, executeOne, executeRows } from "./query";
import type { StoreEventReplayJobRow } from "./types";
import { requireNonBlank, requirePositiveLimit } from "./validation";

export class StoreEventReplayBillingRepository extends RepositoryModule {
	async claimStoreEventReplayJobs(
		workerId: string,
		limit: number,
	): Promise<StoreEventReplayJobRow[]> {
		requireNonBlank(workerId, "p_worker_id");
		const cappedLimit = requirePositiveLimit(limit);
		const rows = await executeRows(
			this.database,
			drizzleSql`
			WITH due_events AS (
				SELECT events.id
				FROM store_events events
				WHERE (
						events.processing_status IN ('pending', 'skipped', 'failed')
						AND events.next_attempt_at <= now()
					)
					OR (
						events.processing_status = 'processing'
						AND events.locked_at <= now() - INTERVAL '5 minutes'
					)
				ORDER BY COALESCE(events.next_attempt_at, events.locked_at) ASC, events.created_at ASC
				LIMIT ${cappedLimit}
				FOR UPDATE SKIP LOCKED
			)
			UPDATE store_events events
			SET
				processing_status = 'processing',
				locked_at = now(),
				locked_by = ${workerId},
				updated_at = now()
			FROM due_events
			WHERE events.id = due_events.id
			RETURNING
				events.*,
				(SELECT projects.key FROM projects projects WHERE projects.id = events.project_id) AS project_key
		`,
		);
		return rows.map(parseStoreEventReplayJobRow);
	}

	async claimStoreEventReplayJobById(
		workerId: string,
		project: ProjectInstanceContext,
		eventId: string,
	): Promise<StoreEventReplayJobRow> {
		requireNonBlank(workerId, "p_worker_id");
		const projectId = project.projectInstanceId;
		const row = await executeOne(
			this.database,
			drizzleSql`
			UPDATE store_events events
			SET
				processing_status = 'processing',
				locked_at = now(),
				locked_by = ${workerId},
				updated_at = now()
			WHERE events.id = ${eventId}
				AND events.project_id = ${projectId}
				AND (
					events.processing_status IN ('pending', 'skipped', 'failed')
					OR (
						events.processing_status = 'processing'
						AND events.locked_at <= now() - INTERVAL '5 minutes'
					)
				)
			RETURNING
				events.*,
				(SELECT projects.key FROM projects projects WHERE projects.id = events.project_id) AS project_key
		`,
		);
		if (row === null) {
			throw new Error(`store event replay job ${eventId} is not claimable`);
		}
		return parseStoreEventReplayJobRow(row);
	}

	async markStoreEventReplayJobSucceeded(
		projectId: string,
		eventId: string,
		workerId: string,
	): Promise<void> {
		await assertUpdated(
			this.database,
			drizzleSql`
			UPDATE store_events events
			SET
				processing_status = 'processed',
				processing_error = NULL,
				processed_at = now(),
				locked_at = NULL,
				locked_by = NULL,
				updated_at = now()
			WHERE events.id = ${eventId}
				AND events.project_id = ${projectId}
				AND events.processing_status = 'processing'
				AND events.locked_by = ${workerId}
			RETURNING events.id
		`,
			`store event replay job ${eventId} is not locked by worker ${workerId}`,
		);
	}

	async renewStoreEventReplayJobLease(
		projectId: string,
		eventId: string,
		workerId: string,
	): Promise<void> {
		await executeRows(
			this.database,
			drizzleSql`
				UPDATE store_events events
				SET locked_at = now(), updated_at = now()
				WHERE events.id = ${eventId}
					AND events.project_id = ${projectId}
					AND events.processing_status = 'processing'
					AND events.locked_by = ${workerId}
			`,
		);
	}

	async markStoreEventReplayJobFailed(
		projectId: string,
		eventId: string,
		errorMessage: string,
		nextAttemptAt: Date | null,
		workerId: string,
	): Promise<void> {
		requireNonBlank(errorMessage, "p_processing_error");
		// Bind as ISO: Bun SQL serializes a raw Date via toString (a locale string) that
		// Postgres rejects for ::timestamptz; the record* paths already do the same.
		const nextAttemptAtIso = nextAttemptAt?.toISOString() ?? null;
		await assertUpdated(
			this.database,
			drizzleSql`
			UPDATE store_events events
			SET
				processing_status = CASE WHEN ${nextAttemptAtIso}::timestamptz IS NULL THEN 'failed' ELSE 'pending' END,
				processing_error = ${errorMessage},
				attempts = events.attempts + 1,
				next_attempt_at = COALESCE(${nextAttemptAtIso}::timestamptz, 'infinity'::timestamptz),
				locked_at = NULL,
				locked_by = NULL,
				updated_at = now()
			WHERE events.id = ${eventId}
				AND events.project_id = ${projectId}
				AND events.processing_status = 'processing'
				AND events.locked_by = ${workerId}
			RETURNING events.id
		`,
			`store event replay job ${eventId} is not locked by worker ${workerId}`,
		);
	}
}
