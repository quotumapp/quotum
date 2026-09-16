import { describe, expect, it } from "bun:test";
import {
	type CreatePromotionInput,
	normalizeCreatePromotionInput,
	normalizePromotionCode,
	type PromotionCodeAvailability,
	promotionCodeUnavailability,
} from "../../src/billing/promotions";

function discountInput(overrides: Partial<CreatePromotionInput> = {}): CreatePromotionInput {
	return {
		key: "spring-sale",
		name: "Spring sale",
		effect: {
			kind: "discount",
			discount: { type: "percent", percentOffBps: 2000, duration: "once", durationMonths: null },
		},
		actor: "operator@example.com",
		...overrides,
	};
}

function errorCode(action: () => unknown): string | undefined {
	try {
		action();
	} catch (error) {
		return (error as { code?: string }).code;
	}
	return undefined;
}

describe("promotion codes", () => {
	it("normalizes codes case-insensitively and rejects other characters", () => {
		expect(normalizePromotionCode("  spring-26 ")).toBe("SPRING-26");
		for (const invalid of ["ab", "spring sale", "spring_sale", "x".repeat(65), "ümlaut"]) {
			expect(errorCode(() => normalizePromotionCode(invalid))).toBe(
				"PROMOTION_CODE_INVALID_FORMAT",
			);
		}
	});
});

describe("promotion terms", () => {
	it("hashes terms independently of target, channel, currency and item order", () => {
		const left = normalizeCreatePromotionInput(
			discountInput({
				effect: {
					kind: "discount",
					discount: {
						type: "amount",
						amounts: [
							{ currency: "usd", amountOffMinor: 500 },
							{ currency: "EUR", amountOffMinor: 450 },
						],
						duration: "repeating",
						durationMonths: 3,
					},
				},
				targets: [
					{ kind: "product", key: "credits" },
					{ kind: "plan", key: "pro" },
				],
				allowedChannels: ["android", "web"],
			}),
		);
		const right = normalizeCreatePromotionInput(
			discountInput({
				effect: {
					kind: "discount",
					discount: {
						type: "amount",
						amounts: [
							{ currency: "EUR", amountOffMinor: 450 },
							{ currency: "USD", amountOffMinor: 500 },
						],
						duration: "repeating",
						durationMonths: 3,
					},
				},
				targets: [
					{ kind: "plan", key: "pro" },
					{ kind: "product", key: "credits" },
				],
				allowedChannels: ["web", "android"],
				codes: [{ code: "SPRING" }],
			}),
		);

		expect(left.termsHash).toBe(right.termsHash);
		expect(right.allowedChannels).toEqual(["web", "android"]);
		expect(right.targets).toEqual([
			{ kind: "plan", key: "pro" },
			{ kind: "product", key: "credits" },
		]);
		expect(normalizeCreatePromotionInput(discountInput({ name: "Other" })).termsHash).not.toBe(
			normalizeCreatePromotionInput(discountInput()).termsHash,
		);
	});

	it("canonicalizes feature grant quantities and defaults every channel", () => {
		const normalized = normalizeCreatePromotionInput(
			discountInput({
				effect: {
					kind: "feature_grant",
					items: [
						{ featureKey: "tokens", quantity: "25.500", expiresAfterSeconds: null },
						{ featureKey: "credits", quantity: "1000.0", expiresAfterSeconds: 86_400 },
					],
				},
			}),
		);

		expect(normalized.effect).toEqual({
			kind: "feature_grant",
			items: [
				{ featureKey: "credits", quantity: "1000", expiresAfterSeconds: 86_400 },
				{ featureKey: "tokens", quantity: "25.5", expiresAfterSeconds: null },
			],
		});
		expect(normalized.allowedChannels).toEqual(["web", "ios", "android"]);
	});

	it("rejects inconsistent terms", () => {
		const invalid: CreatePromotionInput[] = [
			discountInput({
				effect: {
					kind: "discount",
					discount: {
						type: "percent",
						percentOffBps: 10_001,
						duration: "once",
						durationMonths: null,
					},
				},
			}),
			discountInput({
				effect: {
					kind: "discount",
					discount: {
						type: "percent",
						percentOffBps: 100,
						duration: "repeating",
						durationMonths: null,
					},
				},
			}),
			discountInput({
				effect: {
					kind: "discount",
					discount: { type: "percent", percentOffBps: 100, duration: "forever", durationMonths: 2 },
				},
			}),
			discountInput({
				effect: {
					kind: "discount",
					discount: {
						type: "amount",
						amounts: [
							{ currency: "usd", amountOffMinor: 1 },
							{ currency: "USD", amountOffMinor: 2 },
						],
						duration: "once",
						durationMonths: null,
					},
				},
			}),
			discountInput({
				effect: {
					kind: "feature_grant",
					items: [{ featureKey: "credits", quantity: "0", expiresAfterSeconds: null }],
				},
			}),
			discountInput({
				effect: { kind: "plan_grant", planKey: "pro", durationUnit: "month", durationCount: 25 },
			}),
			discountInput({
				effect: { kind: "plan_grant", planKey: "pro", durationUnit: "day", durationCount: 30 },
				targets: [{ kind: "plan", key: "pro" }],
			}),
			discountInput({ allowedChannels: [] }),
			discountInput({
				codes: [
					{ code: "SPRING", startsAt: "2026-10-01T00:00:00Z", expiresAt: "2026-09-01T00:00:00Z" },
				],
			}),
		];
		for (const input of invalid) {
			expect(errorCode(() => normalizeCreatePromotionInput(input))).toBe("PROMOTION_TERMS_INVALID");
		}
	});

	it("limits hosted Checkout entry to limits Stripe can enforce", () => {
		const hosted = normalizeCreatePromotionInput(
			discountInput({
				codes: [{ code: "HOSTED", hostedCheckoutEnabled: true, maxRedemptions: 10 }],
			}),
		);
		const apiOnly = normalizeCreatePromotionInput(
			discountInput({
				codes: [{ code: "API" }, { code: "UNLIMITED", maxRedemptionsPerCustomer: null }],
			}),
		);

		expect(hosted.codes[0]).toMatchObject({
			normalizedCode: "HOSTED",
			hostedCheckoutEnabled: true,
			maxRedemptions: 10,
			maxRedemptionsPerCustomer: null,
		});
		expect(apiOnly.codes.map((code) => code.maxRedemptionsPerCustomer)).toEqual([1, null]);
		for (const input of [
			discountInput({
				codes: [{ code: "HOSTED", hostedCheckoutEnabled: true, maxRedemptionsPerCustomer: 1 }],
			}),
			discountInput({
				codes: [{ code: "HOSTED", hostedCheckoutEnabled: true, billingAccountId: "acct" }],
			}),
			discountInput({
				allowedChannels: ["ios"],
				codes: [{ code: "HOSTED", hostedCheckoutEnabled: true }],
			}),
			discountInput({
				effect: {
					kind: "feature_grant",
					items: [{ featureKey: "credits", quantity: "1", expiresAfterSeconds: null }],
				},
				codes: [{ code: "HOSTED", hostedCheckoutEnabled: true }],
			}),
		]) {
			expect(errorCode(() => normalizeCreatePromotionInput(input))).toBe(
				"PROMOTION_HOSTED_CHECKOUT_UNSUPPORTED",
			);
		}
		expect(
			errorCode(() =>
				normalizeCreatePromotionInput(
					discountInput({ codes: [{ code: "same" }, { code: "SAME" }] }),
				),
			),
		).toBe("PROMOTION_CODE_CONFLICT");
	});
});

