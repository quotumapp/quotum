import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sha256Hex, stableJson } from "../../src/billing/decimal";
import {
	executeProviderOperation,
	type PrepareProviderOperation,
	RejectedProviderWrite,
	reconcileProviderOperation,
} from "../../src/billing/provider-operations";
import { ProviderOperationRecoveryWorker } from "../../src/workers/provider-operation-recovery";
import { projectContextResolver } from "../helpers/project-context";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
function intent(): PrepareProviderOperation {
	const id = crypto.randomUUID();
	return {
		billingAccountId: `operation-${id}`,
		provider: "stripe",
		providerAccountId: "acct_operation_test",
		connectionVersionId: crypto.randomUUID(),
		idempotencyKey: id,
		resourceKey: `customer:${id}`,
		operation: "checkout.create",
		request: { price: "price_test" },
		requestHash: sha256Hex(stableJson({ price: "price_test" })),
	};
}

localDescribe("durable provider operation recovery", () => {
	let context: LocalPostgresContext;
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	afterAll(async () => {
		await context.sql.close();
	});

	it("dispatches once across concurrent identical requests and replays the result", async () => {
		const input = intent();
		let writes = 0;
		const run = () =>
			executeProviderOperation({
				project,
				store: context.repository.providerOperations,
				intent: input,
				write: async () => {
					writes++;
					return { providerObjectId: "txn_concurrent", result: { id: "txn_concurrent" } };
				},
			});
		await Promise.all([run(), run(), run()]);
		expect(await run()).toMatchObject({
			status: "succeeded",
			attempts: 1,
			providerObjectId: "txn_concurrent",
		});
		expect(writes).toBe(1);
	});

	it("reconciles a lost create response without repeating the write", async () => {
		const input = intent();
		const store = context.repository.providerOperations;
		let writes = 0;
		const run = () =>
			executeProviderOperation({
				project,
				store,
				intent: input,
				write: async () => {
					writes++;
					throw new Error("The remote side succeeded but its response was lost");
				},
			});
		const receipt = await run();
		expect(receipt).toMatchObject({
			status: "reconciling",
			errorCode: "PROVIDER_OPERATION_UNCERTAIN",
		});
		await run();
		const lease = await store.claimReconciliation(project, input.billingAccountId, receipt.id);
		if (!lease) throw new Error("Expected reconciliation lease");
		await store.settle(project, lease, {
			status: "succeeded",
			providerObjectId: "txn_recovered",
			result: { recovered: true },
		});
		expect(await run()).toMatchObject({ status: "succeeded", providerObjectId: "txn_recovered" });
		expect(writes).toBe(1);
	});

	it("never redispatches expired in-flight work and fences its previous owner", async () => {
		const input = intent();
		const store = context.repository.providerOperations;
		const receipt = await store.prepare(project, input);
		const dispatch = await store.claimDispatch(project, input.billingAccountId, receipt.id);
		if (!dispatch) throw new Error("Expected dispatch lease");
		expect(await store.claimReconciliation(project, input.billingAccountId, receipt.id)).toBeNull();
		await context.sql`UPDATE provider_operations SET lease_until = clock_timestamp() - interval '1 second' WHERE project_id = ${project.projectInstanceId} AND id = ${receipt.id}`;
		expect(await store.claimDispatch(project, input.billingAccountId, receipt.id)).toBeNull();
		expect(await store.renew(project, dispatch)).toBe(false);
		const recovery = await store.claimReconciliation(project, input.billingAccountId, receipt.id);
		if (!recovery) throw new Error("Expected recovery lease");
		await expect(
			store.settle(project, dispatch, { status: "failed", errorCode: "STALE_OWNER" }),
		).rejects.toMatchObject({ code: "PROVIDER_OPERATION_LEASE_LOST" });
		await store.settle(project, recovery, {
			status: "requires_review",
			errorCode: "PROVIDER_OPERATION_UNCERTAIN",
		});
		expect(await store.get(project, input.billingAccountId, receipt.id)).toMatchObject({
			status: "requires_review",
			attempts: 1,
		});
	});

	it("blocks conflicting work while review is required", async () => {
		const input = intent();
		const store = context.repository.providerOperations;
		const receipt = await store.prepare(project, input);
		const lease = await store.claimDispatch(project, input.billingAccountId, receipt.id);
		if (!lease) throw new Error("Expected dispatch lease");
		await store.settle(project, lease, {
			status: "requires_review",
			errorCode: "PROVIDER_OPERATION_UNCERTAIN",
		});
		await expect(
			store.prepare(project, { ...input, idempotencyKey: crypto.randomUUID() }),
		).rejects.toMatchObject({ code: "PROVIDER_OPERATION_PENDING" });
	});

	it("binds a key to semantic input and account but permits same-account credential rotation", async () => {
		const input = intent();
		const store = context.repository.providerOperations;
		const receipt = await store.prepare(project, input);
		await expect(
			store.prepare(project, { ...input, requestHash: "b".repeat(64) }),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		await expect(
			store.prepare(project, { ...input, request: { price: "changed_under_same_hash" } }),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		await expect(
			store.prepare(project, { ...input, providerAccountId: "another_account" }),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		expect(
			await store.prepare(project, { ...input, connectionVersionId: crypto.randomUUID() }),
		).toMatchObject({ id: receipt.id, connectionVersionId: input.connectionVersionId });
	});

	it("recovers only against the recorded provider account and keeps lookup failures unresolved", async () => {
		const input = intent();
		const store = context.repository.providerOperations;
		const receipt = await executeProviderOperation({
			project,
			store,
			intent: input,
			write: async () => {
				throw new Error("lost");
			},
		});
		let observations = 0;
		const observe = async () => {
			observations++;
			return {
				status: "succeeded" as const,
				providerObjectId: "txn_found",
				result: { recovered: true },
			};
		};
		const run = (resolve: Parameters<typeof reconcileProviderOperation>[0]["resolve"]) =>
			reconcileProviderOperation({
				project,
				store,
				billingAccountId: input.billingAccountId,
				operationId: receipt.id,
				resolve,
			});
		expect(
			await run(async () => ({
				provider: "stripe",
				providerAccountId: "acct_replacement",
				observe,
			})),
		).toMatchObject({
			status: "requires_review",
			errorCode: "PROVIDER_OPERATION_ACCOUNT_MISMATCH",
		});
		expect(observations).toBe(0);
		expect(
			await run(async () => {
				throw new Error("lookup unavailable");
			}),
		).toMatchObject({ status: "reconciling" });
		expect(
			await run(async (operation) => {
				expect(operation.connectionVersionId).toBe(input.connectionVersionId);
				return { provider: "stripe", providerAccountId: input.providerAccountId, observe };
			}),
		).toMatchObject({ status: "succeeded", attempts: 1 });
		expect(
			await run(async () => {
				throw new Error("terminal receipts are never observed again");
			}),
		).toMatchObject({ status: "succeeded" });
		expect(observations).toBe(1);
	});

	it("renews only the active lease and does not misclassify a local completion failure", async () => {
		const input = intent();
		const store = context.repository.providerOperations;
		let completions = 0;
		await expect(
			executeProviderOperation({
				project,
				intent: input,
				store: {
					prepare: (...args) => store.prepare(...args),
					get: (...args) => store.get(...args),
					claimDispatch: async (...args) => {
						const lease = await store.claimDispatch(...args);
						if (!lease) throw new Error("Expected lease");
						expect(await store.renew(project, lease)).toBe(true);
						return lease;
					},
					settle: async () => {
						completions++;
						throw new Error("database unavailable");
					},
				},
				write: async () => ({ providerObjectId: "txn_remote_success", result: {} }),
			}),
		).rejects.toThrow("database unavailable");
		expect(completions).toBe(1);
		expect(await store.prepare(project, input)).toMatchObject({ status: "in_flight", attempts: 1 });
	});

	it("keeps operation reads and claims scoped to project and billing account", async () => {
		const input = intent();
		const store = context.repository.providerOperations;
		const receipt = await store.prepare(project, input);
		await expect(
			store.get(integrationProjectContext("globex"), input.billingAccountId, receipt.id),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(store.get(project, "other_customer", receipt.id)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(
			await store.claimDispatch(
				integrationProjectContext("globex"),
				input.billingAccountId,
				receipt.id,
			),
		).toBeNull();
		expect(await store.claimDispatch(project, "other_customer", receipt.id)).toBeNull();
	});

	it("records a definitive rejection and permits a separately keyed corrected operation", async () => {
		const input = intent();
		const store = context.repository.providerOperations;
		let writes = 0;
		const run = () =>
			executeProviderOperation({
				project,
				store,
				intent: input,
				write: async () => {
					writes++;
					throw new RejectedProviderWrite("payment_declined");
				},
			});
		expect(await run()).toMatchObject({ status: "failed", errorCode: "payment_declined" });
		await run();
		expect(writes).toBe(1);
		expect(
			await store.prepare(project, { ...input, idempotencyKey: crypto.randomUUID() }),
		).toMatchObject({ status: "prepared", attempts: 0 });
	});
	it("backs off automatic observations, stops at its budget and audits manual review", async () => {
		const input = intent();
		const store = context.repository.providerOperations;
		const receipt = await executeProviderOperation({
			project,
			store,
			intent: input,
			write: async () => {
				throw new Error("lost");
			},
		});
		expect((await store.due(100)).some((row) => row.id === receipt.id)).toBe(false);
		for (let attempt = 0; attempt < 10; attempt++) {
			const result = await reconcileProviderOperation({
				project,
				store,
				billingAccountId: input.billingAccountId,
				operationId: receipt.id,
				resolve: async () => {
					throw new Error("provider unavailable");
				},
			});
			expect(result.status).toBe(attempt === 9 ? "requires_review" : "reconciling");
		}
		await context.sql`UPDATE provider_operations SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE project_id=${project.projectInstanceId} AND id=${receipt.id}`;
		expect((await store.due(100)).some((row) => row.id === receipt.id)).toBe(false);
		await expect(
			store.requestReview(
				integrationProjectContext("globex"),
				input.billingAccountId,
				receipt.id,
				"intruder",
			),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			store.requestReview(project, "other", receipt.id, "intruder"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await store.requestReview(project, input.billingAccountId, receipt.id, "operator:test");
		const result = await reconcileProviderOperation({
			project,
			store,
			billingAccountId: input.billingAccountId,
			operationId: receipt.id,
			resolve: async () => ({
				provider: input.provider,
				providerAccountId: input.providerAccountId,
				observe: async () => ({ status: "succeeded", providerObjectId: "txn_found", result: {} }),
			}),
		});
		expect(result).toMatchObject({ status: "succeeded", attempts: 1 });
		const [row] =
			await context.sql`SELECT review_requests,recovery_attempts FROM provider_operations WHERE project_id=${project.projectInstanceId} AND id=${receipt.id}`;
		expect(row?.review_requests).toEqual([
			expect.objectContaining({ actor: "operator:test", status: "requires_review" }),
		]);
		expect(row?.recovery_attempts).toBe(11);
	});
	it("lets competing workers observe once and defers unresolved projects without dispatching", async () => {
		const input = intent();
		const store = context.repository.providerOperations;
		const receipt = await executeProviderOperation({
			project,
			store,
			intent: input,
			write: async () => {
				throw new Error("lost");
			},
		});
		await context.sql`UPDATE provider_operations SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE project_id=${project.projectInstanceId} AND id=${receipt.id}`;
		const selected = await store.due(100);
		expect(selected.some((row) => row.id === receipt.id)).toBe(true);
		const repository = {
			prepare: store.prepare.bind(store),
			get: store.get.bind(store),
			claimDispatch: store.claimDispatch.bind(store),
			claimReconciliation: store.claimReconciliation.bind(store),
			settle: store.settle.bind(store),
			renew: store.renew.bind(store),
			deferRecovery: store.deferRecovery.bind(store),
			due: async () => selected.filter((row) => row.id === receipt.id),
		};
		const blocked = new ProviderOperationRecoveryWorker({
			repository,
			projects: projectContextResolver({ unavailable: true }),
			resolve: async () => {
				throw new Error("must not observe");
			},
		});
		expect(await blocked.runOnce()).toEqual({ selected: 1, recovered: 0, unresolved: 1 });
		expect((await store.due(100)).some((row) => row.id === receipt.id)).toBe(false);
		let observations = 0;
		const worker = new ProviderOperationRecoveryWorker({
			repository,
			projects: projectContextResolver({ contexts: [project] }),
			resolve: async (_, operation) => {
				expect(operation.connectionVersionId).toBe(input.connectionVersionId);
				return {
					provider: input.provider,
					providerAccountId: input.providerAccountId,
					observe: async () => {
						observations++;
						return { status: "succeeded", providerObjectId: "txn_worker", result: {} };
					},
				};
			},
		});
		const results = await Promise.all([worker.runOnce(), worker.runOnce()]);
		expect(results.every((result) => result.selected === 1)).toBe(true);
		expect(observations).toBe(1);
		expect(await store.get(project, input.billingAccountId, receipt.id)).toMatchObject({
			status: "succeeded",
			attempts: 1,
		});
	});
});
