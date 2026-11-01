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

async function refusal(call: () => Promise<unknown>): Promise<string> {
	try {
		await call();
	} catch (error) {
		return (error as { code: string }).code;
	}
	throw new Error("the call was not refused");
}

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

	it("leaves nothing that names the account in a redemption's stored results and keys", async () => {
		const seeded = await seedAccount();
		const { promotions } = context.repository;
		await promotions.createPromotion(project, {
			key: "canary-grant",
			name: "Canary grant",
			effect: {
				kind: "feature_grant",
				items: [{ featureKey: "ai_credits", quantity: "5", expiresAfterSeconds: null }],
			},
			codes: [{ code: "CANARY-GRANT" }],
			actor,
		});
		const redeemed = await promotions.redeemPromotionCode(project, {
			billingAccountId: canary,
			code: "CANARY-GRANT",
			channel: "web",
			idempotencyKey: `redeem-${canary}`,
			actor: null,
		});
		if (redeemed.redemption === null) throw new Error("the grant was not redeemed");
		await promotions.revokePromotionRedemption(project, {
			redemptionId: redeemed.redemption.id,
			reason: `asked by ${canaryEmail}`,
			actor,
			idempotencyKey: `revoke-${canary}`,
		});
		await context.sql`
			INSERT INTO promotion_apple_signature_attempts (
				project_id, customer_id, redemption_id, idempotency_key, request_hash, result
			) VALUES (
				${projectId}, ${seeded.customerId}, ${redeemed.redemption.id}, ${`signature-${canary}`},
				${"b".repeat(64)}, ${JSON.stringify({ redemption: { billingAccountId: canary } })}::text::jsonb
			)
		`;
		expect(await tablesMentioningCanary()).toContain("promotion_redemptions");

		const accepted = await seeded.erase("erase-redemptions", {
			acknowledge: ["forfeit_paid_balances"],
		});
		expect(accepted.status).toBe(201);
		await work();

		expect(await tablesMentioningCanary()).toEqual([]);
		// The ledger stays: what was redeemed and that it was reversed.
		const [row] = await context.sql`
			SELECT status, reversed_at FROM promotion_redemptions WHERE customer_id = ${seeded.customerId}
		`;
		expect(row.status).toBe("reversed");
		expect(row.reversed_at).not.toBeNull();
	});

	it("runs the documented cleanup for redemptions an older erasure left behind", async () => {
		const guide = await Bun.file("docs/operations.md").text();
		const batch = (name: string) => {
			const statement = guide.match(new RegExp(`\`\`\`sql\n(-- ${name}[\\s\\S]*?)\n\`\`\``))?.[1];
			if (statement === undefined) throw new Error(`Missing ${name} SQL`);
			return statement;
		};
		const seeded = await seedAccount();
		const { promotions } = context.repository;
		await promotions.createPromotion(project, {
			key: "canary-grant",
			name: "Canary grant",
			effect: {
				kind: "feature_grant",
				items: [{ featureKey: "ai_credits", quantity: "5", expiresAfterSeconds: null }],
			},
			codes: [{ code: "CANARY-GRANT" }, { code: "OTHER-GRANT" }],
			actor,
		});
		const redeemed = await promotions.redeemPromotionCode(project, {
			billingAccountId: canary,
			code: "CANARY-GRANT",
			channel: "web",
			idempotencyKey: "redeem-1",
			actor: null,
		});
		if (redeemed.redemption === null) throw new Error("the grant was not redeemed");
		// Another account's redemption, which the cleanup must leave alone.
		await ensureCustomer(context.db as never, projectId, "active-account");
		await promotions.redeemPromotionCode(project, {
			billingAccountId: "active-account",
			code: "OTHER-GRANT",
			channel: "web",
			idempotencyKey: "active-redeem",
			actor: null,
		});
		const accepted = await seeded.erase("erase-history", {
			acknowledge: ["forfeit_paid_balances"],
		});
		expect(accepted.status).toBe(201);
		await work();

		// What an erasure from before the fix leaves in place.
		const leftover = JSON.stringify({ redemption: { billingAccountId: canary } });
		await context.sql`
			UPDATE promotion_redemptions
			SET idempotency_key = ${`api_redeem:${canary}`}, result = ${leftover}::text::jsonb
			WHERE customer_id = ${seeded.customerId}
		`;
		await context.sql`
			INSERT INTO promotion_apple_signature_attempts (
				project_id, customer_id, redemption_id, idempotency_key, request_hash, result
			) VALUES (
				${projectId}, ${seeded.customerId}, ${redeemed.redemption.id}, ${`signature-${canary}`},
				${"c".repeat(64)}, ${leftover}::text::jsonb
			)
		`;
		expect(await tablesMentioningCanary()).toEqual([
			"promotion_apple_signature_attempts",
			"promotion_redemptions",
		]);

		const run = async (statement: string) => {
			const [row] = await context.sql.unsafe<{ updated: string }[]>(statement);
			return Number(row?.updated);
		};
		expect(await run(batch("Erased redemption cleanup batch"))).toBe(1);
		expect(await run(batch("Erased signature attempt cleanup batch"))).toBe(1);
		expect(await run(batch("Erased redemption cleanup batch"))).toBe(0);
		expect(await run(batch("Erased signature attempt cleanup batch"))).toBe(0);

		expect(await tablesMentioningCanary()).toEqual([]);
		const [active] = await context.sql`
			SELECT redemption.idempotency_key, redemption.result IS NOT NULL AS has_result
			FROM promotion_redemptions redemption
			JOIN customers customer ON customer.id = redemption.customer_id
			WHERE customer.billing_account_id = 'active-account'
		`;
		expect(active.idempotency_key).toBe("api_redeem:active-redeem");
		expect(active.has_result).toBe(true);
	});

	it("finishes for an account that holds a code restricted to it", async () => {
		const seeded = await seedAccount();
		await context.repository.promotions.createPromotion(project, {
			key: "canary-only",
			name: "Canary only",
			effect: {
				kind: "feature_grant",
				items: [{ featureKey: "ai_credits", quantity: "5", expiresAfterSeconds: null }],
			},
			codes: [{ code: "CANARY-ONLY", billingAccountId: canary }],
			actor,
		});

		const accepted = await seeded.erase("erase-restricted", {
			acknowledge: ["forfeit_paid_balances"],
		});
		expect(accepted.status).toBe(201);
		const { erasure } = (await accepted.json()).data;
		await work();

		const finished = await (await seeded.receipt(erasure.id)).json();
		expect(finished.data).toMatchObject({ state: "completed", lastError: null });
		expect(await tablesMentioningCanary()).toEqual([]);
		const [code] = await context.sql`
			SELECT active, deactivated_at, deactivated_by FROM promotion_codes
			WHERE project_id = ${projectId} AND normalized_code = 'CANARY-ONLY'
		`;
		expect(code.active).toBe(false);
		expect(code.deactivated_at).not.toBeNull();
		expect(code.deactivated_by).toBe("system:customer-erasure");
	});

	/** A program rewarding both sides with credits, for referrals around the erased account. */
	async function referralProgram() {
		await context.repository.promotions.createPromotion(project, {
			key: "referral-credits",
			name: "Referral credits",
			effect: {
				kind: "feature_grant",
				items: [{ featureKey: "ai_credits", quantity: "5", expiresAfterSeconds: null }],
			},
			actor,
		});
		await context.repository.referrals.createProgram(project, {
			key: "friends",
			name: "Friends",
			rewardPromotionKey: "referral-credits",
			trigger: "redemption",
			recipient: "both",
			actor,
		});
		await ensureCustomer(context.db as never, projectId, "friend-account");
		return context.repository.referrals;
	}

	it("removes an erased referrer's code and leaves nothing that names it in a referral", async () => {
		const seeded = await seedAccount();
		const referrals = await referralProgram();
		const { code } = await referrals.getOrCreateCode(project, {
			billingAccountId: canary,
			programKey: "friends",
		});
		await referrals.redeemCode(project, {
			billingAccountId: "friend-account",
			code,
			channel: "web",
		});

		const accepted = await seeded.erase("erase-referrer", {
			acknowledge: ["forfeit_paid_balances"],
		});
		expect(accepted.status).toBe(201);
		await work();

		expect(await tablesMentioningCanary()).toEqual([]);
		const [codes] = await context.sql`SELECT count(*)::int AS count FROM referral_codes`;
		expect(codes.count).toBe(0);
		const page = await referrals.listAccountReferrals(project, "friend-account", {
			limit: 10,
			cursor: null,
			role: "referee",
		});
		expect(page.items[0]?.counterpartBillingAccountId).toBeNull();
		// The friend keeps what the friend was given.
		expect(page.items[0]?.rewards[0]?.status).toBe("issued");
		expect(
			await refusal(() =>
				referrals.redeemCode(project, {
					billingAccountId: "friend-account",
					code,
					channel: "web",
				}),
			),
		).toBe("REFERRAL_CODE_NOT_FOUND");
	});

	it("leaves nothing that names an erased referee, and shows the referrer no id", async () => {
		const referrals = await referralProgram();
		const { code } = await referrals.getOrCreateCode(project, {
			billingAccountId: "friend-account",
			programKey: "friends",
		});
		// A referee enters the code before paying; seeding gives the account its paid purchase.
		await ensureCustomer(context.db as never, projectId, canary, canaryEmail);
		await referrals.redeemCode(project, { billingAccountId: canary, code, channel: "web" });
		const seeded = await seedAccount();

		const accepted = await seeded.erase("erase-referee", {
			acknowledge: ["forfeit_paid_balances"],
		});
		expect(accepted.status).toBe(201);
		await work();

		expect(await tablesMentioningCanary()).toEqual([]);
		const ledger = await referrals.listProgramReferrals(project, "friends", {
			limit: 10,
			cursor: null,
		});
		expect(ledger.items[0]).toMatchObject({
			referrerBillingAccountId: "friend-account",
			refereeBillingAccountId: null,
		});
	});

	it("skips a reward still owed to an account erased in the meantime", async () => {
		const seeded = await seedAccount();
		const referrals = await referralProgram();
		const { code } = await referrals.getOrCreateCode(project, {
			billingAccountId: canary,
			programKey: "friends",
		});
		await referrals.redeemCode(project, {
			billingAccountId: "friend-account",
			code,
			channel: "web",
		});
		// The inline attempt issued it, so put the reward back to what a failed attempt leaves.
		const [reward] = await context.sql`
			UPDATE referral_rewards SET status = 'pending', issued_at = NULL, promotion_code_id = NULL
			WHERE recipient = 'referrer'
			RETURNING id
		`;

		const accepted = await seeded.erase("erase-owed", {
			acknowledge: ["forfeit_paid_balances"],
		});
		expect(accepted.status).toBe(201);
		await work();
		await referrals.issueReward(project, reward.id);

		const [row] = await context.sql`
			SELECT status, reason, promotion_code_id FROM referral_rewards WHERE id = ${reward.id}
		`;
		expect(row).toEqual({
			status: "skipped",
			reason: "RECIPIENT_ERASED",
			promotion_code_id: null,
		});
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
