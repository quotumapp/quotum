import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { wrapStripeService } from "../../src/providers/stripe/adapter";
import { STRIPE_API_VERSION } from "../../src/providers/stripe/client";
import { StripeBillingService } from "../../src/providers/stripe/service";
import { FakeStripeBillingClient } from "../../src/providers/stripe/testing/fake-client";
import { AutoTopupWorker } from "../../src/workers/auto-topup";
import { RecurringBillingWorker } from "../../src/workers/recurring-billing";
import { createDeferred } from "../helpers/deferred";
import { heartbeatTimers } from "../helpers/heartbeat-timers";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import {
	seedAutoTopupJobs,
	seedSubscriptionChanges,
	seedUsageInvoicePeriods,
} from "./helpers/queue-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
const tables = {
	topup: "auto_topup_jobs",
	change: "subscription_changes",
	period: "usage_invoice_periods",
	adjustment: "usage_invoice_adjustments",
} as const;
type Kind = keyof typeof tables;
const kinds: Kind[] = ["topup", "change", "period", "adjustment"];
const timing = { payment: { kind: "collected" }, entitlement: { kind: "unchanged" } } as const;
let context: LocalPostgresContext;

localDescribe("Billing worker lease protection", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});
	afterAll(async () => {
		await context.sql.close();
	});

	it.each(["topup", "period"] as const)(
		"replays one %s invoice after payment succeeds but persistence fails",
		async (kind) => {
			await seed(kind, 1);
			const config = {
				apiVersion: STRIPE_API_VERSION,
				secretKey: "sk_test_lease",
				webhookSecret: "whsec_lease",
				checkoutSuccessUrl: "https://example.test/success",
				checkoutCancelUrl: "https://example.test/cancel",
				portalReturnUrl: "https://example.test/billing",
			};
			const client = new FakeStripeBillingClient(config, { defaultPaymentMethod: "pm_default" });
			const invoiceIds = new Set<string>();
			const createInvoice = client.createInvoice.bind(client);
			client.createInvoice = async (...args) => {
				const invoice = await createInvoice(...args);
				invoiceIds.add(invoice.id);
				return invoice;
			};
			const provider = new StripeBillingService({
				config,
				client,
				repository: context.repository.forProject(project),
			});
			// Simulate a process losing its database after the successful external payment: neither
			// completion nor the fallback failure marker may persist before the next worker claims it.
			const unavailableMarkers = new Set<PropertyKey>([
				"markAutoTopupSucceeded",
				"markAutoTopupFailed",
				"markUsageInvoiceSucceeded",
				"markUsageInvoiceFailed",
			]);
			const disconnected = new Proxy(context.repository, {
				get(target, property) {
					if (unavailableMarkers.has(property))
						return async () => {
							throw new Error("database disconnected");
						};
					const value = Reflect.get(target, property);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			const clock = heartbeatTimers();
			const run = (workerId: string, repository = context.repository) => {
				const options = {
					workerId,
					repository,
					projectContextResolver: context.projectContextResolver,
					adapterForJob: () => wrapStripeService(provider),
					logger: { error() {} },
					leaseHeartbeatTimers: clock.timers,
				};
				return kind === "topup"
					? new AutoTopupWorker(options).runOnce()
					: new RecurringBillingWorker(options).runOnce();
			};
			if (kind === "topup")
				await expect(run("worker-a", disconnected)).rejects.toThrow("database disconnected");
			else
				expect(await run("worker-a", disconnected)).toMatchObject({
					failed: 1,
					usageInvoicesCreated: 0,
				});
			expect(clock.active).toBe(0);
			await expire(kind);
			expect(await run("worker-b")).toMatchObject(
				kind === "topup" ? { succeeded: 1 } : { usageInvoicesCreated: 1 },
			);
			expect(client.invoiceCreateParams).toHaveLength(2);
			expect(invoiceIds.size).toBe(1);
			expect(clock.active).toBe(0);
			if (kind === "topup") {
				const [row] = await context.sql<
					{ purchases: number; allocations: number; charged: number }[]
				>`
				SELECT (SELECT count(*)::integer FROM purchases) AS purchases,
					(SELECT count(*)::integer FROM balance_allocations WHERE source_kind = 'topup') AS allocations,
					charged_amount_minor::integer AS charged FROM auto_topup_jobs
			`;
				expect(row).toEqual({ purchases: 1, allocations: 1, charged: 499 });
			}
		},
	);

	it.each(kinds)("keeps active and waiting %s jobs leased until the batch ends", async (kind) => {
		await seed(kind);
		const gate = createDeferred();
		const started = createDeferred();
		const clock = heartbeatTimers();
		let dispatched = 0;
		const block = async () => {
			dispatched++;
			started.resolve();
			await gate.promise;
		};
		const common = {
			workerId: "worker-a",
			repository: context.repository,
			projectContextResolver: context.projectContextResolver,
			leaseHeartbeatTimers: clock.timers,
			logger: { error() {} },
		};
		const worker =
			kind === "topup"
				? new AutoTopupWorker({
						...common,
						adapterForJob: () => ({
							topups: {
								async chargeAutomatic(job) {
									await block();
									return {
										status: "succeeded",
										externalInvoiceId: `in_${job.jobId}`,
										externalPaymentId: `pi_${job.jobId}`,
										amountPaidMinor: job.amountMinor,
										currency: job.currency,
										timing,
									};
								},
							},
						}),
					})
				: new RecurringBillingWorker({
						...common,
						adapterForJob: () => ({
							changes: {
								async apply(change) {
									await block();
									return {
										outcome: "committed",
										providerRequestId: change.externalSubscriptionId,
										timing,
									};
								},
							},
							settlement: {
								async collectFinalizedCharge(job) {
									await block();
									return { outcome: "committed", externalChargeId: `in_${job.jobId}`, timing };
								},
							},
						}),
					});
		const run = worker.runOnce();
		try {
			await Promise.race([
				started.promise,
				run.then(() => {
					throw new Error("Worker did not dispatch");
				}),
			]);
			await expire(kind);
			clock.tick();
			await waitUntil(async () => {
				const rows = await context.sql.unsafe<{ fresh: number }[]>(
					`SELECT count(*)::integer AS fresh FROM ${tables[kind]} WHERE status = 'processing' AND locked_at > now() - interval '1 minute'`,
				);
				return rows[0]?.fresh === 2;
			});
			expect(await claim(kind, "worker-b")).toEqual([]);
			expect(dispatched).toBe(1);
		} finally {
			gate.resolve();
			await run;
		}
		expect(dispatched).toBe(2);
		expect(clock.active).toBe(0);
		const rows = await context.sql.unsafe<{ id: string }[]>(`SELECT id::text FROM ${tables[kind]}`);
		for (const row of rows) expect(await renew(kind, row.id, "worker-a")).toBe(false);
	});

	it.each(kinds)(
		"allows abandoned %s claims to expire and fences their previous owner",
		async (kind) => {
			await seed(kind);
			const first = await claim(kind, "worker-a");
			expect(first).toHaveLength(2);
			await expire(kind);
			const second = await claim(kind, "worker-b");
			expect(new Set(second)).toEqual(new Set(first));
			for (const id of first) {
				expect(await renew(kind, id, "worker-a")).toBe(false);
				expect(
					await renew(kind, id, "worker-b", integrationProjectContext("globex").projectInstanceId),
				).toBe(false);
				expect(await renew(kind, id, "worker-b")).toBe(true);
				const repo = context.repository;
				const mark =
					kind === "topup"
						? repo.markAutoTopupSucceeded(project.projectInstanceId, id, "worker-a", {
								status: "succeeded",
								externalInvoiceId: "in_old",
								externalPaymentId: "pi_old",
								amountPaidMinor: 499,
								currency: "USD",
							})
						: kind === "change"
							? repo.markSubscriptionChangeApplied(
									project.projectInstanceId,
									id,
									"sub_old",
									"worker-a",
								)
							: repo.markUsageInvoiceSucceeded(
									project.projectInstanceId,
									kind,
									id,
									"in_old",
									"worker-a",
								);
				await expect(mark).rejects.toThrow(/(owned|locked)/);
			}
		},
	);
});

async function seed(kind: Kind, count = 2) {
	if (kind === "topup") return await seedAutoTopupJobs(context.sql, context.repository, count);
	if (kind === "change") return await seedSubscriptionChanges(context.sql, count);
	const periods = await seedUsageInvoicePeriods(context.sql, count);
	if (kind === "period") return periods;
	for (const id of periods) {
		await context.sql`UPDATE usage_invoice_periods SET status = 'invoiced', invoiced_at = now(), external_invoice_id = ${`in_${id}`} WHERE id = ${id}`;
		await context.sql`
			WITH event AS (
				INSERT INTO usage_events (project_id, customer_id, meter_feature_id, wallet_feature_id, operation, quantity, wallet_quantity, effective_at, rate_card_path)
				SELECT period.project_id, period.customer_id, item.feature_id, item.feature_id, 'consume', 1, 1, now(), 'direct'
				FROM usage_invoice_periods period JOIN plan_items item ON item.id = period.plan_item_id WHERE period.id = ${id}
				RETURNING id, recorded_at, project_id
			)
			INSERT INTO usage_invoice_adjustments (project_id, closed_period_id, usage_event_id, usage_event_recorded_at, quantity, amount_minor, currency)
			SELECT project_id, ${id}, id, recorded_at, -1, -100, 'USD' FROM event
		`;
	}
	return periods;
}

async function claim(kind: Kind, workerId: string): Promise<string[]> {
	const repo = context.repository;
	if (kind === "topup")
		return (await repo.claimAutoTopupJobs(workerId, 25, new Date(Date.now() - 300_000))).map(
			(job) => job.jobId,
		);
	if (kind === "change")
		return (await repo.claimSubscriptionChanges(workerId, 25)).map((job) => job.changeId);
	return (await repo.materializeAndClaimUsageInvoicePeriods(workerId, 25)).jobs.map(
		(job) => job.jobId,
	);
}

async function renew(
	kind: Kind,
	id: string,
	workerId: string,
	projectId = project.projectInstanceId,
) {
	const repo = context.repository;
	if (kind === "topup") return await repo.renewAutoTopupJobLease(projectId, id, workerId);
	if (kind === "change") return await repo.renewSubscriptionChangeLease(projectId, id, workerId);
	return await repo.renewUsageInvoiceJobLease(projectId, kind, id, workerId);
}

async function expire(kind: Kind) {
	await context.sql.unsafe(
		`UPDATE ${tables[kind]} SET locked_at = now() - interval '6 minutes' WHERE status = 'processing'`,
	);
}

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) throw new Error("Heartbeat did not refresh every claimed job");
		await Bun.sleep(10);
	}
}
