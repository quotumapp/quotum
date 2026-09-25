import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { decimalToUnits, unitsToDecimal } from "../../src/billing/decimal";
import type { MeteringBalance } from "../../src/billing/metering";
import {
	calculateRateCardQuantity,
	calculateTieredUsageCharge,
	calculateUsageCharge,
	type RateCardTier,
} from "../../src/billing/pricing";
import { applyDiscountToLines } from "../../src/billing/promotions";
import {
	buildDecision,
	calculateMeteredOverageCharge,
	calculateWalletQuantity,
	type FeatureRow,
	type MeterLimitDecision,
	meterLimitReservationSpend,
	type RateDecision,
} from "../../src/db/repository/metering-persistence";
import { FakeDatabase } from "../db/repository-fixture";

const NUM_RUNS = Number(process.env.FC_NUM_RUNS ?? 300);

const scale = fc.integer({ min: 0, max: 9 });
const rateUnits = fc.bigInt({ min: 1n, max: 10n ** 20n });
const rate = rateUnits.map((units) => unitsToDecimal(units, 18));

interface RateCard {
	pricingModel: "flat" | "graduated";
	ratePerUnit: string;
	tiers: Array<{ upTo: bigint | null; rate: bigint }>;
}

/** A flat card, or a graduated card whose bounds are metered units at the meter scale. */
const rateCard: fc.Arbitrary<RateCard> = fc.oneof(
	rateUnits.map((units) => ({
		pricingModel: "flat" as const,
		ratePerUnit: unitsToDecimal(units, 18),
		tiers: [],
	})),
	fc
		.uniqueArray(fc.bigInt({ min: 1n, max: 10n ** 6n }), { minLength: 0, maxLength: 3 })
		.chain((bounds) => {
			const sorted = [...bounds].sort((a, b) => (a < b ? -1 : 1));
			return fc.tuple(...[...sorted, null].map(() => rateUnits)).map((rates) => ({
				pricingModel: "graduated" as const,
				ratePerUnit: "1",
				tiers: [...sorted, null].map((upTo, index) => ({ upTo, rate: rates[index] ?? 1n })),
			}));
		}),
);

function charge(card: RateCard, units: bigint, meterScale: number, walletScale: number): bigint {
	const tiers: RateCardTier[] = card.tiers.map((tier) => ({
		upToQuantity: tier.upTo === null ? null : unitsToDecimal(tier.upTo, meterScale),
		ratePerUnit: unitsToDecimal(tier.rate, 18),
	}));
	return decimalToUnits(
		calculateRateCardQuantity({
			quantity: unitsToDecimal(units, meterScale),
			pricingModel: card.pricingModel,
			ratePerUnit: card.ratePerUnit,
			tiers,
			meterScale,
			walletScale,
		}),
		walletScale,
	);
}

/** The unrounded cost in wallet units times 10^(meterScale + 18 - walletScale). */
function exactNumerator(card: RateCard, units: bigint): bigint {
	if (card.pricingModel === "flat") return units * decimalToUnits(card.ratePerUnit, 18);
	let numerator = 0n;
	let lower = 0n;
	for (const tier of card.tiers) {
		const upper = tier.upTo === null || tier.upTo > units ? units : tier.upTo;
		if (upper > lower) numerator += (upper - lower) * tier.rate;
		if (tier.upTo === null || tier.upTo >= units) break;
		lower = tier.upTo;
	}
	return numerator;
}

