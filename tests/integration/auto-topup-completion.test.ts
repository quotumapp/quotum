import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { configureErasureKeyring } from "../../src/db/erasure-keyring";
import {
	readAutoTopupReviews,
	resumeAutoTopupReview,
} from "../../src/db/repository/auto-topup-repairs";
import { wrapStripeService } from "../../src/providers/stripe/adapter";
import { STRIPE_API_VERSION } from "../../src/providers/stripe/client";
import { StripeBillingService } from "../../src/providers/stripe/service";
import { FakeStripeBillingClient } from "../../src/providers/stripe/testing/fake-client";
import { erasureKeyFromBase64 } from "../../src/shared/erasure-digest";
import { AutoTopupWorker } from "../../src/workers/auto-topup";
import { heartbeatTimers } from "../helpers/heartbeat-timers";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { seedAutoTopupJobs } from "./helpers/queue-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;
const providerConfig = {
	apiVersion: STRIPE_API_VERSION,
	secretKey: "sk_test_recovery",
	webhookSecret: "whsec_test",
	checkoutSuccessUrl: "https://example.test/success",
	checkoutCancelUrl: "https://example.test/cancel",
	portalReturnUrl: "https://example.test/billing",
};
function providerWorker(client: FakeStripeBillingClient) {
	const provider = new StripeBillingService({
		config: providerConfig,
		client,
		repository: context.repository.forProject(integrationProjectContext()),
	});
	return new AutoTopupWorker({
		workerId: "recovery-test",
		projectContextResolver: context.projectContextResolver,
		repository: context.repository,
		leaseHeartbeatTimers: heartbeatTimers().timers,
		adapterForJob: () => wrapStripeService(provider),
		logger: { error() {} },
	});
}
localDescribe("paid automatic top-up completion recovery", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		configureErasureKeyring({
			current: erasureKeyFromBase64("topup-test", Buffer.alloc(32, 5).toString("base64")),
			previous: null,
		});
		await context.sql`INSERT INTO webhook_endpoints(project_id,url,secret_envelope,created_by,idempotency_key,request_hash) VALUES(${integrationProjectContext().projectInstanceId},'https://events.example.test','{}'::jsonb,'test','completion-test',repeat('a',64))`;
	});
	afterEach(() => configureErasureKeyring(null));
	afterAll(() => context.sql.close());
	it("preserves a paid receipt and budget through persistent credit failures, then completes once", async () => {
		await seedAutoTopupJobs(context.sql, context.repository, 1);
		await context.sql.unsafe(
			`CREATE FUNCTION block_topup_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.source_kind='topup' THEN RAISE EXCEPTION 'completion blocked'; END IF; RETURN NEW; END $$`,
		);
		await context.sql.unsafe(
			`CREATE TRIGGER block_topup_credit BEFORE INSERT ON balance_allocations FOR EACH ROW EXECUTE FUNCTION block_topup_credit()`,
		);
		let charges = 0;
		const worker = () =>
			new AutoTopupWorker({
				workerId: "completion-worker",
				projectContextResolver: context.projectContextResolver,
				repository: context.repository,
				leaseHeartbeatTimers: heartbeatTimers().timers,
				adapterForJob: () => ({
					topups: {
						async chargeAutomatic(job, checkpoint) {
							charges++;
							await checkpoint?.({ invoiceId: "in_paid" });
							return {
								status: "succeeded",
								externalInvoiceId: "in_paid",
								externalPaymentId: "pi_paid",
								amountPaidMinor: job.amountMinor,
								currency: job.currency,
								timing: { payment: { kind: "collected" }, entitlement: { kind: "unchanged" } },
							};
						},
					},
				}),
				logger: { error() {} },
			});
		try {
			for (let i = 0; i < 10; i++) {
				await context.sql`UPDATE auto_topup_jobs SET next_attempt_at=now()`;
				expect(await worker().runOnce()).toMatchObject({
					claimed: 1,
					succeeded: 0,
					retryScheduled: i === 9 ? 0 : 1,
				});
			}
			const [job] =
				await context.sql`SELECT status,budget_reserved_at,external_invoice_id,provider_result,completion_attempts FROM auto_topup_jobs`;
			expect(job).toMatchObject({
				status: "requires_review",
				external_invoice_id: "in_paid",
				completion_attempts: 10,
			});
			expect(job.budget_reserved_at).not.toBeNull();
			expect(job.provider_result.status).toBe("succeeded");
			const [state] =
				await context.sql`SELECT purchases_in_interval,spend_minor_in_interval,consecutive_failures FROM auto_topup_states`;
			expect(state.purchases_in_interval).toBe(1);
			expect(Number(state.spend_minor_in_interval)).toBeGreaterThan(0);
			expect(state.consecutive_failures).toBe(0);
			expect(
				await context.sql`SELECT id FROM domain_events WHERE type='auto_topup.failed'`,
			).toHaveLength(0);
			expect(charges).toBe(1);
		} finally {
			await context.sql.unsafe(`DROP TRIGGER block_topup_credit ON balance_allocations`);
			await context.sql.unsafe(`DROP FUNCTION block_topup_credit()`);
		}
		expect(await worker().runOnce()).toMatchObject({ claimed: 0 });
		const project = integrationProjectContext();
		const report = await readAutoTopupReviews(context.db as never, project.projectInstanceId);
		expect(report.jobs).toHaveLength(1);
		const review = report.jobs[0];
		if (!review) throw new Error("Missing reviewed job");
		expect(review).toMatchObject({
			phase: "complete",
			has_paid_receipt: true,
			completion_attempts: 10,
		});
		const erasure = await context.repository.customerErasures.previewCustomerErasure(
			project,
			"topup-account-0",
		);
		expect(erasure.blockers).toContainEqual({ kind: "auto_topup_job", count: 1 });
		await context.sql`UPDATE provider_customers SET external_customer_id='cus_review' WHERE customer_id IN (SELECT id FROM customers WHERE billing_account_id='topup-account-0')`;
		const [link] = await context.sql<
			{ external_customer_id: string }[]
		>`SELECT pc.external_customer_id FROM provider_customers pc JOIN customers c ON c.id=pc.customer_id WHERE c.billing_account_id='topup-account-0'`;
		if (!link) throw new Error("Missing Stripe link");
		await expect(
			context.repository.providerCustomerUnlinks.unlinkProviderCustomer(project, {
				billingAccountId: "topup-account-0",
				provider: "stripe",
				externalCustomerId: link.external_customer_id,
				reason: "Review must prevent unlink",
				actor: "test",
				idempotencyKey: "review-unlink",
			}),
		).rejects.toMatchObject({ code: "PROVIDER_CUSTOMER_LINK_IN_USE" });
		await context.sql`UPDATE auto_topup_states SET cooldown_until=now()-interval '1 second',interval_started_at=now()-interval '2 days'`;
		await context.repository.consumeUsage(project, {
			billingAccountId: "topup-account-0",
			featureKey: "ai_credits",
			quantity: "1",
			idempotencyKey: "review-blocks-new-job",
		});
		expect(await context.sql`SELECT id FROM auto_topup_jobs`).toHaveLength(1);
		expect(
			await resumeAutoTopupReview(context.db as never, project.projectInstanceId, review.id),
		).toEqual({
			jobId: review.id,
			status: "resumed",
		});
		expect(
			await resumeAutoTopupReview(context.db as never, project.projectInstanceId, review.id),
		).toEqual({
			jobId: review.id,
			status: "unchanged",
		});
		const [resumed] =
			await context.sql`SELECT budget_interval_started_at,provider_result,completion_attempts FROM auto_topup_jobs`;
		expect(resumed.budget_interval_started_at).toEqual(review.budget_interval_started_at);
		expect(resumed.provider_result.status).toBe("succeeded");
		expect(resumed.completion_attempts).toBe(0);
		// Completion must survive disabling the policy or a missing provider connection after payment.
		await context.sql`UPDATE auto_topup_policies SET active=false`;
		await context.sql`UPDATE auto_topup_jobs SET next_attempt_at=now()`;
		expect(await worker().runOnce()).toMatchObject({ claimed: 1, succeeded: 1 });
		expect(await worker().runOnce()).toMatchObject({ claimed: 0 });
		expect(charges).toBe(1);
		expect(
			await context.sql`SELECT id FROM balance_allocations WHERE source_kind='topup'`,
		).toHaveLength(1);
		expect(
			await context.sql`SELECT id FROM domain_events WHERE type='auto_topup.succeeded'`,
		).toHaveLength(1);
	});
	it("recovers a payment whose response was lost from the saved invoice without creating another", async () => {
		await seedAutoTopupJobs(context.sql, context.repository, 1);
		const config = {
			apiVersion: STRIPE_API_VERSION,
			secretKey: "sk_test_recovery",
			webhookSecret: "whsec_test",
			checkoutSuccessUrl: "https://example.test/success",
			checkoutCancelUrl: "https://example.test/cancel",
			portalReturnUrl: "https://example.test/billing",
		};
		const client = new FakeStripeBillingClient(config, { defaultPaymentMethod: "pm_saved" });
		let creates = 0;
		let payments = 0;
		const create = client.createInvoice.bind(client);
		client.createInvoice = async (...args) => {
			creates++;
			if (creates > 1) throw new Error("A new invoice must not be created on recovery");
			return create(...args);
		};
		const pay = client.payInvoice.bind(client);
		client.payInvoice = async (...args) => {
			payments++;
			await pay(...args);
			throw new Error("Payment response lost");
		};
		const provider = new StripeBillingService({
			config,
			client,
			repository: context.repository.forProject(integrationProjectContext()),
		});
		const worker = () =>
			new AutoTopupWorker({
				workerId: "recover-worker",
				projectContextResolver: context.projectContextResolver,
				repository: context.repository,
				leaseHeartbeatTimers: heartbeatTimers().timers,
				adapterForJob: () => wrapStripeService(provider),
				logger: { error() {} },
			});
		expect(await worker().runOnce()).toMatchObject({ claimed: 1, succeeded: 0, retryScheduled: 1 });
		const [saved] =
			await context.sql`SELECT external_invoice_id,provider_result,budget_reserved_at FROM auto_topup_jobs`;
		expect(saved.external_invoice_id).not.toBeNull();
		expect(saved.provider_result).toBeNull();
		expect(saved.budget_reserved_at).not.toBeNull();
		await context.sql`UPDATE auto_topup_jobs SET next_attempt_at=now()`;
		expect(await worker().runOnce()).toMatchObject({ claimed: 1, succeeded: 1 });
		expect(creates).toBe(1);
		expect(payments).toBe(1);
	});
	it("credits a paid recovery exactly once after a short safety interval rolls", async () => {
		await seedAutoTopupJobs(context.sql, context.repository, 1);
		await context.sql`UPDATE auto_topup_policies SET limit_interval_seconds=60`;
		await context.sql`UPDATE auto_topup_states SET interval_started_at=clock_timestamp()-interval '59 seconds'`;
		const [job] = await context.repository.claimAutoTopupJobs("before-roll", 1, 300_000);
		if (!job) throw new Error("Missing job");
		const receipt = {
			status: "succeeded" as const,
			externalInvoiceId: "in_roll",
			externalPaymentId: "pi_roll",
			amountPaidMinor: job.amountMinor,
			currency: job.currency,
		};
		await context.repository.checkpointAutoTopup(job.projectId, job.jobId, "before-roll", {
			invoiceId: "in_roll",
			result: receipt,
		});
		await context.repository.retryAutoTopupCompletion(
			job.projectId,
			job.jobId,
			"before-roll",
			"local failure",
			0,
		);
		const [before] = await context.sql`SELECT budget_interval_started_at FROM auto_topup_jobs`;
		await context.sql`SELECT pg_sleep(1.05)`;
		const [recovered] = await context.repository.claimAutoTopupJobs("after-roll", 1, 300_000);
		expect(recovered?.phase).toBe("complete");
		const [after] = await context.sql`SELECT budget_interval_started_at FROM auto_topup_jobs`;
		expect(after.budget_interval_started_at).toEqual(before.budget_interval_started_at);
		await context.repository.markAutoTopupSucceeded(
			job.projectId,
			job.jobId,
			"after-roll",
			receipt,
		);
		await context.repository.markAutoTopupSucceeded(
			job.projectId,
			job.jobId,
			"after-roll",
			receipt,
		);
		const [state] =
			await context.sql`SELECT purchases_in_interval,spend_minor_in_interval FROM auto_topup_states`;
		expect(state.purchases_in_interval).toBe(1);
		expect(Number(state.spend_minor_in_interval)).toBe(job.amountMinor);
		expect(
			await context.sql`SELECT id FROM balance_allocations WHERE source_kind='topup'`,
		).toHaveLength(1);
	});
	it.each(["card decline", "finalization decline", "before collection"])(
		"counts %s failures through the normal circuit and releases the budget",
		async (failure) => {
			await seedAutoTopupJobs(context.sql, context.repository, 1);
			const client = new FakeStripeBillingClient(providerConfig);
			let calls = 0;
			if (failure === "card decline")
				client.payInvoice = async () => {
					calls++;
					throw Object.assign(new Error("Card declined"), {
						type: "StripeCardError",
						code: "card_declined",
						payment_intent: { id: "pi_decline" },
					});
				};
			else if (failure === "finalization decline")
				client.finalizeInvoice = async () => {
					calls++;
					throw Object.assign(new Error("Card declined while finalizing"), {
						type: "StripeCardError",
						code: "card_declined",
					});
				};
			else
				client.addInvoiceLines = async () => {
					calls++;
					throw new Error("Line request failed");
				};
			const worker = providerWorker(client);
			for (let attempt = 0; attempt < 3; attempt++) {
				await context.sql`UPDATE auto_topup_jobs SET next_attempt_at=clock_timestamp()`;
				expect(await worker.runOnce()).toMatchObject({
					claimed: 1,
					failed: 1,
					retryScheduled: attempt === 2 ? 0 : 1,
					circuitOpened: attempt === 2 ? 1 : 0,
				});
			}
			const [job] =
				await context.sql`SELECT status,phase,completion_attempts,budget_reserved_at,budget_interval_started_at FROM auto_topup_jobs`;
			expect(job).toMatchObject({
				status: "failed",
				phase: "charge",
				completion_attempts: 0,
				budget_reserved_at: null,
				budget_interval_started_at: null,
			});
			const [state] =
				await context.sql`SELECT status,consecutive_failures,purchases_in_interval,spend_minor_in_interval FROM auto_topup_states`;
			expect(state).toMatchObject({
				status: "suspended",
				consecutive_failures: 3,
				purchases_in_interval: 0,
			});
			expect(Number(state.spend_minor_in_interval)).toBe(0);
			expect(
				await context.sql`SELECT id FROM domain_events WHERE type='auto_topup.failed'`,
			).toHaveLength(1);
			expect(calls).toBe(3);
		},
	);
	it("inspects an unknown payment without paying again and parks the tenth failed recovery", async () => {
		await seedAutoTopupJobs(context.sql, context.repository, 1);
		const client = new FakeStripeBillingClient(providerConfig);
		let payments = 0;
		client.payInvoice = async () => {
			payments++;
			throw new Error("Unknown provider response");
		};
		const worker = providerWorker(client);
		for (let attempt = 0; attempt < 10; attempt++) {
			await context.sql`UPDATE auto_topup_jobs SET next_attempt_at=clock_timestamp()`;
			expect(await worker.runOnce()).toMatchObject({
				claimed: 1,
				retryScheduled: attempt === 9 ? 0 : 1,
			});
		}
		const [job] =
			await context.sql`SELECT status,phase,budget_reserved_at,provider_result,completion_attempts FROM auto_topup_jobs`;
		expect(job).toMatchObject({
			status: "requires_review",
			phase: "reconcile",
			provider_result: null,
			completion_attempts: 10,
		});
		expect(job.budget_reserved_at).not.toBeNull();
		expect(payments).toBe(1);
		expect(await worker.runOnce()).toMatchObject({ claimed: 0 });
		expect(
			await context.sql`SELECT id FROM domain_events WHERE type='auto_topup.failed'`,
		).toHaveLength(0);
	});
});
