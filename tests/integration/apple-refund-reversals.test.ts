import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "drizzle-orm";
import {
	applyAppleRefundReversalRepair,
	readAppleRefundReversalRepairs,
} from "../../src/db/repository/apple-refund-repairs";
import type {
	RecordStoreKitTransactionProjectionInput,
	TransactionalQueryExecutor,
} from "../../src/db/repository/types";
import { renderDrizzleSql } from "../helpers/drizzle-sql";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	databaseNow,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { aiCreditsCatalog, publishAiCreditsCatalog } from "./helpers/metering-catalog";

const localDescribe = describeLocalPostgres(describe, describe.skip);
type Kind = "consumable" | "subscription";
type Event = "purchase_verified" | "REFUND" | "REFUND_REVERSED" | "REVOKE";
let context: LocalPostgresContext;
let now: Date;
const account = "apple_refund_account";
const project = () => integrationProjectContext();
const database = () => context.db as unknown as TransactionalQueryExecutor;
const balance = () => context.repository.getMeteringBalance(project(), account, "ai_credits");

async function record(
	kind: Kind,
	event: Event,
	overrides: Partial<RecordStoreKitTransactionProjectionInput> = {},
): Promise<string> {
	const transactionId = overrides.transactionId ?? `apple_${kind}`;
	const externalEventId = overrides.externalEventId ?? `${transactionId}:${event}`;
	const invalidated = event === "REFUND" || event === "REVOKE";
	await context.repository.recordStoreKitTransactionAndEnqueueProjection(project(), {
		billingAccountId: event === "purchase_verified" ? account : null,
		appAccountToken: null,
		channel: "ios",
		externalProductId: kind === "consumable" ? "echo_credits_10" : "premium_monthly",
		purchaseKind: kind,
		transactionId,
		originalTransactionId: kind === "subscription" ? "apple_original" : null,
		webOrderLineItemId: null,
		purchaseStatus: event === "REVOKE" ? "revoked" : invalidated ? "refunded" : "completed",
		subscriptionStatus:
			kind === "consumable"
				? null
				: event === "REVOKE"
					? "revoked"
					: invalidated
						? "refunded"
						: "active",
		purchasedAt: new Date(now.getTime() - 3_600_000),
		expiresAt: kind === "subscription" ? new Date(now.getTime() + 28 * 86_400_000) : null,
		autoRenew: kind === "subscription" ? true : null,
		invalidatedAt: invalidated ? now : null,
		invalidationReason: invalidated ? "refund" : null,
		rawPayload: { event },
		eventType: event,
		externalEventId,
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: `apple:${externalEventId}`,
		...overrides,
	});
	const [row] = await context.sql<{ id: string }[]>`
		SELECT id FROM store_events WHERE project_id = ${project().projectInstanceId}
			AND external_event_id = ${externalEventId}
	`;
	if (!row) throw new Error("Apple test event was not recorded");
	return row.id;
}

async function allocations() {
	return await context.sql<
		{
			id: string;
			quantity: string;
			consumed_quantity: string;
			held_quantity: string;
			expires_at: string | null;
			reversed_at: string | null;
			reversed_quantity: string;
		}[]
	>`SELECT id::text, quantity::text, consumed_quantity::text, held_quantity::text,
		expires_at::text, reversed_at::text, reversed_quantity::text
		FROM balance_allocations WHERE project_id = ${project().projectInstanceId} ORDER BY id`;
}

/** Restore the exact stranded rows the old recorder left behind, including DB microseconds. */
async function historicalReversal(kind: Kind): Promise<string> {
	await record(kind, "purchase_verified");
	await record(kind, "REFUND");
	const invalidated = await allocations();
	const eventId = await record(kind, "REFUND_REVERSED");
	for (const row of invalidated) {
		await context.sql`
			UPDATE balance_allocations SET reversed_at = ${row.reversed_at}::timestamptz,
				reversed_quantity = ${row.reversed_quantity}::numeric
			WHERE project_id = ${project().projectInstanceId} AND id = ${row.id}::bigint
		`;
	}
	return eventId;
}

