import { sql as drizzleSql } from "drizzle-orm";
import { NotFoundBillingError, PersistenceConflictError } from "../../billing/errors";
import type { ProjectionSyncStatus } from "../../billing/types";
import type { ProjectInstanceContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import { parseProjectionSyncJobRow } from "./parsers";
import { assertUpdated, executeOne, executeRows } from "./query";
import type { ProjectionSyncJobRow } from "./types";
import { requireNonBlank, requirePositiveLimit } from "./validation";

export class ProjectionJobBillingRepository extends RepositoryModule {
	async claimProjectionSyncJobs(workerId: string, limit: number): Promise<ProjectionSyncJobRow[]> {
		requireNonBlank(workerId, "p_worker_id");
		const cappedLimit = requirePositiveLimit(limit);
		const rows = await executeRows(
			this.database,
			drizzleSql`
			WITH ranked_jobs AS (
				SELECT
					jobs.id,
					ROW_NUMBER() OVER (
						PARTITION BY jobs.project_id
						ORDER BY COALESCE(jobs.next_attempt_at, jobs.locked_at) ASC, jobs.created_at ASC
					) AS project_rank,
					COALESCE(jobs.next_attempt_at, jobs.locked_at) AS due_at,
					jobs.created_at
				FROM projection_sync_jobs jobs
				WHERE (
						jobs.status = 'pending'
						AND jobs.next_attempt_at <= now()
					)
					OR (
						jobs.status = 'processing'
						AND jobs.locked_at <= now() - INTERVAL '5 minutes'
					)
			),
			due_jobs AS (
				SELECT jobs.id
				FROM projection_sync_jobs jobs
				JOIN ranked_jobs ranked ON ranked.id = jobs.id
				ORDER BY ranked.project_rank ASC, ranked.due_at ASC, ranked.created_at ASC
				LIMIT ${cappedLimit}
				FOR UPDATE OF jobs SKIP LOCKED
			)
			UPDATE projection_sync_jobs jobs
			SET
				status = 'processing',
				locked_at = now(),
				locked_by = ${workerId},
				updated_at = now()
			FROM due_jobs
			WHERE jobs.id = due_jobs.id
			RETURNING
				jobs.*,
				(SELECT projects.key FROM projects projects WHERE projects.id = jobs.project_id) AS project_key
		`,
		);
		return rows.map(parseProjectionSyncJobRow);
	}

	async markProjectionSyncJobSucceeded(
		projectId: string,
		jobId: string,
		workerId: string,
	): Promise<void> {
		await assertUpdated(
			this.database,
			drizzleSql`
			UPDATE projection_sync_jobs jobs
			SET
				status = CASE
					WHEN jobs.reprojection_requested THEN 'pending'
					ELSE 'succeeded'
				END,
				locked_at = NULL,
				locked_by = NULL,
				last_error = NULL,
				reprojection_requested = false,
				attempts = CASE
					WHEN jobs.reprojection_requested THEN 0
					ELSE jobs.attempts
				END,
				next_attempt_at = CASE
					WHEN jobs.reprojection_requested THEN now()
					ELSE jobs.next_attempt_at
				END,
				updated_at = now()
			WHERE jobs.id = ${jobId}
				AND jobs.project_id = ${projectId}
				AND jobs.status = 'processing'
				AND jobs.locked_by = ${workerId}
			RETURNING jobs.id
		`,
			`projection sync job ${jobId} is not locked by worker ${workerId}`,
		);
	}

	async markProjectionSyncJobFailed(
		projectId: string,
		jobId: string,
		lastError: string,
		nextAttemptAt: Date | null,
		workerId: string,
	): Promise<void> {
		// Bind as ISO: Bun SQL serializes a raw Date via toString (a locale string) that
		// Postgres rejects for ::timestamptz; the record* paths already do the same.
		const nextAttemptAtIso = nextAttemptAt?.toISOString() ?? null;
		await assertUpdated(
			this.database,
			drizzleSql`
			UPDATE projection_sync_jobs jobs
			SET
				status = CASE
					WHEN jobs.reprojection_requested THEN 'pending'
					WHEN ${nextAttemptAtIso}::timestamptz IS NULL THEN 'failed'
					ELSE 'pending'
				END,
				attempts = CASE
					WHEN jobs.reprojection_requested THEN 0
					ELSE LEAST(jobs.attempts::bigint + 1, 2147483647)::integer
				END,
				last_error = CASE
					WHEN jobs.reprojection_requested THEN NULL
					ELSE ${lastError}
				END,
				reprojection_requested = false,
				next_attempt_at = CASE
					WHEN jobs.reprojection_requested THEN now()
					ELSE COALESCE(${nextAttemptAtIso}::timestamptz, jobs.next_attempt_at)
				END,
				locked_at = NULL,
				locked_by = NULL,
				updated_at = now()
			WHERE jobs.id = ${jobId}
				AND jobs.project_id = ${projectId}
				AND jobs.status = 'processing'
				AND jobs.locked_by = ${workerId}
			RETURNING jobs.id
		`,
			`projection sync job ${jobId} is not locked by worker ${workerId}`,
		);
	}

	async retryProjectionSyncJob(
		project: ProjectInstanceContext,
		jobId: string,
	): Promise<{ jobId: string; status: "pending" }> {
		const projectId = project.projectInstanceId;
		const retried = await executeOne<{ id: string }>(
			this.database,
			drizzleSql`
				UPDATE projection_sync_jobs jobs
				SET
					status = 'pending',
					attempts = 0,
					last_error = NULL,
					reprojection_requested = false,
					next_attempt_at = now(),
					locked_at = NULL,
					locked_by = NULL,
					updated_at = now()
				WHERE jobs.id = ${jobId}
					AND jobs.project_id = ${projectId}
					AND jobs.status = 'failed'
				RETURNING jobs.id
			`,
		);
		if (retried !== null) {
			return { jobId: retried.id, status: "pending" };
		}

		const existing = await executeOne<{ status: ProjectionSyncStatus }>(
			this.database,
			drizzleSql`
				SELECT jobs.status
				FROM projection_sync_jobs jobs
				WHERE jobs.id = ${jobId}
					AND jobs.project_id = ${projectId}
				LIMIT 1
			`,
		);
		if (existing === null) {
			throw new NotFoundBillingError(`Projection sync job ${jobId} was not found`);
		}

		throw new PersistenceConflictError(
			`Projection sync job ${jobId} is ${existing.status}; only failed jobs can be retried`,
			"PROJECTION_JOB_NOT_FAILED",
		);
	}
}
