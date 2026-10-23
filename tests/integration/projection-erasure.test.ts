import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import type { CustomerErasureInput } from "../../src/billing/customer-erasures";
import type { ProjectionJobPayload } from "../../src/billing/types";
import { configureErasureKeyring } from "../../src/db/erasure-keyring";
import { CustomerErasureRepository } from "../../src/db/repository/customer-erasures";
import {
	enqueueProjectionSyncJob,
	enqueueUsageProjection,
} from "../../src/db/repository/entitlements";
import { resolveUsageCustomer } from "../../src/db/repository/identities";
import type {
	ProjectionSyncJobRow,
	QueryExecutor,
	TransactionalQueryExecutor,
} from "../../src/db/repository/types";
import { erasureKeyFromBase64 } from "../../src/shared/erasure-digest";
import { createDeferred } from "../helpers/deferred";
import { renderDrizzleSql } from "../helpers/drizzle-sql";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";
import { createRecordingProjectionFetch, runProjectionWorkerOnce } from "./helpers/worker-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
const projectId = project.projectInstanceId;
const key = erasureKeyFromBase64("projection-erasure", Buffer.alloc(32, 21).toString("base64"));
const runOptions = {
	workerId: "erasure-worker",
	batchSize: 100,
	budgetMs: 10_000,
	leaseSeconds: 60,
};
let context: LocalPostgresContext;
type EnqueueKind = "usage" | "stored";

