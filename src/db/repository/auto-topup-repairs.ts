import { sql } from "drizzle-orm";
import type { AutoTopupPhase } from "../../billing/auto-topup";
import { executeOne, executeRows } from "./query";
import type { QueryExecutor } from "./types";

interface AutoTopupReview {
	id: string;
	billing_account_id: string;
	phase: AutoTopupPhase;
	external_invoice_id: string | null;
	completion_attempts: number;
	budget_interval_started_at: Date | string | null;
	has_paid_receipt: boolean;
	last_error: string | null;
}

export async function readAutoTopupReviews(
	executor: QueryExecutor,
	projectId: string,
	options: { after?: string; limit?: number } = {},
): Promise<{ jobs: AutoTopupReview[]; nextAfter: string | null }> {
	const limit = options.limit ?? 100;
	if (!Number.isInteger(limit) || limit < 1 || limit > 500)
		throw new Error("Review report limit must be an integer from 1 to 500");
	const jobs = await executeRows<AutoTopupReview>(
		executor,
		sql`
		SELECT j.id,c.billing_account_id,j.phase,j.external_invoice_id,j.completion_attempts,
			j.budget_interval_started_at,j.provider_result IS NOT NULL AS has_paid_receipt,j.last_error
		FROM auto_topup_jobs j JOIN customers c ON c.project_id=j.project_id AND c.id=j.customer_id
		WHERE j.project_id=${projectId} AND j.status='requires_review'
			AND (${options.after ?? null}::uuid IS NULL OR j.id>${options.after ?? null}::uuid)
		ORDER BY j.id LIMIT ${limit + 1}
	`,
	);
	return {
		jobs: jobs.slice(0, limit),
		nextAfter: jobs.length > limit ? (jobs[limit - 1]?.id ?? null) : null,
	};
}

/** Resume the same durable operation; never release its hold or erase its provider receipt. */
export async function resumeAutoTopupReview(
	executor: QueryExecutor,
	projectId: string,
	jobId: string,
): Promise<{ jobId: string; status: "resumed" | "unchanged" }> {
	const row = await executeOne(
		executor,
		sql`
		UPDATE auto_topup_jobs SET status='pending',completion_attempts=0,
			next_attempt_at=clock_timestamp(),locked_at=NULL,locked_by=NULL,updated_at=now()
		WHERE project_id=${projectId} AND id=${jobId} AND status='requires_review'
		RETURNING id
	`,
	);
	return { jobId, status: row === null ? "unchanged" : "resumed" };
}
