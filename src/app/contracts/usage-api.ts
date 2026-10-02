import { z } from "zod";
import { storableDateTimeSchema } from "../../shared/input-bounds";

export const publicIdSchema = z
	.string()
	.min(1)
	.max(200)
	.regex(/^\S(?:[\s\S]*\S)?$/u);
export const accountParamsSchema = z.object({ billingAccountId: publicIdSchema });
export const operationLookupQuerySchema = z
	.object({ entityId: publicIdSchema.optional() })
	.strict();
export const checkBodySchema = z
	.object({
		featureId: z
			.string()
			.min(1)
			.max(120)
			.regex(/^\S(?:[\s\S]*\S)?$/u),
		value: z
			.string()
			.min(1)
			.max(80)
			.regex(/^\d+(?:\.\d+)?$/u)
			.optional(),
		entityId: publicIdSchema.optional(),
		occurredAt: storableDateTimeSchema().optional(),
	})
	.strict();
export const consumeBodySchema = checkBodySchema.extend({
	value: checkBodySchema.shape.value.unwrap(),
});
export const accountSchema = z.object({ id: z.string(), createdAt: z.string() });
const quantitySchema = z.object({ featureId: z.string(), unit: z.string(), value: z.string() });
const balanceSchema = z.object({
	featureId: z.string(),
	unit: z.string(),
	// An unlimited quota grants no finite amount, so granted and available are null.
	granted: z.string().nullable(),
	consumed: z.string(),
	held: z.string(),
	available: z.string().nullable(),
	unlimited: z.literal(true).optional(),
	/** A meter limit's scope and current window (PC-12); absent on wallet balances. */
	scope: z.enum(["account", "entity"]).optional(),
	windowStartAt: z.string().optional(),
	windowEndAt: z.string().optional(),
});
const scopeShape = { featureId: z.string(), entityId: z.string().nullable() };
const meteredShape = {
	...scopeShape,
	usage: quantitySchema,
	rated: quantitySchema,
	balance: balanceSchema,
};
const denialShape = {
	allowed: z.literal(false),
	reason: z.enum(["not_entitled", "insufficient_balance", "control_limit_exceeded"]),
	control: z
		.object({
			kind: z.enum(["spend_limit", "usage_limit"]),
			source: z.enum(["account", "entity", "plan_default", "contract"]),
			revision: z.number(),
			policyId: z.string(),
			limitValue: z.string(),
			currentValue: z.string(),
			requestedValue: z.string(),
			remainingValue: z.string(),
		})
		.optional(),
};
export const checkSchema = z.union([
	z.object({
		...scopeShape,
		kind: z.literal("boolean"),
		checkedAt: z.string(),
		allowed: z.literal(true),
	}),
	z.object({ ...scopeShape, kind: z.literal("boolean"), checkedAt: z.string(), ...denialShape }),
	z.object({
		...meteredShape,
		kind: z.literal("metered"),
		checkedAt: z.string(),
		allowed: z.literal(true),
	}),
	z.object({ ...meteredShape, kind: z.literal("metered"), checkedAt: z.string(), ...denialShape }),
]);
const identityShape = { operation: z.literal("consume"), operationId: z.string() };
export const consumeSchema = z.discriminatedUnion("allowed", [
	z.object({
		...meteredShape,
		...identityShape,
		allowed: z.literal(true),
		receiptId: z.string(),
		usageEventId: z.string(),
		recordedAt: z.string(),
	}),
	z.object({ ...meteredShape, ...identityShape, ...denialShape }),
]);
export const receiptSchema = z.object({
	...meteredShape,
	...identityShape,
	receiptId: z.string(),
	usageEventId: z.string(),
	billingAccountId: z.string(),
	occurredAt: z.string().nullable(),
	recordedAt: z.string(),
	rating: z.object({
		path: z.enum(["direct", "pinned", "additive"]),
		revision: z.number().nullable(),
	}),
	deductionCount: z.number().int().nonnegative(),
});
export const deductionPageSchema = z.object({
	items: z.array(
		z.object({
			sourceKind: z.string(),
			sourceKey: z.string(),
			value: z.string(),
			expiresAt: z.string().nullable(),
		}),
	),
	nextCursor: z.string().nullable(),
});
export const envelope = <T extends z.ZodType>(data: T) =>
	z.object({ success: z.literal(true), data });
