import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { CreatePromotionInput, PromotionCodeInput } from "../../src/billing/promotions";
import type { ReservePromotionRedemptionInput } from "../../src/db/repository/promotions";
import { syncPromotionStripeObject } from "../../src/providers/stripe/promotions";
import { createFakeStripePromotions } from "../../src/providers/stripe/testing/fake-promotions";
import { PromotionMaintenanceWorker } from "../../src/workers/promotion-maintenance";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";
import { integrationProjectContextResolver } from "./helpers/platform-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
const actor = "operator@example.com";
let context: LocalPostgresContext;

localDescribe("promotion repository", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("creates promotions idempotently and rejects changed terms", async () => {
		const input = discountPromotion({
			codes: [
				{ code: "SPRING", maxRedemptions: 5 },
				{ code: "Hosted-1", hostedCheckoutEnabled: true },
			],
		});

		const first = await context.repository.promotions.createPromotion(project, input);
		const replay = await context.repository.promotions.createPromotion(project, input);

		expect(first.created).toBe(true);
		expect(replay.created).toBe(false);
		expect(replay.promotion).toEqual(first.promotion);
		expect(first.promotion).toMatchObject({
			key: "spring-sale",
			status: "active",
			effect: {
				kind: "discount",
				discount: { type: "percent", percentOffBps: 2000, duration: "once", durationMonths: null },
			},
			targets: [{ kind: "product", key: "echo_credits_10" }],
			allowedChannels: ["web", "ios", "android"],
			codeCounts: { total: 2, active: 2 },
			redemptionCounts: { reserved: 0, applied: 0, released: 0, reversed: 0 },
			createdBy: actor,
		});
		expect(
			await captureCode(
				context.repository.promotions.createPromotion(project, { ...input, name: "Renamed" }),
			),
		).toBe("PROMOTION_KEY_CONFLICT");
		const audit = await context.sql<Array<{ action: string }>>`
			SELECT action FROM promotion_audit_events ORDER BY id
		`;
		expect(audit.map((row) => row.action)).toEqual(["promotion_created", "codes_added"]);
	});

	it("resolves catalog references for discounts and grants", async () => {
		const grant = await context.repository.promotions.createPromotion(project, {
			key: "welcome-credits",
			name: "Welcome credits",
			effect: {
				kind: "feature_grant",
				items: [{ featureKey: "ai_credits", quantity: "1000.500", expiresAfterSeconds: 86_400 }],
			},
			actor,
		});
		const planGrant = await context.repository.promotions.createPromotion(project, {
			key: "premium-trial",
			name: "Premium trial",
			effect: { kind: "plan_grant", planKey: "premium", durationUnit: "day", durationCount: 30 },
			allowedChannels: ["web", "android"],
			actor,
		});

		expect(grant.promotion.effect).toEqual({
			kind: "feature_grant",
			items: [{ featureKey: "ai_credits", quantity: "1000.5", expiresAfterSeconds: 86_400 }],
		});
		expect(planGrant.promotion.effect).toEqual({
			kind: "plan_grant",
			planKey: "premium",
			durationUnit: "day",
			durationCount: 30,
		});
		expect(
			await captureCode(
				context.repository.promotions.createPromotion(
					project,
					discountPromotion({ key: "missing-target", targets: [{ kind: "plan", key: "unknown" }] }),
				),
			),
		).toBe("PROMOTION_TARGET_NOT_FOUND");
		expect(
			await captureCode(
				context.repository.promotions.createPromotion(project, {
					key: "fractional-tokens",
					name: "Fractional tokens",
					effect: {
						kind: "feature_grant",
						items: [{ featureKey: "model_tokens", quantity: "1.5", expiresAfterSeconds: null }],
					},
					actor,
				}),
			),
		).toBe("PROMOTION_TERMS_INVALID");
	});

	it("adds, replays and deactivates codes with case-insensitive uniqueness", async () => {
		await context.repository.promotions.createPromotion(
			project,
			discountPromotion({ codes: [{ code: "SPRING" }] }),
		);
		await context.repository.promotions.createPromotion(
			project,
			discountPromotion({ key: "summer-sale", name: "Summer sale" }),
		);

		const replay = await context.repository.promotions.addPromotionCodes(
			project,
			"spring-sale",
			[{ code: "SPRING" }, { code: "SPRING-VIP", maxRedemptions: 10 }],
			actor,
		);
		expect(replay.created).toBe(1);
		expect(replay.codes.map((code) => code.code)).toEqual(["SPRING", "SPRING-VIP"]);
		expect(
			await captureCode(
				context.repository.promotions.addPromotionCodes(
					project,
					"summer-sale",
					[{ code: "spring" }],
					actor,
				),
			),
		).toBe("PROMOTION_CODE_CONFLICT");
		expect(
			await captureCode(
				context.repository.promotions.addPromotionCodes(
					project,
					"spring-sale",
					[{ code: "SPRING", maxRedemptions: 3 }],
					actor,
				),
			),
		).toBe("PROMOTION_CODE_CONFLICT");

		const vip = replay.codes.find((code) => code.code === "SPRING-VIP");
		if (vip === undefined) throw new Error("missing SPRING-VIP");
		const deactivated = await context.repository.promotions.deactivatePromotionCode(
			project,
			"spring-sale",
			vip.id,
			actor,
		);
		const again = await context.repository.promotions.deactivatePromotionCode(
			project,
			"spring-sale",
			vip.id,
			actor,
		);
		expect(deactivated).toMatchObject({ active: false, deactivatedBy: actor });
		expect(again.deactivatedAt).toBe(deactivated.deactivatedAt);
		const active = await context.repository.promotions.listPromotionCodes(project, "spring-sale", {
			active: true,
			limit: 10,
		});
		expect(active.items.map((code) => code.code)).toEqual(["SPRING"]);

		const archived = await context.repository.promotions.archivePromotion(
			project,
			"spring-sale",
			actor,
		);
		expect(archived).toMatchObject({ status: "archived", archivedBy: actor });
		expect(
			await captureCode(
				context.repository.promotions.addPromotionCodes(
					project,
					"spring-sale",
					[{ code: "LATE" }],
					actor,
				),
			),
		).toBe("PROMOTION_ARCHIVED");
		expect(
			(
				await context.repository.promotions.createPromotion(
					project,
					discountPromotion({ codes: [{ code: "SPRING" }] }),
				)
			).created,
		).toBe(false);
	});

	it("never exceeds a global cap under concurrent reservations", async () => {
		const code = await createCode({ code: "FLASH", maxRedemptions: 5 });
		const customers = await Promise.all(
			Array.from({ length: 20 }, (_, index) => customerId(`flash-${index}`)),
		);

		const outcomes = await Promise.allSettled(
			customers.map((id, index) =>
				context.repository.promotions.reservePromotionRedemption(
					project,
					reservation({
						customerId: id,
						billingAccountId: `flash-${index}`,
						promotionCodeId: code,
					}),
				),
			),
		);

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(5);
		expect(
			outcomes
				.filter((outcome) => outcome.status === "rejected")
				.map((outcome) => (outcome as PromiseRejectedResult).reason.code),
		).toEqual(Array(15).fill("PROMOTION_CODE_EXHAUSTED"));
		const [counters] = await context.sql<Array<{ reserved_count: number; redeemed_count: number }>>`
			SELECT reserved_count, redeemed_count FROM promotion_codes WHERE id = ${code}
		`;
		expect(counters).toEqual({ reserved_count: 5, redeemed_count: 0 });
	});

	it("serializes one customer's concurrent attempts against the per-customer cap", async () => {
		const code = await createCode({ code: "ONCE" });
		const id = await customerId("single");

		const outcomes = await Promise.allSettled(
			Array.from({ length: 5 }, (_, index) =>
				context.repository.promotions.reservePromotionRedemption(
					project,
					reservation({
						customerId: id,
						billingAccountId: "single",
						promotionCodeId: code,
						idempotencyKey: `attempt-${index}`,
						reservedUntil: null,
					}),
				),
			),
		);

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(
			outcomes
				.filter((outcome) => outcome.status === "rejected")
				.map((outcome) => (outcome as PromiseRejectedResult).reason.code),
		).toEqual(Array(4).fill("PROMOTION_CODE_ALREADY_REDEEMED"));
	});

	it("replays by idempotency key and rejects a changed request", async () => {
		const code = await createCode({ code: "REPLAY", maxRedemptionsPerCustomer: null });
		const id = await customerId("replay");
		const input = reservation({
			customerId: id,
			billingAccountId: "replay",
			promotionCodeId: code,
		});

		const first = await context.repository.promotions.reservePromotionRedemption(project, input);
		const replay = await context.repository.promotions.reservePromotionRedemption(project, input);

		expect(first.duplicate).toBe(false);
		expect(replay).toEqual({ redemption: first.redemption, duplicate: true });
		expect(first.redemption).toMatchObject({
			status: "reserved",
			code: "REPLAY",
			billingAccountId: "replay",
			provider: "stripe",
			source: "commercial_action",
		});
		expect(
			await captureCode(
				context.repository.promotions.reservePromotionRedemption(project, {
					...input,
					requestHash: "b".repeat(64),
				}),
			),
		).toBe("IDEMPOTENCY_CONFLICT");
	});

	it("applies, releases and sweeps reservations while recording late overruns", async () => {
		const code = await createCode({
			code: "LATE",
			maxRedemptions: 1,
			maxRedemptionsPerCustomer: null,
		});
		const first = await customerId("late-1");
		const second = await customerId("late-2");
		const expired = await context.repository.promotions.reservePromotionRedemption(
			project,
			reservation({
				customerId: first,
				billingAccountId: "late-1",
				promotionCodeId: code,
				reservedUntil: new Date(Date.now() - 1_000),
			}),
		);

		expect(await context.repository.promotions.releaseExpiredPromotionReservations(10)).toBe(1);
		const taken = await context.repository.promotions.reservePromotionRedemption(
			project,
			reservation({ customerId: second, billingAccountId: "late-2", promotionCodeId: code }),
		);
		const applied = await context.repository.promotions.applyPromotionRedemption(project, {
			redemptionId: taken.redemption.id,
			stripeCheckoutSessionId: "cs_late_2",
			currency: "usd",
			amountTotalMinor: 399,
		});
		const late = await context.repository.promotions.applyPromotionRedemption(project, {
			redemptionId: expired.redemption.id,
			stripeCheckoutSessionId: "cs_late_1",
		});

		expect(applied).toMatchObject({
			status: "applied",
			stripeCheckoutSessionId: "cs_late_2",
			currency: "USD",
			amountTotalMinor: 399,
			limitViolation: null,
		});
		expect(late).toMatchObject({ status: "applied", limitViolation: "global" });
		const [counters] = await context.sql<Array<{ reserved_count: number; redeemed_count: number }>>`
			SELECT reserved_count, redeemed_count FROM promotion_codes WHERE id = ${code}
		`;
		expect(counters).toEqual({ reserved_count: 0, redeemed_count: 2 });
		expect(
			(await context.repository.promotions.releasePromotionRedemption(project, taken.redemption.id))
				.status,
		).toBe("applied");
	});

	it("frees a customer's own expired reservation before checking the per-customer cap", async () => {
		const code = await createCode({ code: "RETRY" });
		const id = await customerId("retry");
		await context.repository.promotions.reservePromotionRedemption(
			project,
			reservation({
				customerId: id,
				billingAccountId: "retry",
				promotionCodeId: code,
				idempotencyKey: "abandoned",
				reservedUntil: new Date(Date.now() - 1_000),
			}),
		);

		const retry = await context.repository.promotions.reservePromotionRedemption(
			project,
			reservation({
				customerId: id,
				billingAccountId: "retry",
				promotionCodeId: code,
				idempotencyKey: "retry",
			}),
		);

		expect(retry.redemption.status).toBe("reserved");
		const statuses = await context.sql<Array<{ idempotency_key: string; status: string }>>`
			SELECT idempotency_key, status FROM promotion_redemptions ORDER BY idempotency_key
		`;
		expect(statuses).toEqual([
			{ idempotency_key: "abandoned", status: "released" },
			{ idempotency_key: "retry", status: "reserved" },
		]);
	});

	it("enforces account restrictions, channels and first-purchase codes", async () => {
		const restricted = await createCode({ code: "VIP-ONLY", billingAccountId: "vip" });
		const firstPurchase = await createCode({ code: "FIRST", firstPurchaseOnly: true });
		const buyer = await customerId("buyer");
		await context.sql`
			INSERT INTO purchases (
				project_id, customer_id, product_id, provider, channel, purchase_kind,
				transaction_id, status
			)
			SELECT ${project.projectInstanceId}, ${buyer}, id, 'stripe', 'web', 'consumable',
				'pi_existing', 'completed'
			FROM products
			WHERE project_id = ${project.projectInstanceId} AND key = 'echo_credits_10'
		`;

		expect(
			await captureCode(
				context.repository.promotions.reservePromotionRedemption(
					project,
					reservation({
						customerId: buyer,
						billingAccountId: "buyer",
						promotionCodeId: restricted,
					}),
				),
			),
		).toBe("PROMOTION_CODE_NOT_FOUND");
		expect(
			await captureCode(
				context.repository.promotions.reservePromotionRedemption(
					project,
					reservation({
						customerId: buyer,
						billingAccountId: "buyer",
						promotionCodeId: firstPurchase,
					}),
				),
			),
		).toBe("PROMOTION_CODE_FIRST_PURCHASE_ONLY");
		await context.repository.promotions.createPromotion(
			project,
			discountPromotion({
				key: "web-only",
				name: "Web only",
				allowedChannels: ["web"],
				codes: [{ code: "WEB-ONLY" }],
			}),
		);
		const [webOnly] = (
			await context.repository.promotions.listPromotionCodes(project, "web-only", { limit: 1 })
		).items;
		if (webOnly === undefined) throw new Error("missing WEB-ONLY");
		expect(
			await captureCode(
				context.repository.promotions.reservePromotionRedemption(
					project,
					reservation({
						customerId: buyer,
						billingAccountId: "buyer",
						promotionCodeId: webOnly.id,
						channel: "ios",
					}),
				),
			),
		).toBe("PROMOTION_CODE_CHANNEL_NOT_SUPPORTED");
		expect(
			await context.repository.promotions.addPromotionCodes(project, "web-only", [], actor),
		).toEqual({ codes: [], created: 0 });
		const newcomer = await customerId("newcomer");
		expect(
			(
				await context.repository.promotions.reservePromotionRedemption(
					project,
					reservation({
						customerId: newcomer,
						billingAccountId: "newcomer",
						promotionCodeId: firstPurchase,
					}),
				)
			).redemption.status,
		).toBe("reserved");
	});

	it("paginates promotions and filters redemptions by billing account", async () => {
		for (const key of ["a-sale", "b-sale", "c-sale"]) {
			await context.repository.promotions.createPromotion(
				project,
				discountPromotion({ key, name: key }),
			);
		}
		const code = await createCode({ code: "PAGE", maxRedemptionsPerCustomer: null });
		for (const account of ["page-1", "page-2"]) {
			await context.repository.promotions.reservePromotionRedemption(
				project,
				reservation({
					customerId: await customerId(account),
					billingAccountId: account,
					promotionCodeId: code,
				}),
			);
		}

		const first = await context.repository.promotions.listPromotions(project, { limit: 2 });
		const second = await context.repository.promotions.listPromotions(project, {
			limit: 2,
			cursor: first.nextCursor,
		});
		const redemptions = await context.repository.promotions.listPromotionRedemptions(
			project,
			"spring-sale",
			{ limit: 10, billingAccountId: "page-2" },
		);

		expect(first.items).toHaveLength(2);
		expect(first.nextCursor).not.toBeNull();
		expect([...first.items, ...second.items].map((item) => item.key).sort()).toEqual([
			"a-sale",
			"b-sale",
			"c-sale",
			"spring-sale",
		]);
		expect(second.nextCursor).toBeNull();
		expect(redemptions.items.map((item) => item.billingAccountId)).toEqual(["page-2"]);
		expect(
			(await context.repository.promotions.getPromotion(project, "spring-sale")).redemptionCounts,
		).toEqual({ reserved: 2, applied: 0, released: 0, reversed: 0 });
	});
});