localDescribe("projection erasure finality", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		configureErasureKeyring({ current: key, previous: null }, 30);
		await context.sql`UPDATE metering_settings SET projection_usage_debounce_ms = 0`;
	});
	afterEach(() => {
		configureErasureKeyring(null);
	});
	afterAll(async () => {
		await context.sql.close();
	});

	it.each(["usage", "stored"] as const)(
		"suppresses a late %s enqueue after deletion and before verification",
		async (kind) => {
			const account = await createAccount();
			const remembered = createDeferred();
			const resume = createDeferred();
			const late = database().transaction(async (tx) => {
				const customer = await resolveUsageCustomer(tx, projectId, account.billingAccountId);
				remembered.resolve();
				await resume.promise;
				await enqueue(kind, tx, customer.id, account.billingAccountId);
			});
			try {
				await remembered.promise;
				const request = await context.repository.customerErasures.requestCustomerErasure(
					project,
					erasureInput(account.billingAccountId),
				);
				let resumed = false;
				const erasures = new CustomerErasureRepository(
					intercept({
						before: async (query) => {
							if (!resumed && query.startsWith("SELECT id FROM customers")) {
								resumed = true;
								expect(await projectionCount(account.id)).toBe(0);
								resume.resolve();
								await late;
							}
						},
					}),
				);
				expect((await erasures.runNextCustomerErasure(runOptions)).kind).toBe("completed");
				expect(resumed).toBe(true);
				expect(await projectionCount(account.id)).toBe(0);
				expect((await erasures.getCustomerErasure(project, request.erasure.id)).state).toBe(
					"completed",
				);
				const recording = createRecordingProjectionFetch();
				expect(
					await runProjectionWorkerOnce({
						env: context.env,
						repository: context.repository,
						fetch: recording.fetch,
					}),
				).toEqual({ claimed: 0, succeeded: 0, failed: 0, skipped: 0 });
				expect(recording.requests).toEqual([]);
			} finally {
				resume.resolve();
				await late;
			}
		},
	);

	it.each(["usage", "stored"] as const)(
		"keeps a %s enqueue locked until commit before admitting erasure",
		async (kind) => {
			const account = await createAccount();
			const enqueued = createDeferred();
			const commit = createDeferred();
			const write = database().transaction(async (tx) => {
				await enqueue(kind, tx, account.id, account.billingAccountId);
				enqueued.resolve();
				await commit.promise;
			});
			let erase: ReturnType<CustomerErasureRepository["requestCustomerErasure"]> | undefined;
			try {
				await enqueued.promise;
				erase = context.repository.customerErasures.requestCustomerErasure(
					project,
					erasureInput(account.billingAccountId),
				);
				await waitForLock("SELECT id, billing_account_id FROM customers");
				commit.resolve();
				await write;
				const request = await erase;
				expect(request.erasure.state).toBe("running");
				expect(await projectionCount(account.id)).toBe(1);
				expect(
					(await context.repository.customerErasures.runNextCustomerErasure(runOptions)).kind,
				).toBe("completed");
				expect(await projectionCount(account.id)).toBe(0);
			} finally {
				commit.resolve();
				await write;
				await erase;
			}
		},
	);

	it.each(["usage", "stored"] as const)(
		"waits for an earlier erasure lock before checking a %s enqueue",
		async (kind) => {
			const account = await createAccount();
			const locked = createDeferred();
			const freeze = createDeferred();
			const erasures = new CustomerErasureRepository(
				intercept({
					after: async (query) => {
						if (query.startsWith("SELECT id, billing_account_id FROM customers")) {
							locked.resolve();
							await freeze.promise;
						}
					},
				}),
			);
			const erase = erasures.requestCustomerErasure(
				project,
				erasureInput(account.billingAccountId),
			);
			let write: Promise<unknown> | undefined;
			try {
				await locked.promise;
				write = database().transaction((tx) =>
					enqueue(kind, tx, account.id, account.billingAccountId),
				);
				await waitForLock(
					kind === "usage"
						? "INSERT INTO projection_sync_jobs"
						: "SELECT c.project_id, c.erased_at",
				);
				freeze.resolve();
				await erase;
				await write;
				expect(await projectionCount(account.id)).toBe(0);
				const [customer] =
					await context.sql`SELECT projection_sequence FROM customers WHERE id = ${account.id}`;
				expect(Number(customer.projection_sequence)).toBe(0);
			} finally {
				freeze.resolve();
				await erase;
				await write;
			}
		},
	);

	for (const kind of ["stored", "usage", "usage_retry"] as const) {
		it.each([false, true])(
			`skips a claimed ${kind} payload after freeze (deleted before delivery: %s)`,
			async (deleted) => {
				const account = await createAccount();
				await database().transaction((tx) =>
					enqueue(kind === "stored" ? "stored" : "usage", tx, account.id, account.billingAccountId),
				);
				if (kind === "usage_retry") {
					const [job] = await context.repository.claimProjectionSyncJobs("crashed-worker", 1);
					await context.repository.buildUsageProjection(projectId, account.id, {
						jobId: job.id,
						workerId: "crashed-worker",
					});
					await context.sql`UPDATE projection_sync_jobs SET status = 'pending', locked_at = NULL, locked_by = NULL WHERE id = ${job.id}`;
				}
				const frozen = createDeferred();
				const commit = createDeferred();
				let jobs: ProjectionSyncJobRow[] = [];
				const erasures = new CustomerErasureRepository(
					intercept({
						before: async (query) => {
							if (query.startsWith("UPDATE customers SET billing_account_id")) {
								jobs = await context.repository.claimProjectionSyncJobs("projection-worker", 1);
							}
						},
						after: async (query) => {
							if (query.startsWith("UPDATE customers SET billing_account_id")) {
								frozen.resolve();
								await commit.promise;
							}
						},
					}),
				);
				const erase = erasures.requestCustomerErasure(
					project,
					erasureInput(account.billingAccountId),
				);
				let delivery: ReturnType<typeof deliverCaptured> | undefined;
				try {
					await frozen.promise;
					expect(jobs).toHaveLength(1);
					if (deleted) {
						commit.resolve();
						await erase;
						expect(
							(await context.repository.customerErasures.runNextCustomerErasure(runOptions)).kind,
						).toBe("completed");
						delivery = deliverCaptured(jobs);
					} else {
						delivery = deliverCaptured(jobs);
						await waitForLock("FOR SHARE OF customer");
						commit.resolve();
						await erase;
					}
					const result = await delivery;
					expect(result.run).toEqual({ claimed: 1, succeeded: 0, failed: 0, skipped: 1 });
					expect(result.requests).toEqual([]);
					if (!deleted) {
						const [parked] =
							await context.sql`SELECT status, locked_by, next_attempt_at = 'infinity' AS parked FROM projection_sync_jobs WHERE id = ${jobs[0].id}`;
						expect(parked).toEqual({ status: "pending", locked_by: null, parked: true });
						expect(
							(await context.repository.customerErasures.runNextCustomerErasure(runOptions)).kind,
						).toBe("completed");
					}
					expect(await projectionCount(account.id)).toBe(0);
				} finally {
					commit.resolve();
					await erase;
					await delivery;
				}
			},
		);
	}

	it("blocks erasure after delivery admission without holding a transaction during HTTP", async () => {
		const account = await createAccount();
		await database().transaction((tx) =>
			enqueue("stored", tx, account.id, account.billingAccountId),
		);
		const sending = createDeferred();
		const acknowledge = createDeferred();
		const delivery = runProjectionWorkerOnce({
			env: context.env,
			repository: context.repository,
			fetch: async () => {
				sending.resolve();
				await acknowledge.promise;
				return Response.json({ success: true });
			},
		});
		try {
			await sending.promise;
			await expect(
				context.repository.customerErasures.requestCustomerErasure(
					project,
					erasureInput(account.billingAccountId),
				),
			).rejects.toMatchObject({ code: "CUSTOMER_ERASURE_BLOCKED" });
			acknowledge.resolve();
			expect(await delivery).toEqual({ claimed: 1, succeeded: 1, failed: 0, skipped: 0 });
			await context.repository.customerErasures.requestCustomerErasure(
				project,
				erasureInput(account.billingAccountId),
			);
			expect(
				(await context.repository.customerErasures.runNextCustomerErasure(runOptions)).kind,
			).toBe("completed");
		} finally {
			acknowledge.resolve();
			await delivery;
		}
	});

	it("never advances sequence or materializes usage for a frozen customer", async () => {
		const account = await createAccount();
		await context.repository.customerErasures.requestCustomerErasure(
			project,
			erasureInput(account.billingAccountId),
		);
		await expect(context.repository.buildUsageProjection(projectId, account.id)).rejects.toThrow(
			"projection sequence customer",
		);
		const [customer] =
			await context.sql`SELECT projection_sequence FROM customers WHERE id = ${account.id}`;
		expect(Number(customer.projection_sequence)).toBe(0);
	});

	it("skips lost claims and wrong project selectors without changing another worker's lease", async () => {
		const account = await createAccount();
		await database().transaction((tx) =>
			enqueue("stored", tx, account.id, account.billingAccountId),
		);
		const jobs = await context.repository.claimProjectionSyncJobs("projection-worker", 1);
		await context.sql`UPDATE projection_sync_jobs SET locked_by = 'replacement-worker' WHERE id = ${jobs[0].id}`;
		const result = await deliverCaptured(jobs);
		expect(result.run.skipped).toBe(1);
		expect(result.requests).toEqual([]);
		expect(
			await context.repository.prepareProjectionSyncJobDelivery(
				integrationProjectContext("globex").projectInstanceId,
				jobs[0].id,
				"replacement-worker",
			),
		).toBe("skipped");
		const [owned] =
			await context.sql`SELECT status, locked_by FROM projection_sync_jobs WHERE id = ${jobs[0].id}`;
		expect(owned).toEqual({ status: "processing", locked_by: "replacement-worker" });
	});

	it("filters erased pending and stale jobs before bounding candidates", async () => {
		const account = await createAccount();
		await context.repository.customerErasures.requestCustomerErasure(
			project,
			erasureInput(account.billingAccountId),
		);
		await context.sql`INSERT INTO projection_sync_jobs (project_id, customer_id, idempotency_key, reason, payload, status, next_attempt_at, locked_at, locked_by)
			SELECT ${projectId}, ${account.id}, 'legacy:' || n, 'usage_changed', NULL,
				CASE WHEN n <= 15 THEN 'pending' ELSE 'processing' END, now() - interval '1 day', now() - interval '1 day', 'old-worker'
			FROM generate_series(1, 30) n`;
		const other = integrationProjectContext("globex");
		const live = await createAccount("live-account", other.projectInstanceId);
		await database().transaction((tx) =>
			enqueueUsageProjection(tx, { projectId: other.projectInstanceId, customerId: live.id }),
		);
		const jobs = await context.repository.claimProjectionSyncJobs("live-worker", 1);
		expect(jobs.map((job) => job.customer_id)).toEqual([live.id]);
		const [legacy] =
			await context.sql`SELECT count(*)::int AS count FROM projection_sync_jobs WHERE customer_id = ${account.id} AND locked_by = 'old-worker'`;
		expect(legacy.count).toBe(30);
	});

	it("fails verification for every residual projection status and payload, then cleans them on replay", async () => {
		const account = await createAccount();
		const input = erasureInput(account.billingAccountId);
		const request = await context.repository.customerErasures.requestCustomerErasure(
			project,
			input,
		);
		for (const status of ["pending", "processing", "failed", "succeeded"]) {
			const payload =
				status === "pending" || status === "processing"
					? null
					: JSON.stringify({ ...storedPayload("rewritten-id"), reason: "usage_changed" });
			await context.sql`INSERT INTO projection_sync_jobs (project_id, customer_id, idempotency_key, reason, payload, status)
				VALUES (${projectId}, ${account.id}, ${status}, 'usage_changed', ${payload}::text::jsonb, ${status})`;
		}
		await context.sql`UPDATE customer_erasures SET cursor = '{"step":"verify"}'::jsonb WHERE id = ${request.erasure.id}`;
		expect(
			(await context.repository.customerErasures.runNextCustomerErasure(runOptions)).kind,
		).toBe("failed");
		const failed = await context.repository.customerErasures.getCustomerErasure(
			project,
			request.erasure.id,
		);
		expect(failed).toMatchObject({
			state: "failed",
			lastError: "RESIDUAL_ROWS",
			counts: { "residual.projection_sync_jobs": 4 },
		});
		const [receipt] =
			await context.sql`SELECT subject_id, completed_at FROM customer_erasures WHERE id = ${request.erasure.id}`;
		expect(receipt).toEqual({ subject_id: account.billingAccountId, completed_at: null });
		await context.repository.customerErasures.requestCustomerErasure(project, input);
		expect(
			(await context.repository.customerErasures.runNextCustomerErasure(runOptions)).kind,
		).toBe("completed");
		expect(await projectionCount(account.id)).toBe(0);
	});

	it("runs the historical cleanup in bounded batches, skips locks and preserves active accounts", async () => {
		const guide = await Bun.file(new URL("../../docs/operations.md", import.meta.url)).text();
		const cleanup = guide.match(/```sql\n(-- Erased projection cleanup batch[\s\S]*?)\n```/)?.[1];
		if (cleanup === undefined) throw new Error("Missing historical projection cleanup SQL");
		const account = await createAccount();
		const request = await context.repository.customerErasures.requestCustomerErasure(
			project,
			erasureInput(account.billingAccountId),
		);
		expect(
			(await context.repository.customerErasures.runNextCustomerErasure(runOptions)).kind,
		).toBe("completed");
		const live = await createAccount("live-account");
		await database().transaction((tx) => enqueue("stored", tx, live.id, live.billingAccountId));
		await context.sql`INSERT INTO projection_sync_jobs (project_id, customer_id, idempotency_key, reason, payload, status)
			SELECT ${projectId}, ${account.id}, 'legacy:' || n, 'provider_webhook', ${JSON.stringify(storedPayload(account.billingAccountId))}::text::jsonb,
				CASE n % 4 WHEN 0 THEN 'pending' WHEN 1 THEN 'processing' WHEN 2 THEN 'failed' ELSE 'succeeded' END
			FROM generate_series(1, 501) n`;
		const locked = createDeferred();
		const release = createDeferred();
		const hold = database().transaction(async (tx) => {
			await tx.execute(
				drizzleSql`SELECT id FROM projection_sync_jobs WHERE customer_id = ${account.id} ORDER BY id LIMIT 1 FOR UPDATE`,
			);
			locked.resolve();
			await release.promise;
		});
		const batch = async () => {
			const [row] = await context.sql.unsafe<{ deleted: string }[]>(cleanup);
			return Number(row.deleted);
		};
		try {
			await locked.promise;
			expect(await batch()).toBe(500);
			expect(await batch()).toBe(0);
			expect(await projectionCount(account.id)).toBe(1);
			release.resolve();
			await hold;
			expect(await batch()).toBe(1);
			expect(await batch()).toBe(0);
			expect(await projectionCount(account.id)).toBe(0);
			expect(await projectionCount(live.id)).toBe(1);
			expect(
				(await context.repository.customerErasures.getCustomerErasure(project, request.erasure.id))
					.state,
			).toBe("completed");
		} finally {
			release.resolve();
			await hold;
		}
	});

	it("preserves accounting when usage and provider-style grants enqueue concurrently", async () => {
		await publishAiCreditsCatalog(context.repository);
		const billingAccountId = "concurrent-account";
		await context.repository.grantAllocation(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity: "100",
			sourceKind: "credit_grant",
			sourceKey: "seed",
		});
		const results = await Promise.all(
			Array.from({ length: 4 }, async (_, index) => {
				const [usage] = await Promise.all([
					context.repository.consumeUsage(project, {
						billingAccountId,
						featureKey: "model_tokens",
						quantity: "100",
						idempotencyKey: `usage-${index}`,
					}),
					context.repository.grantAllocation(project, {
						billingAccountId,
						featureKey: "ai_credits",
						quantity: "1",
						sourceKind: "credit_grant",
						sourceKey: `grant-${index}`,
					}),
				]);
				return usage;
			}),
		);
		expect(results.every((result) => result.allowed)).toBe(true);
		const [facts] =
			await context.sql`SELECT (SELECT count(*)::int FROM usage_events) AS usage, (SELECT count(*)::int FROM balance_allocations) AS grants, (SELECT count(*)::int FROM projection_sync_jobs WHERE payload IS NULL) AS jobs`;
		expect(facts).toEqual({ usage: 4, grants: 5, jobs: 1 });
	});
});

