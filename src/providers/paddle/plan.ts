import { z } from "zod";
import { BillingError, InvalidRequestError } from "../../billing/errors";
import { paddlePriceBindingSchema } from "./catalog";

const databaseId = z.string().regex(/^[1-9][0-9]*$/);
export const paddlePlanPinSchema = z
	.object({
		planVersionId: databaseId,
		catalogRevisionId: databaseId,
		priceComponentId: databaseId,
		storeProductId: z.uuid(),
	})
	.strict();
export type PaddlePlanPin = z.infer<typeof paddlePlanPinSchema>;

export const paddleCommercialTargetSchema = z
	.object({
		productKey: z.string().min(1),
		name: z.string().min(1),
		priceKey: z.string().min(1),
		storeProductId: z.uuid(),
		binding: paddlePriceBindingSchema,
		plan: paddlePlanPinSchema.nullable(),
	})
	.strict();
export type PaddleCommercialTarget = z.infer<typeof paddleCommercialTargetSchema>;

export const paddleCommercialContextSchema = z
	.object({
		connectionVersionId: z.uuid(),
		providerAccountId: z.string().min(1),
		paymentPageUrl: z.url(),
		target: paddleCommercialTargetSchema,
	})
	.strict();

export function parsePaddleCommercialContext(value: unknown) {
	const parsed = paddleCommercialContextSchema.safeParse(value);
	if (!parsed.success)
		throw new BillingError(
			"Stored Paddle preview is invalid; create a new preview",
			"COMMERCIAL_PREVIEW_STALE",
			409,
		);
	return parsed.data;
}

export function normalizePaddleEmail(value: string | null | undefined): string | null {
	if (value == null) return null;
	const parsed = z.email().safeParse(value.trim());
	if (!parsed.success) throw new InvalidRequestError("A valid customer email is required");
	return parsed.data;
}