localDescribe("promotion HTTP API", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
		await publishAiCreditsCatalog(context.repository, "wiseley");
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("manages promotions through operator routes and validates codes for an account", async () => {
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const operator = {
			...authHeaders("voysee"),
			"x-billing-operator-key": context.env.operatorApiKey ?? "",
			"x-billing-actor": actor,
			"content-type": "application/json",
		};
		const body = JSON.stringify({
			key: "premium-launch",
			name: "Premium launch",
			effect: {
				kind: "discount",
				discount: {
					type: "amount",
					amounts: [{ currency: "usd", amountOffMinor: 300 }],
					duration: "repeating",
					durationMonths: 3,
				},
			},
			targets: [{ kind: "plan", key: "premium" }],
			allowedChannels: ["web"],
			codes: [
				{ code: "LAUNCH", maxRedemptions: 50 },
				{ code: "LAUNCH-EXPIRED", expiresAt: "2026-01-01T00:00:00Z" },
				{ code: "LAUNCH-VIP", billingAccountId: "vip-account" },
			],
		});

		const created = await testRequest(app, "/v1/admin/promotions", {
			method: "POST",
			headers: operator,
			body,
		});
		const replay = await testRequest(app, "/v1/admin/promotions", {
			method: "POST",
			headers: operator,
			body,
		});
		expect(created.status).toBe(201);
		expect(replay.status).toBe(200);
		expect((await created.json()).data).toMatchObject({
			key: "premium-launch",
			effect: {
				kind: "discount",
				discount: { type: "amount", amounts: [{ currency: "USD", amountOffMinor: 300 }] },
			},
			codeCounts: { total: 3, active: 3 },
		});

		const validate = async (billingAccountId: string, payload: unknown) => {
			const response = await testRequest(
				app,
				`/v1/billing-accounts/${billingAccountId}/promotion-codes/validate`,
				{
					method: "POST",
					headers: { ...authHeaders("voysee"), "content-type": "application/json" },
					body: JSON.stringify(payload),
				},
			);
			expect(response.status).toBe(200);
			return (await response.json()).data;
		};
		expect(
			await validate("buyer", { code: "launch", target: { kind: "plan", key: "premium" } }),
		).toMatchObject({
			valid: true,
			reason: null,
			promotion: { key: "premium-launch", effectKind: "discount" },
			code: { code: "LAUNCH" },
		});
		expect(await validate("buyer", { code: "LAUNCH-EXPIRED" })).toMatchObject({
			valid: false,
			reason: "PROMOTION_CODE_EXPIRED",
		});
		expect(await validate("buyer", { code: "LAUNCH-VIP" })).toEqual({
			valid: false,
			reason: "PROMOTION_CODE_NOT_FOUND",
			promotion: null,
			code: null,
		});
		expect(await validate("buyer", { code: "LAUNCH", channel: "ios" })).toMatchObject({
			valid: false,
			reason: "PROMOTION_CODE_CHANNEL_NOT_SUPPORTED",
		});
		expect(
			await validate("buyer", {
				code: "LAUNCH",
				target: { kind: "product", key: "echo_credits_10" },
			}),
		).toMatchObject({ valid: false, reason: "PROMOTION_CODE_NOT_APPLICABLE" });
		expect(await validate("nobody", { code: "UNKNOWN" })).toMatchObject({
			valid: false,
			reason: "PROMOTION_CODE_NOT_FOUND",
		});
		expect(
			await context.sql`SELECT id FROM customers WHERE billing_account_id IN ('buyer', 'nobody')`,
		).toHaveLength(0);

		const codes = await testRequest(app, "/v1/admin/promotions/premium-launch/codes?active=true", {
			headers: operator,
		});
		const launch = (await codes.json()).data.find(
			(item: { code: string }) => item.code === "LAUNCH",
		);
		await context.repository.promotions.reservePromotionRedemption(
			project,
			reservation({
				customerId: await customerId("buyer"),
				billingAccountId: "buyer",
				promotionCodeId: launch.id,
			}),
		);
		expect(await validate("buyer", { code: "LAUNCH" })).toMatchObject({
			valid: false,
			reason: "PROMOTION_CODE_ALREADY_REDEEMED",
		});
		const redemptions = await testRequest(
			app,
			"/v1/admin/promotions/premium-launch/redemptions?billingAccountId=buyer",
			{ headers: operator },
		);
		expect((await redemptions.json()).data).toMatchObject([
			{ billingAccountId: "buyer", code: "LAUNCH", status: "reserved" },
		]);

		const deactivated = await testRequest(
			app,
			`/v1/admin/promotions/premium-launch/codes/${launch.id}/deactivate`,
			{ method: "POST", headers: operator },
		);
		expect((await deactivated.json()).data).toMatchObject({ active: false, deactivatedBy: actor });
		const archived = await testRequest(app, "/v1/admin/promotions/premium-launch/archive", {
			method: "POST",
			headers: operator,
		});
		expect((await archived.json()).data.status).toBe("archived");
		const added = await testRequest(app, "/v1/admin/promotions/premium-launch/codes", {
			method: "POST",
			headers: operator,
			body: JSON.stringify({ codes: [{ code: "TOO-LATE" }] }),
		});
		expect(added.status).toBe(409);
		expect((await added.json()).error.code).toBe("PROMOTION_ARCHIVED");
	});

	it("isolates promotions and codes between project instances", async () => {
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await context.repository.promotions.createPromotion(
			project,
			discountPromotion({ codes: [{ code: "SHARED" }] }),
		);
		const wiseleyOperator = {
			...authHeaders("wiseley"),
			"x-billing-operator-key": context.env.operatorApiKey ?? "",
			"x-billing-actor": actor,
			"content-type": "application/json",
		};

		const read = await testRequest(app, "/v1/admin/promotions/spring-sale", {
			headers: wiseleyOperator,
		});
		const validate = await testRequest(app, "/v1/billing-accounts/buyer/promotion-codes/validate", {
			method: "POST",
			headers: { ...authHeaders("wiseley"), "content-type": "application/json" },
			body: JSON.stringify({ code: "SHARED" }),
		});
		const sameKey = await testRequest(app, "/v1/admin/promotions", {
			method: "POST",
			headers: wiseleyOperator,
			body: JSON.stringify({
				key: "spring-sale",
				name: "Wiseley spring",
				effect: {
					kind: "discount",
					discount: { type: "percent", percentOffBps: 500, duration: "forever" },
				},
				codes: [{ code: "SHARED" }],
			}),
		});

		expect(read.status).toBe(404);
		expect((await read.json()).error.code).toBe("PROMOTION_NOT_FOUND");
		expect((await validate.json()).data).toMatchObject({
			valid: false,
			reason: "PROMOTION_CODE_NOT_FOUND",
		});
		expect(sameKey.status).toBe(201);
		const listed = await testRequest(app, "/v1/admin/promotions", { headers: wiseleyOperator });
		expect((await listed.json()).data.map((item: { name: string }) => item.name)).toEqual([
			"Wiseley spring",
		]);
	});
});

