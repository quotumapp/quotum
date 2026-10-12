import { describe, expect, it } from "bun:test";
import type { CommercialLineItem } from "../../src/billing/commercial";
import { priceCommercialLines } from "../../src/billing/commercial-pricing";
import type { CommercialPromotion } from "../../src/billing/promotions";

const line = (overrides: Partial<CommercialLineItem> = {}): CommercialLineItem => ({
	key: "base",
	label: "Pro",
	quantity: 1,
	unitAmountMinor: 2000,
	currency: "USD",
	interval: "month",
	intervalCount: 1,
	pricingModel: "flat",
	...overrides,
});

const promotion = (discount: CommercialPromotion["discount"]): CommercialPromotion => ({
	promotionId: "promotion-1",
	promotionKey: "launch",
	promotionName: "Launch",
	promotionCodeId: "code-1",
	code: "LAUNCH",
	hostedCheckoutEnabled: false,
	discount,
	fingerprint: {},
});

describe("commercial preview pricing", () => {
	it("shows exact per-line discounts and the next invoice for a repeating code", () => {
		const priced = priceCommercialLines({
			lines: [line(), line({ key: "seats", label: "Seats", quantity: 3, unitAmountMinor: 500 })],
			currency: "USD",
			recurringInterval: { unit: "month", count: 1 },
			promotion: promotion({
				type: "amount",
				amounts: [{ currency: "USD", amountOffMinor: 700 }],
				duration: "repeating",
				durationMonths: 3,
			}),
			hostedEntry: false,
		});

		expect(priced).toMatchObject({
			subtotalMinor: 3500,
			discountTotalMinor: 700,
			estimatedTotalMinor: 2800,
			amountStatus: "exact",
			promotionCodeEntry: "code",
			promotion: {
				code: "LAUNCH",
				discount: { type: "amount", amountOffMinor: 700, currency: "USD", durationMonths: 3 },
			},
			nextCycle: {
				subtotalMinor: 3500,
				discountMinor: 700,
				totalMinor: 2800,
				discountStatus: "applies",
			},
			warnings: [],
		});
		expect(
			priced.lineItems.map((item) => [item.subtotalMinor, item.discountMinor, item.totalMinor]),
		).toEqual([
			[2000, 400, 1600],
			[1500, 300, 1200],
		]);
	});

	// capability: catalog.price.tiered
	it("leaves tiered totals to Stripe and ends a once discount before the next invoice", () => {
		const tiered = priceCommercialLines({
			lines: [line(), line({ key: "usage", pricingModel: "graduated" })],
			currency: "USD",
			recurringInterval: { unit: "month", count: 1 },
			promotion: promotion({
				type: "percent",
				percentOffBps: 1000,
				duration: "once",
				durationMonths: null,
			}),
			hostedEntry: false,
		});
		const once = priceCommercialLines({
			lines: [line()],
			currency: "USD",
			recurringInterval: { unit: "month", count: 1 },
			promotion: promotion({
				type: "percent",
				percentOffBps: 1000,
				duration: "once",
				durationMonths: null,
			}),
			hostedEntry: false,
		});
		const hosted = priceCommercialLines({
			lines: [line({ interval: null, intervalCount: null })],
			currency: "USD",
			recurringInterval: null,
			promotion: null,
			hostedEntry: true,
		});

		expect(tiered).toMatchObject({
			subtotalMinor: null,
			discountTotalMinor: null,
			estimatedTotalMinor: null,
			amountStatus: "provider_calculated",
			nextCycle: { discountStatus: "provider_calculated", totalMinor: null },
			warnings: ["Stripe calculates tiered line totals and their discount during Checkout."],
		});
		expect(once.nextCycle).toEqual({
			interval: "month",
			intervalCount: 1,
			currency: "USD",
			subtotalMinor: 2000,
			discountMinor: 0,
			totalMinor: 2000,
			discountStatus: "ended",
		});
		expect(once.estimatedTotalMinor).toBe(1800);
		expect(hosted).toMatchObject({
			promotionCodeEntry: "hosted",
			promotion: null,
			discountTotalMinor: 0,
			nextCycle: null,
		});
		expect(hosted.warnings[0]).toContain("Customer-entered promotion codes");
	});

	describe("flat totals past the largest exact amount", () => {
		const price = (lines: CommercialLineItem[], discount?: CommercialPromotion["discount"]) =>
			priceCommercialLines({
				lines,
				currency: "USD",
				recurringInterval: { unit: "month", count: 1 },
				promotion: discount === undefined ? null : promotion(discount),
				hostedEntry: false,
			});
		const refused = { code: "INVALID_QUANTITY", status: 400 };

		it("states the largest exactly representable total and refuses the next amount", () => {
			// 3 x 3,002,399,751,580,330 is 9,007,199,254,740,990; one more seat is 9,007,199,254,740,993.
			const exact = price([line({ unitAmountMinor: 3, quantity: 3_002_399_751_580_330 })]);
			expect(exact).toMatchObject({
				subtotalMinor: 9_007_199_254_740_990,
				estimatedTotalMinor: 9_007_199_254_740_990,
				amountStatus: "exact",
			});
			const largest = price([line({ unitAmountMinor: 1, quantity: Number.MAX_SAFE_INTEGER })]);
			expect(largest.subtotalMinor).toBe(Number.MAX_SAFE_INTEGER);

			expect(() => price([line({ unitAmountMinor: 3, quantity: 3_002_399_751_580_331 })])).toThrow(
				expect.objectContaining(refused),
			);
			expect(() =>
				price([line({ unitAmountMinor: 2, quantity: Number.MAX_SAFE_INTEGER })]),
			).toThrow(expect.objectContaining(refused));
		});

		it("refuses lines that are each exact but sum past it", () => {
			const half = Math.floor(Number.MAX_SAFE_INTEGER / 2);
			expect(() =>
				price([
					line({ key: "base", unitAmountMinor: 1, quantity: half }),
					line({ key: "seats", unitAmountMinor: 1, quantity: half + 2 }),
				]),
			).toThrow(expect.objectContaining(refused));
			expect(
				price([
					line({ key: "base", unitAmountMinor: 1, quantity: half }),
					line({ key: "seats", unitAmountMinor: 1, quantity: half + 1 }),
				]).subtotalMinor,
			).toBe(Number.MAX_SAFE_INTEGER);
		});

		it("refuses a unit amount or a quantity that is not a safe integer", () => {
			expect(() => price([line({ unitAmountMinor: 2 ** 60, quantity: 1 })])).toThrow(
				expect.objectContaining(refused),
			);
			expect(() => price([line({ unitAmountMinor: 100, quantity: 1.5 })])).toThrow(
				expect.objectContaining(refused),
			);
		});

		it("keeps a discount on the largest exact total exact", () => {
			const discounted = price([line({ unitAmountMinor: 1, quantity: Number.MAX_SAFE_INTEGER })], {
				type: "percent",
				percentOffBps: 2500,
				duration: "once",
				durationMonths: null,
			});
			// 25% of 9,007,199,254,740,991, rounded half up, computed on integers.
			expect(discounted.discountTotalMinor).toBe(2_251_799_813_685_248);
			expect(discounted.estimatedTotalMinor).toBe(Number.MAX_SAFE_INTEGER - 2_251_799_813_685_248);
		});

		it("leaves a tiered line's amount to Stripe whatever its quantity", () => {
			const tiered = price([
				line({
					key: "usage",
					pricingModel: "graduated",
					unitAmountMinor: 2 ** 60,
					quantity: 2 ** 40,
				}),
			]);
			expect(tiered).toMatchObject({ subtotalMinor: null, amountStatus: "provider_calculated" });
		});
	});
});
