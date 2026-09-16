import type { ProjectInstanceContext } from "../projects/context";
import { canonicalDecimal, positiveDecimal, sha256Hex, stableJson } from "./decimal";
import { BillingError } from "./errors";

export const promotionChannels = ["web", "ios", "android"] as const;
export type PromotionChannel = (typeof promotionChannels)[number];
export type PromotionEffectKind = "discount" | "feature_grant" | "plan_grant";
export type PromotionStatus = "active" | "archived";
export type PromotionDiscountDuration = "once" | "repeating" | "forever";
export type PromotionRedemptionStatus = "reserved" | "applied" | "released" | "reversed";
export type PromotionRedemptionProvider = "quotum" | "stripe" | "apple" | "google";
export type PromotionRedemptionSource =
	| "api_redeem"
	| "commercial_action"
	| "stripe_hosted_checkout"
	| "apple_offer"
	| "google_offer";
export type PromotionLimitViolation =
	| "global"
	| "first_purchase"
	| "not_applicable"
	| "inactive"
	| "expired";

export const PROMOTION_CODE_PATTERN = /^[A-Za-z0-9-]{3,64}$/;
const PROMOTION_KEY_MAX = 120;
const MAX_CODES_PER_REQUEST = 100;
const MAX_TARGETS = 50;
const MAX_GRANT_ITEMS = 20;
const MAX_CURRENCIES = 20;

export type PromotionDiscount =
	| {
			type: "percent";
			percentOffBps: number;
			duration: PromotionDiscountDuration;
			durationMonths: number | null;
	  }
	| {
			type: "amount";
			amounts: Array<{ currency: string; amountOffMinor: number }>;
			duration: PromotionDiscountDuration;
			durationMonths: number | null;
	  };

export interface PromotionGrantItem {
	featureKey: string;
	quantity: string;
	expiresAfterSeconds: number | null;
}

export type PromotionEffect =
	| { kind: "discount"; discount: PromotionDiscount }
	| { kind: "feature_grant"; items: PromotionGrantItem[] }
	| {
			kind: "plan_grant";
			planKey: string;
			durationUnit: "day" | "month";
			durationCount: number;
	  };

export type PromotionTarget = { kind: "plan"; key: string } | { kind: "product"; key: string };

export interface PromotionCodeInput {
	code: string;
	startsAt?: string | null;
	expiresAt?: string | null;
	maxRedemptions?: number | null;
	/** Omitted means one per customer; `null` means unlimited. Hosted codes must leave it unset. */
	maxRedemptionsPerCustomer?: number | null;
	firstPurchaseOnly?: boolean;
	billingAccountId?: string | null;
	hostedCheckoutEnabled?: boolean;
}

export interface CreatePromotionInput {
	key: string;
	name: string;
	effect: PromotionEffect;
	targets?: PromotionTarget[];
	allowedChannels?: PromotionChannel[];
	metadata?: Record<string, unknown>;
	codes?: PromotionCodeInput[];
	actor: string;
}

export interface NormalizedPromotionCode {
	code: string;
	normalizedCode: string;
	startsAt: string | null;
	expiresAt: string | null;
	maxRedemptions: number | null;
	maxRedemptionsPerCustomer: number | null;
	firstPurchaseOnly: boolean;
	billingAccountId: string | null;
	hostedCheckoutEnabled: boolean;
}

export interface NormalizedPromotion {
	key: string;
	name: string;
	effect: PromotionEffect;
	targets: PromotionTarget[];
	allowedChannels: PromotionChannel[];
	metadata: Record<string, unknown>;
	termsHash: string;
	codes: NormalizedPromotionCode[];
	actor: string;
}

export interface PromotionRecord {
	id: string;
	key: string;
	name: string;
	status: PromotionStatus;
	effect: PromotionEffect;
	targets: PromotionTarget[];
	allowedChannels: PromotionChannel[];
	metadata: Record<string, unknown>;
	termsHash: string;
	createdBy: string;
	createdAt: string;
	archivedBy: string | null;
	archivedAt: string | null;
	codeCounts: { total: number; active: number };
	redemptionCounts: Record<PromotionRedemptionStatus, number>;
	providerObjects: PromotionProviderObjectRecord[];
}

