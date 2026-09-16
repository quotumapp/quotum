import type Stripe from "stripe";
import type { PromotionStripeSyncJob, PromotionStripeSyncOutcome } from "../../billing/promotions";

/** The Stripe calls promotion provisioning needs; every key is derived from the object id. */
export interface StripePromotionClient {
	createCoupon(
		params: Stripe.CouponCreateParams,
		idempotencyKey: string,
	): Promise<StripeCouponLike>;
	retrieveCoupon(couponId: string): Promise<StripeCouponLike>;
	createPromotionCode(
		params: Stripe.PromotionCodeCreateParams,
		idempotencyKey: string,
	): Promise<StripePromotionCodeLike>;
	updatePromotionCode(
		promotionCodeId: string,
		params: Stripe.PromotionCodeUpdateParams,
		idempotencyKey: string,
	): Promise<StripePromotionCodeLike>;
	findPromotionCodes(input: { code: string; coupon: string }): Promise<StripePromotionCodeLike[]>;
}

export interface StripeCouponLike {
	id: string;
	percent_off?: number | null;
	amount_off?: number | null;
	currency?: string | null;
	duration?: string | null;
	duration_in_months?: number | null;
	metadata?: Record<string, string> | null;
}

export interface StripePromotionCodeLike {
	id: string;
	active: boolean;
	code?: string;
	metadata?: Record<string, string> | null;
}

/** Stripe's customer-facing coupon id: never the merchant key, so terms changes get a new coupon. */
export function stripeCouponId(objectId: string): string {
	return `quotum_${objectId.replaceAll("-", "")}`;
}

export async function syncPromotionStripeObject(
	client: StripePromotionClient,
	job: PromotionStripeSyncJob,
): Promise<PromotionStripeSyncOutcome> {
	try {
		return job.objectKind === "coupon"
			? await syncCoupon(client, job)
			: await syncPromotionCode(client, job);
	} catch (error) {
		return {
			kind: "failed",
			error: stripeErrorMessage(error),
			terminal: isTerminalStripeError(error),
		};
	}
}

async function syncCoupon(
	client: StripePromotionClient,
	job: Extract<PromotionStripeSyncJob, { objectKind: "coupon" }>,
): Promise<PromotionStripeSyncOutcome> {
	const params = couponParams(job);
	try {
		const coupon = await client.createCoupon(
			params,
			`billing:promotion:${job.projectKey}:coupon:${job.objectId}:create`,
		);
		return { kind: "ready", externalId: coupon.id, providerActive: true };
	} catch (error) {
		// Idempotency keys expire after a day; the deterministic id is the durable guard.
		if (stripeErrorCode(error) !== "resource_already_exists" || params.id === undefined)
			throw error;
		const existing = await client.retrieveCoupon(params.id);
		if (!couponMatches(existing, params, job.objectId)) {
			return {
				kind: "failed",
				error: `Stripe coupon ${params.id} already exists with different terms`,
				terminal: true,
			};
		}
		return { kind: "ready", externalId: existing.id, providerActive: true };
	}
}

async function syncPromotionCode(
	client: StripePromotionClient,
	job: Extract<PromotionStripeSyncJob, { objectKind: "promotion_code" }>,
): Promise<PromotionStripeSyncOutcome> {
	if (job.externalId === null) {
		if (
			job.retireRequested ||
			(job.expiresAt !== null && Date.parse(job.expiresAt) <= Date.now())
		) {
			return { kind: "retired", externalId: null };
		}
		const params: Stripe.PromotionCodeCreateParams = {
			promotion: { type: "coupon", coupon: job.couponExternalId },
			code: job.code,
			active: job.desiredActive,
			...(job.expiresAt === null
				? {}
				: { expires_at: Math.floor(Date.parse(job.expiresAt) / 1000) }),
			...(job.maxRedemptions === null ? {} : { max_redemptions: job.maxRedemptions }),
			...(job.firstPurchaseOnly ? { restrictions: { first_time_transaction: true } } : {}),
			metadata: metadata(job),
		};
		try {
			const created = await client.createPromotionCode(
				params,
				`billing:promotion:${job.projectKey}:promotion-code:${job.objectId}:create`,
			);
			return { kind: "ready", externalId: created.id, providerActive: created.active };
		} catch (error) {
			if (!isInvalidRequest(error)) throw error;
			const adopted = (
				await client.findPromotionCodes({ code: job.code, coupon: job.couponExternalId })
			).find((candidate) => candidate.metadata?.quotumProviderObjectId === job.objectId);
			if (adopted === undefined) throw error;
			return { kind: "ready", externalId: adopted.id, providerActive: adopted.active };
		}
	}
	const desired = job.retireRequested ? false : job.desiredActive;
	let providerActive = job.providerActive;
	if (providerActive !== desired) {
		const updated = await client.updatePromotionCode(
			job.externalId,
			{ active: desired },
			`billing:promotion:${job.projectKey}:promotion-code:${job.objectId}:active:${desired}:${job.desiredGeneration}`,
		);
		providerActive = updated.active;
	}
	return job.retireRequested && providerActive === false
		? { kind: "retired", externalId: job.externalId }
		: { kind: "ready", externalId: job.externalId, providerActive: providerActive ?? desired };
}

