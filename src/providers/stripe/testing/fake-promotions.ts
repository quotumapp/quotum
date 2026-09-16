import type Stripe from "stripe";
import type {
	StripeCouponLike,
	StripePromotionClient,
	StripePromotionCodeLike,
} from "../promotions";

export interface FakeStripePromotionState {
	coupons: Map<string, StripeCouponLike & { params: Stripe.CouponCreateParams }>;
	promotionCodes: Map<
		string,
		StripePromotionCodeLike & { params: Stripe.PromotionCodeCreateParams; coupon: string }
	>;
	calls: string[];
}

/**
 * In-memory coupons and promotion codes with Stripe's uniqueness rules: coupon ids are unique and
 * active promotion codes are unique case-insensitively. Idempotency keys replay the first response.
 */
export function createFakeStripePromotions(): StripePromotionClient & {
	state: FakeStripePromotionState;
} {
	const state: FakeStripePromotionState = {
		coupons: new Map(),
		promotionCodes: new Map(),
		calls: [],
	};
	const replays = new Map<string, StripeCouponLike | StripePromotionCodeLike>();
	let sequence = 0;
	return {
		state,
		async createCoupon(params, idempotencyKey) {
			state.calls.push(`createCoupon:${params.id ?? ""}`);
			const replay = replays.get(idempotencyKey);
			if (replay !== undefined) return replay as StripeCouponLike;
			const id = params.id ?? `co_fake_${++sequence}`;
			if (state.coupons.has(id)) {
				throw Object.assign(new Error(`Coupon ${id} already exists`), {
					type: "StripeInvalidRequestError",
					code: "resource_already_exists",
				});
			}
			const coupon = {
				id,
				percent_off: params.percent_off ?? null,
				amount_off: params.amount_off ?? null,
				currency: params.currency ?? null,
				duration: params.duration ?? null,
				duration_in_months: params.duration_in_months ?? null,
				metadata: (params.metadata || {}) as Record<string, string>,
				params,
			};
			state.coupons.set(id, coupon);
			replays.set(idempotencyKey, coupon);
			return coupon;
		},
		async retrieveCoupon(couponId) {
			state.calls.push(`retrieveCoupon:${couponId}`);
			const coupon = state.coupons.get(couponId);
			if (coupon === undefined) {
				throw Object.assign(new Error(`No such coupon: ${couponId}`), {
					type: "StripeInvalidRequestError",
					code: "resource_missing",
				});
			}
			return coupon;
		},
		async createPromotionCode(params, idempotencyKey) {
			state.calls.push(`createPromotionCode:${params.code ?? ""}`);
			const replay = replays.get(idempotencyKey);
			if (replay !== undefined) return replay as StripePromotionCodeLike;
			const coupon = params.promotion.coupon ?? "";
			if (!state.coupons.has(coupon)) {
				throw Object.assign(new Error(`No such coupon: ${coupon}`), {
					type: "StripeInvalidRequestError",
					code: "resource_missing",
				});
			}
			const active = params.active ?? true;
			const duplicate = [...state.promotionCodes.values()].some(
				(existing) =>
					existing.active && active && existing.code?.toUpperCase() === params.code?.toUpperCase(),
			);
			if (duplicate) {
				throw Object.assign(new Error("An active promotion code with this code already exists"), {
					type: "StripeInvalidRequestError",
				});
			}
			const promotionCode = {
				id: `promo_fake_${++sequence}`,
				active,
				code: params.code,
				metadata: (params.metadata || {}) as Record<string, string>,
				params,
				coupon,
			};
			state.promotionCodes.set(promotionCode.id, promotionCode);
			replays.set(idempotencyKey, promotionCode);
			return promotionCode;
		},
		async updatePromotionCode(promotionCodeId, params, idempotencyKey) {
			state.calls.push(`updatePromotionCode:${promotionCodeId}:${String(params.active)}`);
			const replay = replays.get(idempotencyKey);
			if (replay !== undefined) return replay as StripePromotionCodeLike;
			const promotionCode = state.promotionCodes.get(promotionCodeId);
			if (promotionCode === undefined) {
				throw Object.assign(new Error(`No such promotion code: ${promotionCodeId}`), {
					type: "StripeInvalidRequestError",
					code: "resource_missing",
				});
			}
			if (params.active !== undefined) promotionCode.active = params.active;
			const snapshot = { ...promotionCode };
			replays.set(idempotencyKey, snapshot);
			return snapshot;
		},
		async findPromotionCodes(input) {
			state.calls.push(`findPromotionCodes:${input.code}`);
			return [...state.promotionCodes.values()].filter(
				(candidate) =>
					candidate.coupon === input.coupon &&
					candidate.code?.toUpperCase() === input.code.toUpperCase(),
			);
		},
	};
}
