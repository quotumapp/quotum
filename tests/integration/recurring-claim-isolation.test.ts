import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { OperationTiming } from "../../src/providers/contract";
import {
	RecurringBillingWorker,
	type RecurringBillingWorkerAdapter,
} from "../../src/workers/recurring-billing";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	setSubscriptionChangeAttempts,
	setUsageInvoiceAdjustmentAttempts,
	setUsageInvoicePeriodAttempts,
} from "./helpers/job-time-travel";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import {
	closeUsageWindows,
	overageFeatureKey,
	seedOverageSubscriber,
} from "./helpers/overage-fixtures";
import { seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";
import { seedSubscriptionChanges } from "./helpers/queue-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
const timing: OperationTiming = {
	payment: { kind: "uncertain" },
	entitlement: { kind: "awaiting_provider_event" },
};
let context: LocalPostgresContext;

/**
 * Each of these jobs is claimed and then cannot be built. While the claim built its jobs, one of
 * them rolled back the whole claim: no project made progress and the poison job never counted an
 * attempt, so it never reached its terminal state.
 */
localDescribe("Recurring billing claim isolation", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("invoices other periods while a period without a Stripe customer fails on its own", async () => {
		await seedPhase3ControlCatalog(context.sql);
		await seedOverageSubscriber(context.sql, { account: "iso-apple", provider: "apple" });
		await seedOverageSubscriber(context.sql, { account: "iso-stripe", provider: "stripe" });
		await consumeOverage("iso-apple");
		await consumeOverage("iso-stripe");
		await closeUsageWindows(context.sql);
		const failures: string[] = [];

		expect(await runWorkerOnce(failures)).toMatchObject({
			materializedUsagePeriods: 2,
			usageInvoicesCreated: 1,
			usageAdjustmentsCreated: 0,
			failed: 1,
		});
		const poisoned = await periodId("iso-apple");
		expect(failures).toEqual([`Usage invoice period ${poisoned} cannot be invoiced`]);
		expect(await periodRows()).toEqual([
			{ account: "iso-apple", status: "pending", attempts: 1, last_error: null },
			{ account: "iso-stripe", status: "invoiced", attempts: 1, last_error: null },
		]);

		await setUsageInvoicePeriodAttempts(context.sql, poisoned, 7);
		expect(await runWorkerOnce(failures)).toMatchObject({
			materializedUsagePeriods: 0,
			usageInvoicesCreated: 0,
			failed: 1,
		});
		expect(await periodRows()).toEqual([
			{
				account: "iso-apple",
				status: "failed",
				attempts: 8,
				last_error: `Usage invoice period ${poisoned} cannot be invoiced`,
			},
			{ account: "iso-stripe", status: "invoiced", attempts: 1, last_error: null },
		]);
	});

	it("invoices other adjustments while a positive volume adjustment fails on its own", async () => {
		await seedPhase3ControlCatalog(context.sql);
		await seedOverageSubscriber(context.sql, { account: "iso-flat", provider: "stripe" });
		await seedOverageSubscriber(context.sql, {
			account: "iso-volume",
			provider: "stripe",
			pricingModel: "volume",
		});
		const flatUsage = await consumeOverage("iso-flat");
		const volumeUsage = await consumeOverage("iso-volume");
		await closeUsageWindows(context.sql);
		const failures: string[] = [];
		expect(await runWorkerOnce(failures)).toMatchObject({
			materializedUsagePeriods: 2,
			usageInvoicesCreated: 2,
			failed: 0,
		});

		// The correction drops the volume usage into a dearer tier, which stores a positive delta.
		await correctOverage("iso-flat", flatUsage);
		await correctOverage("iso-volume", volumeUsage);
		expect(await adjustmentRows()).toEqual([
			{ account: "iso-flat", amount_minor: "-10", status: "pending", attempts: 0 },
			{ account: "iso-volume", amount_minor: "8", status: "pending", attempts: 0 },
		]);

		expect(await runWorkerOnce(failures)).toMatchObject({
			materializedUsagePeriods: 0,
			usageInvoicesCreated: 0,
			usageAdjustmentsCreated: 1,
			failed: 1,
		});
		const poisoned = await adjustmentId("iso-volume");
		expect(failures).toEqual([`Usage invoice adjustment ${poisoned} has an invalid amount`]);
		expect(await adjustmentRows()).toEqual([
			{ account: "iso-flat", amount_minor: "-10", status: "invoiced", attempts: 1 },
			{ account: "iso-volume", amount_minor: "8", status: "pending", attempts: 1 },
		]);

		await setUsageInvoiceAdjustmentAttempts(context.sql, poisoned, 7);
		expect(await runWorkerOnce(failures)).toMatchObject({ usageAdjustmentsCreated: 0, failed: 1 });
		expect(await adjustmentRows()).toEqual([
			{ account: "iso-flat", amount_minor: "-10", status: "invoiced", attempts: 1 },
			{ account: "iso-volume", amount_minor: "8", status: "failed", attempts: 8 },
		]);
	});

	it("applies other changes while a change without a matching binding fails on its own", async () => {
		const [poisonChangeId, healthyChangeId] = await seedSubscriptionChanges(context.sql, 2);
		if (poisonChangeId === undefined || healthyChangeId === undefined) {
			throw new Error("Expected two seeded subscription changes");
		}
		// The target plan publishes Stripe web prices only, so an iOS subscription has no binding.
		await context.sql`
			UPDATE subscriptions
			SET channel = 'ios'
			FROM subscription_changes changes
			WHERE changes.id = ${poisonChangeId}::uuid
				AND subscriptions.project_id = changes.project_id
				AND subscriptions.id = changes.subscription_id
		`;
		const failures: string[] = [];

		expect(await runWorkerOnce(failures)).toMatchObject({
			subscriptionChangesApplied: 1,
			failed: 1,
		});
		expect(failures).toEqual(["Target plan has no Stripe recurring prices"]);
		expect(await changeRow(poisonChangeId)).toEqual({
			status: "pending",
			attempts: 1,
			last_error: null,
		});
		expect(await changeRow(healthyChangeId)).toEqual({
			status: "applied",
			attempts: 1,
			last_error: null,
		});

		await setSubscriptionChangeAttempts(context.sql, poisonChangeId, 7);
		expect(await runWorkerOnce(failures)).toMatchObject({
			subscriptionChangesApplied: 0,
			failed: 1,
		});
		expect(await changeRow(poisonChangeId)).toEqual({
			status: "failed",
			attempts: 8,
			last_error: "Target plan has no Stripe recurring prices",
		});
		expect(await changeRow(healthyChangeId)).toEqual({
			status: "applied",
			attempts: 1,
			last_error: null,
		});
	});
});

