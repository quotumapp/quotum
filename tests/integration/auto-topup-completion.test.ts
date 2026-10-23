import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { wrapStripeService } from "../../src/providers/stripe/adapter";
import { STRIPE_API_VERSION } from "../../src/providers/stripe/client";
import { StripeBillingService } from "../../src/providers/stripe/service";
import { FakeStripeBillingClient } from "../../src/providers/stripe/testing/fake-client";
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
localDescribe("paid automatic top-up completion recovery", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});
	afterAll(() => context.sql.close());
	it("preserves a paid receipt and budget through persistent credit failures, then completes once", async () => {
		await seedAutoTopupJobs(context.sql, context.repository, 1);
		await context.sql`INSERT INTO webhook_endpoints(project_id,url,secret_envelope,created_by,idempotency_key,request_hash) VALUES(${integrationProjectContext().projectInstanceId},'https://events.example.test','{}'::jsonb,'test','completion-test',repeat('a',64))`;
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
			for (let i = 0; i < 4; i++) {
				await context.sql`UPDATE auto_topup_jobs SET next_attempt_at=now()`;
				expect(await worker().runOnce()).toMatchObject({
					claimed: 1,
					succeeded: 0,
					retryScheduled: 1,
				});
			}
			const [job] =
				await context.sql`SELECT status,budget_reserved_at,external_invoice_id,provider_result,completion_attempts FROM auto_topup_jobs`;
			expect(job).toMatchObject({
				status: "pending",
				external_invoice_id: "in_paid",
				completion_attempts: 4,
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
});