export type PromotionProviderObjectKind =
	| "coupon"
	| "promotion_code"
	| "apple_promotional_offer"
	| "apple_offer_code"
	| "google_developer_offer"
	| "google_promo_code";
export type PromotionProviderObjectStatus = "pending" | "ready" | "failed" | "retired";

export interface PromotionProviderObjectRecord {
	id: string;
	provider: "stripe" | "apple" | "google";
	objectKind: PromotionProviderObjectKind;
	promotionCodeId: string | null;
	externalId: string | null;
	status: PromotionProviderObjectStatus;
	desiredActive: boolean;
	providerActive: boolean | null;
	error: string | null;
	attempts: number;
	updatedAt: string;
}

/** One claimed Stripe object with everything the provider call needs; no further reads required. */
export type PromotionStripeSyncJob = {
	projectId: string;
	projectKey: string;
	objectId: string;
	promotionKey: string;
	promotionName: string;
	status: PromotionProviderObjectStatus;
	externalId: string | null;
	desiredActive: boolean;
	desiredGeneration: number;
	providerActive: boolean | null;
	retireRequested: boolean;
	attempts: number;
} & (
	| {
			objectKind: "coupon";
			discount: PromotionDiscount;
			appliesToProducts: string[] | null;
	  }
	| {
			objectKind: "promotion_code";
			code: string;
			couponExternalId: string;
			expiresAt: string | null;
			maxRedemptions: number | null;
			firstPurchaseOnly: boolean;
	  }
);

export type PromotionStripeSyncOutcome =
	| { kind: "ready"; externalId: string; providerActive: boolean }
	| { kind: "retired"; externalId: string | null }
	| { kind: "failed"; error: string; terminal: boolean };

export interface PromotionCodeRecord {
	id: string;
	promotionKey: string;
	code: string;
	active: boolean;
	startsAt: string | null;
	expiresAt: string | null;
	maxRedemptions: number | null;
	maxRedemptionsPerCustomer: number | null;
	firstPurchaseOnly: boolean;
	billingAccountId: string | null;
	hostedCheckoutEnabled: boolean;
	redeemedCount: number;
	reservedCount: number;
	createdBy: string;
	createdAt: string;
	deactivatedBy: string | null;
	deactivatedAt: string | null;
}

export interface PromotionRedemptionRecord {
	id: string;
	promotionKey: string;
	promotionCodeId: string | null;
	code: string | null;
	billingAccountId: string;
	channel: PromotionChannel;
	status: PromotionRedemptionStatus;
	provider: PromotionRedemptionProvider;
	source: PromotionRedemptionSource;
	stripeCheckoutSessionId: string | null;
	externalSubscriptionId: string | null;
	currency: string | null;
	amountSubtotalMinor: number | null;
	amountDiscountMinor: number | null;
	amountTotalMinor: number | null;
	limitViolation: PromotionLimitViolation | null;
	actor: string;
	reason: string | null;
	reservedUntil: string | null;
	appliedAt: string | null;
	releasedAt: string | null;
	reversedAt: string | null;
	createdAt: string;
}

export interface PromotionListResult<T> {
	items: T[];
	nextCursor: string | null;
}

export interface PromotionValidationInput {
	billingAccountId: string;
	code: string;
	channel: PromotionChannel;
	target?: PromotionTarget | null;
}

export interface PromotionValidation {
	valid: boolean;
	reason: PromotionErrorCode | null;
	promotion: {
		key: string;
		name: string;
		effectKind: PromotionEffectKind;
		allowedChannels: PromotionChannel[];
	} | null;
	code: {
		id: string;
		code: string;
		expiresAt: string | null;
		hostedCheckoutEnabled: boolean;
	} | null;
}

