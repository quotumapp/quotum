import { InvalidRequestError } from "../billing/errors";
import { type CadenceUnit, sameCadence } from "../shared/cadence";
import type {
	AuthoredCatalogIntent,
	AuthoredPlanIntent,
	AuthoredPlanItemIntent,
	CanonicalCatalog,
	CanonicalPlan,
	CanonicalPlanItem,
	CanonicalTopup,
	CatalogAdvisory,
	CatalogExpiryIntent,
	CatalogGiftIntent,
	CatalogIntent,
	CatalogPlanIntent,
	CatalogPlanItemIntent,
	CatalogPriceIntent,
	CatalogProviderBindingIntent,
	CatalogProviderPricedIntent,
	CatalogTopupIntent,
} from "./types";

/**
 * Maps canonical authoring to the database working representation and back. Validation and
 * publication use the same normalized working catalog; preview stores and hashes its canonical form.
 */

/** The advisory for a Stripe product whose price the Stripe dashboard owns. */
export const stripeProviderPricedAdvisory = "Use `basePrice` when Quotum should model the price.";

export function bindingIdentity(binding: CatalogProviderBindingIntent): string {
	return `${binding.provider}:${binding.channel}:${binding.productKey}`;
}

function sortedBindings(bindings: CatalogProviderBindingIntent[]): CatalogProviderBindingIntent[] {
	return [...bindings].sort((left, right) =>
		bindingIdentity(left).localeCompare(bindingIdentity(right)),
	);
}

/** Both lists' bindings once each, sorted: a plan's product bindings span both price blocks. */
export function unionBindings(
	...lists: CatalogProviderBindingIntent[][]
): CatalogProviderBindingIntent[] {
	const byIdentity = new Map<string, CatalogProviderBindingIntent>();
	for (const binding of lists.flat()) byIdentity.set(bindingIdentity(binding), binding);
	return sortedBindings([...byIdentity.values()]);
}

interface Cadence {
	unit: NonNullable<CatalogPlanIntent["billingInterval"]>;
	count: number;
}

/** A priced plan has exactly one billing cadence; only an unpriced plan has none. */
function planCadence(plan: AuthoredPlanIntent, prices: CatalogPriceIntent[]): Cadence | null {
	const cadences = [
		...(plan.basePrice == null
			? []
			: [
					{ unit: plan.basePrice.billingInterval, count: plan.basePrice.billingIntervalCount ?? 1 },
				]),
		...(plan.providerPriced == null
			? []
			: [
					{
						unit: plan.providerPriced.billingInterval,
						count: plan.providerPriced.billingIntervalCount ?? 1,
					},
				]),
		...prices.map((price) => ({
			unit: price.billingInterval,
			count: price.billingIntervalCount ?? 1,
		})),
	];
	const [first, ...rest] = cadences;
	if (first === undefined) return null;
	if (rest.some((cadence) => !sameCadence(first, cadence))) {
		throw new InvalidRequestError(`Plan ${plan.key} price intervals must match`);
	}
	return first;
}

/** The working model's expiry columns: an exact duration or a calendar cadence, never both. */
interface WorkingExpiry {
	expiresAfterSeconds: number | null;
	expiryInterval: CadenceUnit | null;
	expiryIntervalCount: number | null;
}

function workingExpiry(expiry: CatalogExpiryIntent | undefined): WorkingExpiry {
	if (expiry === undefined || expiry.mode === "forever") {
		return { expiresAfterSeconds: null, expiryInterval: null, expiryIntervalCount: null };
	}
	if (expiry.mode === "after") {
		return {
			expiresAfterSeconds: null,
			expiryInterval: expiry.interval,
			expiryIntervalCount: expiry.intervalCount,
		};
	}
	return { expiresAfterSeconds: expiry.seconds, expiryInterval: null, expiryIntervalCount: null };
}

function canonicalExpiry(working: {
	expiresAfterSeconds: number | null;
	expiryInterval?: CadenceUnit | null;
	expiryIntervalCount?: number | null;
}): CatalogExpiryIntent {
	if (working.expiryInterval !== undefined && working.expiryInterval !== null) {
		return {
			mode: "after",
			interval: working.expiryInterval,
			intervalCount: working.expiryIntervalCount ?? 1,
		};
	}
	return working.expiresAfterSeconds === null
		? { mode: "forever" }
		: { mode: "after_seconds", seconds: working.expiresAfterSeconds };
}

