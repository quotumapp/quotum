import { z } from "zod";

export const paddleId = (prefix: string) =>
	z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{26}$`));
const date = z.iso.datetime({ offset: true });
const money = z.string().regex(/^\d+$/);
// Subscription changes can create credit lines with negative quantities and totals.
const signedMoney = z.string().regex(/^-?\d+$/);
export const paddleCadenceSchema = z.object({
	interval: z.enum(["day", "week", "month", "year"]),
	frequency: z.number().int().positive(),
});
export const paddlePriceSchema = z
	.object({
		id: paddleId("pri"),
		product_id: paddleId("pro"),
		status: z.enum(["active", "archived"]),
		billing_cycle: paddleCadenceSchema.nullable(),
		trial_period: paddleCadenceSchema.nullable(),
		unit_price: z.object({ amount: money, currency_code: z.string().regex(/^[A-Z]{3}$/) }),
		quantity: z.object({ minimum: z.number().int().min(1), maximum: z.number().int().min(1) }),
		tax_mode: z.enum(["account_setting", "external", "internal", "location"]),
	})
	.passthrough();

export type PaddlePrice = z.infer<typeof paddlePriceSchema>;

export const paddleSubscriptionSchema = z
	.object({
		id: paddleId("sub"),
		customer_id: paddleId("ctm"),
		status: z.enum(["active", "trialing", "past_due", "paused", "canceled"]),
		currency_code: z.string().regex(/^[A-Z]{3}$/),
		collection_mode: z.enum(["automatic", "manual"]),
		custom_data: z.record(z.string(), z.unknown()).nullable(),
		current_billing_period: z.object({ starts_at: date, ends_at: date }).nullable(),
		next_billed_at: date.nullable(),
		started_at: date.nullable(),
		canceled_at: date.nullable(),
		paused_at: date.nullable(),
		updated_at: date,
		scheduled_change: z
			.object({ action: z.enum(["cancel", "pause", "resume"]), effective_at: date })
			.passthrough()
			.nullable(),
		items: z
			.array(
				z
					.object({
						price: paddlePriceSchema,
						quantity: z.number().int().positive(),
						status: z.enum(["active", "inactive", "trialing"]),
						trial_dates: z.object({ starts_at: date, ends_at: date }).nullable(),
					})
					.passthrough(),
			)
			.min(1),
	})
	.passthrough();
export type PaddleSubscription = z.infer<typeof paddleSubscriptionSchema>;

export const paddleTransactionSchema = z
	.object({
		id: paddleId("txn"),
		origin: z.enum([
			"api",
			"web",
			"subscription_charge",
			"subscription_payment_method_change",
			"subscription_recurring",
			"subscription_update",
		]),
		status: z.enum(["draft", "ready", "billed", "paid", "completed", "canceled", "past_due"]),
		customer_id: paddleId("ctm").nullable(),
		subscription_id: paddleId("sub").nullable(),
		currency_code: z.string().regex(/^[A-Z]{3}$/),
		collection_mode: z.enum(["automatic", "manual"]),
		custom_data: z.record(z.string(), z.unknown()).nullable(),
		updated_at: date,
		checkout: z.object({ url: z.url().nullable() }).nullable(),
		details: z
			.object({
				totals: z
					.object({
						total: signedMoney,
						tax: signedMoney,
						grand_total: signedMoney,
						currency_code: z.string(),
					})
					.passthrough(),
				line_items: z.array(
					z
						.object({
							id: paddleId("txnitm"),
							price_id: paddleId("pri"),
							quantity: z.number().int().safe(),
							product: z.object({ id: paddleId("pro") }).passthrough(),
							totals: z.object({ total: signedMoney, tax: signedMoney }).passthrough(),
						})
						.passthrough(),
				),
			})
			.passthrough(),
	})
	.passthrough();
export type PaddleTransaction = z.infer<typeof paddleTransactionSchema>;

// Canceled drafts can lack calculated totals. Their authenticated identity proves cancellation.
export const paddleTransactionIdentitySchema = paddleTransactionSchema.pick({
	id: true,
	origin: true,
	status: true,
	customer_id: true,
	subscription_id: true,
	collection_mode: true,
	custom_data: true,
});
export type PaddleTransactionIdentity = z.infer<typeof paddleTransactionIdentitySchema>;

export const paddleAdjustmentSchema = z
	.object({
		id: paddleId("adj"),
		transaction_id: paddleId("txn"),
		customer_id: paddleId("ctm"),
		action: z.enum([
			"refund",
			"credit",
			"chargeback",
			"chargeback_warning",
			"chargeback_warning_reverse",
			"chargeback_reverse",
			"credit_reverse",
		]),
		status: z.enum(["pending_approval", "approved", "rejected", "reversed"]),
		currency_code: z.string().regex(/^[A-Z]{3}$/),
		updated_at: date,
		totals: z.object({ total: money, tax: money }).passthrough(),
		items: z.array(
			z
				.object({
					item_id: paddleId("txnitm"),
					totals: z.object({ total: money, tax: money }).passthrough(),
				})
				.passthrough(),
		),
	})
	.passthrough();
export type PaddleAdjustment = z.infer<typeof paddleAdjustmentSchema>;

export const paddleEventSchema = z
	.object({
		event_id: paddleId("evt"),
		event_type: z.string().min(1),
		occurred_at: date,
		data: z.record(z.string(), z.unknown()),
	})
	.passthrough();
export type PaddleEvent = z.infer<typeof paddleEventSchema>;
