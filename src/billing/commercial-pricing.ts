import type { BillingCadenceUnit, Cadence } from "../shared/cadence";
import type {
	CommercialActionPreview,
	CommercialLineItem,
	CommercialPreviewNextCycle,
	CommercialPreviewPromotion,
} from "./commercial";
import type { BillingError } from "./errors";
import { invalidQuantityError } from "./licensed-quantity";
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

const maxSafeMinor = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * A flat line's subtotal. JavaScript numbers hold integers exactly only up to 2^53 - 1, so the
 * product is formed as a bigint and refused, rather than rounded, when it does not fit.
 */
function flatSubtotalMinor(line: CommercialLineItem): number {
	if (Number.isSafeInteger(line.unitAmountMinor) && Number.isSafeInteger(line.quantity)) {
		const subtotal = BigInt(line.unitAmountMinor) * BigInt(line.quantity);
		if (subtotal <= maxSafeMinor) return Number(subtotal);
	}
	throw amountOutOfRange(`The total for ${line.key}`);
}

function amountOutOfRange(subject: string): BillingError {
	return invalidQuantityError(
		`${subject} exceeds ${Number.MAX_SAFE_INTEGER} minor units; lower a quantity`,
	);
}

/**
 * Prices Checkout lines with an optional discount code. Flat lines are exact; tiered lines leave
 * every amount to Stripe so the preview never shows a total Checkout will not charge. A flat total
 * past the largest exactly representable amount is refused with `INVALID_QUANTITY`.
 */
export function priceCommercialLines(input: {
	lines: readonly CommercialLineItem[];
	currency: string | null;
	recurringInterval: Cadence | null;
	promotion: CommercialPromotion | null;
	hostedEntry: boolean;
}): PricedCommercialPreview {
	const subtotals = input.lines.map((line) =>
		line.pricingModel === "flat" ? flatSubtotalMinor(line) : null,
	);
	const exact = subtotals.every((subtotal) => subtotal !== null);
	let subtotalMinor: number | null = null;
	if (exact) {
		const total = subtotals.reduce<bigint>((sum, value) => sum + BigInt(value ?? 0), 0n);
		if (total > maxSafeMinor) throw amountOutOfRange("The subtotal");
		subtotalMinor = Number(total);
	}
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
	interval: Cadence;
	currency: string | null;
	subtotalMinor: number | null;
	firstCycleDiscountMinor: number | null;
	promotion: CommercialPromotion | null;
}): CommercialPreviewNextCycle {
	if (input.subtotalMinor === null || input.firstCycleDiscountMinor === null) {
		return {
			interval: input.interval.unit as BillingCadenceUnit,
			intervalCount: input.interval.count,
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
		interval: input.interval.unit as BillingCadenceUnit,
		intervalCount: input.interval.count,
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

/** The billing interval of the first recurring line, or null when every line is one-off. */
export function recurringCadenceOf(
	lines: ReadonlyArray<Pick<CommercialLineItem, "interval" | "intervalCount">>,
): Cadence | null {
	const line = lines.find(({ interval }) => interval !== null);
	return line === undefined || line.interval === null
		? null
		: { unit: line.interval, count: line.intervalCount ?? 1 };
}
