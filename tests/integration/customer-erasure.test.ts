import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { configureErasureKeyring } from "../../src/db/erasure-keyring";
import { ensureCustomer } from "../../src/db/repository/identities";
import { erasureKeyFromBase64 } from "../../src/shared/erasure-digest";
import { CustomerErasureWorker } from "../../src/workers/customer-erasure";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { stripeCheckoutSessionObject, stripeEvent } from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";
import { runStoreEventReplayWorkerOnce } from "./helpers/worker-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const key = erasureKeyFromBase64("erasure-test", Buffer.alloc(32, 5).toString("base64"));
const project = integrationProjectContext("acme");
const projectId = project.projectInstanceId;
const canary = "canary-acct-7f3a9c";
const canaryEmail = "canary-7f3a9c@example.com";
const canaryEntity = "canary-entity-7f3a9c";
const actor = "support@example.com";
let context: LocalPostgresContext;

localDescribe("customer erasure", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
		configureErasureKeyring({ current: key, previous: null }, 30);
	});

	afterEach(() => {
		configureErasureKeyring(null);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	function fixture(event?: ReturnType<typeof stripeEvent>) {
		const created = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			...(event === undefined ? {} : { stripeEvent: event }),
		});
		const operator = (idempotencyKey?: string): HeadersInit => ({
			...created.authHeaders("acme"),
			"x-billing-operator-key": context.env.operatorApiKey ?? "",
			"x-billing-actor": actor,
			"content-type": "application/json",
			...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
		});
		const post = (path: string, body: unknown, idempotencyKey?: string) =>
			testRequest(created.app, path, {
				method: "POST",
				headers: operator(idempotencyKey),
				body: JSON.stringify(body),
			});
		return {
			...created,
			preview: (billingAccountId = canary) =>
				post("/v1/admin/customer-erasures/preview", { billingAccountId }),
			erase: (
				idempotencyKey: string,
				body: Record<string, unknown> = {},
				billingAccountId = canary,
			) =>
				post(
					"/v1/admin/customer-erasures",
					{ billingAccountId, basis: "data_subject_request", ...body },
					idempotencyKey,
				),
			receipt: (erasureId: string) =>
				testRequest(created.app, `/v1/admin/customer-erasures/${erasureId}`, {
					headers: operator(),
				}),
			webhook: (eventId: string) =>
				testRequest(created.app, "/v1/projects/acme/webhooks/stripe", {
					method: "POST",
					headers: { "content-type": "application/json", "stripe-signature": "sig_test" },
					body: JSON.stringify({
						id: eventId,
						type: "checkout.session.completed",
						data: { object: {} },
					}),
				}),
			replay: () =>
				runStoreEventReplayWorkerOnce({
					env: context.env,
					repository: context.repository,
					providers: {
						apple: null,
						google: null,
						stripe: created.projectProviderServices.acme?.stripeBillingService ?? null,
					},
				}),
		};
	}

	function paidSession() {
		return stripeEvent(
			"checkout.session.completed",
			stripeCheckoutSessionObject({
				client_reference_id: canary,
				customer: "cus_canary",
				id: "cs_canary",
				metadata: {
					billingAccountId: canary,
					externalPriceId: "price_credits_10",
					externalProductId: "prod_stripe_credits_10",
					productKey: "echo_credits_10",
					purchaseKind: "consumable",
				},
				payment_intent: {
					id: "pi_canary",
					latest_charge: "ch_canary",
					metadata: { billingAccountId: canary },
					object: "payment_intent",
				},
			}),
			"evt_canary",
		);
	}

	/** An account that touched every kind of store: a paid purchase, usage, an entity, payloads. */
	async function seedAccount() {
		const created = fixture(paidSession());
		expect((await created.webhook("evt_canary")).status).toBe(200);
		const customer = await ensureCustomer(context.db as never, projectId, canary, canaryEmail);
		await context.repository.grantAllocation(project, {
			billingAccountId: canary,
			featureKey: "ai_credits",
			quantity: "100",
			sourceKind: "credit_grant",
			sourceKey: `${canary}-grant`,
		});
		await context.repository.consumeUsage(project, {
			billingAccountId: canary,
			featureKey: "model_tokens",
			quantity: "10",
			idempotencyKey: "consume-1",
			filters: { model: "a" },
			metadata: { note: canaryEmail, ref: canary },
		});
		await context.sql`
			INSERT INTO entities (project_id, customer_id, external_id, kind, metadata)
			VALUES (${projectId}, ${customer.id}, ${canaryEntity}, 'user', ${JSON.stringify({ email: canaryEmail })}::text::jsonb)
		`;
		await context.sql`
			INSERT INTO store_events (
				project_id, provider, channel, external_event_id, event_type, customer_id,
				processing_status, raw_payload
			) VALUES (
				${projectId}, 'stripe', 'web', 'evt_unlinked', 'customer.updated', NULL, 'skipped',
				${JSON.stringify({ data: { object: { email: canaryEmail, metadata: { billingAccountId: canary } } } })}::text::jsonb
			)
		`;
		await context.sql`
			INSERT INTO catalog_audit_log (project_id, catalog_revision_id, action, actor, intent_hash, details)
			SELECT ${projectId}, id, 'contract_published', ${actor}, ${"a".repeat(64)},
				${JSON.stringify({ billingAccountId: canary, entityId: canaryEntity })}::text::jsonb
			FROM catalog_revisions WHERE project_id = ${projectId} LIMIT 1
		`;
		return { ...created, customerId: customer.id as string };
	}

	/** Every table in the database whose rows still mention one of the canary strings. */
	async function tablesMentioningCanary() {
		const tables = await context.sql`
			SELECT table_name FROM information_schema.tables
			WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
				AND table_name NOT LIKE 'usage_events_%'
		`;
		const found: string[] = [];
		for (const { table_name: table } of tables) {
			const [row] = await context.sql.unsafe(
				`SELECT count(*)::int AS count FROM "${table}" AS t
				 WHERE t::text LIKE '%canary-acct-7f3a9c%' OR t::text LIKE '%canary-7f3a9c@%'
					OR t::text LIKE '%canary-entity-7f3a9c%'`,
			);
			if (row.count > 0) found.push(table);
		}
		return found.sort();
	}

	async function work(
		runs = 30,
		options: ConstructorParameters<typeof CustomerErasureWorker>[0] extends infer T
			? Partial<T>
			: never = {},
	) {
		const worker = new CustomerErasureWorker({
			repository: context.repository.customerErasures,
			workerId: "erasure-worker",
			batchSize: 2,
			...options,
		});
		for (let run = 0; run < runs; run += 1) {
			const result = await worker.runOnce();
			if (result.progressed + result.completed + result.failed === 0) return;
		}
	}

	it("previews, requires acknowledgement, erases and leaves nothing that names the account", async () => {
		const seeded = await seedAccount();
		expect(await tablesMentioningCanary()).toContain("store_events");

		const preview = await (await seeded.preview()).json();
		expect(preview.data.blockers).toEqual([]);
		expect(preview.data.requiredAcknowledgements).toEqual(["forfeit_paid_balances"]);

		const refused = await seeded.erase("erase-1", { reference: "ticket-4411" });
		expect(refused.status).toBe(409);
		expect((await refused.json()).error.code).toBe("CUSTOMER_ERASURE_ACKNOWLEDGEMENT_REQUIRED");

		const accepted = await seeded.erase("erase-1", {
			reference: "ticket-4411",
			acknowledge: ["forfeit_paid_balances"],
		});
		expect(accepted.status).toBe(201);
		const { erasure } = (await accepted.json()).data;
		expect(erasure).toMatchObject({ state: "running", basis: "data_subject_request" });
		// Frozen at once: the id is gone from the account before any batch ran.
		const [stub] = await context.sql`
			SELECT billing_account_id, email, erased_at FROM customers WHERE id = ${seeded.customerId}
		`;
		expect(stub.billing_account_id).toBe(`erased:${erasure.id}`);
		expect(stub.email).toBeNull();
		expect(stub.erased_at).not.toBeNull();

		await work();

		const finished = await (await seeded.receipt(erasure.id)).json();
		expect(finished.data).toMatchObject({ state: "completed", step: null, lastError: null });
		expect(JSON.stringify(finished)).not.toContain(canary);
		expect(await tablesMentioningCanary()).toEqual([]);
		const [receipt] = await context.sql`
			SELECT subject_id, request_hash FROM customer_erasures WHERE id = ${erasure.id}
		`;
		expect(receipt.subject_id).toBeNull();
		expect(receipt.request_hash).not.toContain(canary);
		// The facts stay: usage and the allocations it drew from.
		const [facts] = await context.sql`
			SELECT
				(SELECT count(*)::int FROM usage_events WHERE customer_id = ${seeded.customerId}) AS usage,
				(SELECT count(*)::int FROM balance_allocations WHERE customer_id = ${seeded.customerId}) AS allocations,
				(SELECT count(*)::int FROM purchases WHERE customer_id = ${seeded.customerId}) AS purchases,
				(SELECT count(*)::int FROM projection_sync_jobs WHERE customer_id = ${seeded.customerId}) AS projections
		`;
		expect(facts.usage).toBeGreaterThan(0);
		expect(facts.allocations).toBeGreaterThan(0);
		expect(facts.purchases).toBe(1);
		expect(facts.projections).toBe(0);
	});

	it("replays an erasure by its key and refuses the key for a different request", async () => {
		const seeded = await seedAccount();
		const body = { reference: "ticket-1", acknowledge: ["forfeit_paid_balances"] };
		const first = await seeded.erase("erase-replay", body);
		expect(first.status).toBe(201);
		const id = (await first.json()).data.erasure.id;

		const again = await seeded.erase("erase-replay", body);
		expect(again.status).toBe(200);
		expect((await again.json()).data).toMatchObject({ duplicate: true, erasure: { id } });

		const different = await seeded.erase("erase-replay", { ...body, reference: "ticket-2" });
		expect(different.status).toBe(409);
		expect((await different.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");

		await work();
		const afterCompletion = await seeded.erase("erase-replay", body);
		expect(afterCompletion.status).toBe(200);
		expect((await afterCompletion.json()).data.erasure.state).toBe("completed");
	});

	it("blocks while an usage reservation is held and says what", async () => {
		const seeded = await seedAccount();
		await context.repository.reserveUsage(project, {
			billingAccountId: canary,
			featureKey: "model_tokens",
			quantity: "5",
			idempotencyKey: "hold-1",
		});

		const response = await seeded.erase("erase-blocked", {
			acknowledge: ["forfeit_paid_balances"],
		});

		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.error.code).toBe("CUSTOMER_ERASURE_BLOCKED");
		expect(body.error.details.blockers).toEqual([{ kind: "usage_reservation", count: 1 }]);
		const [account] = await context.sql`
			SELECT erased_at FROM customers WHERE project_id = ${projectId} AND billing_account_id = ${canary}
		`;
		expect(account.erased_at).toBeNull();
	});

	it("answers an unknown account as not found and an erased one as erased", async () => {
		const seeded = await seedAccount();
		const unknown = await seeded.erase("erase-unknown", {}, "never-existed");
		expect(unknown.status).toBe(404);
		expect((await unknown.json()).error.code).toBe("BILLING_ACCOUNT_NOT_FOUND");

		await seeded.erase("erase-ok", { acknowledge: ["forfeit_paid_balances"] });
		const second = await seeded.erase("erase-second", { acknowledge: ["forfeit_paid_balances"] });
		expect(second.status).toBe(409);
		expect((await second.json()).error.code).toBe("BILLING_ACCOUNT_ERASED");
	});

	it("keeps every creation path from bringing the account back", async () => {
		const seeded = await seedAccount();
		await seeded.erase("erase-paths", { acknowledge: ["forfeit_paid_balances"] });
		await work();

		const put = await testRequest(seeded.app, `/v1/billing-accounts/${canary}`, {
			method: "PUT",
			headers: { ...seeded.authHeaders("acme"), "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(put.status).toBe(409);
		expect((await put.json()).error.code).toBe("BILLING_ACCOUNT_ERASED");
		await expect(
			context.repository.consumeUsage(project, {
				billingAccountId: canary,
				featureKey: "model_tokens",
				quantity: "1",
				idempotencyKey: "after-erasure",
			}),
		).rejects.toMatchObject({ code: "BILLING_ACCOUNT_ERASED" });
		const [rows] = await context.sql`
			SELECT count(*)::int AS count FROM customers
			WHERE project_id = ${projectId} AND billing_account_id = ${canary}
		`;
		expect(rows.count).toBe(0);
	});

	it("resumes after a worker stops mid-operation and takes over an expired lease", async () => {
		const seeded = await seedAccount();
		const accepted = await seeded.erase("erase-resume", { acknowledge: ["forfeit_paid_balances"] });
		const id = (await accepted.json()).data.erasure.id;

		// One row per statement and no time: the first worker can only start.
		await work(1, { batchSize: 1, budgetMs: 1, leaseSeconds: 60 });
		const [midway] =
			await context.sql`SELECT state, subject_id FROM customer_erasures WHERE id = ${id}`;
		expect(midway.state).not.toBe("completed");
		expect(midway.subject_id).toBe(canary);

		await context.sql`
			UPDATE customer_erasures SET locked_by = 'dead-worker', locked_at = now() - interval '1 hour',
				next_attempt_at = now() WHERE id = ${id}
		`;
		await work();

		const [done] =
			await context.sql`SELECT state, subject_id FROM customer_erasures WHERE id = ${id}`;
		expect(done).toEqual({ state: "completed", subject_id: null });
		expect(await tablesMentioningCanary()).toEqual([]);
	});

	it("drops a late provider event for the erased account instead of keeping its payload", async () => {
		const seeded = await seedAccount();
		await seeded.erase("erase-late", { acknowledge: ["forfeit_paid_balances"] });
		await work();

		const late = fixture(
			stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject({
					client_reference_id: canary,
					customer: "cus_canary",
					id: "cs_late",
					metadata: {
						billingAccountId: canary,
						externalPriceId: "price_credits_10",
						externalProductId: "prod_stripe_credits_10",
						productKey: "echo_credits_10",
						purchaseKind: "consumable",
					},
				}),
				"evt_late",
			),
		);
		await late.webhook("evt_late");
		await late.replay();
		await late.replay();

		expect(await tablesMentioningCanary()).toEqual([]);
		const events: Array<{ processing_status: string }> = await context.sql`
			SELECT processing_status FROM store_events WHERE external_event_id = 'evt_late'
		`;
		expect(events.every((row) => row.processing_status !== "failed")).toBe(true);
		const [rows] = await context.sql`
			SELECT count(*)::int AS count FROM customers
			WHERE project_id = ${projectId} AND billing_account_id = ${canary}
		`;
		expect(rows.count).toBe(0);
	});

	it("lets the id start again once the tombstone expired and the sweep ran", async () => {
		const seeded = await seedAccount();
		await seeded.erase("erase-expiry", { acknowledge: ["forfeit_paid_balances"] });
		await work();
		await context.sql`
			UPDATE customer_erasure_tombstones
			SET created_at = now() - interval '40 days', expires_at = now() - interval '10 days'
		`;
		await context.sql`UPDATE customer_erasures SET tombstone_expires_at = now() - interval '10 days'`;

		const reopened = await ensureCustomer(context.db as never, projectId, canary);
		expect(reopened.billing_account_id).toBe(canary);
		expect(await context.repository.customerErasures.sweepCustomerErasures(100)).toBeGreaterThan(0);
		const [receipt] = await context.sql`SELECT request_hash FROM customer_erasures LIMIT 1`;
		expect(receipt.request_hash).toBeNull();
	});
});