/** The database working item for a canonical one. */
function workingItem(item: AuthoredPlanItemIntent): CatalogPlanItemIntent {
	switch (item.itemKind) {
		case "access":
			return {
				featureKey: item.featureKey,
				itemKind: "access",
				quantity: null,
				resetInterval: null,
				resetIntervalCount: null,
				expiresAfterSeconds: null,
				overagePolicy: "blocked",
				allocationScope: "account",
				rollover: null,
				price: null,
			};
		case "allocation":
			return {
				featureKey: item.featureKey,
				itemKind: "allocation",
				quantity: item.quantity,
				resetInterval: item.reset?.interval ?? null,
				resetIntervalCount: item.reset?.intervalCount ?? null,
				...workingExpiry(item.expiry),
				overagePolicy: "blocked",
				allocationScope: item.allocationScope ?? "account",
				rollover: item.rollover ?? null,
				price: null,
			};
		case "meter_limit": {
			const overage = item.overage ?? { policy: "blocked" as const };
			return {
				featureKey: item.featureKey,
				itemKind: "meter_limit",
				quantity: item.quantity,
				resetInterval: item.reset.interval,
				resetIntervalCount: item.reset.intervalCount,
				expiresAfterSeconds: null,
				overagePolicy: overage.policy,
				allocationScope: item.allocationScope ?? "account",
				rollover: null,
				price: overage.policy === "allowed" ? overage.price : null,
			};
		}
		case "licensed_quantity":
			return {
				featureKey: item.featureKey,
				itemKind: "licensed_quantity",
				quantity: item.quantity,
				resetInterval: null,
				resetIntervalCount: null,
				expiresAfterSeconds: null,
				overagePolicy: "blocked",
				allocationScope: item.allocationScope ?? "account",
				rollover: null,
				price: item.price,
			};
		case "unlimited_usage":
			return {
				featureKey: item.featureKey,
				itemKind: "unlimited_usage",
				quantity: null,
				resetInterval: null,
				resetIntervalCount: null,
				expiresAfterSeconds: null,
				overagePolicy: "blocked",
				allocationScope: "account",
				rollover: null,
				price: null,
			};
	}
}

function itemPrices(items: CatalogPlanItemIntent[]): CatalogPriceIntent[] {
	return items.flatMap((item) =>
		item.price === undefined || item.price === null ? [] : [item.price],
	);
}

/** Converts canonical authoring into the database working representation. */
export function toWorkingShape(authored: AuthoredCatalogIntent): CatalogIntent {
	const plans = authored.plans.map((plan): CatalogPlanIntent => {
		const items = plan.items.map(workingItem);
		const basePrice = plan.basePrice ?? null;
		const providerPriced = plan.providerPriced ?? null;
		const cadence = planCadence(plan, itemPrices(items));
		return {
			...plan,
			trialDays: plan.trialDays ?? null,
			currency: basePrice?.currency ?? null,
			baseAmountMinor: basePrice?.unitAmountMinor ?? null,
			billingInterval: cadence?.unit ?? null,
			billingIntervalCount: cadence?.count ?? null,
			basePrice,
			items,
			providerBindings: unionBindings(
				basePrice?.providerBindings ?? [],
				providerPriced?.providerBindings ?? [],
			),
		};
	});
	const topups = authored.topups.map(
		(topup): CatalogTopupIntent => ({
			key: topup.key,
			featureKey: topup.featureKey,
			quantity: topup.quantity,
			...workingExpiry(topup.expiry),
			providerBindings: topup.providerBindings,
		}),
	);
	return {
		features: authored.features,
		plans,
		topups,
		rateCards: authored.rateCards,
		...(authored.gifts === undefined
			? {}
			: {
					gifts: authored.gifts.map(
						(gift): CatalogGiftIntent => ({
							key: gift.key,
							name: gift.name,
							promotionKey: gift.promotionKey,
							codeCount: gift.codeCount ?? 1,
							codeValidDays: gift.codeValidDays,
							providerBindings: gift.providerBindings,
						}),
					),
				}),
		...(authored.retiredFeatureKeys === undefined
			? {}
			: { retiredFeatureKeys: authored.retiredFeatureKeys }),
		...(authored.retiredPlanKeys === undefined
			? {}
			: { retiredPlanKeys: authored.retiredPlanKeys }),
		...(authored.retiredTopupKeys === undefined
			? {}
			: { retiredTopupKeys: authored.retiredTopupKeys }),
		...(authored.retiredGiftKeys === undefined
			? {}
			: { retiredGiftKeys: authored.retiredGiftKeys }),
		...(authored.defaultPlan === undefined ? {} : { defaultPlan: authored.defaultPlan }),
	};
}

