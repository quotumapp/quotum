import type { PaddlePriceBinding } from "../../../src/providers/paddle/catalog";
import type { PaddleConfig } from "../../../src/providers/paddle/config";
import type {
	PaddlePrice,
	PaddleSubscription,
	PaddleTransaction,
} from "../../../src/providers/paddle/schemas";

/** Synthetic fixtures. These are not evidence of a completed Paddle sandbox qualification. */
export const id = (prefix: string, suffix = "a") => `${prefix}_${suffix.repeat(26)}`;
export const config: PaddleConfig = {
	apiKey: "pdl_sdbx_test_only",
	webhookSecret: "test_only_webhook_secret",
	notificationSettingId: id("ntfset"),
	paymentPageUrl: "https://merchant.example/pay",
	clientToken: "test_fixture",
};
export const price: PaddlePrice = {
	id: id("pri"),
	product_id: id("pro"),
	status: "active",
	billing_cycle: { interval: "month", frequency: 1 },
	trial_period: null,
	unit_price: { amount: "1000", currency_code: "USD" },
	quantity: { minimum: 1, maximum: 100 },
	tax_mode: "external",
};
export const binding: PaddlePriceBinding = {
	priceId: price.id,
	productId: price.product_id,
	productType: "subscription",
	currency: "USD",
	unitAmountMinor: "1000",
	billingCycle: price.billing_cycle,
	trialPeriod: null,
	quantity: 2,
};
export const subscription: PaddleSubscription = {
	id: id("sub"),
	customer_id: id("ctm"),
	status: "active",
	currency_code: "USD",
	collection_mode: "automatic",
	custom_data: { existing: "preserved" },
	current_billing_period: { starts_at: "2026-10-01T00:00:00Z", ends_at: "2026-11-01T00:00:00Z" },
	next_billed_at: "2026-11-01T00:00:00Z",
	started_at: "2026-10-01T00:00:00Z",
	canceled_at: null,
	paused_at: null,
	updated_at: "2026-10-01T00:00:00Z",
	scheduled_change: null,
	items: [{ price, quantity: 2, status: "active", trial_dates: null }],
};
export const correlation = {
	operationId: "00000000-0000-4000-8000-000000000099",
	requestHash: "a".repeat(64),
};
export const transaction: PaddleTransaction = {
	origin: "api",
	id: id("txn"),
	status: "completed",
	customer_id: id("ctm"),
	subscription_id: id("sub"),
	currency_code: "USD",
	collection_mode: "automatic",
	custom_data: { quotum: correlation },
	updated_at: "2026-10-01T00:00:00Z",
	checkout: { url: `${config.paymentPageUrl}?_ptxn=${id("txn")}` },
	details: {
		totals: { total: "2000", tax: "0", grand_total: "2000", currency_code: "USD" },
		line_items: [
			{
				id: id("txnitm"),
				price_id: price.id,
				product: { id: price.product_id },
				quantity: 2,
				totals: { total: "2000", tax: "0" },
			},
		],
	},
};
export function event(eventType: string, data: unknown) {
	return { event_id: id("evt"), event_type: eventType, occurred_at: "2026-10-01T00:00:00Z", data };
}