describe("promotion code availability", () => {
	const now = new Date("2026-09-16T12:00:00.000Z");
	const available: PromotionCodeAvailability = {
		promotionStatus: "active",
		allowedChannels: ["web", "android"],
		active: true,
		startsAt: new Date("2026-09-01T00:00:00.000Z"),
		expiresAt: new Date("2026-10-01T00:00:00.000Z"),
		billingAccountId: null,
		maxRedemptions: 5,
		redeemedCount: 3,
		reservedCount: 1,
	};
	const context = { now, billingAccountId: "acct_1", channel: "web" as const };

	it("reports the first failing rule in a fixed order", () => {
		expect(promotionCodeUnavailability(available, context)).toBeNull();
		expect(
			promotionCodeUnavailability(
				{ ...available, billingAccountId: "acct_2", active: false },
				context,
			),
		).toBe("PROMOTION_CODE_NOT_FOUND");
		expect(
			promotionCodeUnavailability(
				{ ...available, promotionStatus: "archived", expiresAt: now },
				context,
			),
		).toBe("PROMOTION_CODE_INACTIVE");
		expect(
			promotionCodeUnavailability(
				{ ...available, startsAt: new Date("2026-09-17T00:00:00Z") },
				context,
			),
		).toBe("PROMOTION_CODE_NOT_STARTED");
		expect(promotionCodeUnavailability({ ...available, expiresAt: now }, context)).toBe(
			"PROMOTION_CODE_EXPIRED",
		);
		expect(promotionCodeUnavailability(available, { ...context, channel: "ios" })).toBe(
			"PROMOTION_CODE_CHANNEL_NOT_SUPPORTED",
		);
		expect(promotionCodeUnavailability({ ...available, reservedCount: 2 }, context)).toBe(
			"PROMOTION_CODE_EXHAUSTED",
		);
	});
});