/** Operator management and read-only validation, as the HTTP routes use them. */
export interface PromotionServiceLike {
	createPromotion(
		project: ProjectInstanceContext,
		input: CreatePromotionInput,
	): Promise<{ promotion: PromotionRecord; created: boolean }>;
	getPromotion(project: ProjectInstanceContext, key: string): Promise<PromotionRecord>;
	listPromotions(
		project: ProjectInstanceContext,
		input: { limit: number; cursor?: string | null; status?: PromotionStatus | null },
	): Promise<PromotionListResult<PromotionRecord>>;
	archivePromotion(
		project: ProjectInstanceContext,
		key: string,
		actor: string,
	): Promise<PromotionRecord>;
	addPromotionCodes(
		project: ProjectInstanceContext,
		key: string,
		codes: readonly PromotionCodeInput[],
		actor: string,
	): Promise<{ codes: PromotionCodeRecord[]; created: number }>;
	listPromotionCodes(
		project: ProjectInstanceContext,
		key: string,
		input: { limit: number; cursor?: string | null; active?: boolean | null },
	): Promise<PromotionListResult<PromotionCodeRecord>>;
	deactivatePromotionCode(
		project: ProjectInstanceContext,
		key: string,
		codeId: string,
		actor: string,
	): Promise<PromotionCodeRecord>;
	listPromotionRedemptions(
		project: ProjectInstanceContext,
		key: string,
		input: {
			limit: number;
			cursor?: string | null;
			status?: PromotionRedemptionStatus | null;
			billingAccountId?: string | null;
		},
	): Promise<PromotionListResult<PromotionRedemptionRecord>>;
	validatePromotionCode(
		project: ProjectInstanceContext,
		input: PromotionValidationInput,
	): Promise<PromotionValidation>;
	requestPromotionProviderSync(
		project: ProjectInstanceContext,
		key: string,
		actor: string,
	): Promise<PromotionRecord>;
}

/** The mutable state that decides whether a code can be used right now. */
export interface PromotionCodeAvailability {
	promotionStatus: PromotionStatus;
	allowedChannels: readonly PromotionChannel[];
	active: boolean;
	startsAt: Date | null;
	expiresAt: Date | null;
	billingAccountId: string | null;
	maxRedemptions: number | null;
	redeemedCount: number;
	reservedCount: number;
}

// Each entry declares `code` literally so the wire error registry inventories it.
const promotionErrorDefinitions = [
	{ code: "PROMOTION_NOT_FOUND", status: 404, message: "Promotion was not found" },
	{
		code: "PROMOTION_KEY_CONFLICT",
		status: 409,
		message: "A promotion with this key already exists with different terms",
	},
	{ code: "PROMOTION_ARCHIVED", status: 409, message: "Promotion is archived" },
	{ code: "PROMOTION_TERMS_INVALID", status: 400, message: "Promotion terms are invalid" },
	{ code: "PROMOTION_TARGET_NOT_FOUND", status: 400, message: "Promotion target was not found" },
	{
		code: "PROMOTION_HOSTED_CHECKOUT_UNSUPPORTED",
		status: 400,
		message:
			"Hosted Checkout entry requires a web discount code without a per-customer limit or account restriction",
	},
	{
		code: "PROMOTION_CODE_INVALID_FORMAT",
		status: 400,
		message: "Promotion codes use 3 to 64 letters, digits or hyphens",
	},
	{
		code: "PROMOTION_CODE_CONFLICT",
		status: 409,
		message: "Promotion code already exists with different settings",
	},
	{ code: "PROMOTION_CODE_NOT_FOUND", status: 404, message: "Promotion code was not found" },
	{ code: "PROMOTION_CODE_INACTIVE", status: 409, message: "Promotion code is not active" },
	{ code: "PROMOTION_CODE_NOT_STARTED", status: 409, message: "Promotion code is not yet valid" },
	{ code: "PROMOTION_CODE_EXPIRED", status: 409, message: "Promotion code has expired" },
	{
		code: "PROMOTION_CODE_EXHAUSTED",
		status: 409,
		message: "Promotion code has reached its redemption limit",
	},
	{
		code: "PROMOTION_CODE_ALREADY_REDEEMED",
		status: 409,
		message: "Promotion code was already redeemed by this billing account",
	},
	{
		code: "PROMOTION_CODE_FIRST_PURCHASE_ONLY",
		status: 409,
		message: "Promotion code is limited to a first purchase",
	},
	{
		code: "PROMOTION_CODE_NOT_APPLICABLE",
		status: 409,
		message: "Promotion code does not apply to this purchase",
	},
	{
		code: "PROMOTION_CODE_CHANNEL_NOT_SUPPORTED",
		status: 409,
		message: "Promotion code cannot be redeemed on this channel",
	},
	{
		code: "PROMOTION_CODE_ENTRY_CONFLICT",
		status: 400,
		message: "Send either promotionCode or allowPromotionCodes, not both",
	},
	{
		code: "PROMOTION_STACKING_NOT_ALLOWED",
		status: 409,
		message: "The subscription already has an active promotion discount",
	},
	{
		code: "PROMOTION_CURRENCY_NOT_SUPPORTED",
		status: 409,
		message: "Promotion has no discount amount in this currency",
	},
	{
		code: "PROMOTION_PROVIDER_NOT_READY",
		status: 503,
		message: "The provider discount for this promotion is not ready yet",
	},
	{
		code: "PROMOTION_REDEMPTION_NOT_FOUND",
		status: 404,
		message: "Promotion redemption was not found",
	},
] as const;

