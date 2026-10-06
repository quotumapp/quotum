import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
	RECURRING_JOB_MAX_ATTEMPTS,
	recurringRetryDelayMinutes,
} from "../../src/db/repository/recurring-retry";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { seedSubscriptionChanges, seedUsageInvoicePeriods } from "./helpers/queue-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
let context: LocalPostgresContext;

/** Attempt counts around every step of the schedule, the cap, and one far beyond the limit. */
const scheduleSamples = [1, 2, 3, 4, 5, 6, 7, 8, RECURRING_JOB_MAX_ATTEMPTS - 1, 1_000];

localDescribe("Recurring billing job retries", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("claims a failed subscription change only after the delay of its attempt count", async () => {
		const [changeId] = await seedSubscriptionChanges(context.sql, 1);
		if (changeId === undefined) throw new Error("Expected a seeded subscription change");

		for (const attempts of scheduleSamples) {
			const delaySeconds = recurringRetryDelayMinutes(attempts) * 60;
			await failedChangeAttemptedSecondsAgo(changeId, attempts, delaySeconds - 20);
			expect(await claimedChangeIds(), `${attempts} attempts, 20 s early`).toEqual([]);
			await failedChangeAttemptedSecondsAgo(changeId, attempts, delaySeconds + 20);
			expect(await claimedChangeIds(), `${attempts} attempts, 20 s late`).toEqual([changeId]);
		}
	});

	it("claims a failed usage invoice period only after the delay of its attempt count", async () => {
		const [periodId] = await seedUsageInvoicePeriods(context.sql, 1);
		if (periodId === undefined) throw new Error("Expected a seeded usage invoice period");

		for (const attempts of scheduleSamples) {
			const delaySeconds = recurringRetryDelayMinutes(attempts) * 60;
			await failedPeriodAttemptedSecondsAgo(periodId, attempts, delaySeconds - 20);
			expect(await claimedPeriodIds(), `${attempts} attempts, 20 s early`).toEqual([]);
			await failedPeriodAttemptedSecondsAgo(periodId, attempts, delaySeconds + 20);
			expect(await claimedPeriodIds(), `${attempts} attempts, 20 s late`).toEqual([periodId]);
		}
	});

	it("claims a job that never ran at once, however recently it was written", async () => {
		const [changeId] = await seedSubscriptionChanges(context.sql, 1);
		if (changeId === undefined) throw new Error("Expected a seeded subscription change");
		await context.sql`
			UPDATE subscription_changes SET updated_at = now(), attempts = 0 WHERE id = ${changeId}::uuid
		`;
		expect(await claimedChangeIds()).toEqual([changeId]);
	});

	it("keeps the reason on a retried job and parks it only after the last attempt", async () => {
		const [changeId] = await seedSubscriptionChanges(context.sql, 1);
		if (changeId === undefined) throw new Error("Expected a seeded subscription change");

		await failedChangeAttemptedSecondsAgo(changeId, 3, 3600);
		expect(await claimedChangeIds()).toEqual([changeId]);
		await context.repository.markSubscriptionChangeFailed(
			project.projectInstanceId,
			changeId,
			"Stripe is unavailable",
			"retry-worker",
		);
		expect(await changeState(changeId)).toEqual({
			status: "pending",
			attempts: 4,
			last_error: "Stripe is unavailable",
			locked_by: null,
		});

		await failedChangeAttemptedSecondsAgo(changeId, RECURRING_JOB_MAX_ATTEMPTS - 1, 4 * 3600);
		expect(await claimedChangeIds()).toEqual([changeId]);
		await context.repository.markSubscriptionChangeFailed(
			project.projectInstanceId,
			changeId,
			"Stripe is still unavailable",
			"retry-worker",
		);
		expect(await changeState(changeId)).toEqual({
			status: "failed",
			attempts: RECURRING_JOB_MAX_ATTEMPTS,
			last_error: "Stripe is still unavailable",
			locked_by: null,
		});
		expect(await claimedChangeIds()).toEqual([]);
	});

	it("puts a parked subscription change back in the queue with a fresh budget", async () => {
		const [changeId] = await seedSubscriptionChanges(context.sql, 1);
		if (changeId === undefined) throw new Error("Expected a seeded subscription change");
		await parkChange(changeId);

		expect(
			await context.repository.retryRecurringJob(project, "subscription-change", changeId),
		).toEqual({ jobKind: "subscription-change", jobId: changeId, status: "pending" });

		// The reason it was parked stays until the change succeeds.
		expect(await changeState(changeId)).toEqual({
			status: "pending",
			attempts: 0,
			last_error: "parked",
			locked_by: null,
		});
		expect(await claimedChangeIds()).toEqual([changeId]);
	});

	it("puts a parked usage invoice period back in the queue with a fresh budget", async () => {
		const [periodId] = await seedUsageInvoicePeriods(context.sql, 1);
		if (periodId === undefined) throw new Error("Expected a seeded usage invoice period");
		await context.sql`
			UPDATE usage_invoice_periods
			SET status = 'failed', attempts = ${RECURRING_JOB_MAX_ATTEMPTS}, last_error = 'parked'
			WHERE id = ${periodId}::uuid
		`;

		expect(
			await context.repository.retryRecurringJob(project, "usage-invoice-period", periodId),
		).toEqual({ jobKind: "usage-invoice-period", jobId: periodId, status: "pending" });
		const [state] = await context.sql<
			Array<{ status: string; attempts: number; last_error: string }>
		>`
			SELECT status, attempts, last_error FROM usage_invoice_periods WHERE id = ${periodId}::uuid
		`;
		expect(state).toEqual({ status: "pending", attempts: 0, last_error: "parked" });
		expect(await claimedPeriodIds()).toEqual([periodId]);
	});

	it("refuses a change that is not parked, unknown, or another project's", async () => {
		const [changeId] = await seedSubscriptionChanges(context.sql, 1);
		if (changeId === undefined) throw new Error("Expected a seeded subscription change");
		const unknown = "00000000-0000-4000-8000-000000000000";

		await expect(
			context.repository.retryRecurringJob(project, "subscription-change", changeId),
		).rejects.toMatchObject({ code: "RECURRING_JOB_NOT_FAILED", status: 409 });
		await expect(
			context.repository.retryRecurringJob(project, "subscription-change", unknown),
		).rejects.toMatchObject({ code: "RECURRING_JOB_NOT_FOUND", status: 404 });

		await parkChange(changeId);
		await expect(
			context.repository.retryRecurringJob(
				integrationProjectContext("globex"),
				"subscription-change",
				changeId,
			),
		).rejects.toMatchObject({ code: "RECURRING_JOB_NOT_FOUND", status: 404 });
		expect((await changeState(changeId)).status).toBe("failed");
	});

	it("refuses a usage invoice period or adjustment that is not parked, unknown, or foreign", async () => {
		const [periodId] = await seedUsageInvoicePeriods(context.sql, 1);
		if (periodId === undefined) throw new Error("Expected a seeded usage invoice period");
		const unknown = "00000000-0000-4000-8000-000000000000";

		await expect(
			context.repository.retryRecurringJob(project, "usage-invoice-period", periodId),
		).rejects.toMatchObject({ code: "RECURRING_JOB_NOT_FAILED", status: 409 });
		await expect(
			context.repository.retryRecurringJob(project, "usage-invoice-period", unknown),
		).rejects.toMatchObject({ code: "RECURRING_JOB_NOT_FOUND", status: 404 });
		await expect(
			context.repository.retryRecurringJob(project, "usage-invoice-adjustment", "999999"),
		).rejects.toMatchObject({ code: "RECURRING_JOB_NOT_FOUND", status: 404 });

		await context.sql`
			UPDATE usage_invoice_periods
			SET status = 'failed', attempts = ${RECURRING_JOB_MAX_ATTEMPTS}, last_error = 'parked'
			WHERE id = ${periodId}::uuid
		`;
		await expect(
			context.repository.retryRecurringJob(
				integrationProjectContext("globex"),
				"usage-invoice-period",
				periodId,
			),
		).rejects.toMatchObject({ code: "RECURRING_JOB_NOT_FOUND", status: 404 });
	});

	it("refuses a parked change that ended a catalog migration job", async () => {
		const [changeId] = await seedSubscriptionChanges(context.sql, 1);
		if (changeId === undefined) throw new Error("Expected a seeded subscription change");
		const [draft] = await context.sql<Array<{ id: string }>>`
			INSERT INTO catalog_migration_drafts (
				project_id, from_plan_version_id, to_plan_version_id, preview_token, intent_hash,
				effective_mode, status, impact, created_by, expires_at, published_at
			)
			SELECT change.project_id, change.from_plan_version_id, change.to_plan_version_id,
				repeat('a', 64), repeat('b', 64), 'immediate', 'published', '{}'::jsonb,
				'retry-test', now() + INTERVAL '1 day', now()
			FROM subscription_changes change
			WHERE change.id = ${changeId}::uuid
			RETURNING id::text AS id
		`;
		await context.sql`
			INSERT INTO catalog_migration_jobs (
				project_id, draft_id, subscription_id, subscription_change_id, status, effective_mode,
				last_error
			)
			SELECT change.project_id, ${draft?.id ?? null}::uuid, change.subscription_id, change.id,
				'failed', 'immediate', 'parked'
			FROM subscription_changes change
			WHERE change.id = ${changeId}::uuid
		`;
		await parkChange(changeId);

		await expect(
			context.repository.retryRecurringJob(project, "subscription-change", changeId),
		).rejects.toMatchObject({ code: "SUBSCRIPTION_CHANGE_NOT_RETRYABLE", status: 409 });
		expect((await changeState(changeId)).status).toBe("failed");
	});

	it("refuses a parked change while a newer change for its subscription is pending", async () => {
		const [changeId] = await seedSubscriptionChanges(context.sql, 1);
		if (changeId === undefined) throw new Error("Expected a seeded subscription change");
		await parkChange(changeId);
		await context.sql`
			INSERT INTO subscription_changes (
				project_id, customer_id, subscription_id, provider, provider_account_id,
				from_plan_version_id, to_plan_version_id, requested_quantities, change_kind,
				effective_mode, effective_at, proration_behavior, status, idempotency_key, request_hash
			)
			SELECT parked.project_id, parked.customer_id, parked.subscription_id, parked.provider,
				parked.provider_account_id, parked.from_plan_version_id, parked.to_plan_version_id,
				parked.requested_quantities, parked.change_kind, parked.effective_mode,
				now() + INTERVAL '1 day', parked.proration_behavior, 'pending', 'newer-change',
				repeat('c', 64)
			FROM subscription_changes parked
			WHERE parked.id = ${changeId}::uuid
		`;

		await expect(
			context.repository.retryRecurringJob(project, "subscription-change", changeId),
		).rejects.toMatchObject({ code: "SUBSCRIPTION_CHANGE_NOT_RETRYABLE", status: 409 });
		expect((await changeState(changeId)).status).toBe("failed");
	});
});

