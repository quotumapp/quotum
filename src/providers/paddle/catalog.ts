import { z } from "zod";
import { BillingError } from "../../billing/errors";
import { type PaddlePrice, paddleCadenceSchema, paddleId, paddlePriceSchema } from "./schemas";

/** A published Quotum binding, resolved before any provider write. */
export const paddlePriceBindingSchema = z
	.object({
		priceId: paddleId("pri"),
		productId: paddleId("pro"),
		productType: z.enum(["subscription", "non_consumable"]),
		currency: z.string().regex(/^[A-Z]{3}$/),
		unitAmountMinor: z.string().regex(/^\d+$/),
		billingCycle: paddleCadenceSchema.nullable(),
		trialPeriod: paddleCadenceSchema.nullable(),
		quantity: z.number().int().positive().safe(),
	})
	.strict();
export type PaddlePriceBinding = z.infer<typeof paddlePriceBindingSchema>;

/** Read each price using the connected seller's key; IDs alone are not proof of a binding. */
export function validatePaddlePrice(binding: PaddlePriceBinding, input: unknown): PaddlePrice {
	const price = paddlePriceSchema.parse(input);
	if (
		price.id !== binding.priceId ||
		price.product_id !== binding.productId ||
		price.status !== "active" ||
		price.unit_price.currency_code !== binding.currency ||
		price.unit_price.amount !== binding.unitAmountMinor ||
		!sameCadence(price.billing_cycle, binding.billingCycle) ||
		!sameCadence(price.trial_period, binding.trialPeriod) ||
		(binding.productType === "subscription") !== (price.billing_cycle !== null) ||
		!Number.isSafeInteger(binding.quantity) ||
		binding.quantity < price.quantity.minimum ||
		binding.quantity > price.quantity.maximum
	) {
		throw new BillingError(
			"Paddle price does not match the published binding",
			"PADDLE_PRICE_MISMATCH",
			409,
		);
	}
	return price;
}

export function validatePaddleItemSet(bindings: readonly PaddlePriceBinding[]): void {
	for (const binding of bindings) {
		paddlePriceBindingSchema.parse(binding);
		if (
			(binding.productType === "subscription") !== (binding.billingCycle !== null) ||
			(binding.billingCycle === null && binding.trialPeriod !== null)
		) {
			throw new BillingError(
				"Paddle product type and cadence disagree",
				"PADDLE_ITEMS_INVALID",
				400,
			);
		}
	}
	if (
		bindings.length < 1 ||
		bindings.length > 100 ||
		new Set(bindings.map((item) => item.priceId)).size !== bindings.length
	) {
		throw new BillingError(
			"Paddle requires a nonempty set of distinct price items",
			"PADDLE_ITEMS_INVALID",
			400,
		);
	}
	const first = bindings[0];
	if (!first) throw new Error("Expected at least one item");
	if (
		bindings.some(
			(item) =>
				item.currency !== first.currency ||
				item.productType !== first.productType ||
				!sameCadence(item.billingCycle, first.billingCycle),
		)
	) {
		throw new BillingError(
			"Paddle items must share a currency and billing interval",
			"PADDLE_ITEMS_INVALID",
			400,
		);
	}
}

function sameCadence(a: PaddlePrice["billing_cycle"], b: PaddlePrice["billing_cycle"]): boolean {
	return a === null || b === null
		? a === b
		: a.interval === b.interval && a.frequency === b.frequency;
}
