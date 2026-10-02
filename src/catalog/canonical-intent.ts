import { InvalidRequestError } from "../billing/errors";
import { type CadenceUnit, sameCadence } from "../shared/cadence";
import type {
	AuthoredCatalogIntent,
	AuthoredPlanIntent,
	AuthoredPlanItemIntent,
	AuthoredTopupIntent,
	CanonicalCatalog,
	CanonicalPlan,
	CanonicalPlanItem,
	CanonicalTopup,
	CatalogAdvisory,
	CatalogDeprecation,
	CatalogExpiryIntent,
	CatalogIntent,
	CatalogPlanIntent,
	CatalogPlanItemIntent,
	CatalogPriceIntent,
	CatalogProviderBindingIntent,
	CatalogProviderPricedIntent,
	CatalogTopupIntent,
} from "./types";

/**
 * The canonical catalog intent (DEC-25) and its two neighbours. Operators author either spelling
 * during the transition; preview stores and hashes the canonical one; the control plane validates
 * and publishes from the normalized legacy-shaped working intent, rebuilt from the canonical one so
 * that what is stored is what is published.
 */

/** The advisory for a Stripe product whose price the Stripe dashboard owns. */
export const stripeProviderPricedAdvisory = "Use `basePrice` when Quotum should model the price.";

const legacyPlanFields = [
	"currency",
	"baseAmountMinor",
	"billingInterval",
	"billingIntervalCount",
	"providerBindings",
] as const;

const legacyItemFields = [
	"quantity",
	"resetInterval",
	"resetIntervalCount",
	"expiresAfterSeconds",
	"overagePolicy",
	"price",
	"allocationScope",
	"rollover",
] as const;

/** Whether an authored plan uses the legacy plan-level price fields. */
export function isLegacyPlan(plan: AuthoredPlanIntent): boolean {
	return legacyPlanFields.some((field) => plan[field] !== undefined);
}

/** Whether an authored item is spelled the legacy way; a canonical item never has these fields. */
export function isLegacyItem(item: AuthoredPlanItemIntent): item is CatalogPlanItemIntent {
	return "overagePolicy" in item || "resetInterval" in item || "expiresAfterSeconds" in item;
}

/** Whether an authored top-up uses the legacy `expiresAfterSeconds`. */
function isLegacyTopup(topup: AuthoredTopupIntent): boolean {
	return topup.expiresAfterSeconds !== undefined;
}

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

/** The one cadence every item price shares, or null when there is none or they differ. */
function sharedItemPriceCadence(prices: CatalogPriceIntent[]): Cadence | null {
	const [first, ...rest] = prices;
	if (first === undefined) return null;
	const cadence = { unit: first.billingInterval, count: first.billingIntervalCount ?? 1 };
	return rest.every((price) =>
		sameCadence(cadence, { unit: price.billingInterval, count: price.billingIntervalCount ?? 1 }),
	)
		? cadence
		: null;
}

/**
 * A plan's billing cadence: its base price's, its provider-priced block's, or, for a plan priced only
 * through its items (seats), the cadence they share. `plan_versions.billing_interval` comes from it.
 */
function planCadence(
	basePrice: CatalogPriceIntent | null,
	providerPriced: { billingInterval: Cadence["unit"] | null; billingIntervalCount?: number } | null,
	itemPrices: CatalogPriceIntent[],
): Cadence | null {
	if (basePrice !== null) {
		return { unit: basePrice.billingInterval, count: basePrice.billingIntervalCount ?? 1 };
	}
	if (providerPriced !== null && providerPriced.billingInterval !== null) {
		return {
			unit: providerPriced.billingInterval,
			count: providerPriced.billingIntervalCount ?? 1,
		};
	}
	return sharedItemPriceCadence(itemPrices);
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

/** The working (legacy-shaped) item for a canonical one. */
function workingItem(item: AuthoredPlanItemIntent): CatalogPlanItemIntent {
	if (isLegacyItem(item)) return item;
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
	}
}

function itemPrices(items: CatalogPlanItemIntent[]): CatalogPriceIntent[] {
	return items.flatMap((item) =>
		item.price === undefined || item.price === null ? [] : [item.price],
	);
}