export type PromotionErrorCode = (typeof promotionErrorDefinitions)[number]["code"];

export function promotionError(code: PromotionErrorCode, message?: string): BillingError {
	const definition = promotionErrorDefinitions.find((candidate) => candidate.code === code);
	return new BillingError(
		message ?? definition?.message ?? "Promotion request failed",
		code,
		definition?.status ?? 400,
	);
}

export function normalizePromotionCode(value: string): string {
	const trimmed = value.trim();
	if (!PROMOTION_CODE_PATTERN.test(trimmed)) {
		throw promotionError("PROMOTION_CODE_INVALID_FORMAT");
	}
	return trimmed.toUpperCase();
}

export function normalizeCreatePromotionInput(input: CreatePromotionInput): NormalizedPromotion {
	const key = requiredText(input.key, "key", PROMOTION_KEY_MAX);
	const name = requiredText(input.name, "name", 200);
	const actor = requiredText(input.actor, "actor", 200);
	const effect = normalizeEffect(input.effect);
	const targets = normalizeTargets(input.targets ?? [], effect.kind);
	const allowedChannels = normalizeChannels(input.allowedChannels);
	const metadata = input.metadata ?? {};
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
		throw invalidTerms("metadata must be an object");
	}
	const codes = normalizePromotionCodes(input.codes ?? [], { effect, allowedChannels });
	const termsHash = sha256Hex(
		stableJson({ key, name, effect, targets, allowedChannels, metadata }),
	);
	return { key, name, effect, targets, allowedChannels, metadata, termsHash, codes, actor };
}

export function normalizePromotionCodes(
	codes: readonly PromotionCodeInput[],
	promotion: { effect: PromotionEffect; allowedChannels: readonly PromotionChannel[] },
): NormalizedPromotionCode[] {
	if (codes.length > MAX_CODES_PER_REQUEST) {
		throw invalidTerms(`at most ${MAX_CODES_PER_REQUEST} codes can be added at once`);
	}
	const seen = new Set<string>();
	return codes.map((input) => {
		const normalizedCode = normalizePromotionCode(input.code);
		if (seen.has(normalizedCode)) {
			throw promotionError(
				"PROMOTION_CODE_CONFLICT",
				`Promotion code ${input.code.trim()} is repeated in the request`,
			);
		}
		seen.add(normalizedCode);
		const hostedCheckoutEnabled = input.hostedCheckoutEnabled === true;
		const billingAccountId =
			input.billingAccountId === undefined || input.billingAccountId === null
				? null
				: requiredText(input.billingAccountId, "billingAccountId", 200);
		const maxRedemptionsPerCustomer =
			input.maxRedemptionsPerCustomer === undefined
				? hostedCheckoutEnabled
					? null
					: 1
				: optionalPositiveInteger(input.maxRedemptionsPerCustomer, "maxRedemptionsPerCustomer");
		if (
			hostedCheckoutEnabled &&
			(promotion.effect.kind !== "discount" ||
				!promotion.allowedChannels.includes("web") ||
				billingAccountId !== null ||
				maxRedemptionsPerCustomer !== null)
		) {
			throw promotionError("PROMOTION_HOSTED_CHECKOUT_UNSUPPORTED");
		}
		const startsAt = optionalTimestamp(input.startsAt, "startsAt");
		const expiresAt = optionalTimestamp(input.expiresAt, "expiresAt");
		if (startsAt !== null && expiresAt !== null && Date.parse(expiresAt) <= Date.parse(startsAt)) {
			throw invalidTerms("expiresAt must be after startsAt");
		}
		return {
			code: input.code.trim(),
			normalizedCode,
			startsAt,
			expiresAt,
			maxRedemptions: optionalPositiveInteger(input.maxRedemptions, "maxRedemptions"),
			maxRedemptionsPerCustomer,
			firstPurchaseOnly: input.firstPurchaseOnly === true,
			billingAccountId,
			hostedCheckoutEnabled,
		};
	});
}

