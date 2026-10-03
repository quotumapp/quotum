import { z } from "zod";
import { sha256Hex, stableJson } from "../../billing/decimal";
import { BillingError } from "../../billing/errors";
import { type PaddlePriceBinding, validatePaddleItemSet } from "./catalog";
import type { PaddleConfig } from "./config";
import { type PaddleSubscription, paddleId } from "./schemas";

export interface PaddleCorrelation {
	operationId: string;
	requestHash: string;
}
export interface PaddleCommand {
	method: "POST" | "PATCH";
	path: string;
	body: Record<string, unknown>;
}

const correlationSchema = z.object({
	operationId: z.uuid(),
	requestHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export function paddleCorrelation(input: PaddleCorrelation): { quotum: PaddleCorrelation } {
	return { quotum: correlationSchema.parse(input) };
}

export function paddleCheckoutCommand(input: {
	customerId: string;
	bindings: readonly PaddlePriceBinding[];
	config: Pick<PaddleConfig, "paymentPageUrl">;
	correlation: PaddleCorrelation;
}): PaddleCommand {
	validatePaddleItemSet(input.bindings);
	const page = new URL(input.config.paymentPageUrl);
	if (
		page.protocol !== "https:" ||
		page.username ||
		page.password ||
		page.hash ||
		page.searchParams.has("_ptxn")
	) {
		throw new BillingError("Invalid Paddle payment page", "PADDLE_PAYMENT_PAGE_INVALID", 400);
	}
	return {
		method: "POST",
		path: "/transactions",
		body: {
			customer_id: paddleId("ctm").parse(input.customerId),
			collection_mode: "automatic",
			currency_code: input.bindings[0]?.currency,
			items: items(input.bindings),
			checkout: { url: page.href },
			custom_data: paddleCorrelation(input.correlation),
		},
	};
}

/** Separate collection policy from when access changes. Initial qualification covers immediate changes. */
export type PaddleChangeBillingPolicy =
	| { billing: "prorated" | "full"; collection: "immediate" | "next_renewal" }
	| { billing: "none"; collection: "next_renewal" };

export function paddleProrationMode(policy: PaddleChangeBillingPolicy): string {
	if (policy.billing === "none") return "do_not_bill";
	const collection = policy.collection === "immediate" ? "immediately" : "next_billing_period";
	return `${policy.billing === "prorated" ? "prorated" : "full"}_${collection}`;
}

export function paddleSubscriptionFingerprint(subscription: PaddleSubscription): string {
	return sha256Hex(
		stableJson({
			id: subscription.id,
			customer: subscription.customer_id,
			status: subscription.status,
			updatedAt: subscription.updated_at,
			period: subscription.current_billing_period,
			scheduled: subscription.scheduled_change,
			currency: subscription.currency_code,
			items: subscription.items
				.map((item) => ({ priceId: item.price.id, quantity: item.quantity }))
				.sort((a, b) => a.priceId.localeCompare(b.priceId)),
		}),
	);
}

export function paddleChangeCommand(input: {
	subscription: PaddleSubscription;
	expectedFingerprint: string;
	/** Complete desired subscription, including all retained components. */
	bindings: readonly PaddlePriceBinding[];
	effectiveMode: "immediate" | "period_end";
	billingPolicy: PaddleChangeBillingPolicy;
	correlation: PaddleCorrelation;
	now?: number;
}): PaddleCommand {
	if (input.effectiveMode !== "immediate")
		unsupported("Period-end Paddle plan changes are not qualified");
	const subscription = input.subscription;
	if (paddleSubscriptionFingerprint(subscription) !== input.expectedFingerprint) {
		throw new BillingError(
			"Paddle subscription changed since preview",
			"PADDLE_PREVIEW_STALE",
			409,
		);
	}
	assertMutable(subscription, input.now ?? Date.now());
	if (subscription.status !== "active" || subscription.scheduled_change !== null)
		unsupported("Paddle plan changes require an active subscription without a scheduled change");
	validatePaddleItemSet(input.bindings);
	if (
		input.bindings.some(
			(binding) =>
				binding.productType !== "subscription" || binding.currency !== subscription.currency_code,
		)
	)
		unsupported("Paddle plan changes require recurring items in the subscription currency");
	return {
		method: "PATCH",
		path: `/subscriptions/${subscription.id}`,
		body: {
			items: items(input.bindings),
			proration_billing_mode: paddleProrationMode(input.billingPolicy),
			on_payment_failure: "prevent_change",
			custom_data: { ...subscription.custom_data, ...paddleCorrelation(input.correlation) },
		},
	};
}

export function paddleCancellationCommand(input: {
	subscription: PaddleSubscription;
	action: "cancel" | "uncancel";
	effectiveMode: "immediate" | "period_end";
	now?: number;
}): PaddleCommand {
	const subscription = input.subscription;
	assertMutable(subscription, input.now ?? Date.now());
	if (input.action === "uncancel") {
		if (subscription.scheduled_change?.action !== "cancel")
			unsupported("Paddle subscription has no scheduled cancellation");
		return {
			method: "PATCH",
			path: `/subscriptions/${subscription.id}`,
			body: { scheduled_change: null },
		};
	}
	if (subscription.scheduled_change !== null)
		unsupported("Paddle subscription already has a scheduled change");
	return {
		method: "POST",
		path: `/subscriptions/${subscription.id}/cancel`,
		body: {
			effective_from: input.effectiveMode === "immediate" ? "immediately" : "next_billing_period",
		},
	};
}

function assertMutable(subscription: PaddleSubscription, now: number): void {
	if (
		subscription.collection_mode !== "automatic" ||
		!["active", "trialing"].includes(subscription.status)
	)
		unsupported("Paddle subscription cannot be changed in its current state");
	if (subscription.next_billed_at && Date.parse(subscription.next_billed_at) - now <= 30 * 60_000)
		unsupported("Paddle subscription is within the renewal exclusion window");
}

function items(bindings: readonly PaddlePriceBinding[]) {
	return bindings.map((binding) => ({
		price_id: paddleId("pri").parse(binding.priceId),
		quantity: z.number().int().positive().safe().parse(binding.quantity),
	}));
}

function unsupported(message: string): never {
	throw new BillingError(message, "PADDLE_OPERATION_UNSUPPORTED", 409);
}