/** Collects what a preview reports about the spelling it was given. */
export interface SpellingFindings {
	deprecations: CatalogDeprecation[];
}

/**
 * The legacy-shaped intent for an authored one, before normalization. Canonical plans, items and
 * top-ups are spelled the legacy way; legacy ones pass through and, when `findings` is given, are
 * reported as deprecations. Lenient: authoring rules are asserted separately.
 */
export function toWorkingShape(
	authored: AuthoredCatalogIntent,
	findings?: SpellingFindings,
): CatalogIntent {
	const plans = authored.plans.map((plan, index): CatalogPlanIntent => {
		const items = plan.items.map((item, itemIndex) => {
			if (findings !== undefined && isLegacyItem(item)) {
				findings.deprecations.push(itemDeprecation(`plans[${index}].items[${itemIndex}]`, item));
			}
			return workingItem(item);
		});
		const basePrice = plan.basePrice ?? null;
		if (isLegacyPlan(plan)) {
			if (findings !== undefined) {
				findings.deprecations.push(planDeprecation(`plans[${index}]`, plan));
			}
			return {
				...withoutCanonicalPlanFields(plan),
				trialDays: plan.trialDays ?? null,
				currency: plan.currency ?? null,
				baseAmountMinor: plan.baseAmountMinor ?? null,
				billingInterval: plan.billingInterval ?? null,
				...(plan.billingIntervalCount === undefined
					? {}
					: { billingIntervalCount: plan.billingIntervalCount }),
				basePrice,
				items,
				providerBindings: plan.providerBindings ?? [],
			};
		}
		const providerPriced = plan.providerPriced ?? null;
		const cadence = planCadence(basePrice, providerPriced, itemPrices(items));
		return {
			...withoutCanonicalPlanFields(plan),
			trialDays: plan.trialDays ?? null,
			// A plan's currency is its base price's: item prices carry their own, and a plan version
			// records a currency only with a base amount (`plan_versions_price_check`).
			currency: basePrice?.currency ?? null,
			baseAmountMinor: basePrice?.unitAmountMinor ?? null,
			billingInterval: cadence?.unit ?? null,
			billingIntervalCount: cadence?.count ?? null,
			basePrice,
			items,
			providerBindings: providerPriced?.providerBindings ?? [],
		};
	});
	const topups = authored.topups.map((topup, index): CatalogTopupIntent => {
		if (findings !== undefined && isLegacyTopup(topup)) {
			findings.deprecations.push({
				path: `topups[${index}]`,
				legacy: ["expiresAfterSeconds"],
				canonical: ["expiry"],
				message: "Use expiry instead of expiresAfterSeconds.",
			});
		}
		return {
			key: topup.key,
			featureKey: topup.featureKey,
			quantity: topup.quantity,
			...(isLegacyTopup(topup)
				? {
						expiresAfterSeconds: topup.expiresAfterSeconds ?? null,
						expiryInterval: null,
						expiryIntervalCount: null,
					}
				: workingExpiry(topup.expiry)),
			providerBindings: topup.providerBindings,
		};
	});
	return {
		features: authored.features,
		plans,
		topups,
		rateCards: authored.rateCards,
		...(authored.retiredFeatureKeys === undefined
			? {}
			: { retiredFeatureKeys: authored.retiredFeatureKeys }),
		...(authored.retiredPlanKeys === undefined
			? {}
			: { retiredPlanKeys: authored.retiredPlanKeys }),
		...(authored.retiredTopupKeys === undefined
			? {}
			: { retiredTopupKeys: authored.retiredTopupKeys }),
		...(authored.defaultPlan === undefined ? {} : { defaultPlan: authored.defaultPlan }),
	};
}

function withoutCanonicalPlanFields(
	plan: AuthoredPlanIntent,
): Omit<
	CatalogPlanIntent,
	| "currency"
	| "baseAmountMinor"
	| "billingInterval"
	| "billingIntervalCount"
	| "trialDays"
	| "basePrice"
	| "items"
	| "providerBindings"