localDescribe("promotion Stripe provisioning", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("provisions coupons and hosted codes, follows catalog product changes and deactivates codes", async () => {
		const stripe = createFakeStripePromotions();
		let failNext = false;
		const worker = new PromotionMaintenanceWorker({
			workerId: "promotion-worker",
			repository: {
				releaseExpiredPromotionReservations: (limit) =>
					context.repository.promotions.releaseExpiredPromotionReservations(limit),
				reconcilePromotionCoupons: (limit) =>
					context.repository.promotionProviders.reconcilePromotionCoupons(limit),
				ensureHostedPromotionCodeObjects: (limit) =>
					context.repository.promotionProviders.ensureHostedPromotionCodeObjects(limit),
				claimStripeObjects: (workerId, limit, staleBefore) =>
					context.repository.promotionProviders.claimStripeObjects(workerId, limit, staleBefore),
				markStripeObjectOutcome: (projectId, objectId, workerId, outcome) =>
					context.repository.promotionProviders.markStripeObjectOutcome(
						projectId,
						objectId,
						workerId,
						outcome,
					),
			},
			projectContextResolver: integrationProjectContextResolver(),
			stripeForProject: () => ({
				syncPromotionStripeObject: async (job) => {
					if (failNext) {
						failNext = false;
						return {
							kind: "failed",
							error: "No such product: prod_stripe_premium",
							terminal: true,
						};
					}
					return await syncPromotionStripeObject(stripe, job);
				},
			}),
			logger: { error() {} },
		});
		await context.repository.promotions.createPromotion(
			project,
			discountPromotion({
				key: "premium-launch",
				name: "Premium launch",
				targets: [{ kind: "plan", key: "premium" }],
				codes: [
					{ code: "HOSTED", hostedCheckoutEnabled: true, maxRedemptions: 10 },
					{ code: "API" },
				],
			}),
		);

		expect(await worker.runOnce()).toMatchObject({
			couponsCreated: 1,
			promotionCodesCreated: 1,
			claimed: 1,
			ready: 1,
		});
		expect(await worker.runOnce()).toMatchObject({ couponsCreated: 0, claimed: 1, ready: 1 });
		let promotion = await context.repository.promotions.getPromotion(project, "premium-launch");
		const [coupon, hostedCode] = promotion.providerObjects;
		expect(promotion.providerObjects).toMatchObject([
			{ objectKind: "coupon", status: "ready", providerActive: true },
			{ objectKind: "promotion_code", status: "ready", providerActive: true, desiredActive: true },
		]);
		expect(stripe.state.coupons.get(coupon?.externalId ?? "")?.params).toMatchObject({
			percent_off: 20,
			duration: "once",
			applies_to: { products: ["prod_stripe_premium"] },
		});
		expect(stripe.state.promotionCodes.get(hostedCode?.externalId ?? "")?.params).toMatchObject({
			code: "HOSTED",
			active: true,
			max_redemptions: 10,
		});
		expect(await worker.runOnce()).toMatchObject({ claimed: 0 });

		await context.sql`
			UPDATE store_products SET external_product_id = 'prod_stripe_premium_v2'
			WHERE external_product_id = 'prod_stripe_premium'
		`;
		await context.sql`UPDATE promotion_provider_objects SET catalog_revision_id = NULL`;
		expect(await worker.runOnce()).toMatchObject({ couponsCreated: 1, ready: 1, retired: 1 });
		expect(await worker.runOnce()).toMatchObject({ promotionCodesCreated: 1, ready: 1 });
		promotion = await context.repository.promotions.getPromotion(project, "premium-launch");
		expect(promotion.providerObjects.map((object) => [object.objectKind, object.status])).toEqual([
			["coupon", "ready"],
			["promotion_code", "retired"],
			["coupon", "ready"],
			["promotion_code", "ready"],
		]);
		const replacement = promotion.providerObjects[3];
		expect(stripe.state.promotionCodes.get(hostedCode?.externalId ?? "")?.active).toBe(false);
		expect(stripe.state.promotionCodes.get(replacement?.externalId ?? "")?.coupon).toBe(
			promotion.providerObjects[2]?.externalId ?? "missing coupon",
		);
		expect(
			stripe.state.coupons.get(promotion.providerObjects[2]?.externalId ?? "")?.params.applies_to,
		).toEqual({ products: ["prod_stripe_premium_v2"] });

		const codes = await context.repository.promotions.listPromotionCodes(
			project,
			"premium-launch",
			{
				limit: 10,
			},
		);
		const hosted = codes.items.find((item) => item.code === "HOSTED");
		await context.repository.promotions.deactivatePromotionCode(
			project,
			"premium-launch",
			hosted?.id ?? "",
			actor,
		);
		expect(await worker.runOnce()).toMatchObject({ claimed: 1, ready: 1 });
		expect(stripe.state.promotionCodes.get(replacement?.externalId ?? "")?.active).toBe(false);

		await context.repository.promotions.createPromotion(
			project,
			discountPromotion({ key: "broken", name: "Broken", targets: [] }),
		);
		failNext = true;
		expect(await worker.runOnce()).toMatchObject({ couponsCreated: 1, failed: 1 });
		const failed = await context.repository.promotions.getPromotion(project, "broken");
		expect(failed.providerObjects).toMatchObject([
			{ status: "failed", error: "No such product: prod_stripe_premium" },
		]);
		const resynced = await context.repository.promotions.requestPromotionProviderSync(
			project,
			"broken",
			actor,
		);
		expect(resynced.providerObjects).toMatchObject([
			{ status: "pending", error: null, attempts: 0 },
		]);
		expect(await worker.runOnce()).toMatchObject({ ready: 1 });
	});
});