async function parkChange(changeId: string): Promise<void> {
	await context.sql`
		UPDATE subscription_changes
		SET status = 'failed', attempts = ${RECURRING_JOB_MAX_ATTEMPTS}, last_error = 'parked'
		WHERE id = ${changeId}::uuid
	`;
}

async function failedChangeAttemptedSecondsAgo(
	changeId: string,
	attempts: number,
	secondsAgo: number,
): Promise<void> {
	await context.sql`
		UPDATE subscription_changes
		SET status = 'pending', attempts = ${attempts}, locked_at = NULL, locked_by = NULL,
			last_error = 'earlier failure', updated_at = now() - make_interval(secs => ${secondsAgo})
		WHERE id = ${changeId}::uuid
	`;
}

async function failedPeriodAttemptedSecondsAgo(
	periodId: string,
	attempts: number,
	secondsAgo: number,
): Promise<void> {
	await context.sql`
		UPDATE usage_invoice_periods
		SET status = 'pending', attempts = ${attempts}, locked_at = NULL, locked_by = NULL,
			last_error = 'earlier failure', updated_at = now() - make_interval(secs => ${secondsAgo})
		WHERE id = ${periodId}::uuid
	`;
}

async function claimedChangeIds(): Promise<string[]> {
	return (await context.repository.claimSubscriptionChanges("retry-worker", 25)).map(
		(claimed) => claimed.changeId,
	);
}

async function claimedPeriodIds(): Promise<string[]> {
	const claim = await context.repository.materializeAndClaimUsageInvoicePeriods("retry-worker", 25);
	return claim.jobs.filter((job) => job.jobKind === "period").map((job) => job.jobId);
}

async function changeState(changeId: string) {
	const [row] = await context.sql<
		Array<{ status: string; attempts: number; last_error: string | null; locked_by: string | null }>
	>`
		SELECT status, attempts, last_error, locked_by
		FROM subscription_changes
		WHERE id = ${changeId}::uuid
	`;
	if (row === undefined) throw new Error(`No subscription change ${changeId}`);
	return row;
}