/** The provider is out of scope here: every claimed job that loads must finalize. */
function committedAdapter(): RecurringBillingWorkerAdapter {
	return {
		changes: {
			async apply(operation) {
				return { outcome: "committed", providerRequestId: operation.changeId, timing };
			},
		},
		settlement: {
			async collectFinalizedCharge(job) {
				return { outcome: "committed", externalChargeId: `in_${job.jobId}`, timing };
			},
		},
	};
}

async function runWorkerOnce(failures: string[]) {
	failures.length = 0;
	const worker = new RecurringBillingWorker({
		projectContextResolver: context.projectContextResolver,
		workerId: "claim-isolation-worker",
		repository: context.repository,
		adapterForJob: committedAdapter,
		logger: {
			error(_message, error) {
				failures.push(error instanceof Error ? error.message : String(error));
			},
		},
	});
	return await worker.runOnce();
}

async function consumeOverage(billingAccountId: string) {
	const receipt = await context.repository.consumeUsage(project, {
		billingAccountId,
		featureKey: overageFeatureKey(billingAccountId),
		quantity: "135",
		idempotencyKey: `${billingAccountId}:usage`,
	});
	expect(receipt).toMatchObject({ allowed: true });
	return receipt;
}

async function correctOverage(
	billingAccountId: string,
	receipt: { usageEventId: string | null; recordedAt: string | null },
): Promise<void> {
	if (receipt.usageEventId === null || receipt.recordedAt === null) {
		throw new Error(`Expected an accepted usage event for ${billingAccountId}`);
	}
	await context.repository.correctUsage(project, {
		billingAccountId,
		originalUsageEventId: receipt.usageEventId,
		originalRecordedAt: new Date(receipt.recordedAt),
		quantity: "20",
		reason: "claim isolation correction",
		actor: "claim-isolation-test",
		idempotencyKey: `${billingAccountId}:correct`,
	});
}

async function periodRows() {
	return await context.sql<
		Array<{ account: string; status: string; attempts: number; last_error: string | null }>
	>`
		SELECT customer.billing_account_id AS account, period.status, period.attempts,
			period.last_error
		FROM usage_invoice_periods period
		JOIN customers customer
			ON customer.project_id = period.project_id AND customer.id = period.customer_id
		WHERE period.project_id = ${project.projectInstanceId}::uuid
		ORDER BY account
	`;
}

async function periodId(account: string): Promise<string> {
	const [row] = await context.sql<Array<{ id: string }>>`
		SELECT period.id::text AS id
		FROM usage_invoice_periods period
		JOIN customers customer
			ON customer.project_id = period.project_id AND customer.id = period.customer_id
		WHERE period.project_id = ${project.projectInstanceId}::uuid
			AND customer.billing_account_id = ${account}
	`;
	if (row === undefined) throw new Error(`No usage invoice period for ${account}`);
	return row.id;
}

async function adjustmentRows() {
	return await context.sql<
		Array<{ account: string; amount_minor: string; status: string; attempts: number }>
	>`
		SELECT customer.billing_account_id AS account, adjustment.amount_minor::text AS amount_minor,
			adjustment.status, adjustment.attempts
		FROM usage_invoice_adjustments adjustment
		JOIN usage_invoice_periods period
			ON period.project_id = adjustment.project_id AND period.id = adjustment.closed_period_id
		JOIN customers customer
			ON customer.project_id = period.project_id AND customer.id = period.customer_id
		WHERE adjustment.project_id = ${project.projectInstanceId}::uuid
		ORDER BY account
	`;
}

async function adjustmentId(account: string): Promise<string> {
	const [row] = await context.sql<Array<{ id: string }>>`
		SELECT adjustment.id::text AS id
		FROM usage_invoice_adjustments adjustment
		JOIN usage_invoice_periods period
			ON period.project_id = adjustment.project_id AND period.id = adjustment.closed_period_id
		JOIN customers customer
			ON customer.project_id = period.project_id AND customer.id = period.customer_id
		WHERE adjustment.project_id = ${project.projectInstanceId}::uuid
			AND customer.billing_account_id = ${account}
	`;
	if (row === undefined) throw new Error(`No usage invoice adjustment for ${account}`);
	return row.id;
}

async function changeRow(changeId: string) {
	const [row] = await context.sql<
		Array<{ status: string; attempts: number; last_error: string | null }>
	>`
		SELECT status, attempts, last_error
		FROM subscription_changes
		WHERE project_id = ${project.projectInstanceId}::uuid AND id = ${changeId}::uuid
	`;
	if (row === undefined) throw new Error(`No subscription change ${changeId}`);
	return row;
}