function discountPromotion(overrides: Partial<CreatePromotionInput> = {}): CreatePromotionInput {
	return {
		key: "spring-sale",
		name: "Spring sale",
		effect: {
			kind: "discount",
			discount: { type: "percent", percentOffBps: 2000, duration: "once", durationMonths: null },
		},
		targets: [{ kind: "product", key: "echo_credits_10" }],
		actor,
		...overrides,
	};
}

async function createCode(code: PromotionCodeInput): Promise<string> {
	const created = await context.repository.promotions.createPromotion(
		project,
		discountPromotion({ codes: [code] }),
	);
	const listed = await context.repository.promotions.listPromotionCodes(
		project,
		created.promotion.key,
		{
			limit: 100,
		},
	);
	const match = listed.items.find((item) => item.code === code.code);
	if (match === undefined) throw new Error(`code ${code.code} was not created`);
	return match.id;
}

async function customerId(billingAccountId: string): Promise<string> {
	const [row] = await context.sql<Array<{ id: string }>>`
		INSERT INTO customers (project_id, billing_account_id)
		VALUES (${project.projectInstanceId}, ${billingAccountId})
		RETURNING id
	`;
	if (row === undefined) throw new Error("customer was not created");
	return row.id;
}

function reservation(
	overrides: Partial<ReservePromotionRedemptionInput> &
		Pick<ReservePromotionRedemptionInput, "customerId" | "billingAccountId" | "promotionCodeId">,
): ReservePromotionRedemptionInput {
	return {
		channel: "web",
		provider: "stripe",
		source: "commercial_action",
		idempotencyKey: `reserve:${overrides.billingAccountId}`,
		requestHash: "a".repeat(64),
		reservedUntil: new Date(Date.now() + 30 * 60_000),
		effectSnapshot: { kind: "discount" },
		actor: "backend",
		...overrides,
	};
}

async function captureCode(promise: Promise<unknown>): Promise<string | undefined> {
	try {
		await promise;
	} catch (error) {
		return (error as { code?: string }).code;
	}
	return undefined;
}
