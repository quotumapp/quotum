import { canonicalDecimal, decimalToUnits, unitsToDecimal } from "./decimal";
import { InvalidRequestError } from "./errors";

export type StripeProrationBehavior = "always_invoice" | "create_prorations" | "none";

export interface UsageCharge {
	usageQuantity: string;
	includedQuantity: string;
	billableQuantity: string;
	amountMinor: bigint;
}

export interface PriceTier {
	upToQuantity: string | null;
	unitAmountMinor: bigint;
	flatAmountMinor?: bigint;
}

export interface RateCardTier {
	upToQuantity: string | null;
	ratePerUnit: string;
}

export type PricingModel = "flat" | "graduated" | "volume";

export function calculateRateCardQuantity(input: {
	quantity: string;
	pricingModel: "flat" | "graduated";
	ratePerUnit: string;
	tiers?: RateCardTier[];
	meterScale?: number;
	walletScale?: number;
}): string {
	const meterScale = input.meterScale ?? 9;
	const walletScale = input.walletScale ?? 9;
	const quantity = decimalToUnits(
		canonicalDecimal(input.quantity, "quantity", meterScale),
		meterScale,
	);
	if (input.pricingModel === "flat") {
		if ((input.tiers ?? []).length > 0) {
			throw new InvalidRequestError("Flat rate-card pricing cannot use tiers");
		}
		return rateNumeratorToQuantity(
			quantity * decimalToUnits(canonicalDecimal(input.ratePerUnit, "ratePerUnit", 18), 18),
			meterScale,
			walletScale,
		);
	}

	const tiers = normalizeRateCardTiers(input.tiers ?? [], meterScale);
	let lowerBound = 0n;
	let numerator = 0n;
	for (const tier of tiers) {
		const upperBound = tier.upTo === null || tier.upTo > quantity ? quantity : tier.upTo;
		const tierQuantity = upperBound > lowerBound ? upperBound - lowerBound : 0n;
		if (tierQuantity > 0n) numerator += tierQuantity * tier.ratePerUnit;
		if (upperBound === quantity) break;
		lowerBound = upperBound;
	}
	return rateNumeratorToQuantity(numerator, meterScale, walletScale);
}

function rateNumeratorToQuantity(
	numerator: bigint,
	meterScale: number,
	walletScale: number,
): string {
	const denominator = 10n ** BigInt(meterScale + 18 - walletScale);
	return unitsToDecimal((numerator + denominator / 2n) / denominator, walletScale);
}

function normalizeRateCardTiers(
	tiers: RateCardTier[],
	meterScale: number,
): Array<{ upTo: bigint | null; ratePerUnit: bigint }> {
	if (tiers.length === 0) {
		throw new InvalidRequestError("Graduated rate-card pricing requires tiers");
	}
	let previous = 0n;
	return tiers.map((tier, index) => {
		const upTo =
			tier.upToQuantity === null
				? null
				: decimalToUnits(
						canonicalDecimal(tier.upToQuantity, "tier upToQuantity", meterScale),
						meterScale,
					);
		if (upTo === null && index !== tiers.length - 1) {
			throw new InvalidRequestError("Only the final rate-card tier can be unbounded");
		}
		if (upTo !== null && upTo <= previous) {
			throw new InvalidRequestError("Rate-card tier boundaries must be strictly increasing");
		}
		if (upTo !== null) previous = upTo;
		if (index === tiers.length - 1 && upTo !== null) {
			throw new InvalidRequestError("The final rate-card tier must be unbounded");
		}
		const ratePerUnit = decimalToUnits(
			canonicalDecimal(tier.ratePerUnit, "tier ratePerUnit", 18),
			18,
		);
		if (ratePerUnit <= 0n) {
			throw new InvalidRequestError("Tier ratePerUnit must be greater than zero");
		}
		return { upTo, ratePerUnit };
	});
}

export function calculateUsageCharge(input: {
	usageQuantity: string;
	includedQuantity: string;
	billingUnits: string;
	unitAmountMinor: bigint;
	scale?: number;
}): UsageCharge {
	const scale = input.scale ?? 9;
	const usage = decimalToUnits(
		canonicalDecimal(input.usageQuantity, "usageQuantity", scale),
		scale,
	);
	const included = decimalToUnits(
		canonicalDecimal(input.includedQuantity, "includedQuantity", scale),
		scale,
	);
	const billingUnits = decimalToUnits(
		canonicalDecimal(input.billingUnits, "billingUnits", scale),
		scale,
	);
	if (billingUnits <= 0n) throw new InvalidRequestError("billingUnits must be greater than zero");
	if (input.unitAmountMinor < 0n) {
		throw new InvalidRequestError("unitAmountMinor must be nonnegative");
	}
	const billable = usage > included ? usage - included : 0n;
	const numerator = billable * input.unitAmountMinor;
	const amountMinor = (numerator + billingUnits / 2n) / billingUnits;
	return {
		usageQuantity: unitsToDecimal(usage, scale),
		includedQuantity: unitsToDecimal(included, scale),
		billableQuantity: unitsToDecimal(billable, scale),
		amountMinor,
	};
}

