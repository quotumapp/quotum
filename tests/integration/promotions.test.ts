import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { CreatePromotionInput, PromotionCodeInput } from "../../src/billing/promotions";
import type { ReservePromotionRedemptionInput } from "../../src/db/repository/promotions";
import { syncPromotionStripeObject } from "../../src/providers/stripe/promotions";
import { StripeBillingService } from "../../src/providers/stripe/service";
import { createFakeStripePromotions } from "../../src/providers/stripe/testing/fake-promotions";
import { PromotionMaintenanceWorker } from "../../src/workers/promotion-maintenance";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	stripeCheckoutSessionObject,
	stripeEvent,
	stripeRefundObject,
} from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";
import { seedPhase3CatalogMigration, seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";
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
			adapterForJob: () => ({
				promotions: {
					syncObject: async (job) => {
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

localDescribe("promotion Checkout", () => {
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

	// capability: promotion.code_entry
	it("previews, executes, applies and reverses a discount code on a credit pack", async () => {
		await context.repository.promotions.createPromotion(
			project,
			discountPromotion({
				key: "save-20",
				name: "Save 20",
				codes: [{ code: "SAVE20", maxRedemptions: 5 }],
			}),
		);
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const headers = { ...authHeaders("voysee"), "content-type": "application/json" };

		const previewResponse = await testRequest(
			app,
			"/v1/billing-accounts/integration_user/commercial-actions/preview",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					intent: {
						kind: "checkout_product",
						productKey: "echo_credits_10",
						promotionCode: "save20",
					},
				}),
			},
		);
		expect(previewResponse.status).toBe(200);
		const preview = (await previewResponse.json()).data;
		expect(preview).toMatchObject({
			subtotalMinor: 499,
			discountTotalMinor: 100,
			estimatedTotalMinor: 399,
			amountStatus: "exact",
			promotionCodeEntry: "code",
			promotion: {
				promotionKey: "save-20",
				code: "SAVE20",
				discount: { type: "percent", percentOffBps: 2000, duration: "once" },
			},
			lineItems: [{ subtotalMinor: 499, discountMinor: 100, totalMinor: 399 }],
			nextCycle: null,
		});

		const execute = () =>
			testRequest(app, "/v1/billing-accounts/integration_user/commercial-actions", {
				method: "POST",
				headers: { ...headers, "idempotency-key": "checkout-save20" },
				body: JSON.stringify({ previewToken: preview.previewToken }),
			});
		const executed = await execute();
		const replayed = await execute();
		expect(executed.status).toBe(200);
		const result = (await executed.json()).data;
		expect(result).toMatchObject({
			kind: "checkout",
			sessionId: "cs_test_integration",
			promotionRedemption: { status: "reserved" },
		});
		expect((await replayed.json()).data).toEqual(result);
		expect(stripe.checkoutSessionParams).toHaveLength(1);
		const [coupon] = [...stripe.promotions.coupons.values()];
		expect(stripe.checkoutSessionParams[0]).toMatchObject({
			discounts: [{ coupon: coupon?.id }],
			metadata: { quotumPromotionRedemptionId: result.promotionRedemption.id },
			payment_intent_data: {
				metadata: { quotumPromotionRedemptionId: result.promotionRedemption.id },
			},
		});
		expect(stripe.checkoutSessionParams[0]?.allow_promotion_codes).toBeUndefined();
		expect(coupon?.params).toMatchObject({
			percent_off: 20,
			duration: "once",
			applies_to: { products: ["prod_stripe_credits_10"] },
		});
		const [reserved] = await context.sql<
			Array<{ status: string; stripe_checkout_session_id: string }>
		>`
			SELECT status, stripe_checkout_session_id FROM promotion_redemptions
		`;
		expect(reserved).toEqual({
			status: "reserved",
			stripe_checkout_session_id: "cs_test_integration",
		});

		const completed = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject({
					amount_subtotal: 499,
					amount_total: 399,
					total_details: { amount_discount: 100 },
					discounts: [{ coupon: coupon?.id, promotion_code: null }],
					metadata: {
						...stripeCheckoutSessionObject().metadata,
						quotumPromotionRedemptionId: result.promotionRedemption.id,
					},
				}),
				"evt_discounted_checkout",
			),
		});
		expect((await postWebhook(completed, "evt_discounted_checkout")).status).toBe(200);
		const [applied] = await context.sql<
			Array<{
				status: string;
				purchase_id: string | null;
				amount_discount_minor: string;
				redeemed_count: number;
				reserved_count: number;
			}>
		>`
			SELECT r.status, r.purchase_id, r.amount_discount_minor::text, c.redeemed_count, c.reserved_count
			FROM promotion_redemptions r
			JOIN promotion_codes c ON c.id = r.promotion_code_id
		`;
		expect(applied).toMatchObject({
			status: "applied",
			amount_discount_minor: "100",
			redeemed_count: 1,
			reserved_count: 0,
		});
		expect(applied?.purchase_id).not.toBeNull();

		const refund = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"refund.created",
				stripeRefundObject({ id: "re_discounted", amount: 399 }),
				"evt_discounted_refund",
			),
		});
		expect((await postWebhook(refund, "evt_discounted_refund")).status).toBe(200);
		const [reversed] = await context.sql<Array<{ status: string; redeemed_count: number }>>`
			SELECT r.status, c.redeemed_count
			FROM promotion_redemptions r
			JOIN promotion_codes c ON c.id = r.promotion_code_id
		`;
		expect(reversed).toEqual({ status: "reversed", redeemed_count: 1 });
	});

	it("releases the use when the Checkout Session expires and rejects invalid codes", async () => {
		await context.repository.promotions.createPromotion(
			project,
			discountPromotion({
				key: "credits-launch",
				name: "Credits launch",
				effect: {
					kind: "discount",
					discount: {
						type: "amount",
						amounts: [{ currency: "USD", amountOffMinor: 300 }],
						duration: "repeating",
						durationMonths: 3,
					},
				},
				codes: [{ code: "LAUNCH" }],
			}),
		);
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const headers = { ...authHeaders("voysee"), "content-type": "application/json" };
		const preview = async (intent: Record<string, unknown>) =>
			await testRequest(app, "/v1/billing-accounts/launch_user/commercial-actions/preview", {
				method: "POST",
				headers,
				body: JSON.stringify({ intent }),
			});

		const wrongTarget = await preview({
			kind: "checkout_product",
			productKey: "premium_monthly",
			promotionCode: "LAUNCH",
		});
		const bothEntries = await preview({
			kind: "checkout_product",
			productKey: "echo_credits_10",
			promotionCode: "LAUNCH",
			allowPromotionCodes: true,
		});
		const unknown = await preview({
			kind: "checkout_product",
			productKey: "echo_credits_10",
			promotionCode: "NOPE",
		});
		expect(wrongTarget.status).toBe(409);
		expect((await wrongTarget.json()).error.code).toBe("PROMOTION_CODE_NOT_APPLICABLE");
		expect(bothEntries.status).toBe(400);
		expect((await bothEntries.json()).error.code).toBe("PROMOTION_CODE_ENTRY_CONFLICT");
		expect(unknown.status).toBe(404);
		expect((await unknown.json()).error.code).toBe("PROMOTION_CODE_NOT_FOUND");

		const launchPreview = await preview({
			kind: "checkout_product",
			productKey: "echo_credits_10",
			promotionCode: "LAUNCH",
		});
		expect(launchPreview.status).toBe(200);
		const previewBody = (await launchPreview.json()).data;
		expect(previewBody).toMatchObject({
			promotionCodeEntry: "code",
			discountTotalMinor: 300,
			estimatedTotalMinor: 199,
			promotion: { code: "LAUNCH", discount: { amountOffMinor: 300, currency: "USD" } },
		});
		const executed = await testRequest(app, "/v1/billing-accounts/launch_user/commercial-actions", {
			method: "POST",
			headers: { ...headers, "idempotency-key": "checkout-launch" },
			body: JSON.stringify({ previewToken: previewBody.previewToken }),
		});
		expect(executed.status).toBe(200);
		const redemptionId = (await executed.json()).data.promotionRedemption.id;

		const expired = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.expired",
				{
					id: "cs_test_integration",
					object: "checkout.session",
					mode: "payment",
					status: "expired",
					metadata: { quotumPromotionRedemptionId: redemptionId },
				},
				"evt_launch_expired",
			),
		});
		expect((await postWebhook(expired, "evt_launch_expired")).status).toBe(200);
		const [released] = await context.sql<Array<{ status: string; reserved_count: number }>>`
			SELECT r.status, c.reserved_count
			FROM promotion_redemptions r
			JOIN promotion_codes c ON c.id = r.promotion_code_id
		`;
		expect(released).toEqual({ status: "released", reserved_count: 0 });
	});

	// capability: promotion.hosted_code
	it("opens hosted code entry and records a code the customer typed on Stripe", async () => {
		await context.repository.promotions.createPromotion(
			project,
			discountPromotion({
				key: "hosted-sale",
				name: "Hosted sale",
				codes: [{ code: "HOSTED10", hostedCheckoutEnabled: true, maxRedemptions: 1 }],
			}),
		);
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });
		const worker = new PromotionMaintenanceWorker({
			workerId: "hosted-worker",
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
			adapterForJob: () => ({
				promotions: {
					syncObject: (job) => syncPromotionStripeObject(fixture.stripe.client, job),
				},
			}),
			logger: { error() {} },
		});
		await worker.runOnce();
		await worker.runOnce();
		const promotion = await context.repository.promotions.getPromotion(project, "hosted-sale");
		const hostedObject = promotion.providerObjects.find(
			(object) => object.objectKind === "promotion_code",
		);
		expect(hostedObject).toMatchObject({ status: "ready", providerActive: true });

		const headers = { ...fixture.authHeaders("voysee"), "content-type": "application/json" };
		const previewResponse = await testRequest(
			fixture.app,
			"/v1/billing-accounts/hosted_user/commercial-actions/preview",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					intent: {
						kind: "checkout_product",
						productKey: "echo_credits_10",
						allowPromotionCodes: true,
					},
				}),
			},
		);
		const preview = (await previewResponse.json()).data;
		expect(preview).toMatchObject({
			promotionCodeEntry: "hosted",
			discountTotalMinor: 0,
			promotion: null,
		});
		const executed = await testRequest(
			fixture.app,
			"/v1/billing-accounts/hosted_user/commercial-actions",
			{
				method: "POST",
				headers: { ...headers, "idempotency-key": "checkout-hosted" },
				body: JSON.stringify({ previewToken: preview.previewToken }),
			},
		);
		expect((await executed.json()).data).toMatchObject({ promotionRedemption: null });
		expect(fixture.stripe.checkoutSessionParams[0]).toMatchObject({ allow_promotion_codes: true });
		expect(fixture.stripe.checkoutSessionParams[0]?.discounts).toBeUndefined();

		const completed = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeEvent: stripeEvent(
				"checkout.session.completed",
				stripeCheckoutSessionObject({
					id: "cs_hosted",
					amount_subtotal: 499,
					amount_total: 449,
					total_details: { amount_discount: 50 },
					discounts: [{ coupon: "quotum_hosted", promotion_code: hostedObject?.externalId }],
					payment_intent: "pi_hosted",
					customer: "cus_hosted_user",
					metadata: { ...stripeCheckoutSessionObject().metadata, billingAccountId: "hosted_user" },
					client_reference_id: "hosted_user",
				}),
				"evt_hosted_checkout",
			),
		});
		expect((await postWebhook(completed, "evt_hosted_checkout")).status).toBe(200);
		expect(await postWebhook(completed, "evt_hosted_checkout")).toBeDefined();
		const redemptions = await context.repository.promotions.listPromotionRedemptions(
			project,
			"hosted-sale",
			{ limit: 10 },
		);
		expect(redemptions.items).toMatchObject([
			{
				billingAccountId: "hosted_user",
				source: "stripe_hosted_checkout",
				status: "applied",
				stripeCheckoutSessionId: "cs_hosted",
				amountDiscountMinor: 50,
				limitViolation: null,
			},
		]);
		expect(
			(
				await context.repository.promotions.getPromotion(project, "hosted-sale")
			).providerObjects.find((object) => object.objectKind === "promotion_code"),
		).toMatchObject({ desiredActive: false });
	});
});