> {
	const {
		providerPriced: _providerPriced,
		currency: _currency,
		baseAmountMinor: _baseAmountMinor,
		billingInterval: _billingInterval,
		billingIntervalCount: _billingIntervalCount,
		trialDays: _trialDays,
		basePrice: _basePrice,
		items: _items,
		providerBindings: _providerBindings,
		...rest
	} = plan;
	return rest;
}

function planDeprecation(path: string, plan: AuthoredPlanIntent): CatalogDeprecation {
	const legacy = legacyPlanFields.filter((field) => plan[field] !== undefined);
	const basePrice = plan.basePrice ?? null;
	const bindings = plan.providerBindings ?? [];
	const priceIdentities = new Set((basePrice?.providerBindings ?? []).map(bindingIdentity));
	const remainder = bindings.filter((binding) => !priceIdentities.has(bindingIdentity(binding)));
	const canonical = [
		...(basePrice === null ? [] : ["basePrice"]),
		...(remainder.length === 0 ? [] : ["providerPriced"]),
	];
	const dropped =
		basePrice === null
			? [
					...((plan.baseAmountMinor ?? null) === null ? [] : ["baseAmountMinor"]),
					...((plan.currency ?? null) === null ? [] : ["currency"]),
					...(bindings.length === 0 && (plan.billingInterval ?? null) !== null
						? ["billingInterval"]
						: []),
				]
			: [];
	const droppedReason =
		bindings.length > 0
			? "the provider owns this plan's price"
			: "the plan has no price or provider binding";
	return {
		path,
		legacy,
		canonical,
		message: [
			"Plan-level price fields are legacy syntax; use basePrice for a price Quotum models and providerPriced for products a provider prices.",
			...(dropped.length === 0 ? [] : [`${dropped.join(" and ")} dropped: ${droppedReason}.`]),
		].join(" "),
	};
}

function itemDeprecation(path: string, item: CatalogPlanItemIntent): CatalogDeprecation {
	const legacy = legacyItemFields.filter((field) => item[field] !== undefined);
	const canonical =
		item.itemKind === "access"
			? []
			: item.itemKind === "allocation"
				? ["quantity", "reset", "expiry", "allocationScope", "rollover"]
				: item.itemKind === "meter_limit"
					? ["quantity", "reset", "overage", "allocationScope"]
					: ["quantity", "price", "allocationScope"];
	return {
		path,
		legacy,
		canonical,
		message:
			canonical.length === 0
				? "An access item takes only itemKind and featureKey."
				: `Use the canonical ${item.itemKind} item: ${canonical.join(", ")}.`,
	};
}

/**
 * The canonical intent for a normalized working one. Lenient by design: it also reads intents
 * stored before a rule existed, so it never refuses; fields the runtime never reads for an item
 * kind (an expiry on a meter limit, a price on an allocation or on a blocked limit) are dropped.
 */