function database(): TransactionalQueryExecutor {
	return context.db as never;
}

function intercept(hooks: {
	before?: (query: string) => Promise<void>;
	after?: (query: string) => Promise<void>;
}): TransactionalQueryExecutor {
	const wrap = (executor: QueryExecutor): QueryExecutor => ({
		async execute<T>(query: DrizzleSQL) {
			const statement = renderDrizzleSql(query)
				.split("\n-- params:")[0]
				.replace(/\s+/g, " ")
				.trim();
			await hooks.before?.(statement);
			const rows = await executor.execute<T>(query);
			await hooks.after?.(statement);
			return rows;
		},
	});
	return {
		...wrap(database()),
		transaction: (callback) => database().transaction((tx) => callback(wrap(tx))),
	};
}

async function createAccount(billingAccountId = "erasure-account", instanceId = projectId) {
	const [row] = await context.sql<
		{ id: string }[]
	>`INSERT INTO customers (project_id, billing_account_id) VALUES (${instanceId}, ${billingAccountId}) RETURNING id`;
	return { id: row.id, billingAccountId };
}

function erasureInput(billingAccountId: string): CustomerErasureInput {
	return {
		billingAccountId,
		basis: "data_subject_request",
		reference: null,
		actor: "operator:projection-test",
		idempotencyKey: `erase:${billingAccountId}`,
		acknowledge: [],
	};
}

