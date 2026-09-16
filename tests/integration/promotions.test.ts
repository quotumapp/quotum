import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { CreatePromotionInput, PromotionCodeInput } from "../../src/billing/promotions";
import type { ReservePromotionRedemptionInput } from "../../src/db/repository/promotions";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";

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
		expect(
			await captureCode(
				context.repository.promotions.reservePromotionRedemption(
					project,
					reservation({
						customerId: buyer,
						billingAccountId: "buyer",
						promotionCodeId: restricted,
						channel: "ios",
					}),
				),
			),
		).toBe("PROMOTION_CODE_NOT_FOUND");
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