localDescribe("Apple refund reversal accounting", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		now = await databaseNow(context.sql);
	});
	afterAll(async () => {
		await context.sql.close();
	});

	// capability: refund.sync
	it("restores a top-up once and never replenishes it on duplicate reversals", async () => {
		await publishAiCreditsCatalog(context.repository);
		await record("consumable", "purchase_verified");
		expect(await balance()).toMatchObject({ granted: "10", available: "10" });
		const original = await allocations();
		await record("consumable", "REFUND");
		expect(await balance()).toMatchObject({ available: "0" });
		await record("consumable", "REFUND_REVERSED");
		expect(await balance()).toMatchObject({ granted: "10", available: "10" });
		expect(await allocations()).toEqual(original);
		await context.repository.consumeUsage(project(), {
			billingAccountId: account,
			featureKey: "ai_credits",
			quantity: "3",
			idempotencyKey: "spend-after-reversal",
		});
		await record("consumable", "REFUND_REVERSED");
		await record("consumable", "REFUND_REVERSED", { externalEventId: "second-reversal-notice" });
		expect(await balance()).toMatchObject({ granted: "10", consumed: "3", available: "7" });
		expect(await allocations()).toHaveLength(1);
	});

	it.each(["consumable", "subscription"] as const)(
		"does not restore a %s refund after an independent revocation",
		async (kind) => {
			await publishAiCreditsCatalog(context.repository);
			await record(kind, "purchase_verified");
			await record(kind, "REFUND");
			await record(kind, "REVOKE");
			const before = await allocations();
			await context.sql`DELETE FROM projection_sync_jobs WHERE project_id = ${project().projectInstanceId}`;
			await record(kind, "REFUND_REVERSED");
			expect(await balance()).toMatchObject({ available: "0" });
			expect(await allocations()).toEqual(before);
			expect(
				await context.sql<{ status: string }[]>`SELECT status FROM purchases
				WHERE project_id = ${project().projectInstanceId}`,
			).toEqual([{ status: "revoked" }]);
			expect(
				await context.sql<{ id: string }[]>`SELECT id FROM projection_sync_jobs
				WHERE project_id = ${project().projectInstanceId}`,
			).toEqual([]);
			if (kind === "subscription") {
				expect(
					await context.sql<{ status: string }[]>`SELECT status FROM subscriptions
					WHERE project_id = ${project().projectInstanceId}`,
				).toEqual([{ status: "revoked" }]);
			}
		},
	);

	it("does not restore an older payment after a later subscription payment is refunded", async () => {
		await publishAiCreditsCatalog(context.repository);
		await record("subscription", "purchase_verified");
		await record("subscription", "REFUND");
		const renewal = {
			transactionId: "apple_renewal",
			purchasedAt: new Date(now.getTime() + 28 * 86_400_000),
			expiresAt: new Date(now.getTime() + 56 * 86_400_000),
		};
		await record("subscription", "purchase_verified", renewal);
		await record("subscription", "REFUND", renewal);
		const before = await allocations();
		await record("subscription", "REFUND_REVERSED");
		expect(await allocations()).toEqual(before);
		expect(
			await context.sql<{ status: string }[]>`SELECT status FROM purchases
			WHERE project_id = ${project().projectInstanceId} ORDER BY transaction_id`,
		).toEqual([{ status: "refunded" }, { status: "refunded" }]);
		expect(
			await context.sql<{ status: string }[]>`SELECT status FROM subscriptions
			WHERE project_id = ${project().projectInstanceId}`,
		).toEqual([{ status: "refunded" }]);
	});

	it.each(["consumable", "subscription"] as const)(
		"keeps a revoked %s invalid even when another refund is recorded afterwards",
		async (kind) => {
			await publishAiCreditsCatalog(context.repository);
			await record(kind, "purchase_verified");
			await record(kind, "REVOKE");
			await record(kind, "REFUND");
			const before = await allocations();
			await record(kind, "REFUND_REVERSED");
			expect(await allocations()).toEqual(before);
			expect(await balance()).toMatchObject({ available: "0" });
		},
	);

	it("leaves a reversal without refund evidence unchanged", async () => {
		await publishAiCreditsCatalog(context.repository);
		await record("consumable", "purchase_verified");
		const before = await allocations();
		await context.sql`DELETE FROM projection_sync_jobs WHERE project_id = ${project().projectInstanceId}`;
		await record("consumable", "REFUND_REVERSED");
		expect(await allocations()).toEqual(before);
		expect(await balance()).toMatchObject({ available: "10" });
		const jobs = await context.sql`SELECT id FROM projection_sync_jobs
			WHERE project_id = ${project().projectInstanceId}`;
		expect(jobs).toHaveLength(0);
	});

	it.each(["consumable", "subscription"] as const)(
		"preserves consumption and an open reservation across a %s refund reversal",
		async (kind) => {
			await publishAiCreditsCatalog(context.repository);
			await record(kind, "purchase_verified");
			await context.repository.consumeUsage(project(), {
				billingAccountId: account,
				featureKey: "ai_credits",
				quantity: "3",
				idempotencyKey: "spend-before-refund",
			});
			const hold = await context.repository.reserveUsage(project(), {
				billingAccountId: account,
				featureKey: "ai_credits",
				quantity: "2",
				idempotencyKey: "hold-before-refund",
				expiresInSeconds: 3600,
			});
			const original = await allocations();
			if (hold.reservationId === null) throw new Error("Test reservation was denied");
			await record(kind, "REFUND");
			expect(await balance()).toMatchObject({ available: "0" });
			await record(kind, "purchase_verified", { externalEventId: "ordinary-reverification" });
			expect(await balance()).toMatchObject({ available: "0" });
			await record(kind, "REFUND_REVERSED");
			expect(await allocations()).toEqual(original);
			expect(await balance()).toMatchObject({
				consumed: "3",
				held: "2",
				available: kind === "consumable" ? "5" : "995",
			});
			await context.repository.confirmUsageReservation(project(), {
				billingAccountId: account,
				reservationId: hold.reservationId,
				quantity: "1",
				idempotencyKey: "confirm-after-reversal",
			});
			expect(await balance()).toMatchObject({
				consumed: "4",
				held: "0",
				available: kind === "consumable" ? "6" : "996",
			});
		},
	);

	it.each(["consumable", "subscription"] as const)(
		"keeps original expiry and restores recorded %s grants after bindings retire",
		async (kind) => {
			await publishAiCreditsCatalog(context.repository);
			await record(kind, "purchase_verified");
			await context.sql`UPDATE balance_allocations SET expires_at = now() - interval '1 hour'
				WHERE project_id = ${project().projectInstanceId}`;
			const original = await allocations();
			await record(kind, "REFUND");
			await context.sql`UPDATE store_products SET active = false
				WHERE project_id = ${project().projectInstanceId} AND provider = 'apple'`;
			await context.sql`DELETE FROM provider_topup_bindings
				WHERE project_id = ${project().projectInstanceId}`;
			await record(kind, "REFUND_REVERSED");
			expect(await balance()).toMatchObject({ available: "0" });
			expect(await allocations()).toEqual(original);
		},
	);

	it.each(["day", null] as const)(
		"restores reset=%s allowances without changing their keys",
		async (resetInterval) => {
			const catalog = structuredClone(aiCreditsCatalog);
			catalog.plans = catalog.plans.map((plan) => ({
				...plan,
				items: plan.items.map((item) =>
					item.itemKind === "allocation"
						? {
								...item,
								reset:
									resetInterval === null ? null : { interval: resetInterval, intervalCount: 1 },
							}
						: item,
				),
			}));
			const preview = await context.repository.previewCatalog(project(), {
				expectedRevision: null,
				actor: "apple-refund-test",
				catalog,
			});
			await context.repository.publishCatalog(project(), {
				expectedRevision: null,
				actor: "apple-refund-test",
				previewToken: preview.previewToken,
				catalog,
			});
			await record("subscription", "purchase_verified");
			const original = await allocations();
			expect(await balance()).toMatchObject({ available: "1000" });
			await record("subscription", "REFUND");
			expect(await balance()).toMatchObject({ available: "0" });
			await record("subscription", "REFUND_REVERSED");
			expect(await balance()).toMatchObject({ available: "1000" });
			expect(await allocations()).toEqual(original);
		},
	);

	it("preserves subscription debits and markers from an independent invalidation", async () => {
		await publishAiCreditsCatalog(context.repository);
		await record("subscription", "purchase_verified");
		await context.sql`UPDATE balance_allocations SET reversed_quantity = 7
			WHERE project_id = ${project().projectInstanceId}`;
		await context.sql`
			INSERT INTO balance_allocations (project_id, customer_id, feature_id, plan_item_id,
				subscription_id, source_kind, source_key, quantity, reversed_at, period_start_at)
			SELECT project_id, customer_id, feature_id, plan_item_id, subscription_id, source_kind,
				'independently-revoked', 12, now() - interval '1 day', now() - interval '2 days'
			FROM balance_allocations WHERE project_id = ${project().projectInstanceId}
		`;
		const original = await allocations();
		await record("subscription", "REFUND");
		await record("subscription", "REFUND_REVERSED");
		expect(await balance()).toMatchObject({ available: "993" });
		expect(await allocations()).toEqual(original);
	});

	it.each(["consumable", "subscription"] as const)(
		"repairs a historical %s reversal once and queues a balance-only projection",
		async (kind) => {
			await publishAiCreditsCatalog(context.repository);
			const eventId = await historicalReversal(kind);
			expect(await balance()).toMatchObject({ available: "0" });
			const before = await allocations();
			expect(before).toHaveLength(1);
			const allocationId = before[0]?.id;
			const report = await readAppleRefundReversalRepairs(database(), project().projectInstanceId);
			expect(report.events).toMatchObject([
				{
					storeEventId: eventId,
					status: "ready",
					reason: null,
					allocations: [{ allocationId, availableDelta: kind === "consumable" ? "10" : "1000" }],
				},
			]);
			expect(await allocations()).toEqual(before);
			await context.sql`DELETE FROM projection_sync_jobs WHERE project_id = ${project().projectInstanceId}`;
			const repaired = await applyAppleRefundReversalRepair(
				database(),
				project().projectInstanceId,
				eventId,
			);
			expect(repaired.restoredAllocationIds).toEqual([allocationId]);
			expect(await balance()).toMatchObject({ available: kind === "consumable" ? "10" : "1000" });
			const jobs = await context.sql`SELECT id, reason, payload, updated_at::text
				FROM projection_sync_jobs WHERE project_id = ${project().projectInstanceId}`;
			expect(jobs).toHaveLength(1);
			expect(jobs[0]).toMatchObject({ reason: "usage_changed", payload: null });
			const repeated = await applyAppleRefundReversalRepair(
				database(),
				project().projectInstanceId,
				eventId,
			);
			expect(repeated).toMatchObject({ status: "unchanged", restoredAllocationIds: [] });
			expect(
				await context.sql`SELECT id, reason, payload, updated_at::text
				FROM projection_sync_jobs WHERE project_id = ${project().projectInstanceId}`,
			).toEqual(jobs);
			const events =
				await context.sql`SELECT processing_status FROM store_events WHERE id = ${eventId}`;
			expect(events).toEqual([{ processing_status: "processed" }]);
			await expect(
				applyAppleRefundReversalRepair(
					database(),
					integrationProjectContext("globex").projectInstanceId,
					eventId,
				),
			).rejects.toThrow("Processed Apple refund reversal was not found in this instance");
			const [customer] = await context.sql<{ id: string }[]>`SELECT id FROM customers
				WHERE project_id = ${project().projectInstanceId} AND billing_account_id = ${account}`;
			if (!customer) throw new Error("Repair test customer was not found");
			const projection = await context.repository.buildUsageProjection(
				project().projectInstanceId,
				customer.id,
			);
			expect(projection.balances).toEqual([
				expect.objectContaining({
					featureKey: "ai_credits",
					available: kind === "consumable" ? "10" : "1000",
				}),
			]);
			expect(projection.purchase).toBeUndefined();
			expect(projection.reversal).toBeUndefined();
		},
	);

	it.each(["consumable", "subscription"] as const)(
		"blocks historical %s repair when an earlier independent revocation was overwritten",
		async (kind) => {
			await publishAiCreditsCatalog(context.repository);
			const eventId = await historicalReversal(kind);
			const revokedId = await record(kind, "REVOKE");
			// Reproduce the old recorder: the reversal cleared purchase/subscription state even
			// though this independent revocation had already been processed.
			await context.sql`UPDATE store_events SET processed_at = (
				SELECT processed_at - interval '1 second' FROM store_events WHERE id = ${eventId}::uuid
			) WHERE project_id = ${project().projectInstanceId} AND id = ${revokedId}::uuid`;
			await context.sql`UPDATE purchases SET status = 'completed', invalidated_at = NULL,
				invalidation_reason = NULL WHERE project_id = ${project().projectInstanceId}`;
			await context.sql`UPDATE subscriptions SET status = 'active'
				WHERE project_id = ${project().projectInstanceId}`;
			await context.sql`DELETE FROM projection_sync_jobs WHERE project_id = ${project().projectInstanceId}`;
			const before = await allocations();
			const report = await readAppleRefundReversalRepairs(database(), project().projectInstanceId);
			expect(report.events).toMatchObject([
				{ storeEventId: eventId, status: "blocked", reason: "refund_not_restorable" },
			]);
			expect(
				await applyAppleRefundReversalRepair(database(), project().projectInstanceId, eventId),
			).toMatchObject({
				status: "blocked",
				reason: "refund_not_restorable",
				restoredAllocationIds: [],
			});
			expect(await allocations()).toEqual(before);
			expect(await balance()).toMatchObject({ available: "0" });
			expect(
				await context.sql<
					{ id: string }[]
				>`SELECT id FROM projection_sync_jobs WHERE project_id = ${project().projectInstanceId}`,
			).toEqual([]);
		},
	);

	it("rolls allocation restoration back when projection enqueueing fails", async () => {
		await publishAiCreditsCatalog(context.repository);
		const eventId = await historicalReversal("consumable");
		const before = await allocations();
		const failingDatabase: TransactionalQueryExecutor = {
			execute: (query) => database().execute(query),
			transaction: (run) =>
				database().transaction((tx) =>
					run({
						async execute<T>(query: SQL): Promise<T[]> {
							if (renderDrizzleSql(query).includes("INSERT INTO projection_sync_jobs"))
								throw new Error("projection enqueue failed");
							return await tx.execute<T>(query);
						},
					}),
				),
		};
		await expect(
			applyAppleRefundReversalRepair(failingDatabase, project().projectInstanceId, eventId),
		).rejects.toThrow("projection enqueue failed");
		expect(await allocations()).toEqual(before);
		expect(await balance()).toMatchObject({ available: "0" });
	});

	it("pages historical events without writing and repairs expired grants without extending them", async () => {
		await publishAiCreditsCatalog(context.repository);
		const firstId = await historicalReversal("consumable");
		const secondId = await historicalReversal("subscription");
		await context.sql`UPDATE balance_allocations SET expires_at = now() - interval '1 hour'
			WHERE project_id = ${project().projectInstanceId}`;
		const before = await allocations();
		const first = await readAppleRefundReversalRepairs(database(), project().projectInstanceId, {
			limit: 1,
		});
		expect(first.nextAfter).toBe(firstId);
		expect(first.events[0]).toMatchObject({
			storeEventId: firstId,
			status: "ready",
			allocations: [{ availableDelta: "0" }],
		});
		const second = await readAppleRefundReversalRepairs(database(), project().projectInstanceId, {
			after: firstId,
			limit: 1,
		});
		expect(second.nextAfter).toBeNull();
		expect(second.events[0]?.storeEventId).toBe(secondId);
		expect(await allocations()).toEqual(before);
		await applyAppleRefundReversalRepair(database(), project().projectInstanceId, firstId);
		await applyAppleRefundReversalRepair(database(), project().projectInstanceId, secondId);
		expect(await balance()).toMatchObject({ available: "0" });
		expect(
			(await allocations()).map((row) => ({
				...row,
				reversed_at: null,
				reversed_quantity: "0.000000000",
			})),
		).toEqual(
			before.map((row) => ({ ...row, reversed_at: null, reversed_quantity: "0.000000000" })),
		);
	});

	it("blocks repair after a later revocation and when subscription attribution is missing", async () => {
		await publishAiCreditsCatalog(context.repository);
		const eventId = await historicalReversal("subscription");
		await context.sql`UPDATE balance_allocations SET reversed_at = now() - interval '2 days'
			WHERE project_id = ${project().projectInstanceId}`;
		const before = await allocations();
		expect(
			await applyAppleRefundReversalRepair(database(), project().projectInstanceId, eventId),
		).toMatchObject({
			status: "blocked",
			reason: "allocation_attribution_missing",
			restoredAllocationIds: [],
		});
		expect(await allocations()).toEqual(before);
		await record("subscription", "REVOKE");
		expect(
			await applyAppleRefundReversalRepair(database(), project().projectInstanceId, eventId),
		).toMatchObject({
			status: "blocked",
			reason: "purchase_invalidated",
			restoredAllocationIds: [],
		});
	});

	it("blocks an old repair after another payment in the lineage was refunded, even after renewal", async () => {
		await publishAiCreditsCatalog(context.repository);
		const eventId = await historicalReversal("subscription");
		const renewal = {
			transactionId: "apple_renewal",
			purchasedAt: new Date(now.getTime() + 28 * 86_400_000),
			expiresAt: new Date(now.getTime() + 56 * 86_400_000),
		};
		await record("subscription", "purchase_verified", renewal);
		await record("subscription", "REFUND", renewal);
		await record("subscription", "purchase_verified", {
			transactionId: "apple_next_renewal",
			purchasedAt: new Date(now.getTime() + 56 * 86_400_000),
			expiresAt: new Date(now.getTime() + 84 * 86_400_000),
		});
		const before = await allocations();
		expect(
			await applyAppleRefundReversalRepair(database(), project().projectInstanceId, eventId),
		).toMatchObject({ status: "blocked", reason: "later_invalidation", restoredAllocationIds: [] });
		expect(await allocations()).toEqual(before);
	});
});