export function canonicalFromWorking(working: CatalogIntent): CanonicalCatalog {
	const plans = working.plans.map((plan): CanonicalPlan => {
		const basePrice = plan.basePrice ?? null;
		const priceIdentities = new Set((basePrice?.providerBindings ?? []).map(bindingIdentity));
		const remainder = sortedBindings(
			plan.providerBindings.filter((binding) => !priceIdentities.has(bindingIdentity(binding))),
		);
		const providerPriced: CatalogProviderPricedIntent | null =
			remainder.length === 0
				? null
				: {
						billingInterval: plan.billingInterval,
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
	return {
		features: working.features,
		plans,
		topups,
		rateCards: working.rateCards,
		retiredFeatureKeys: working.retiredFeatureKeys ?? [],
		retiredPlanKeys: working.retiredPlanKeys ?? [],
		retiredTopupKeys: working.retiredTopupKeys ?? [],
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
				rollover:
					item.rollover === undefined || item.rollover === null
						? null
						: {
								maxQuantity: item.rollover.maxQuantity,
								// Normalization has already respelled `months` as `after`.
								expiry:
									item.rollover.expiry.mode === "after"
										? item.rollover.expiry
										: item.rollover.expiry.mode === "months"
											? {
													mode: "after",
													interval: "month",
													intervalCount: item.rollover.expiry.months,
												}
											: { mode: "forever" },
							},
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
	}
}

/**
 * The working (legacy-shaped) intent for a canonical one: what validation and publishing read. The
 * plan's product bindings are the union of both price blocks' bindings, and its billing cadence is
 * its base price's, its provider-priced block's, or the one its item prices share.
 */
export function workingFromCanonical(canonical: CanonicalCatalog): CatalogIntent {
	// A canonical intent is an authored one, except that a decoded legacy plan may carry a
	// provider-priced block without a billing interval, which the conversion already tolerates.
	const working = toWorkingShape(canonical as unknown as AuthoredCatalogIntent);
	return {
		...working,
		plans: working.plans.map((plan, index) => {
			const source = canonical.plans[index];
			return {
				...plan,
				providerBindings: unionBindings(
					source?.basePrice?.providerBindings ?? [],
					source?.providerPriced?.providerBindings ?? [],
				),
			};
		}),
	};
}

/**
 * The authoring rules of the canonical spelling, on a new intent only: a plan spells its price one
 * way, its two price blocks bill on one cadence and share no binding, an access item carries
 * nothing but its feature, a provider-priced plan has a billing interval, and a top-up states its
 * expiry once.
 */
export function assertAuthoredShape(authored: AuthoredCatalogIntent): void {
	for (const plan of authored.plans) {
		const label = `Plan ${plan.key}`;
		const providerPriced = plan.providerPriced ?? null;
		if (isLegacyPlan(plan) && plan.providerPriced !== undefined) {
			throw new InvalidRequestError(
				`${label} cannot combine providerPriced with the legacy plan-level price fields`,
			);
		}
		const basePrice = plan.basePrice ?? null;
		if (providerPriced !== null && basePrice !== null) {
			const priced = {
				unit: basePrice.billingInterval,
				count: basePrice.billingIntervalCount ?? 1,
			};
			const provided = {
				unit: providerPriced.billingInterval,
				count: providerPriced.billingIntervalCount ?? 1,
			};
			if (!sameCadence(priced, provided)) {
				throw new InvalidRequestError(`${label} price intervals must match`);
			}
			const priceIdentities = new Set(basePrice.providerBindings.map(bindingIdentity));
			const shared = providerPriced.providerBindings.find((binding) =>
				priceIdentities.has(bindingIdentity(binding)),
			);
			if (shared !== undefined) {
				throw new InvalidRequestError(
					`${label} binds ${shared.provider}/${shared.channel}/${shared.productKey} in both basePrice and providerPriced`,
				);
			}
		}
		if (
			isLegacyPlan(plan) &&
			basePrice === null &&
			(plan.providerBindings ?? []).length > 0 &&
			(plan.billingInterval ?? null) === null
		) {
			throw new InvalidRequestError(
				`${label} provider bindings without a basePrice require a billingInterval: the provider prices them on a cadence`,
			);
		}
		for (const item of plan.items) {
			if (!isLegacyItem(item) || item.itemKind !== "access") continue;
			if (
				item.quantity !== null ||
				item.resetInterval !== null ||
				item.expiresAfterSeconds !== null ||
				item.overagePolicy !== "blocked"
			) {
				throw new InvalidRequestError(
					`Access item ${item.featureKey} cannot declare a quantity, reset, expiry or overage`,
				);
			}
		}
	}
	for (const topup of authored.topups) {
		if (topup.expiry !== undefined && topup.expiresAfterSeconds !== undefined) {
			throw new InvalidRequestError(
				`Top-up ${topup.key} sets both expiry and expiresAfterSeconds; use expiry`,
			);
		}
	}
}

/**
 * The legacy price fields as submitted, for the PC-09 comparison with `basePrice`: plans authored
 * in the canonical spelling carry none, so only legacy-spelled plans are compared.
 */
export function legacyPriceView(
	authored: AuthoredCatalogIntent,
	submitted: CatalogIntent,
): CatalogIntent {
	return {
		...submitted,
		plans: submitted.plans.map((plan, index) => {
			const source = authored.plans[index];
			return source !== undefined && isLegacyPlan(source)
				? plan
				: {
						...plan,
						currency: null,
						baseAmountMinor: null,
						billingInterval: null,
						billingIntervalCount: null,
						providerBindings: [],
					};
		}),
	};
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