/** The canonical intent for a normalized database working catalog. */
export function canonicalFromWorking(working: CatalogIntent): CanonicalCatalog {
	const plans = working.plans.map((plan): CanonicalPlan => {
		const basePrice = plan.basePrice ?? null;
		const priceIdentities = new Set((basePrice?.providerBindings ?? []).map(bindingIdentity));
		const remainder = sortedBindings(
			plan.providerBindings.filter((binding) => !priceIdentities.has(bindingIdentity(binding))),
		);
		if (remainder.length > 0 && plan.billingInterval === null) {
			throw new InvalidRequestError(
				`Plan ${plan.key} provider-priced products require a billing cadence`,
			);
		}
		const providerPriced: CatalogProviderPricedIntent | null =
			remainder.length === 0
				? null
				: {
						billingInterval: plan.billingInterval as CatalogProviderPricedIntent["billingInterval"],
						billingIntervalCount: plan.billingIntervalCount ?? 1,
						providerBindings: remainder,
					};
		return {
			key: plan.key,
			name: plan.name,
			version: plan.version,
			kind: plan.kind ?? "base",
			visibility: plan.visibility ?? "public",
			customerBillingAccountId: plan.customerBillingAccountId ?? null,
			tierRank: plan.tierRank ?? 0,
			trialDays: plan.trialDays ?? null,
			trialRequiresPaymentMethod: plan.trialRequiresPaymentMethod ?? true,
			trialEndBehavior: plan.trialEndBehavior ?? "cancel",
			upgradeProrationBehavior: plan.upgradeProrationBehavior ?? "always_invoice",
			downgradeProrationBehavior: plan.downgradeProrationBehavior ?? "none",
			basePrice,
			providerPriced,
			items: plan.items.map(canonicalItem),
			controls: plan.controls ?? [],
		};
	});
	const topups = working.topups.map(
		(topup): CanonicalTopup => ({
			key: topup.key,
			featureKey: topup.featureKey,
			quantity: topup.quantity,
			expiry: canonicalExpiry(topup),
			providerBindings: topup.providerBindings,
		}),
	);
	const defaultPlan = working.defaultPlan ?? null;
	const gifts = working.gifts ?? [];
	const retiredGiftKeys = working.retiredGiftKeys ?? [];
	return {
		features: working.features,
		plans,
		topups,
		rateCards: working.rateCards,
		retiredFeatureKeys: working.retiredFeatureKeys ?? [],
		retiredPlanKeys: working.retiredPlanKeys ?? [],
		retiredTopupKeys: working.retiredTopupKeys ?? [],
		// Left out when empty, so a catalog published before gifts existed keeps its intent hash.
		...(gifts.length === 0 ? {} : { gifts }),
		...(retiredGiftKeys.length === 0 ? {} : { retiredGiftKeys }),
		...(defaultPlan === null
			? {}
			: {
					defaultPlan: {
						planKey: defaultPlan.planKey,
						entitlementKeys: defaultPlan.entitlementKeys ?? [],
					},
				}),
	};
}

function canonicalItem(item: CatalogPlanItemIntent): CanonicalPlanItem {
	const quantity = item.quantity ?? "0";
	switch (item.itemKind) {
		case "access":
			return { itemKind: "access", featureKey: item.featureKey };
		case "allocation":
			return {
				itemKind: "allocation",
				featureKey: item.featureKey,
				quantity,
				reset:
					item.resetInterval === null
						? null
						: { interval: item.resetInterval, intervalCount: item.resetIntervalCount ?? 1 },
				expiry: canonicalExpiry(item),
				allocationScope: item.allocationScope === "entity" ? "entity" : "account",
				rollover: item.rollover ?? null,
			};
		case "meter_limit":
			return {
				itemKind: "meter_limit",
				featureKey: item.featureKey,
				quantity,
				reset: {
					// Normalization refuses a meter limit without a reset.
					interval: item.resetInterval ?? "month",
					intervalCount: item.resetIntervalCount ?? 1,
				},
				overage:
					item.overagePolicy === "allowed" && item.price !== undefined && item.price !== null
						? { policy: "allowed", price: item.price }
						: { policy: "blocked" },
				allocationScope: item.allocationScope === "entity" ? "entity" : "account",
			};
		case "licensed_quantity":
			return {
				itemKind: "licensed_quantity",
				featureKey: item.featureKey,
				quantity,
				// Normalization refuses a licensed quantity without a price.
				price: item.price as CatalogPriceIntent,
				allocationScope: item.allocationScope === "license_pool" ? "license_pool" : "account",
			};
		case "unlimited_usage":
			return { itemKind: "unlimited_usage", featureKey: item.featureKey };
	}
}

/** The database working representation for a canonical catalog. */
export function workingFromCanonical(canonical: CanonicalCatalog): CatalogIntent {
	return toWorkingShape(canonical);
}

/** A binding must belong to exactly one of a plan's price blocks. */
export function assertAuthoredShape(authored: AuthoredCatalogIntent): void {
	for (const plan of authored.plans) {
		const identities = new Set((plan.basePrice?.providerBindings ?? []).map(bindingIdentity));
		const shared = plan.providerPriced?.providerBindings.find((binding) =>
			identities.has(bindingIdentity(binding)),
		);
		if (shared !== undefined) {
			throw new InvalidRequestError(
				`Plan ${plan.key} binds ${shared.provider}/${shared.channel}/${shared.productKey} in both basePrice and providerPriced`,
			);
		}
	}
}

/** The advisories for a canonical intent: each Stripe product a plan leaves to Stripe to price. */
export function catalogAdvisories(catalog: CanonicalCatalog): CatalogAdvisory[] {
	return catalog.plans.flatMap((plan, planIndex) =>
		(plan.providerPriced?.providerBindings ?? []).flatMap((binding, bindingIndex) =>
			binding.provider === "stripe"
				? [
						{
							path: `plans[${planIndex}].providerPriced.providerBindings[${bindingIndex}]`,
							message: stripeProviderPricedAdvisory,
						},
					]
				: [],
		),
	);
}