function couponParams(
	job: Extract<PromotionStripeSyncJob, { objectKind: "coupon" }>,
): Stripe.CouponCreateParams {
	const discount = job.discount;
	const base: Stripe.CouponCreateParams = {
		id: stripeCouponId(job.objectId),
		name: job.promotionName.slice(0, 40).trimEnd(),
		duration: discount.duration,
		...(discount.duration === "repeating" && discount.durationMonths !== null
			? { duration_in_months: discount.durationMonths }
			: {}),
		...(job.appliesToProducts === null ? {} : { applies_to: { products: job.appliesToProducts } }),
		metadata: metadata(job),
	};
	if (discount.type === "percent") {
		return { ...base, percent_off: discount.percentOffBps / 100 };
	}
	const [primary, ...others] = discount.amounts;
	if (primary === undefined) {
		throw new Error(`Promotion ${job.promotionKey} has no discount amount`);
	}
	return {
		...base,
		amount_off: primary.amountOffMinor,
		currency: primary.currency.toLowerCase(),
		...(others.length === 0
			? {}
			: {
					currency_options: Object.fromEntries(
						others.map((amount) => [
							amount.currency.toLowerCase(),
							{ amount_off: amount.amountOffMinor },
						]),
					),
				}),
	};
}

function couponMatches(
	coupon: StripeCouponLike,
	params: Stripe.CouponCreateParams,
	objectId: string,
): boolean {
	return (
		coupon.metadata?.quotumProviderObjectId === objectId &&
		(coupon.percent_off ?? null) === (params.percent_off ?? null) &&
		(coupon.amount_off ?? null) === (params.amount_off ?? null) &&
		(coupon.currency ?? null) === (params.currency ?? null) &&
		(coupon.duration ?? null) === (params.duration ?? null) &&
		(coupon.duration_in_months ?? null) === (params.duration_in_months ?? null)
	);
}

function metadata(job: PromotionStripeSyncJob): Record<string, string> {
	return {
		quotumProjectKey: job.projectKey,
		quotumPromotionKey: job.promotionKey,
		quotumProviderObjectId: job.objectId,
	};
}

function stripeErrorCode(error: unknown): string | null {
	if (typeof error !== "object" || error === null) return null;
	const record = error as { code?: unknown; raw?: { code?: unknown } };
	const code = record.code ?? record.raw?.code;
	return typeof code === "string" ? code : null;
}

function stripeErrorType(error: unknown): string | null {
	if (typeof error !== "object" || error === null) return null;
	const record = error as { type?: unknown; rawType?: unknown };
	const type = record.type ?? record.rawType;
	return typeof type === "string" ? type : null;
}

function isInvalidRequest(error: unknown): boolean {
	const type = stripeErrorType(error);
	return type === "StripeInvalidRequestError" || type === "invalid_request_error";
}

/** Invalid input, permissions and credentials will not fix themselves; everything else is retried. */
function isTerminalStripeError(error: unknown): boolean {
	const code = stripeErrorCode(error);
	if (code === "rate_limit" || code === "lock_timeout") return false;
	const type = stripeErrorType(error);
	return (
		isInvalidRequest(error) ||
		type === "StripePermissionError" ||
		type === "StripeAuthenticationError"
	);
}

function stripeErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return (message.trim() === "" ? "Stripe request failed" : message).slice(0, 2000);
}
