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
			recurringInterval: "month",
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
			recurringInterval: "month",
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
			recurringInterval: "month",
			promotion: promotion({
				type: "percent",
				percentOffBps: 1000,
				duration: "once",
				durationMonths: null,
			}),
			hostedEntry: false,
		});
		const hosted = priceCommercialLines({
			lines: [line({ interval: null })],
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
});