localDescribe("promotion subscription changes", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
		await context.repository.promotions.createPromotion(
			project,
			discountPromotion({
				key: "upgrade-offer",
				name: "Upgrade offer",
				targets: [{ kind: "plan", key: "migration-plan" }],
				effect: {
					kind: "discount",
					discount: {
						type: "percent",
						percentOffBps: 1000,
						duration: "repeating",
						durationMonths: 3,
					},
				},
				codes: [{ code: "UPGRADE" }, { code: "UPGRADE-TWO" }],
			}),
		);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	const intent = (promotionCode: string) => ({
		kind: "subscription_change",
		externalSubscriptionId: "sub_migrate_stripe",
		targetPlanKey: "migration-plan",
		quantities: { licensed_seats: 8 },
		effectiveMode: "immediate",
		promotionCode,
	});

	// capability: subscription.change.apply
	// capability: promotion.code_entry
	it("reserves with the change, keeps merchant discounts on Stripe and applies with the change", async () => {
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });
		const headers = { ...fixture.authHeaders("voysee"), "content-type": "application/json" };
		const preview = await testRequest(
			fixture.app,
			"/v1/billing-accounts/migration-stripe/commercial-actions/preview",
			{ method: "POST", headers, body: JSON.stringify({ intent: intent("upgrade") }) },
		);
		expect(preview.status).toBe(200);
		const previewBody = (await preview.json()).data;
		expect(previewBody).toMatchObject({
			amountStatus: "provider_calculated",
			promotionCodeEntry: "code",
			promotion: { code: "UPGRADE", discount: { type: "percent", percentOffBps: 1000 } },
			nextCycle: {
				interval: "month",
				subtotalMinor: 2700,
				discountMinor: 270,
				totalMinor: 2430,
				discountStatus: "applies",
			},
		});

		const executed = await testRequest(
			fixture.app,
			"/v1/billing-accounts/migration-stripe/commercial-actions",
			{
				method: "POST",
				headers: { ...headers, "idempotency-key": "upgrade-with-code" },
				body: JSON.stringify({ previewToken: previewBody.previewToken }),
			},
		);
		expect(executed.status).toBe(202);
		const result = (await executed.json()).data;
		expect(result).toMatchObject({
			kind: "subscription_change",
			promotionRedemption: { status: "reserved" },
		});

		const stacked = await testRequest(
			fixture.app,
			"/v1/billing-accounts/migration-stripe/commercial-actions/preview",
			{ method: "POST", headers, body: JSON.stringify({ intent: intent("UPGRADE-TWO") }) },
		);
		expect(stacked.status).toBe(409);
		expect((await stacked.json()).error.code).toBe("PROMOTION_STACKING_NOT_ALLOWED");

		const [claimed] = await context.repository.claimSubscriptionChanges("change-worker", 10);
		if (claimed === undefined) throw new Error("change was not claimed");
		const operation = await context.repository.loadClaimedSubscriptionChange(
			claimed.projectInstanceId,
			claimed.changeId,
			"change-worker",
		);
		if (operation === null) throw new Error("the claimed change could not be loaded");
		const coupon = [...fixture.stripe.promotions.coupons.values()][0];
		expect(operation).toMatchObject({
			changeId: result.changeId,
			discountCouponId: coupon?.id,
			promotionRedemption: { id: result.promotionRedemption.id, status: "reserved" },
		});
		fixture.stripe.subscriptionDiscounts.set("sub_migrate_stripe", [
			{ id: "di_merchant", couponId: "co_merchant" },
		]);
		const service = new StripeBillingService({
			config: {
				projectKey: "voysee",
				checkoutSuccessUrl: "https://app.integration.test/success?session_id={CHECKOUT_SESSION_ID}",
				checkoutCancelUrl: "https://app.integration.test/cancel",
				portalReturnUrl: "https://app.integration.test/account",
			},
			client: fixture.stripe.client,
			repository: context.repository.forProject(project),
		});
		await service.applySubscriptionChange(operation);
		expect(fixture.stripe.subscriptionUpdates[0]?.params.discounts).toEqual([
			{ discount: "di_merchant" },
			{ coupon: coupon?.id },
		]);
		expect(fixture.stripe.subscriptionUpdates[0]?.idempotencyKey).toStartWith(
			`billing:subscription-change:${result.changeId}:discounts:`,
		);
		await context.repository.markSubscriptionChangeApplied(
			project.projectInstanceId,
			result.changeId,
			"sub_migrate_stripe",
			"change-worker",
		);
		const [redemption] = await context.sql<
			Array<{ status: string; external_subscription_id: string; redeemed_count: number }>
		>`
			SELECT r.status, r.external_subscription_id, c.redeemed_count
			FROM promotion_redemptions r
			JOIN promotion_codes c ON c.id = r.promotion_code_id
		`;
		expect(redemption).toEqual({
			status: "applied",
			external_subscription_id: "sub_migrate_stripe",
			redeemed_count: 1,
		});
	});

	it("releases the reserved use when the change fails for good", async () => {
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });
		const headers = { ...fixture.authHeaders("voysee"), "content-type": "application/json" };
		const preview = (
			await (
				await testRequest(
					fixture.app,
					"/v1/billing-accounts/migration-stripe/commercial-actions/preview",
					{ method: "POST", headers, body: JSON.stringify({ intent: intent("UPGRADE") }) },
				)
			).json()
		).data;
		const executed = await testRequest(
			fixture.app,
			"/v1/billing-accounts/migration-stripe/commercial-actions",
			{
				method: "POST",
				headers: { ...headers, "idempotency-key": "upgrade-fails" },
				body: JSON.stringify({ previewToken: preview.previewToken }),
			},
		);
		const changeId = (await executed.json()).data.changeId;
		await context.sql`UPDATE subscription_changes SET attempts = 7 WHERE id = ${changeId}`;
		await context.repository.claimSubscriptionChanges("change-worker", 10);
		await context.repository.markSubscriptionChangeFailed(
			project.projectInstanceId,
			changeId,
			"Stripe rejected the change",
			"change-worker",
		);

		const [released] = await context.sql<Array<{ status: string; reserved_count: number }>>`
			SELECT r.status, c.reserved_count
			FROM promotion_redemptions r
			JOIN promotion_codes c ON c.id = r.promotion_code_id
		`;
		expect(released).toEqual({ status: "released", reserved_count: 0 });
	});
});