/**
 * Returns why a code cannot be used by this billing account on this channel, or null when the code
 * itself is usable. Counters are advisory here; the reservation enforces the cap atomically.
 */
export function promotionCodeUnavailability(
	state: PromotionCodeAvailability,
	context: { now: Date; billingAccountId: string; channel: PromotionChannel },
): PromotionErrorCode | null {
	if (state.billingAccountId !== null && state.billingAccountId !== context.billingAccountId) {
		return "PROMOTION_CODE_NOT_FOUND";
	}
	if (!state.active || state.promotionStatus !== "active") {
		return "PROMOTION_CODE_INACTIVE";
	}
	if (state.startsAt !== null && state.startsAt.getTime() > context.now.getTime()) {
		return "PROMOTION_CODE_NOT_STARTED";
	}
	if (state.expiresAt !== null && state.expiresAt.getTime() <= context.now.getTime()) {
		return "PROMOTION_CODE_EXPIRED";
	}
	if (!state.allowedChannels.includes(context.channel)) {
		return "PROMOTION_CODE_CHANNEL_NOT_SUPPORTED";
	}
	if (
		state.maxRedemptions !== null &&
		state.redeemedCount + state.reservedCount >= state.maxRedemptions
	) {
		return "PROMOTION_CODE_EXHAUSTED";
	}
	return null;
}

function normalizeEffect(effect: PromotionEffect): PromotionEffect {
	switch (effect.kind) {
		case "discount":
			return { kind: "discount", discount: normalizeDiscount(effect.discount) };
		case "feature_grant": {
			if (effect.items.length === 0 || effect.items.length > MAX_GRANT_ITEMS) {
				throw invalidTerms(`feature grants need 1 to ${MAX_GRANT_ITEMS} items`);
			}
			const items = effect.items
				.map((item) => ({
					featureKey: requiredText(item.featureKey, "featureKey", 120),
					quantity: grantQuantity(item.quantity),
					expiresAfterSeconds: optionalPositiveInteger(
						item.expiresAfterSeconds,
						"expiresAfterSeconds",
					),
				}))
				.sort((left, right) => compareText(left.featureKey, right.featureKey));
			if (new Set(items.map((item) => item.featureKey)).size !== items.length) {
				throw invalidTerms("feature grant items must use distinct features");
			}
			return { kind: "feature_grant", items };
		}
		case "plan_grant": {
			const durationCount = requiredPositiveInteger(effect.durationCount, "durationCount");
			if (effect.durationUnit !== "day" && effect.durationUnit !== "month") {
				throw invalidTerms("durationUnit must be day or month");
			}
			if (
				(effect.durationUnit === "day" && durationCount > 730) ||
				(effect.durationUnit === "month" && durationCount > 24)
			) {
				throw invalidTerms("plan grants last at most 730 days or 24 months");
			}
			return {
				kind: "plan_grant",
				planKey: requiredText(effect.planKey, "planKey", 120),
				durationUnit: effect.durationUnit,
				durationCount,
			};
		}
		default:
			throw invalidTerms("effect kind is not supported");
	}
}

function grantQuantity(value: string): string {
	try {
		return positiveDecimal(value, "quantity");
	} catch (error) {
		throw invalidTerms(error instanceof Error ? error.message : "quantity is invalid");
	}
}