describe("rate-card conversion properties", () => {
	it("rounds each request's wallet charge up by less than one wallet unit", () => {
		fc.assert(
			fc.property(
				scale,
				scale,
				rateCard,
				fc.bigInt({ min: 0n, max: 10n ** 12n }),
				(meterScale, walletScale, card, units) => {
					const denominator = 10n ** BigInt(meterScale + 18 - walletScale);
					const exact = exactNumerator(card, units);
					const wallet = charge(card, units, meterScale, walletScale);
					expect(wallet * denominator).toBeGreaterThanOrEqual(exact);
					expect((wallet - 1n) * denominator).toBeLessThan(exact === 0n ? 1n : exact);
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});

	it("never converts positive usage into a zero wallet charge", () => {
		// Consume admits any request whose wallet charge fits the available balance, so a positive
		// quantity charged zero would be admitted on an empty wallet, as often as it is repeated.
		fc.assert(
			fc.property(
				scale,
				scale,
				rateCard,
				fc.bigInt({ min: 1n, max: 10n ** 6n }),
				(meterScale, walletScale, card, units) => {
					expect(charge(card, units, meterScale, walletScale)).toBeGreaterThan(0n);
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});

	it("never lowers a flat charge by splitting the request", () => {
		fc.assert(
			fc.property(
				scale,
				scale,
				rate,
				fc.array(fc.bigInt({ min: 1n, max: 10n ** 9n }), { minLength: 1, maxLength: 8 }),
				(meterScale, walletScale, ratePerUnit, parts) => {
					const card: RateCard = { pricingModel: "flat", ratePerUnit, tiers: [] };
					const split = parts.reduce(
						(sum, part) => sum + charge(card, part, meterScale, walletScale),
						0n,
					);
					const whole = parts.reduce((sum, part) => sum + part, 0n);
					expect(split).toBeGreaterThanOrEqual(charge(card, whole, meterScale, walletScale));
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});

	it("never confirms a reservation above the quantity it reserved", () => {
		// Confirmation rates the actual quantity with the reservation's rate card, so the charge for
		// anything up to the reserved quantity must fit the hold quoted at reservation.
		fc.assert(
			fc.property(
				scale,
				scale,
				rateCard,
				fc.bigInt({ min: 1n, max: 10n ** 12n }),
				fc.bigInt({ min: 0n, max: 10n ** 12n }),
				(meterScale, walletScale, card, actual, extra) => {
					const quote = charge(card, actual + extra, meterScale, walletScale);
					expect(charge(card, actual, meterScale, walletScale)).toBeLessThanOrEqual(quote);
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});

	it("prices a single unbounded graduated tier like the flat rate", () => {
		fc.assert(
			fc.property(
				scale,
				scale,
				rate,
				fc.bigInt({ min: 0n, max: 10n ** 12n }),
				(meterScale, walletScale, ratePerUnit, units) => {
					const common = {
						quantity: unitsToDecimal(units, meterScale),
						ratePerUnit,
						meterScale,
						walletScale,
					};
					expect(
						calculateRateCardQuantity({
							...common,
							pricingModel: "graduated",
							tiers: [{ upToQuantity: null, ratePerUnit }],
						}),
					).toBe(calculateRateCardQuantity({ ...common, pricingModel: "flat" }));
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});

	it("denies a sub-unit request against an empty wallet", async () => {
		const feature = (key: string): FeatureRow => ({
			id: key,
			key,
			unit: key,
			credit_scale: 0,
			kind: "metered",
			meter_kind: "consumable",
			filter_dimensions: [],
		});
		const rate: RateDecision = {
			meter: feature("tokens"),
			wallet: feature("credits"),
			path: "additive",
			revision: 1,
			revisionId: "1",
			entryId: "1",
			pricingModel: "flat",
			ratePerUnit: "0.001",
			tiers: [],
		};
		const empty: MeteringBalance = {
			featureKey: "credits",
			unit: "credits",
			scale: 0,
			granted: "0",
			consumed: "0",
			held: "0",
			available: "0",
			breakdown: [],
		};
		// A denial lists the purchase actions, which is the one query the decision runs.
		const database = new FakeDatabase([[]], { strict: true });
		const walletQuantity = await calculateWalletQuantity(database as never, rate, "499");
		const decision = await buildDecision(
			database as never,
			"project",
			rate,
			"499",
			walletQuantity,
			empty,
		);
		expect({ walletQuantity, allowed: decision.allowed, reason: decision.reason }).toEqual({
			walletQuantity: "1",
			allowed: false,
			reason: "insufficient_balance",
		});
		database.assertConsumed();
	});
});

describe("overage charge properties", () => {
	it("rates control spend at the feature scale exactly as the invoice rates it at scale 9", () => {
		fc.assert(
			fc.property(
				scale,
				fc.bigInt({ min: 0n, max: 10n ** 13n }),
				fc.bigInt({ min: 0n, max: 10n ** 13n }),
				fc.bigInt({ min: 1n, max: 10_000n }),
				fc.bigInt({ min: 0n, max: 100_000n }),
				(featureScale, usage, included, billingUnits, unitAmountMinor) => {
					const input = {
						usageQuantity: unitsToDecimal(usage, featureScale),
						includedQuantity: unitsToDecimal(included, featureScale),
						billingUnits: billingUnits.toString(),
						unitAmountMinor,
					};
					expect(calculateUsageCharge({ ...input, scale: featureScale }).amountMinor).toBe(
						calculateUsageCharge(input).amountMinor,
					);
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});

	it("never lets graduated overage fall as usage grows", () => {
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.bigInt({ min: 1n, max: 10_000n }), { minLength: 0, maxLength: 4 }),
				fc.array(fc.bigInt({ min: 0n, max: 500n }), { minLength: 5, maxLength: 5 }),
				fc.array(fc.bigInt({ min: 0n, max: 5_000n }), { minLength: 5, maxLength: 5 }),
				fc.bigInt({ min: 1n, max: 1_000n }),
				fc.bigInt({ min: 0n, max: 20_000n }),
				fc.bigInt({ min: 0n, max: 20_000n }),
				(bounds, units, flats, billingUnits, usage, extra) => {
					const sorted = [...bounds].sort((a, b) => (a < b ? -1 : 1));
					const tiers = [...sorted, null].map((upTo, index) => ({
						upToQuantity: upTo === null ? null : upTo.toString(),
						unitAmountMinor: units[index] ?? 0n,
						flatAmountMinor: flats[index] ?? 0n,
					}));
					const overage = (quantity: bigint) =>
						calculateTieredUsageCharge({
							usageQuantity: quantity.toString(),
							includedQuantity: "0",
							billingUnits: billingUnits.toString(),
							pricingModel: "graduated",
							tiers,
						}).amountMinor;
					expect(overage(usage + extra)).toBeGreaterThanOrEqual(overage(usage));
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});

	it("quotes a volume reservation at least as high as any partial confirmation", () => {
		const meterScale = 1;
		const tierArbitrary = fc
			.uniqueArray(fc.bigInt({ min: 1n, max: 2_000n }), { minLength: 1, maxLength: 4 })
			.chain((bounds) => {
				const sorted = [...bounds].sort((a, b) => (a < b ? -1 : 1));
				return fc.tuple(
					...[...sorted, null].map((upTo) =>
						fc.record({
							upToQuantity: fc.constant(upTo === null ? null : unitsToDecimal(upTo, meterScale)),
							unitAmountMinor: fc.bigInt({ min: 0n, max: 60n }),
							flatAmountMinor: fc.bigInt({ min: 0n, max: 600n }),
						}),
					),
				);
			});
		fc.assert(
			fc.property(
				tierArbitrary,
				fc.bigInt({ min: 1n, max: 50n }),
				fc.bigInt({ min: 0n, max: 1_000n }),
				fc.bigInt({ min: 0n, max: 3_000n }),
				fc.bigInt({ min: 1n, max: 3_000n }),
				(tiers, billingUnits, limit, consumed, reserved) => {
					const meter: MeterLimitDecision = {
						feature: {
							id: "1",
							key: "calls",
							unit: "call",
							credit_scale: meterScale,
							kind: "metered",
							meter_kind: "consumable",
							filter_dimensions: [],
						},
						subscriptionId: "subscription",
						planItemId: "1",
						limit: unitsToDecimal(limit, meterScale),
						overagePolicy: "allowed",
						windowStartAt: new Date("2026-09-01"),
						windowEndAt: new Date("2026-10-01"),
						overagePrice: {
							priceComponentId: "1",
							pricingModel: "volume",
							billingUnits: billingUnits.toString(),
							unitAmountMinor: 0n,
							currency: "USD",
							tiers,
						},
					};
					const balance: MeteringBalance = {
						featureKey: "calls",
						unit: "call",
						scale: meterScale,
						granted: meter.limit,
						consumed: unitsToDecimal(consumed, meterScale),
						held: "0",
						available: "0",
						breakdown: [],
					};
					const quote = BigInt(
						meterLimitReservationSpend(meter, balance, unitsToDecimal(reserved, meterScale))
							.spendMinorDelta,
					);
					const base = calculateMeteredOverageCharge(meter, balance.consumed).amountMinor;
					for (let confirmed = 0n; confirmed <= reserved; confirmed += 1n) {
						const overage = calculateMeteredOverageCharge(
							meter,
							unitsToDecimal(consumed + confirmed, meterScale),
						).amountMinor;
						expect(overage - base).toBeLessThanOrEqual(quote);
					}
				},
			),
			{ numRuns: 150 },
		);
	});
});

describe("fixed discount allocation", () => {
	it("spreads the capped amount across lines without exceeding any line", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 8 }),
				fc.integer({ min: 1, max: 5_000_000 }),
				(subtotals, amountOffMinor) => {
					const { lineDiscountsMinor, discountTotalMinor } = applyDiscountToLines(
						subtotals,
						{
							type: "amount",
							amounts: [{ currency: "USD", amountOffMinor }],
							duration: "once",
							durationMonths: null,
						} as never,
						"usd",
					);
					const total = subtotals.reduce((sum, value) => sum + value, 0);
					expect(discountTotalMinor).toBe(Math.min(amountOffMinor, total));
					lineDiscountsMinor.forEach((discount, index) => {
						expect(discount).toBeGreaterThanOrEqual(0);
						expect(discount).toBeLessThanOrEqual(subtotals[index] ?? 0);
					});
				},
			),
			{ numRuns: NUM_RUNS },
		);
	});
});