function storedPayload(billingAccountId: string): ProjectionJobPayload {
	const generatedAt = new Date().toISOString();
	return {
		billingAccountId,
		generatedAt,
		reason: "provider_webhook",
		entitlements: { billingAccountId, generatedAt, entitlements: [] },
		balances: [],
		sequence: 1,
	};
}

async function enqueue(
	kind: EnqueueKind,
	executor: QueryExecutor,
	customerId: string,
	billingAccountId: string,
) {
	if (kind === "usage") return await enqueueUsageProjection(executor, { projectId, customerId });
	return await enqueueProjectionSyncJob(executor, {
		customerId,
		idempotencyKey: "stored-projection",
		reason: "provider_webhook",
		payload: storedPayload(billingAccountId),
	});
}

async function projectionCount(customerId: string): Promise<number> {
	const [row] =
		await context.sql`SELECT count(*)::int AS count FROM projection_sync_jobs WHERE customer_id = ${customerId}`;
	return row.count;
}

async function waitForLock(queryPart: string): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const [row] =
			await context.sql`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND position(${queryPart} in query) > 0`;
		if (row.waiting > 0) return;
		await Bun.sleep(5);
	}
	throw new Error(`Expected a database lock wait for ${queryPart}`);
}

async function deliverCaptured(jobs: ProjectionSyncJobRow[]) {
	const repository = context.repository;
	const recording = createRecordingProjectionFetch();
	const run = await runProjectionWorkerOnce({
		env: context.env,
		workerId: "projection-worker",
		fetch: recording.fetch,
		repository: {
			claimProjectionSyncJobs: async () => jobs,
			prepareProjectionSyncJobDelivery:
				repository.prepareProjectionSyncJobDelivery.bind(repository),
			buildUsageProjection: repository.buildUsageProjection.bind(repository),
			markProjectionSyncJobSucceeded: repository.markProjectionSyncJobSucceeded.bind(repository),
			markProjectionSyncJobFailed: repository.markProjectionSyncJobFailed.bind(repository),
		},
	});
	return { run, requests: recording.requests };
}
