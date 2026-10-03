import { z } from "zod";
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