function normalizeDiscount(discount: PromotionDiscount): PromotionDiscount {
	const duration = discount.duration;
	if (duration !== "once" && duration !== "repeating" && duration !== "forever") {
		throw invalidTerms("duration must be once, repeating or forever");
	}
	const durationMonths =
		duration === "repeating"
			? requiredPositiveInteger(discount.durationMonths, "durationMonths")
			: discount.durationMonths === undefined || discount.durationMonths === null
				? null
				: (() => {
						throw invalidTerms("durationMonths is only allowed for repeating discounts");
					})();
	if (durationMonths !== null && durationMonths > 36) {
		throw invalidTerms("durationMonths must be at most 36");
	}
	if (discount.type === "percent") {
		const percentOffBps = requiredPositiveInteger(discount.percentOffBps, "percentOffBps");
		if (percentOffBps > 10_000) {
			throw invalidTerms("percentOffBps must be at most 10000");
		}
		return { type: "percent", percentOffBps, duration, durationMonths };
	}
	if (discount.type !== "amount") {
		throw invalidTerms("discount type must be percent or amount");
	}
	if (discount.amounts.length === 0 || discount.amounts.length > MAX_CURRENCIES) {
		throw invalidTerms(`amount discounts need 1 to ${MAX_CURRENCIES} currencies`);
	}
	const amounts = discount.amounts
		.map((amount) => {
			const currency = amount.currency.trim().toUpperCase();
			if (!/^[A-Z]{3}$/.test(currency)) {
				throw invalidTerms("currency must be a three-letter code");
			}
			return {
				currency,
				amountOffMinor: requiredPositiveInteger(amount.amountOffMinor, "amountOffMinor"),
			};
		})
		.sort((left, right) => compareText(left.currency, right.currency));
	if (new Set(amounts.map((amount) => amount.currency)).size !== amounts.length) {
		throw invalidTerms("amount discounts must use distinct currencies");
	}
	return { type: "amount", amounts, duration, durationMonths };
}

function normalizeTargets(
	targets: readonly PromotionTarget[],
	effectKind: PromotionEffectKind,
): PromotionTarget[] {
	if (targets.length > 0 && effectKind !== "discount") {
		throw invalidTerms("only discount promotions can declare targets");
	}
	if (targets.length > MAX_TARGETS) {
		throw invalidTerms(`at most ${MAX_TARGETS} targets are allowed`);
	}
	const normalized = targets
		.map((target) => {
			if (target.kind !== "plan" && target.kind !== "product") {
				throw invalidTerms("target kind must be plan or product");
			}
			return { kind: target.kind, key: requiredText(target.key, "target key", 120) };
		})
		.sort((left, right) => compareText(left.kind, right.kind) || compareText(left.key, right.key));
	const identities = normalized.map((target) => `${target.kind}:${target.key}`);
	if (new Set(identities).size !== identities.length) {
		throw invalidTerms("targets must be distinct");
	}
	return normalized;
}

function normalizeChannels(channels: readonly PromotionChannel[] | undefined): PromotionChannel[] {
	if (channels === undefined) {
		return [...promotionChannels];
	}
	if (channels.length === 0) {
		throw invalidTerms("allowedChannels needs at least one channel");
	}
	for (const channel of channels) {
		if (!promotionChannels.includes(channel)) {
			throw invalidTerms("allowedChannels only accepts web, ios and android");
		}
	}
	return promotionChannels.filter((channel) => channels.includes(channel));
}

function requiredText(value: string, field: string, max: number): string {
	const trimmed = typeof value === "string" ? value.trim() : "";
	if (trimmed.length === 0 || trimmed.length > max) {
		throw invalidTerms(`${field} must be 1 to ${max} characters`);
	}
	return trimmed;
}

function requiredPositiveInteger(value: number | null | undefined, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw invalidTerms(`${field} must be a positive integer`);
	}
	return value;
}

function optionalPositiveInteger(value: number | null | undefined, field: string): number | null {
	return value === undefined || value === null ? null : requiredPositiveInteger(value, field);
}

function optionalTimestamp(value: string | null | undefined, field: string): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	const parsed = Date.parse(value);
	if (Number.isNaN(parsed)) {
		throw invalidTerms(`${field} must be an ISO timestamp`);
	}
	return new Date(parsed).toISOString();
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function invalidTerms(detail: string): BillingError {
	return promotionError("PROMOTION_TERMS_INVALID", `Promotion terms are invalid: ${detail}`);
}

