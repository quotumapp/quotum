import { describe, expect, it } from "bun:test";
import {
	applyDiscountToLines,
	type CreatePromotionInput,
	discountAppliesNextCycle,
	normalizeCreatePromotionInput,
	normalizePromotionCode,
	normalizePromotionTermsUpdate,
	type PromotionCodeAvailability,
	type PromotionRecord,
	promotionCodeUnavailability,
	promotionError,
} from "../../src/billing/promotions";
import { maxExpirySeconds } from "../../src/shared/cadence";

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
				effect: {
					kind: "feature_grant",
					items: [
						{ featureKey: "credits", quantity: "5", expiresAfterSeconds: maxExpirySeconds + 1 },
					],
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

	it("accepts a feature grant that expires after exactly ten years", () => {
		const normalized = normalizeCreatePromotionInput(
			discountInput({
				effect: {
					kind: "feature_grant",
					items: [{ featureKey: "credits", quantity: "5", expiresAfterSeconds: maxExpirySeconds }],
				},
			}),
		);
		expect(normalized.effect).toMatchObject({
			items: [{ featureKey: "credits", expiresAfterSeconds: maxExpirySeconds }],
		});
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
			discountInput({
				effect: { kind: "plan_grant", planKey: "pro", durationUnit: "day", durationCount: 30 },
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

describe("promotion terms updates", () => {
	/** The stored promotion a create produced, as the repository would read it back. */
	function stored(input: CreatePromotionInput): PromotionRecord {
		const normalized = normalizeCreatePromotionInput(input);
		return {
			id: "11111111-1111-4111-8111-111111111111",
			key: normalized.key,
			name: normalized.name,
			status: "active",
			effect: normalized.effect,
			targets: normalized.targets,
			allowedChannels: normalized.allowedChannels,
			metadata: normalized.metadata,
			termsHash: normalized.termsHash,
			createdBy: "operator@example.com",
			createdAt: "2026-10-12T00:00:00.000Z",
			archivedBy: null,
			archivedAt: null,
			codeCounts: { total: 0, active: 0 },
			redemptionCounts: { reserved: 0, applied: 0, released: 0, reversed: 0 },
			providerObjects: [],
		};
	}

	it("hashes an edited promotion like a create with the edited terms", () => {
		const current = stored(
			discountInput({
				targets: [
					{ kind: "product", key: "credits" },
					{ kind: "plan", key: "pro" },
				],
				metadata: { campaign: "spring" },
			}),
		);
		const update = normalizePromotionTermsUpdate(current, {
			name: "Spring sale v2",
			discount: { type: "percent", percentOffBps: 1500, duration: "repeating", durationMonths: 3 },
		});
		const created = normalizeCreatePromotionInput(
			discountInput({
				name: "Spring sale v2",
				effect: {
					kind: "discount",
					discount: {
						type: "percent",
						percentOffBps: 1500,
						duration: "repeating",
						durationMonths: 3,
					},
				},
				targets: [
					{ kind: "plan", key: "pro" },
					{ kind: "product", key: "credits" },
				],
				metadata: { campaign: "spring" },
			}),
		);

		expect(update.termsHash).toBe(created.termsHash);
		expect(update.previousTermsHash).toBe(current.termsHash);
		expect(update.changed).toEqual(["name", "discount"]);
		expect(update.before).toEqual({
			name: "Spring sale",
			discount: { type: "percent", percentOffBps: 2000, duration: "once", durationMonths: null },
		});
	});

	it("reports no change when an edit repeats the stored terms", () => {
		const current = stored(
			discountInput({
				effect: {
					kind: "discount",
					discount: {
						type: "amount",
						amounts: [
							{ currency: "usd", amountOffMinor: 500 },
							{ currency: "eur", amountOffMinor: 450 },
						],
						duration: "once",
						durationMonths: null,
					},
				},
			}),
		);
		const update = normalizePromotionTermsUpdate(current, {
			name: "  Spring sale ",
			discount: {
				type: "amount",
				amounts: [
					{ currency: "EUR", amountOffMinor: 450 },
					{ currency: "USD", amountOffMinor: 500 },
				],
				duration: "once",
				durationMonths: null,
			},
		});

		expect(update.changed).toEqual([]);
		expect(update.termsHash).toBe(update.previousTermsHash);
		expect(update.termsHash).toBe(current.termsHash);
	});

	it("changes a name or metadata of any promotion but only a discount's discount", () => {
		const grant = stored(
			discountInput({
				effect: {
					kind: "feature_grant",
					items: [{ featureKey: "ai_tokens", quantity: "1000", expiresAfterSeconds: null }],
				},
			}),
		);

		const renamed = normalizePromotionTermsUpdate(grant, { name: "Launch credits" });
		expect(renamed.changed).toEqual(["name"]);
		expect(renamed.effect).toEqual(grant.effect);
		expect(
			errorCode(() =>
				normalizePromotionTermsUpdate(grant, {
					discount: { type: "percent", percentOffBps: 500, duration: "once", durationMonths: null },
				}),
			),
		).toBe("PROMOTION_TERMS_INVALID");
	});

	it("validates the changed terms like a create", () => {
		const current = stored(discountInput());
		const invalid = [
			{},
			{ name: "   " },
			{ name: "x".repeat(201) },
			{ metadata: [] as unknown as Record<string, unknown> },
			{
				discount: {
					type: "percent" as const,
					percentOffBps: 10_001,
					duration: "once" as const,
					durationMonths: null,
				},
			},
			{
				discount: {
					type: "percent" as const,
					percentOffBps: 500,
					duration: "repeating" as const,
					durationMonths: null,
				},
			},
			{
				discount: {
					type: "percent" as const,
					percentOffBps: 500,
					duration: "repeating" as const,
					durationMonths: 37,
				},
			},
			{
				discount: {
					type: "percent" as const,
					percentOffBps: 500,
					duration: "once" as const,
					durationMonths: 3,
				},
			},
			{
				discount: {
					type: "amount" as const,
					amounts: [],
					duration: "once" as const,
					durationMonths: null,
				},
			},
		];

		for (const input of invalid) {
			expect(errorCode(() => normalizePromotionTermsUpdate(current, input))).toBe(
				"PROMOTION_TERMS_INVALID",
			);
		}
	});

	it("switches between a percentage and fixed amounts", () => {
		const current = stored(discountInput());
		const update = normalizePromotionTermsUpdate(current, {
			discount: {
				type: "amount",
				amounts: [{ currency: "usd", amountOffMinor: 500 }],
				duration: "forever",
				durationMonths: null,
			},
		});

		expect(update.effect).toEqual({
			kind: "discount",
			discount: {
				type: "amount",
				amounts: [{ currency: "USD", amountOffMinor: 500 }],
				duration: "forever",
				durationMonths: null,
			},
		});
		expect(update.changed).toEqual(["discount"]);
	});
});

describe("plan grant refusals", () => {
	it("answers each refusal as a conflict with its own code", () => {
		for (const code of [
			"PROMOTION_PLAN_NOT_ELIGIBLE",
			"PROMOTION_BASE_PLAN_ACTIVE",
			"PROMOTION_PLAN_GRANT_ACTIVE",
		] as const) {
			const error = promotionError(code);
			expect({ code: error.code, status: error.status }).toEqual({ code, status: 409 });
			expect(error.message).not.toBe("Promotion request failed");
		}
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

describe("discount math", () => {
	it("rounds percentages half up per line", () => {
		expect(
			applyDiscountToLines(
				[499, 1250, 5],
				{ type: "percent", percentOffBps: 2000, duration: "once", durationMonths: null },
				"USD",
			),
		).toEqual({ lineDiscountsMinor: [100, 250, 1], discountTotalMinor: 351 });
		expect(
			applyDiscountToLines(
				[1000],
				{ type: "percent", percentOffBps: 10_000, duration: "forever", durationMonths: null },
				"USD",
			),
		).toEqual({ lineDiscountsMinor: [1000], discountTotalMinor: 1000 });
	});

	it("splits fixed amounts by subtotal with largest remainders and caps at the subtotal", () => {
		const discount = {
			type: "amount" as const,
			amounts: [{ currency: "USD", amountOffMinor: 100 }],
			duration: "once" as const,
			durationMonths: null,
		};
		expect(applyDiscountToLines([300, 300, 300], discount, "usd")).toEqual({
			lineDiscountsMinor: [34, 33, 33],
			discountTotalMinor: 100,
		});
		expect(applyDiscountToLines([10, 70, 20], discount, "USD")).toEqual({
			lineDiscountsMinor: [10, 70, 20],
			discountTotalMinor: 100,
		});
		expect(applyDiscountToLines([40, 20], discount, "USD")).toEqual({
			lineDiscountsMinor: [40, 20],
			discountTotalMinor: 60,
		});
		expect(applyDiscountToLines([0], discount, "USD")).toEqual({
			lineDiscountsMinor: [0],
			discountTotalMinor: 0,
		});
		expect(applyDiscountToLines([100, null], discount, "USD")).toEqual({
			lineDiscountsMinor: [null, null],
			discountTotalMinor: null,
		});
		expect(errorCode(() => applyDiscountToLines([100], discount, "EUR"))).toBe(
			"PROMOTION_CURRENCY_NOT_SUPPORTED",
		);
	});

	it("keeps recurring discounts only while their duration covers the next invoice", () => {
		const percent = (
			duration: "once" | "repeating" | "forever",
			durationMonths: number | null,
		) => ({
			type: "percent" as const,
			percentOffBps: 1000,
			duration,
			durationMonths,
		});
		const month = { unit: "month", count: 1 } as const;
		const year = { unit: "year", count: 1 } as const;
		expect(discountAppliesNextCycle(percent("forever", null), year)).toBe(true);
		expect(discountAppliesNextCycle(percent("once", null), month)).toBe(false);
		expect(discountAppliesNextCycle(percent("repeating", 3), month)).toBe(true);
		expect(discountAppliesNextCycle(percent("repeating", 1), month)).toBe(false);
		expect(discountAppliesNextCycle(percent("repeating", 12), year)).toBe(false);
		// Other cadences compare by length: a quarter is three months, and weeks must fit in the
		// shortest months the discount could span.
		expect(discountAppliesNextCycle(percent("repeating", 4), { unit: "quarter", count: 1 })).toBe(
			true,
		);
		expect(discountAppliesNextCycle(percent("repeating", 3), { unit: "month", count: 3 })).toBe(
			false,
		);
		expect(discountAppliesNextCycle(percent("repeating", 1), { unit: "week", count: 1 })).toBe(
			true,
		);
		expect(discountAppliesNextCycle(percent("repeating", 1), { unit: "day", count: 28 })).toBe(
			false,
		);
	});
});