export function calculateTieredUsageCharge(input: {
	usageQuantity: string;
	includedQuantity: string;
	billingUnits: string;
	pricingModel: "graduated" | "volume";
	tiers: PriceTier[];
	scale?: number;
}): UsageCharge {
	const scale = input.scale ?? 9;
	const usage = decimalToUnits(
		canonicalDecimal(input.usageQuantity, "usageQuantity", scale),
		scale,
	);
	const included = decimalToUnits(
		canonicalDecimal(input.includedQuantity, "includedQuantity", scale),
		scale,
	);
	const billingUnits = decimalToUnits(
		canonicalDecimal(input.billingUnits, "billingUnits", scale),
		scale,
	);
	if (billingUnits <= 0n) throw new InvalidRequestError("billingUnits must be greater than zero");
	const tiers = normalizeTiers(input.tiers, scale);
	const billable = usage > included ? usage - included : 0n;
	let numerator = 0n;
	if (billable > 0n && input.pricingModel === "volume") {
		const tier = tiers.find(({ upTo }) => upTo === null || billable <= upTo);
		if (tier === undefined) throw new InvalidRequestError("Tier table does not cover usage");
		numerator = billable * tier.unitAmountMinor + tier.flatAmountMinor * billingUnits;
	}
	if (billable > 0n && input.pricingModel === "graduated") {
		let lowerBound = 0n;
		for (const tier of tiers) {
			const upperBound = tier.upTo === null || tier.upTo > billable ? billable : tier.upTo;
			const tierQuantity = upperBound > lowerBound ? upperBound - lowerBound : 0n;
			if (tierQuantity > 0n) {
				numerator += tierQuantity * tier.unitAmountMinor + tier.flatAmountMinor * billingUnits;
			}
			if (upperBound === billable) break;
			lowerBound = upperBound;
		}
	}
	return {
		usageQuantity: unitsToDecimal(usage, scale),
		includedQuantity: unitsToDecimal(included, scale),
		billableQuantity: unitsToDecimal(billable, scale),
		amountMinor: (numerator + billingUnits / 2n) / billingUnits,
	};
}

function normalizeTiers(
	tiers: PriceTier[],
	scale: number,
): Array<{
	upTo: bigint | null;
	unitAmountMinor: bigint;
	flatAmountMinor: bigint;
}> {
	if (tiers.length === 0)
		throw new InvalidRequestError("Tiered pricing requires at least one tier");
	let previous = 0n;
	return tiers.map((tier, index) => {
		if (tier.unitAmountMinor < 0n || (tier.flatAmountMinor ?? 0n) < 0n) {
			throw new InvalidRequestError("Tier amounts must be nonnegative");
		}
		const upTo =
			tier.upToQuantity === null
				? null
				: decimalToUnits(canonicalDecimal(tier.upToQuantity, "tier upToQuantity", scale), scale);
		if (upTo === null && index !== tiers.length - 1) {
			throw new InvalidRequestError("Only the final pricing tier can be unbounded");
		}
		if (upTo !== null && upTo <= previous) {
			throw new InvalidRequestError("Pricing tier boundaries must be strictly increasing");
		}
		if (upTo !== null) previous = upTo;
		if (index === tiers.length - 1 && upTo !== null) {
			throw new InvalidRequestError("The final pricing tier must be unbounded");
		}
		return {
			upTo,
			unitAmountMinor: tier.unitAmountMinor,
			flatAmountMinor: tier.flatAmountMinor ?? 0n,
		};
	});
}

export function classifySubscriptionChange(input: {
	fromPlanVersionId: string;
	toPlanVersionId: string;
	fromTierRank: number;
	toTierRank: number;
	quantitiesChanged: boolean;
}): "upgrade" | "downgrade" | "quantity" {
	if (input.fromPlanVersionId === input.toPlanVersionId) {
		if (!input.quantitiesChanged) {
			throw new InvalidRequestError("A subscription change must alter its plan or quantities");
		}
		return "quantity";
	}
	return input.toTierRank >= input.fromTierRank ? "upgrade" : "downgrade";
}

export function defaultChangeTiming(
	kind: "upgrade" | "downgrade" | "quantity",
): "immediate" | "period_end" {
	return kind === "downgrade" ? "period_end" : "immediate";
}

export function stripeProrationForChange(input: {
	kind: "upgrade" | "downgrade" | "quantity";
	upgrade: StripeProrationBehavior;
	downgrade: StripeProrationBehavior;
}): StripeProrationBehavior {
	return input.kind === "downgrade" ? input.downgrade : input.upgrade;
}