localDescribe("promotion feature grants", () => {
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

	it("redeems a feature grant over HTTP, spends the reward first and replays by key", async () => {
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await context.repository.promotions.createPromotion(
			project,
			grantPromotion({ codes: [{ code: "WELCOME" }, { code: "WELCOME-2" }] }),
		);
		await context.repository.promotions.createPromotion(
			project,
			discountPromotion({ codes: [{ code: "SPRING" }] }),
		);
		await context.repository.grantAllocation(project, {
			billingAccountId: "reader",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "reader-base",
		});
		const redeem = (billingAccountId: string, key: string, body: unknown) =>
			testRequest(app, `/v1/billing-accounts/${billingAccountId}/promotion-redemptions`, {
				method: "POST",
				headers: {
					...authHeaders("voysee"),
					"content-type": "application/json",
					"idempotency-key": key,
				},
				body: JSON.stringify(body),
			});

		const granted = await redeem("reader", "redeem-1", { code: "welcome", channel: "web" });
		const replay = await redeem("reader", "redeem-1", { code: "WELCOME", channel: "web" });
		const changed = await redeem("reader", "redeem-1", { code: "WELCOME-2", channel: "web" });
		const again = await redeem("reader", "redeem-2", { code: "WELCOME", channel: "web" });
		const ios = await redeem("ios-user", "redeem-1", { code: "WELCOME", channel: "ios" });
		const discount = await redeem("shopper", "redeem-1", { code: "SPRING", channel: "web" });

		expect(granted.status).toBe(200);
		const grantedData = (await granted.json()).data;
		expect(grantedData).toMatchObject({
			kind: "granted",
			duplicate: false,
			redemption: {
				promotionKey: "welcome-credits",
				code: "WELCOME",
				billingAccountId: "reader",
				status: "applied",
				provider: "quotum",
				source: "api_redeem",
				actor: "billing-account:reader",
			},
			grant: {
				features: [{ featureKey: "ai_credits", quantity: "100.5", expiresAt: expect.any(String) }],
			},
		});
		expect((await replay.json()).data).toEqual({ ...grantedData, duplicate: true });
		expect(changed.status).toBe(409);
		expect((await changed.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
		expect(again.status).toBe(409);
		expect((await again.json()).error.code).toBe("PROMOTION_CODE_ALREADY_REDEEMED");
		expect(ios.status).toBe(409);
		expect((await ios.json()).error.code).toBe("PROMOTION_CODE_CHANNEL_NOT_SUPPORTED");
		expect((await discount.json()).data).toEqual({
			kind: "requires_commercial_action",
			duplicate: false,
			redemption: null,
			promotion: { key: "spring-sale", effectKind: "discount" },
			commercialAction: { promotionCode: "SPRING" },
		});
		expect(
			await context.sql`SELECT id FROM customers WHERE billing_account_id IN ('ios-user', 'shopper')`,
		).toHaveLength(0);

		const consumed = await context.repository.consumeUsage(project, {
			billingAccountId: "reader",
			featureKey: "ai_credits",
			quantity: "5",
			idempotencyKey: "reader-spend",
		});
		expect(consumed).toMatchObject({ allowed: true, balance: { available: "105.5" } });
		const allocations = await context.sql<
			Array<{ source_kind: string; consumed_quantity: string; promotion_redemption_id: string }>
		>`
			SELECT source_kind, consumed_quantity::text, promotion_redemption_id
			FROM balance_allocations
			ORDER BY id
		`;
		expect(allocations).toEqual([
			{ source_kind: "operator", consumed_quantity: "0.000000000", promotion_redemption_id: null },
			{
				source_kind: "reward",
				consumed_quantity: "5.000000000",
				promotion_redemption_id: grantedData.redemption.id,
			},
		]);
		const [code] = await context.sql<Array<{ redeemed_count: number; reserved_count: number }>>`
			SELECT redeemed_count, reserved_count FROM promotion_codes WHERE normalized_code = 'WELCOME'
		`;
		expect(code).toEqual({ redeemed_count: 1, reserved_count: 0 });
		expect(
			await context.sql`
				SELECT 1 FROM projection_sync_jobs j
				JOIN customers c ON c.id = j.customer_id
				WHERE c.billing_account_id = 'reader' AND j.reason = 'usage_changed'
			`,
		).toHaveLength(1);

		const read = (path: string) => testRequest(app, path, { headers: authHeaders("voysee") });
		const ledger = await read("/v1/billing-accounts/reader/promotion-redemptions");
		const detail = await read(
			`/v1/billing-accounts/reader/promotion-redemptions/${grantedData.redemption.id}`,
		);
		const otherAccount = await read(
			`/v1/billing-accounts/shopper/promotion-redemptions/${grantedData.redemption.id}`,
		);
		const unknown = await read("/v1/billing-accounts/nobody/promotion-redemptions");
		expect((await ledger.json()).data).toEqual([grantedData.redemption]);
		expect((await detail.json()).data).toEqual(grantedData.redemption);
		expect(otherAccount.status).toBe(404);
		expect((await otherAccount.json()).error.code).toBe("PROMOTION_REDEMPTION_NOT_FOUND");
		expect(await unknown.json()).toMatchObject({ data: [], pagination: { nextCursor: null } });
	});

	it("never grants more than the global cap under concurrent redemptions", async () => {
		await context.repository.promotions.createPromotion(
			project,
			grantPromotion({ codes: [{ code: "FIRST-THREE", maxRedemptions: 3 }] }),
		);

		const results = await Promise.allSettled(
			Array.from({ length: 12 }, (_, index) =>
				context.repository.promotions.redeemPromotionCode(project, {
					billingAccountId: `racer-${index}`,
					code: "FIRST-THREE",
					channel: "android",
					idempotencyKey: "race",
					actor: null,
				}),
			),
		);

		const codes = results.map((result) =>
			result.status === "fulfilled" ? result.value.kind : (result.reason as { code?: string }).code,
		);
		expect(codes.filter((code) => code === "granted")).toHaveLength(3);
		expect(codes.filter((code) => code === "PROMOTION_CODE_EXHAUSTED")).toHaveLength(9);
		expect(await context.sql`SELECT id FROM balance_allocations`).toHaveLength(3);
		const [code] = await context.sql<Array<{ redeemed_count: number }>>`
			SELECT redeemed_count FROM promotion_codes
		`;
		expect(code?.redeemed_count).toBe(3);
	});

	it("revokes what is left of a grant, keeps consumed usage and replays the revocation", async () => {
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		await context.repository.promotions.createPromotion(
			project,
			grantPromotion({
				effect: {
					kind: "feature_grant",
					items: [
						{ featureKey: "ai_credits", quantity: "100", expiresAfterSeconds: null },
						{ featureKey: "model_tokens", quantity: "5", expiresAfterSeconds: 60 },
					],
				},
				codes: [{ code: "WELCOME" }],
			}),
		);
		const redeemed = await context.repository.promotions.redeemPromotionCode(project, {
			billingAccountId: "reviewer",
			code: "WELCOME",
			channel: "web",
			idempotencyKey: "redeem",
			actor: "user:7",
		});
		if (redeemed.kind !== "granted") throw new Error("expected a granted redemption");
		await context.repository.consumeUsage(project, {
			billingAccountId: "reviewer",
			featureKey: "ai_credits",
			quantity: "30",
			idempotencyKey: "reviewer-spend",
		});
		await context.sql`
			UPDATE balance_allocations
			SET created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
			WHERE source_kind = 'reward' AND expires_at IS NOT NULL
		`;
		await context.sql`DELETE FROM projection_sync_jobs`;
		const operator = (key: string, projectKey = "voysee") => ({
			...authHeaders(projectKey),
			"x-billing-operator-key": context.env.operatorApiKey ?? "",
			"x-billing-actor": actor,
			"content-type": "application/json",
			"idempotency-key": key,
		});
		const revoke = (id: string, key: string, projectKey = "voysee") =>
			testRequest(app, `/v1/admin/promotion-redemptions/${id}/revoke`, {
				method: "POST",
				headers: operator(key, projectKey),
				body: JSON.stringify({ reason: "Abuse report" }),
			});

		const foreign = await revoke(redeemed.redemption.id, "revoke-1", "wiseley");
		const revoked = await revoke(redeemed.redemption.id, "revoke-1");
		const replay = await revoke(redeemed.redemption.id, "revoke-1");
		const twice = await revoke(redeemed.redemption.id, "revoke-2");

		expect(foreign.status).toBe(404);
		expect((await foreign.json()).error.code).toBe("PROMOTION_REDEMPTION_NOT_FOUND");
		expect(revoked.status).toBe(200);
		const revokedData = (await revoked.json()).data;
		expect(revokedData).toMatchObject({
			duplicate: false,
			redemption: {
				id: redeemed.redemption.id,
				status: "reversed",
				reversedAt: expect.any(String),
			},
		});
		expect(
			revokedData.reversedAllocations.map(
				({ allocationId: _id, ...allocation }: { allocationId: string }) => allocation,
			),
		).toEqual([
			{
				featureKey: "ai_credits",
				reversedQuantity: "70",
				consumedQuantity: "30",
				heldQuantity: "0",
				expired: false,
			},
			{
				featureKey: "model_tokens",
				reversedQuantity: "0",
				consumedQuantity: "0",
				heldQuantity: "0",
				expired: true,
			},
		]);
		expect((await replay.json()).data).toEqual({ ...revokedData, duplicate: true });
		expect(twice.status).toBe(409);
		expect((await twice.json()).error.code).toBe("PROMOTION_REDEMPTION_ALREADY_REVERSED");
		expect(
			await context.repository.getMeteringBalance(project, "reviewer", "ai_credits"),
		).toMatchObject({ available: "0" });
		const rows = await context.sql<
			Array<{ reversed_quantity: string; consumed_quantity: string; reversed: boolean }>
		>`
			SELECT reversed_quantity::text, consumed_quantity::text, reversed_at IS NOT NULL AS reversed
			FROM balance_allocations
			ORDER BY id
		`;
		expect(rows).toEqual([
			{ reversed_quantity: "70.000000000", consumed_quantity: "30.000000000", reversed: true },
			{ reversed_quantity: "0.000000000", consumed_quantity: "0.000000000", reversed: false },
		]);
		const [state] = await context.sql<
			Array<{ reversal_actor: string; reversal_reason: string; redeemed_count: number }>
		>`
			SELECT r.reversal_actor, r.reversal_reason, c.redeemed_count
			FROM promotion_redemptions r
			JOIN promotion_codes c ON c.id = r.promotion_code_id
		`;
		expect(state).toEqual({
			reversal_actor: actor,
			reversal_reason: "Abuse report",
			redeemed_count: 1,
		});
		expect(await context.sql`SELECT 1 FROM projection_sync_jobs`).toHaveLength(1);

		const codeId = await createCode({ code: "SPRING" });
		const stripeReservation = await context.repository.promotions.reservePromotionRedemption(
			project,
			reservation({
				customerId: await customerId("buyer"),
				billingAccountId: "buyer",
				promotionCodeId: codeId,
			}),
		);
		const notRevocable = await revoke(stripeReservation.redemption.id, "revoke-3");
		const missing = await revoke("00000000-0000-4000-8000-000000000000", "revoke-4");
		expect(notRevocable.status).toBe(409);
		expect((await notRevocable.json()).error.code).toBe("PROMOTION_REDEMPTION_NOT_REVOCABLE");
		expect(missing.status).toBe(404);
	});
});

async function postWebhook(
	fixture: ReturnType<typeof createIntegrationApp>,
	eventId: string,
): Promise<Response> {
	return await testRequest(fixture.app, "/v1/projects/voysee/webhooks/stripe", {
		method: "POST",
		headers: { "content-type": "application/json", "stripe-signature": "sig_test" },
		body: JSON.stringify({ id: eventId, type: "checkout.session.completed", data: { object: {} } }),
	});
}

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

function grantPromotion(overrides: Partial<CreatePromotionInput> = {}): CreatePromotionInput {
	return {
		key: "welcome-credits",
		name: "Welcome credits",
		effect: {
			kind: "feature_grant",
			items: [{ featureKey: "ai_credits", quantity: "100.5", expiresAfterSeconds: 86_400 }],
		},
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
