import type {
	CommercialActionPreview,
	CommercialLineItem,
	CommercialPreviewNextCycle,
	CommercialPreviewPromotion,
} from "./commercial";
import {
	applyDiscountToLines,
	type CommercialPromotion,
	discountAmountFor,
	discountAppliesNextCycle,
} from "./promotions";

export type PricedCommercialPreview = Pick<
	CommercialActionPreview,
	| "lineItems"
	| "subtotalMinor"
	| "discountTotalMinor"
	| "estimatedTotalMinor"
	| "amountStatus"
	| "promotionCodeEntry"
	| "promotion"
	| "nextCycle"
	| "warnings"
>;

/**
 * Prices Checkout lines with an optional discount code. Flat lines are exact; tiered lines leave
 * every amount to Stripe so the preview never shows a total Checkout will not charge.
 */
export function priceCommercialLines(input: {
	lines: readonly CommercialLineItem[];
	currency: string | null;
	recurringInterval: "month" | "year" | null;
	promotion: CommercialPromotion | null;
	hostedEntry: boolean;
}): PricedCommercialPreview {
	const subtotals = input.lines.map((line) =>
		line.pricingModel === "flat" ? line.unitAmountMinor * line.quantity : null,
	);
	const exact = subtotals.every((subtotal) => subtotal !== null);
	const subtotalMinor = exact
		? subtotals.reduce<number>((sum, value) => sum + (value ?? 0), 0)
		: null;
	const discounted =
		input.promotion === null
			? null
			: applyDiscountToLines(subtotals, input.promotion.discount, input.currency);
	const lineItems = input.lines.map((line, index) => {
		const subtotal = subtotals[index] ?? null;
		const discount =
			discounted === null
				? subtotal === null
					? null
					: 0
				: (discounted.lineDiscountsMinor[index] ?? null);
		return {
			...line,
			subtotalMinor: subtotal,
			discountMinor: discount,
			totalMinor: subtotal === null || discount === null ? null : subtotal - discount,
		};
	});
	const discountTotalMinor =
		discounted === null ? (subtotalMinor === null ? null : 0) : discounted.discountTotalMinor;
	const warnings: string[] = [];
	if (!exact) {
		warnings.push(
			input.promotion === null
				? "Stripe calculates tiered line totals during Checkout."
				: "Stripe calculates tiered line totals and their discount during Checkout.",
		);
	}
	if (input.hostedEntry) {
		warnings.push(
			"Customer-entered promotion codes are validated and priced by Stripe; this preview excludes them.",
		);
	}
	return {
		lineItems,
		subtotalMinor,
		discountTotalMinor,
		estimatedTotalMinor:
			subtotalMinor === null || discountTotalMinor === null
				? null
				: subtotalMinor - discountTotalMinor,
		amountStatus: exact ? "exact" : "provider_calculated",
		promotionCodeEntry: input.promotion !== null ? "code" : input.hostedEntry ? "hosted" : "none",
		promotion: input.promotion === null ? null : previewPromotion(input.promotion, input.currency),
		nextCycle:
			input.recurringInterval === null
				? null
				: nextCycle({
						interval: input.recurringInterval,
						currency: input.currency,
						subtotalMinor,
						firstCycleDiscountMinor: discountTotalMinor,
						promotion: input.promotion,
					}),
		warnings,
	};
}

function nextCycle(input: {
	interval: "month" | "year";
	currency: string | null;
	subtotalMinor: number | null;
	firstCycleDiscountMinor: number | null;
	promotion: CommercialPromotion | null;
}): CommercialPreviewNextCycle {
	if (input.subtotalMinor === null || input.firstCycleDiscountMinor === null) {
		return {
			interval: input.interval,
			currency: input.currency,
			subtotalMinor: null,
			discountMinor: null,
			totalMinor: null,
			discountStatus: input.promotion === null ? "none" : "provider_calculated",
		};
	}
	const applies =
		input.promotion !== null && discountAppliesNextCycle(input.promotion.discount, input.interval);
	const discountMinor = applies ? input.firstCycleDiscountMinor : 0;
	return {
		interval: input.interval,
		currency: input.currency,
		subtotalMinor: input.subtotalMinor,
		discountMinor,
		totalMinor: input.subtotalMinor - discountMinor,
		discountStatus: input.promotion === null ? "none" : applies ? "applies" : "ended",
	};
}

function previewPromotion(
	promotion: CommercialPromotion,
	currency: string | null,
): CommercialPreviewPromotion {
	const discount = promotion.discount;
	return {
		promotionKey: promotion.promotionKey,
		promotionName: promotion.promotionName,
		promotionCodeId: promotion.promotionCodeId,
		code: promotion.code,
		discount: {
			type: discount.type,
			percentOffBps: discount.type === "percent" ? discount.percentOffBps : null,
			amountOffMinor: discount.type === "amount" ? discountAmountFor(discount, currency) : null,
			currency: discount.type === "amount" ? (currency?.toUpperCase() ?? null) : null,
			duration: discount.duration,
			durationMonths: discount.durationMonths,
		},
	};
}
