import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { MeteringMutationInput } from "../../src/billing/metering";
import { BillingRepository } from "../../src/db/repository";
import type { TransactionalQueryExecutor } from "../../src/db/repository/types";
import { createIntegrationApp } from "./helpers/app-fixture";
import {
	resetAndSeedIntegrationData,
	seedIntegrationProjectsAndCatalog,
} from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
const input: MeteringMutationInput = {
	billingAccountId: "recovery",
	featureKey: "model_tokens",
	quantity: "100",
	idempotencyKey: "operation:1",
};
let context: LocalPostgresContext;

localDescribe("usage operation recovery", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
		await grant("recovery");
	});
	afterAll(async () => {
		await context.sql.close();
	});

	it("replays the original outcome after other usage and canonicalizes semantic input", async () => {
		const first = await context.repository.consumeUsage(project, {
			...input,
			filters: { model: "a" },
			metadata: { a: 1, b: 2 },
		});
		await context.repository.consumeUsage(project, { ...input, idempotencyKey: "later" });
		const replay = await context.repository.consumeUsage(project, {
			...input,
			quantity: "100.000",
			filters: { model: "a" },
			metadata: { b: 2, a: 1 },
		});
		expect(replay).toEqual(first);
		expect(await lookup()).toMatchObject({
			status: "completed",
			operationId: input.idempotencyKey,
			outcome: {
				allowed: true,
				usageEventId: first.usageEventId,
				walletQuantity: "0.5",
				balance: { available: "9.5" },
			},
		});
		expect(await counts()).toEqual({ events: 2, claims: 2, consumed: "1.000000000" });
	});

	it("binds every current consume semantic field and ignores transport headers", async () => {
		await context.repository.consumeUsage(project, input);
		for (const changes of [
			{ quantity: "101" },
			{ featureKey: "ai_credits" },
			{ entityId: "another" },
			{ filters: { model: "b" } },
			{ metadata: { run: 2 } },
			{ occurredAt: new Date() },
		]) {
			await expect(
				context.repository.consumeUsage(project, { ...input, ...changes }),
			).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		}
		const { app, authHeaders } = createIntegrationApp(context);
		const response = await app.request("/v1/billing-accounts/recovery/usage/consume", {
			method: "POST",
			headers: {
				...authHeaders(),
				"Content-Type": "application/json",
				"Idempotency-Key": input.idempotencyKey,
				"X-Request-Id": "different-trace",
				"User-Agent": "new-client",
			},
			body: JSON.stringify({ featureKey: input.featureKey, quantity: input.quantity }),
		});
		expect(response.status).toBe(200);
		expect(await counts()).toEqual({ events: 1, claims: 1, consumed: "0.500000000" });
	});

	it("retains a business denial even after the account is funded", async () => {
		const deniedInput = { ...input, quantity: "10000" };
		const denied = await context.repository.consumeUsage(project, deniedInput);
		expect(denied.allowed).toBe(false);
		await grant("recovery", "100", "later-grant");
		expect(await context.repository.consumeUsage(project, deniedInput)).toEqual(denied);
		expect(await lookup()).toMatchObject({
			outcome: { allowed: false, reason: "insufficient_balance" },
		});
		expect((await counts()).events).toBe(0);
	});

	it("returns in-progress without waiting while the first transaction is unresolved", async () => {
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const slow = interceptCompletion(async () => {
			reached.resolve();
			await release.promise;
		});
		const pending = slow.consumeUsage(project, input);
		try {
			await reached.promise;
			const duplicate = context.repository.consumeUsage(project, input).then(
				() => "unexpected",
				(error) => error.code,
			);
			expect(await withinOneSecond(duplicate)).toBe("OPERATION_IN_PROGRESS");
			expect(await withinOneSecond(lookup())).toMatchObject({
				status: "processing",
				outcome: null,
			});
			// The charge and claim are still invisible to a separate connection.
			expect(await counts()).toEqual({ events: 0, claims: 0, consumed: "0.000000000" });
		} finally {
			release.resolve();
		}
		const result = await pending;
		expect(await context.repository.consumeUsage(project, input)).toEqual(result);
		expect((await counts()).events).toBe(1);
	});

	it("rolls accounting, projections, and claim back together after a fault at outcome persistence", async () => {
		const faulty = interceptCompletion(async () => {
			throw new Error("injected before commit");
		}, "before");
		const projectionsBefore = await projectionCount();
		await expect(faulty.consumeUsage(project, input)).rejects.toThrow("injected before commit");
		expect(await counts()).toEqual({ events: 0, claims: 0, consumed: "0.000000000" });
		expect(await projectionCount()).toBe(projectionsBefore);
		await expect(lookup()).rejects.toMatchObject({ code: "OPERATION_NOT_FOUND" });
		expect((await context.repository.consumeUsage(project, input)).allowed).toBe(true);
		expect((await counts()).events).toBe(1);
	});

	it("recovers an unknown commit outcome on a new database connection without a second charge", async () => {
		const database = context.db as unknown as TransactionalQueryExecutor;
		const uncertain = new BillingRepository({
			execute: (query) => database.execute(query),
			async transaction(callback) {
				await database.transaction(callback);
				throw new Error("connection lost after COMMIT");
			},
		});
		await expect(uncertain.consumeUsage(project, input)).rejects.toThrow(
			"connection lost after COMMIT",
		);
		const fresh = await createLocalPostgresContext();
		try {
			const recovered = await fresh.repository.getUsageOperation(project, {
				billingAccountId: "recovery",
				operation: "consume",
				operationId: input.idempotencyKey,
			});
			const replay = await fresh.repository.consumeUsage(project, input);
			expect(recovered).toMatchObject({
				status: "completed",
				outcome: { usageEventId: replay.usageEventId },
			});
			expect(await counts()).toEqual({ events: 1, claims: 1, consumed: "0.500000000" });
		} finally {
			await fresh.sql.close();
		}
	});

	it("replays reserve, confirm, release and correction outcomes and rejects changed TTL/audit facts", async () => {
		const reserveInput = { ...input, expiresInSeconds: 300 };
		const reservation = await context.repository.reserveUsage(project, reserveInput);
		expect(await context.repository.reserveUsage(project, reserveInput)).toEqual(reservation);
		await expect(
			context.repository.reserveUsage(project, { ...reserveInput, expiresInSeconds: 301 }),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		const confirmInput = {
			billingAccountId: "recovery",
			reservationId: reservation.reservationId ?? "",
			quantity: "80",
			idempotencyKey: input.idempotencyKey,
		};
		const confirmed = await context.repository.confirmUsageReservation(project, confirmInput);
		expect(await context.repository.confirmUsageReservation(project, confirmInput)).toEqual(
			confirmed,
		);
		// A reserve replay preserves its original receipt even after confirmation.
		expect(await context.repository.reserveUsage(project, reserveInput)).toEqual(reservation);
		await expect(
			context.repository.confirmUsageReservation(project, { ...confirmInput, quantity: "81" }),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		const correction = {
			billingAccountId: "recovery",
			originalUsageEventId: confirmed.usageEventId ?? "",
			originalRecordedAt: new Date(confirmed.recordedAt ?? ""),
			quantity: "10",
			idempotencyKey: input.idempotencyKey,
			actor: "test",
			reason: "duplicate fact",
		};
		const corrected = await context.repository.correctUsage(project, correction);
		expect(await context.repository.correctUsage(project, correction)).toEqual(corrected);
		for (const changes of [
			{ actor: "different" },
			{ reason: "different" },
			{ originalRecordedAt: new Date() },
			{ metadata: { test: true } },
		]) {
			await expect(
				context.repository.correctUsage(project, { ...correction, ...changes }),
			).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		}
		const second = await context.repository.reserveUsage(project, {
			...reserveInput,
			idempotencyKey: "second",
		});
		const releaseInput = {
			billingAccountId: "recovery",
			reservationId: second.reservationId ?? "",
			idempotencyKey: input.idempotencyKey,
		};
		const released = await context.repository.releaseUsageReservation(project, releaseInput);
		expect(await context.repository.releaseUsageReservation(project, releaseInput)).toEqual(
			released,
		);
		await expect(
			context.repository.releaseUsageReservation(project, {
				...releaseInput,
				reservationId: confirmInput.reservationId,
			}),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		expect((await counts()).events).toBe(2);
	});

	it("keeps expired outcomes as deduplication tombstones and never sweeps unresolved claims", async () => {
		await context.repository.consumeUsage(project, input);
		await context.sql`UPDATE client_idempotency_claims SET created_at = now() - INTERVAL '3 days', completed_at = now() - INTERVAL '2 days', result_expires_at = now() - INTERVAL '1 day'`;
		await expect(context.repository.consumeUsage(project, input)).rejects.toMatchObject({
			code: "OPERATION_RESULT_EXPIRED",
		});
		await expect(lookup()).rejects.toMatchObject({ code: "OPERATION_RESULT_EXPIRED" });
		await context.repository.runMeteringMaintenance(100);
		const [row] =
			await context.sql`SELECT outcome, request_fingerprint FROM client_idempotency_claims`;
		expect(row.outcome).toBeNull();
		expect(row.request_fingerprint).toHaveLength(64);
		await context.sql`UPDATE client_idempotency_claims SET completed_at = NULL, result_expires_at = NULL, expires_at = now() - INTERVAL '1 day'`;
		await context.repository.runMeteringMaintenance(100);
		expect(await lookup()).toMatchObject({ status: "processing" });
		await expect(context.repository.consumeUsage(project, input)).rejects.toMatchObject({
			code: "OPERATION_IN_PROGRESS",
		});
		expect((await counts()).claims).toBe(1);
	});

	it("enforces 24h replay from completion and a separate 7d identity horizon", async () => {
		await context.sql`UPDATE metering_settings SET client_idempotency_ttl_seconds = 60`;
		await context.repository.consumeUsage(project, input);
		const [row] =
			await context.sql`SELECT result_expires_at >= completed_at + INTERVAL '24 hours' AS replay_minimum, expires_at >= completed_at + INTERVAL '7 days' AS identity_minimum FROM client_idempotency_claims`;
		expect(row).toEqual({ replay_minimum: true, identity_minimum: true });
		await context.sql`UPDATE client_idempotency_claims SET created_at = now() - INTERVAL '9 days', completed_at = now() - INTERVAL '8 days', result_expires_at = now() - INTERVAL '7 days', expires_at = now() - INTERVAL '1 day'`;
		await expect(lookup()).rejects.toMatchObject({ code: "OPERATION_NOT_FOUND" });
		const swept = await context.repository.runMeteringMaintenance(100);
		expect(swept.deletedClientClaims).toBe(1);
		expect((await counts()).events).toBe(1);
	});

	it("handles a burst of concurrent requests with one accounting result", async () => {
		const results = await Promise.allSettled(
			Array.from({ length: 24 }, () => context.repository.consumeUsage(project, input)),
		);
		const receipts = [];
		for (const result of results) {
			if (result.status === "fulfilled") receipts.push(result.value.usageEventId);
			else expect(result.reason).toMatchObject({ code: "OPERATION_IN_PROGRESS" });
		}
		expect(receipts.length).toBeGreaterThan(0);
		expect(new Set(receipts).size).toBe(1);
		expect(await counts()).toEqual({ events: 1, claims: 1, consumed: "0.500000000" });
	});

	it("enforces fixed-duration retention across daylight-saving transitions", async () => {
		await context.repository.consumeUsage(project, input);
		for (const completedAt of ["2026-03-04T17:00:00Z", "2026-10-28T16:00:00Z"]) {
			await context.sql.begin(async (tx) => {
				await tx`SET LOCAL TIME ZONE 'America/New_York'`;
				const [row] = await tx`
					UPDATE client_idempotency_claims
					SET created_at = ${completedAt}::timestamptz - INTERVAL '1 second',
					 completed_at = ${completedAt}::timestamptz,
					 result_expires_at = ${completedAt}::timestamptz + make_interval(secs => 86400),
					 expires_at = ${completedAt}::timestamptz + make_interval(secs => 604800)
					RETURNING extract(epoch FROM (expires_at - completed_at))::int AS retained_seconds
				`;
				expect(row.retained_seconds).toBe(604800);
			});
		}
	});

	it("preserves missing-account errors for finalization and correction without creating customers", async () => {
		const subject = { billingAccountId: "missing", idempotencyKey: "missing-account" };
		const reservationId = "00000000-0000-4000-8000-000000000001";
		for (const call of [
			() =>
				context.repository.confirmUsageReservation(project, {
					...subject,
					reservationId,
					quantity: "1",
				}),
			() => context.repository.releaseUsageReservation(project, { ...subject, reservationId }),
			() =>
				context.repository.correctUsage(project, {
					...subject,
					originalUsageEventId: reservationId,
					originalRecordedAt: new Date(),
					quantity: "1",
					actor: "review",
					reason: "correction",
				}),
		])
			await expect(call()).rejects.toMatchObject({ code: "BILLING_ACCOUNT_NOT_FOUND" });
		const [row] =
			await context.sql`SELECT count(*)::int AS count FROM customers WHERE billing_account_id = 'missing'`;
		expect(row.count).toBe(0);
		expect((await counts()).claims).toBe(0);
	});

	it("uses the normalized account for both the claim and all five mutations", async () => {
		const padded = { ...input, billingAccountId: " recovery " };
		const consumed = await context.repository.consumeUsage(project, padded);
		expect(consumed.allowed).toBe(true);
		expect(await context.repository.consumeUsage(project, input)).toEqual(consumed);
		const reserveInput = { ...padded, expiresInSeconds: 300 };
		const reserved = await context.repository.reserveUsage(project, reserveInput);
		const subject = {
			billingAccountId: padded.billingAccountId,
			idempotencyKey: input.idempotencyKey,
		};
		const confirmed = await context.repository.confirmUsageReservation(project, {
			...subject,
			reservationId: reserved.reservationId ?? "",
			quantity: "100",
		});
		await context.repository.correctUsage(project, {
			...subject,
			originalUsageEventId: confirmed.usageEventId ?? "",
			originalRecordedAt: new Date(confirmed.recordedAt ?? ""),
			quantity: "10",
			actor: "review",
			reason: "correction",
		});
		const second = await context.repository.reserveUsage(project, {
			...reserveInput,
			idempotencyKey: "second",
		});
		await context.repository.releaseUsageReservation(project, {
			...subject,
			reservationId: second.reservationId ?? "",
		});
		const [row] = await context.sql`
			SELECT count(*)::int AS count FROM customers WHERE billing_account_id = ${padded.billingAccountId}
		`;
		expect(row.count).toBe(0);
		expect((await counts()).claims).toBe(6);
	});

	it("does not make completed lookups contend with other lookups or replays", async () => {
		const first = await context.repository.consumeUsage(project, input);
		const reached = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const slow = interceptCompletion(
			async () => {
				reached.resolve();
				await release.promise;
			},
			"after",
			/FROM client_idempotency_claims claim/,
		);
		const pending = slow.getUsageOperation(project, {
			billingAccountId: input.billingAccountId,
			operation: "consume",
			operationId: input.idempotencyKey,
		});
		try {
			await reached.promise;
			expect(await withinOneSecond(lookup())).toMatchObject({ status: "completed" });
			expect(await withinOneSecond(context.repository.consumeUsage(project, input))).toEqual(first);
		} finally {
			release.resolve();
			await pending;
		}
		expect((await counts()).events).toBe(1);
	});

	it("rolls back a result exceeding the durable domain-outcome bound", async () => {
		await context.sql`
   INSERT INTO balance_allocations (project_id, customer_id, feature_id, source_kind, source_key, quantity)
   SELECT project_id, customer_id, feature_id, 'operator', 'bound:' || ordinal, 10
   FROM balance_allocations CROSS JOIN generate_series(1, 400) AS ordinal
  `;
		await expect(context.repository.consumeUsage(project, input)).rejects.toMatchObject({
			code: "OPERATION_OUTCOME_TOO_LARGE",
		});
		expect(await counts()).toEqual({ events: 0, claims: 0, consumed: "0.000000000" });
	});

	it("does not reexecute legacy claims whose original outcome cannot be reconstructed", async () => {
		await context.repository.consumeUsage(project, input);
		await context.sql`UPDATE client_idempotency_claims SET recovery_version = 0, outcome = NULL`;
		await expect(context.repository.consumeUsage(project, input)).rejects.toMatchObject({
			code: "OPERATION_RESULT_EXPIRED",
		});
		expect((await counts()).events).toBe(1);
	});

	it("scopes replay and lookup by account, operation and authenticated project", async () => {
		await context.repository.consumeUsage(project, input);
		await grant("other");
		const other = await context.repository.consumeUsage(project, {
			...input,
			billingAccountId: "other",
		});
		expect(other.allowed).toBe(true);
		const { app, authHeaders } = createIntegrationApp(context);
		const path = `/v1/billing-accounts/recovery/usage/operations/consume/${encodeURIComponent(input.idempotencyKey)}`;
		expect((await app.request(path)).status).toBe(401);
		expect((await app.request(path, { headers: authHeaders("wiseley") })).status).toBe(404);
		expect((await app.request(`${path}?projectId=spoof`, { headers: authHeaders() })).status).toBe(
			400,
		);
		const response = await app.request(path, { headers: authHeaders() });
		expect(response.status).toBe(200);
		const payload = await response.json();
		expect(payload.data.outcome.balance.breakdown).toBeUndefined();
		expect(payload.data.outcome.deductions).toBeUndefined();
		expect(JSON.stringify(payload).length).toBeLessThan(2000);
	});

	it("keeps identical account and operation identities independent across environments and organizations", async () => {
		const first = await context.repository.consumeUsage(project, input);
		const { app, authHeaders } = createIntegrationApp(context);
		const path = `/v1/billing-accounts/recovery/usage/operations/consume/${encodeURIComponent(input.idempotencyKey)}`;
		const eventIds = new Set([first.usageEventId]);
		for (const key of ["voysee-sandbox", "wiseley"]) {
			const otherProject = integrationProjectContext(key);
			await seedIntegrationProjectsAndCatalog(context.sql, [
				{
					projectInstanceKey: key,
					name: key,
					projectionUrl: "https://projection.integration.test",
					projectionSecret: "test-secret",
				},
			]);
			await publishAiCreditsCatalog(context.repository, key);
			await context.repository.grantAllocation(otherProject, {
				billingAccountId: input.billingAccountId,
				featureKey: "ai_credits",
				quantity: "20",
				sourceKind: "operator",
				sourceKey: input.billingAccountId,
			});
			expect((await app.request(path, { headers: authHeaders(key) })).status).toBe(404);
			const result = await context.repository.consumeUsage(otherProject, {
				...input,
				quantity: "200",
			});
			eventIds.add(result.usageEventId);
			const response = await app.request(path, { headers: authHeaders(key) });
			expect(response.status).toBe(200);
			expect((await response.json()).data.outcome).toMatchObject({
				usageEventId: result.usageEventId,
				walletQuantity: "1",
				balance: { available: "19" },
			});
			expect(await context.repository.consumeUsage(project, input)).toEqual(first);
		}
		expect(eventIds.size).toBe(3);
		expect(await counts()).toEqual({ events: 3, claims: 3, consumed: "2.500000000" });
	});

	it("validates operation scope and rate-limits authenticated lookup", async () => {
		const { app, authHeaders } = createIntegrationApp(context);
		for (const suffix of ["unknown/key", `consume/${"a".repeat(201)}`, "consume/%20"]) {
			const response = await app.request(
				`/v1/billing-accounts/recovery/usage/operations/${suffix}`,
				{ headers: authHeaders() },
			);
			expect(response.status).toBe(400);
		}
		const limited = createIntegrationApp({
			...context,
			env: {
				...context.env,
				rateLimit: { ...context.env.rateLimit, meteringLimit: 1 },
			},
		});
		const path = "/v1/billing-accounts/recovery/usage/operations/consume/missing";
		expect((await limited.app.request(path, { headers: limited.authHeaders() })).status).toBe(404);
		expect((await limited.app.request(path, { headers: limited.authHeaders() })).status).toBe(429);
	});
});

async function grant(billingAccountId: string, quantity = "10", sourceKey = billingAccountId) {
	await context.repository.grantAllocation(project, {
		billingAccountId,
		featureKey: "ai_credits",
		quantity,
		sourceKind: "operator",
		sourceKey,
	});
}
function lookup() {
	return context.repository.getUsageOperation(project, {
		billingAccountId: input.billingAccountId,
		operation: "consume",
		operationId: input.idempotencyKey,
	});
}
async function counts() {
	const [row] =
		await context.sql`SELECT (SELECT count(*)::int FROM usage_events) AS events, (SELECT count(*)::int FROM client_idempotency_claims) AS claims, (SELECT sum(consumed_quantity)::text FROM balance_allocations) AS consumed`;
	return row;
}
async function projectionCount() {
	const [row] = await context.sql`SELECT count(*)::int AS count FROM projection_sync_jobs`;
	return row.count;
}
function interceptCompletion(
	afterWrite: () => Promise<void>,
	timing: "before" | "after" = "after",
	queryPattern = /UPDATE client_idempotency_claims SET outcome/,
): BillingRepository {
	const database = context.db as unknown as TransactionalQueryExecutor;
	const dialect = new PgDialect();
	return new BillingRepository({
		execute: (query) => database.execute(query),
		transaction: (callback) =>
			database.transaction((tx) =>
				callback({
					async execute<T>(query: Parameters<typeof tx.execute>[0]): Promise<T[]> {
						const completing = queryPattern.test(dialect.sqlToQuery(query).sql);
						if (completing && timing === "before") await afterWrite();
						const rows = await tx.execute<T>(query);
						if (completing && timing === "after") await afterWrite();
						return rows;
					},
				}),
			),
	});
}
async function withinOneSecond<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(new Error("Duplicate held a database connection waiting for the first request")),
					1000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