/** Canonical decimal for a grant quantity read back from NUMERIC(28, 9). */
export function promotionQuantity(value: string): string {
	return canonicalDecimal(value, "quantity");
}

/** A validated discount code for a commercial action, with the state its preview is bound to. */
export interface CommercialPromotion {
	promotionId: string;
	promotionKey: string;
	promotionName: string;
	promotionCodeId: string;
	code: string;
	hostedCheckoutEnabled: boolean;
	discount: PromotionDiscount;
	/** Terms and code state that must not change between preview and execution; not counters. */
	fingerprint: Record<string, unknown>;
}

export interface DiscountedLines {
	lineDiscountsMinor: Array<number | null>;
	discountTotalMinor: number | null;
}

/**
 * Discounts line subtotals the way Stripe does for one coupon: a percentage rounds half up per line;
 * a fixed amount is capped at the subtotal and split across lines in proportion to their subtotals,
 * handing leftover minor units to the largest remainders, lower index first on ties.
 */
export function applyDiscountToLines(
	subtotalsMinor: ReadonlyArray<number | null>,
	discount: PromotionDiscount,
	currency: string | null,
): DiscountedLines {
	if (subtotalsMinor.some((subtotal) => subtotal === null)) {
		return { lineDiscountsMinor: subtotalsMinor.map(() => null), discountTotalMinor: null };
	}
	const subtotals = subtotalsMinor.map((subtotal) => BigInt(subtotal ?? 0));
	let discounts: bigint[];
	if (discount.type === "percent") {
		const bps = BigInt(discount.percentOffBps);
		discounts = subtotals.map((subtotal) => (subtotal * bps + 5_000n) / 10_000n);
	} else {
		const amount = discountAmountFor(discount, currency);
		const total = subtotals.reduce((sum, subtotal) => sum + subtotal, 0n);
		const capped = BigInt(amount) < total ? BigInt(amount) : total;
		if (total === 0n) {
			discounts = subtotals.map(() => 0n);
		} else {
			discounts = subtotals.map((subtotal) => (capped * subtotal) / total);
			let leftover = capped - discounts.reduce((sum, value) => sum + value, 0n);
			const order = subtotals
				.map((subtotal, index) => ({ index, remainder: (capped * subtotal) % total }))
				.sort((left, right) =>
					left.remainder === right.remainder
						? left.index - right.index
						: left.remainder > right.remainder
							? -1
							: 1,
				);
			for (const { index } of order) {
				if (leftover === 0n) break;
				discounts[index] = (discounts[index] ?? 0n) + 1n;
				leftover -= 1n;
			}
		}
	}
	const lineDiscountsMinor = discounts.map((value) => Number(value));
	return {
		lineDiscountsMinor,
		discountTotalMinor: lineDiscountsMinor.reduce((sum, value) => sum + value, 0),
	};
}

export function discountAmountFor(discount: PromotionDiscount, currency: string | null): number {
	if (discount.type !== "amount") {
		throw new Error("Only fixed discounts have currency amounts");
	}
	const match = discount.amounts.find(
		(amount) => currency !== null && amount.currency === currency.toUpperCase(),
	);
	if (match === undefined) {
		throw promotionError("PROMOTION_CURRENCY_NOT_SUPPORTED");
	}
	return match.amountOffMinor;
}

/** Whether a recurring discount still applies on the invoice after the first billing interval. */
export function discountAppliesNextCycle(
	discount: PromotionDiscount,
	interval: "month" | "year",
): boolean {
	if (discount.duration === "forever") return true;
	if (discount.duration === "once") return false;
	return (discount.durationMonths ?? 0) > (interval === "year" ? 12 : 1);
}

/** Discount facts from a completed Checkout Session, present only when a discount was involved. */
export interface StripeCheckoutPromotionFacts {
	checkoutSessionId: string;
	redemptionId: string | null;
	couponIds: string[];
	promotionCodeIds: string[];
	subscriptionId: string | null;
	currency: string | null;
	amountSubtotalMinor: number | null;
	amountDiscountMinor: number | null;
	amountTotalMinor: number | null;
}
