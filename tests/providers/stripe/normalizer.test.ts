import { describe, expect, it } from "bun:test";
import type { SubscriptionStatus } from "../../../src/billing/types";
import {
	normalizeStripeCheckoutSession,
	normalizeStripeDispute,
	normalizeStripeInvoice,
	normalizeStripeRefund,
	normalizeStripeSubscription,
} from "../../../src/providers/stripe/normalizer";

const stripeSeconds = 1770000000;
const now = new Date("2026-06-01T00:00:00.000Z");
const futurePeriodEnd = Math.floor(Date.parse("2026-06-30T00:00:00.000Z") / 1000);
const pastPeriodEnd = Math.floor(Date.parse("2026-05-31T00:00:00.000Z") / 1000);

function checkoutMetadata(overrides: Record<string, string> = {}) {
	return {
		billingAccountId: "user_1",
		productKey: "credits_100",
		purchaseKind: "consumable",
		externalProductId: "prod_credits_100",
		externalPriceId: "price_credits_100",
		...overrides,
	};
}

function subscriptionFixture(overrides: Record<string, unknown> = {}) {
	return {
		id: "sub_123",
		customer: "cus_123",
		latest_invoice: "in_123",
		status: "active",
		created: stripeSeconds,
		current_period_end: futurePeriodEnd,
		cancel_at_period_end: false,
		metadata: {
			billingAccountId: "user_1",
			externalProductId: "prod_premium",
			externalPriceId: "price_premium_monthly",
		},
		...overrides,
	};
}

function invoiceFixture(overrides: Record<string, unknown> = {}) {
	return {
		id: "in_123",
		customer: "cus_123",
		subscription: "sub_123",
		status: "paid",
		created: stripeSeconds,
		metadata: {
			billingAccountId: "user_1",
			externalProductId: "prod_premium",
			externalPriceId: "price_premium_monthly",
		},
		lines: {
			data: [
				{
					period: {
						start: stripeSeconds,
						end: futurePeriodEnd,
					},
					price: {
						id: "price_premium_monthly",
						product: "prod_premium",
					},
				},
			],
		},
		...overrides,
	};
}

describe("Stripe normalizer", () => {
	it("normalizes paid payment-mode Checkout sessions to credit purchases", () => {
		const command = normalizeStripeCheckoutSession({
			eventId: "evt_123",
			session: {
				id: "cs_123",
				mode: "payment",
				payment_status: "paid",
				customer: "cus_123",
				payment_intent: "pi_123",
				amount_total: 499,
				currency: "usd",
				created: stripeSeconds,
				metadata: checkoutMetadata(),
			},
		});

		expect(command).toMatchObject({
			kind: "credit_purchase",
			billingAccountId: "user_1",
			stripeCustomerId: "cus_123",
			externalProductId: "prod_credits_100",
			externalPriceId: "price_credits_100",
			paymentIntentId: "pi_123",
			chargeId: null,
			amountPaidCents: 499,
			currency: "usd",
			eventType: "checkout.session.completed",
			externalEventId: "evt_123",
			projectionIdempotencyKey: "stripe:payment:pi_123:projection",
		});
		if (command.kind !== "credit_purchase") {
			throw new Error("Expected credit purchase command");
		}
		expect(command.purchasedAt.toISOString()).toBe("2026-02-02T02:40:00.000Z");
	});

	it("normalizes subscription-mode Checkout sessions to identity only without grants", () => {
		const command = normalizeStripeCheckoutSession({
			eventId: "evt_sub",
			session: {
				id: "cs_sub",
				mode: "subscription",
				payment_status: "paid",
				customer: "cus_123",
				subscription: "sub_123",
				created: stripeSeconds,
				metadata: checkoutMetadata({
					productKey: "premium_monthly",
					purchaseKind: "subscription",
				}),
			},
		});

		expect(command).toEqual({
			kind: "identity_only",
			billingAccountId: "user_1",
			stripeCustomerId: "cus_123",
			eventType: "checkout.session.completed",
			externalEventId: "evt_sub",
			rawPayload: expect.any(Object),
		});
		expect("projectionIdempotencyKey" in command).toBe(false);
	});

	it("normalizes successful refunds to credit reversals by refund id", () => {
		const command = normalizeStripeRefund({
			eventId: "evt_refund",
			refund: {
				id: "re_123",
				status: "succeeded",
				amount: 499,
				currency: "usd",
				payment_intent: "pi_123",
				charge: "ch_123",
				created: stripeSeconds,
				metadata: {
					billingAccountId: "user_1",
					productKey: "credits_100",
					purchaseKind: "consumable",
				},
			},
		});

		expect(command).toMatchObject({
			kind: "credit_reversal",
			reversalReason: "refund",
			reversalId: "re_123",
			billingAccountId: "user_1",
			paymentIntentId: "pi_123",
			chargeId: "ch_123",
			reversalAmount: 499,
			reversalCurrency: "usd",
			eventType: "refund.created",
			externalEventId: "evt_refund",
			projectionIdempotencyKey: "stripe:refund:re_123:reversal",
		});
		if (command.kind !== "credit_reversal") {
			throw new Error("Expected credit reversal command");
		}
		expect(command.reversedAt.toISOString()).toBe("2026-02-02T02:40:00.000Z");
	});

	it("requires refund reversal amount and currency", () => {
		for (const missingField of ["amount", "currency"]) {
			const refund = {
				id: "re_missing_amount",
				status: "succeeded",
				amount: 499,
				currency: "usd",
				payment_intent: "pi_123",
				charge: "ch_123",
				created: stripeSeconds,
			} as Record<string, unknown>;
			delete refund[missingField];

			expect(() =>
				normalizeStripeRefund({
					eventId: `evt_refund_missing_${missingField}`,
					refund,
				}),
			).toThrow(`Stripe refund ${missingField} is required`);
		}
	});

	it("ignores refunds that are not succeeded", () => {
		for (const status of ["pending", "failed", "canceled"]) {
			const command = normalizeStripeRefund({
				eventId: `evt_refund_${status}`,
				eventType: "refund.updated",
				refund: {
					id: `re_${status}`,
					status,
					payment_intent: "pi_123",
					charge: "ch_123",
					created: stripeSeconds,
				},
			});

			expect(command).toMatchObject({
				kind: "ignored",
				reason: "refund_not_succeeded",
				eventType: "refund.updated",
				externalEventId: `evt_refund_${status}`,
			});
		}
	});

	it("ignores charge.refunded events instead of emitting refund reversals", () => {
		const command = normalizeStripeRefund({
			eventId: "evt_charge_refunded",
			eventType: "charge.refunded",
			refund: {
				id: "ch_123",
				payment_intent: "pi_123",
				amount_refunded: 499,
				currency: "usd",
				created: stripeSeconds,
			},
		});

		expect(command).toMatchObject({
			kind: "ignored",
			reason: "charge_refunded_not_supported",
			eventType: "charge.refunded",
			externalEventId: "evt_charge_refunded",
		});
	});

	it("normalizes disputes to credit reversals by dispute id", () => {
		const command = normalizeStripeDispute({
			eventId: "evt_dispute",
			dispute: {
				id: "dp_123",
				amount: 499,
				currency: "usd",
				charge: "ch_123",
				created: stripeSeconds,
				metadata: {
					billingAccountId: "user_1",
					paymentIntentId: "pi_123",
				},
			},
		});

		expect(command).toMatchObject({
			kind: "credit_reversal",
			reversalReason: "dispute",
			reversalId: "dp_123",
			billingAccountId: "user_1",
			paymentIntentId: "pi_123",
			chargeId: "ch_123",
			reversalAmount: 499,
			reversalCurrency: "usd",
			eventType: "charge.dispute.created",
			externalEventId: "evt_dispute",
			projectionIdempotencyKey: "stripe:dispute:dp_123:reversal",
		});
	});

	it("requires dispute reversal amount and currency", () => {
		for (const missingField of ["amount", "currency"]) {
			const dispute = {
				id: "dp_missing_amount",
				amount: 499,
				currency: "usd",
				charge: "ch_123",
				created: stripeSeconds,
				metadata: { paymentIntentId: "pi_123" },
			} as Record<string, unknown>;
			delete dispute[missingField];

			expect(() =>
				normalizeStripeDispute({
					eventId: `evt_dispute_missing_${missingField}`,
					dispute,
				}),
			).toThrow(`Stripe dispute ${missingField} is required`);
		}
	});

	it("ignores invoices without subscriptions", () => {
		const command = normalizeStripeInvoice({
			eventId: "evt_invoice",
			eventType: "invoice.paid",
			invoice: {
				id: "in_123",
				customer: "cus_123",
				subscription: null,
				status: "paid",
				created: stripeSeconds,
			},
		});

		expect(command).toMatchObject({
			kind: "ignored",
			reason: "invoice_without_subscription",
			eventType: "invoice.paid",
			externalEventId: "evt_invoice",
		});
	});

	it("derives paid and failed invoice expiry and event-scoped idempotency keys", () => {
		const paid = normalizeStripeInvoice({
			eventId: "evt_invoice_paid",
			eventType: "invoice.paid",
			invoice: invoiceFixture({
				status: "paid",
			}),
		});
		const failed = normalizeStripeInvoice({
			eventId: "evt_invoice_failed",
			eventType: "invoice.payment_failed",
			invoice: invoiceFixture({
				status: "open",
			}),
		});

		if (paid.kind !== "subscription" || failed.kind !== "subscription") {
			throw new Error("Expected subscription invoice commands");
		}

		expect(paid.subscriptionStatus).toBe("active");
		expect(failed.subscriptionStatus).toBe("billing_retry");
		expect(paid.expiresAt?.toISOString()).toBe("2026-06-30T00:00:00.000Z");
		expect(failed.expiresAt?.toISOString()).toBe("2026-06-30T00:00:00.000Z");
		expect(paid.projectionIdempotencyKey).toBe(
			"stripe:invoice:in_123:invoice.paid:evt_invoice_paid:projection",
		);
		expect(failed.projectionIdempotencyKey).toBe(
			"stripe:invoice:in_123:invoice.payment_failed:evt_invoice_failed:projection",
		);
		expect(paid.projectionIdempotencyKey).not.toBe(failed.projectionIdempotencyKey);
	});

	it("falls back to subscription metadata and line price data for recurring invoices", () => {
		const command = normalizeStripeInvoice({
			eventId: "evt_invoice_line_fallback",
			eventType: "invoice.paid",
			invoice: invoiceFixture({
				metadata: {},
				subscription: {
					id: "sub_123",
					current_period_end: futurePeriodEnd,
					metadata: {
						billingAccountId: "user_from_subscription",
					},
				},
				lines: {
					data: [
						{
							period: {
								end: futurePeriodEnd,
							},
							price: {
								id: "price_from_line",
								product: {
									id: "prod_from_line",
								},
							},
						},
					],
				},
			}),
		});

		expect(command).toMatchObject({
			kind: "subscription",
			billingAccountId: "user_from_subscription",
			externalProductId: "prod_from_line",
			externalPriceId: "price_from_line",
			stripeSubscriptionId: "sub_123",
		});
		if (command.kind !== "subscription") {
			throw new Error("Expected subscription invoice command");
		}
		expect(command.expiresAt?.toISOString()).toBe("2026-06-30T00:00:00.000Z");
	});

	it("normalizes current-shaped invoices with parent subscription details", () => {
		const command = normalizeStripeInvoice({
			eventId: "evt_invoice_parent_subscription",
			eventType: "invoice.paid",
			invoice: invoiceFixture({
				subscription: undefined,
				metadata: {},
				parent: {
					subscription_details: {
						subscription: "sub_parent_123",
						metadata: {
							billingAccountId: "user_from_parent",
						},
					},
				},
				lines: {
					data: [
						{
							subscription: "sub_parent_123",
							period: {
								end: futurePeriodEnd,
							},
							price: {
								id: "price_parent_subscription",
								product: "prod_parent_subscription",
							},
						},
					],
				},
			}),
		});

		expect(command).toMatchObject({
			kind: "subscription",
			billingAccountId: "user_from_parent",
			stripeSubscriptionId: "sub_parent_123",
			externalProductId: "prod_parent_subscription",
			externalPriceId: "price_parent_subscription",
		});
		if (command.kind !== "subscription") {
			throw new Error("Expected parent subscription invoice command");
		}
		expect(command.expiresAt?.toISOString()).toBe("2026-06-30T00:00:00.000Z");
	});

	it("uses the matching subscription line when invoices include one-time lines first", () => {
		const command = normalizeStripeInvoice({
			eventId: "evt_invoice_mixed_lines",
			eventType: "invoice.paid",
			invoice: invoiceFixture({
				subscription: undefined,
				metadata: {},
				parent: undefined,
				lines: {
					data: [
						{
							period: {
								end: Math.floor(Date.parse("2026-07-15T00:00:00.000Z") / 1000),
							},
							price: {
								id: "price_one_time",
								product: "prod_one_time",
							},
							parent: {
								invoice_item_details: {
									subscription: "sub_mixed_123",
								},
							},
						},
						{
							metadata: {
								billingAccountId: "user_from_subscription_line",
							},
							period: {
								end: futurePeriodEnd,
							},
							price: {
								id: "price_subscription",
								product: "prod_subscription",
							},
							parent: {
								subscription_item_details: {
									subscription: "sub_mixed_123",
								},
							},
						},
					],
				},
			}),
		});

		expect(command).toMatchObject({
			kind: "subscription",
			billingAccountId: "user_from_subscription_line",
			stripeSubscriptionId: "sub_mixed_123",
			externalProductId: "prod_subscription",
			externalPriceId: "price_subscription",
		});
		if (command.kind !== "subscription") {
			throw new Error("Expected mixed-line subscription invoice command");
		}
		expect(command.expiresAt?.toISOString()).toBe("2026-06-30T00:00:00.000Z");
	});

	it("ignores legacy invoiceitem lines when selecting recurring subscription line", () => {
		const command = normalizeStripeInvoice({
			eventId: "evt_invoice_legacy_mixed_lines",
			eventType: "invoice.paid",
			invoice: invoiceFixture({
				subscription: undefined,
				metadata: {},
				parent: undefined,
				lines: {
					data: [
						{
							type: "invoiceitem",
							subscription: "sub_legacy_mixed",
							period: {
								end: Math.floor(Date.parse("2026-07-15T00:00:00.000Z") / 1000),
							},
							price: {
								id: "price_one_time",
								product: "prod_one_time",
							},
						},
						{
							type: "subscription",
							subscription: "sub_legacy_mixed",
							metadata: {
								billingAccountId: "user_from_legacy_subscription_line",
							},
							period: {
								end: futurePeriodEnd,
							},
							price: {
								id: "price_subscription",
								product: "prod_subscription",
							},
						},
					],
				},
			}),
		});

		expect(command).toMatchObject({
			kind: "subscription",
			billingAccountId: "user_from_legacy_subscription_line",
			stripeSubscriptionId: "sub_legacy_mixed",
			externalProductId: "prod_subscription",
			externalPriceId: "price_subscription",
		});
		if (command.kind !== "subscription") {
			throw new Error("Expected legacy mixed-line subscription invoice command");
		}
		expect(command.expiresAt?.toISOString()).toBe("2026-06-30T00:00:00.000Z");
	});

	it("does not use legacy invoiceitem lines for subscription grant fields", () => {
		const command = normalizeStripeInvoice({
			eventId: "evt_invoice_legacy_invoice_item_only",
			eventType: "invoice.paid",
			invoice: invoiceFixture({
				subscription: undefined,
				metadata: {
					billingAccountId: "user_from_invoice_metadata",
					externalProductId: "prod_from_invoice_metadata",
					externalPriceId: "price_from_invoice_metadata",
				},
				parent: undefined,
				lines: {
					data: [
						{
							type: "invoiceitem",
							subscription: "sub_invoice_item_only",
							metadata: {
								billingAccountId: "user_from_invoiceitem_line",
							},
							period: {
								end: Math.floor(Date.parse("2026-07-15T00:00:00.000Z") / 1000),
							},
							price: {
								id: "price_one_time",
								product: "prod_one_time",
							},
						},
					],
				},
			}),
		});

		expect(command).toMatchObject({
			kind: "subscription",
			billingAccountId: "user_from_invoice_metadata",
			stripeSubscriptionId: "sub_invoice_item_only",
			externalProductId: "prod_from_invoice_metadata",
			externalPriceId: "price_from_invoice_metadata",
			expiresAt: null,
		});
	});

	it("does not use current invoice item lines for subscription grant fields", () => {
		const command = normalizeStripeInvoice({
			eventId: "evt_invoice_current_invoice_item_only",
			eventType: "invoice.paid",
			invoice: invoiceFixture({
				subscription: undefined,
				metadata: {
					billingAccountId: "user_from_invoice_metadata",
					externalProductId: "prod_from_invoice_metadata",
					externalPriceId: "price_from_invoice_metadata",
				},
				parent: {
					subscription_details: {
						subscription: "sub_parent_invoice_item_only",
						metadata: {
							billingAccountId: "user_from_parent_metadata",
						},
					},
				},
				lines: {
					data: [
						{
							metadata: {
								billingAccountId: "user_from_current_invoiceitem_line",
							},
							period: {
								end: Math.floor(Date.parse("2026-07-15T00:00:00.000Z") / 1000),
							},
							price: {
								id: "price_one_time",
								product: "prod_one_time",
							},
							parent: {
								invoice_item_details: {
									subscription: "sub_parent_invoice_item_only",
								},
							},
						},
					],
				},
			}),
		});

		expect(command).toMatchObject({
			kind: "subscription",
			billingAccountId: "user_from_invoice_metadata",
			stripeSubscriptionId: "sub_parent_invoice_item_only",
			externalProductId: "prod_from_invoice_metadata",
			externalPriceId: "price_from_invoice_metadata",
			expiresAt: null,
		});
	});

	it("maps Stripe subscription statuses to billing subscription statuses", () => {
		const cases: {
			stripeStatus: string;
			expectedStatus: SubscriptionStatus;
			currentPeriodEnd: number;
		}[] = [
			{ stripeStatus: "active", expectedStatus: "active", currentPeriodEnd: futurePeriodEnd },
			{ stripeStatus: "trialing", expectedStatus: "active", currentPeriodEnd: futurePeriodEnd },
			{
				stripeStatus: "past_due",
				expectedStatus: "billing_retry",
				currentPeriodEnd: futurePeriodEnd,
			},
			{ stripeStatus: "canceled", expectedStatus: "cancelled", currentPeriodEnd: futurePeriodEnd },
			{ stripeStatus: "canceled", expectedStatus: "expired", currentPeriodEnd: pastPeriodEnd },
			{ stripeStatus: "unpaid", expectedStatus: "expired", currentPeriodEnd: futurePeriodEnd },
			{
				stripeStatus: "incomplete_expired",
				expectedStatus: "expired",
				currentPeriodEnd: futurePeriodEnd,
			},
		];

		for (const testCase of cases) {
			const command = normalizeStripeSubscription({
				eventId: `evt_${testCase.stripeStatus}_${testCase.expectedStatus}`,
				eventType: "customer.subscription.updated",
				subscription: subscriptionFixture({
					status: testCase.stripeStatus,
					current_period_end: testCase.currentPeriodEnd,
				}),
				now,
			});

			expect(command.subscriptionStatus).toBe(testCase.expectedStatus);
			expect(command.projectionIdempotencyKey).toBe(
				`stripe:subscription:sub_123:customer.subscription.updated:evt_${testCase.stripeStatus}_${testCase.expectedStatus}:projection`,
			);
		}

		const scheduledCancellation = normalizeStripeSubscription({
			eventId: "evt_cancel_at_period_end",
			eventType: "customer.subscription.updated",
			subscription: subscriptionFixture({
				status: "active",
				cancel_at_period_end: true,
				current_period_end: futurePeriodEnd,
			}),
			now,
		});

		expect(scheduledCancellation.subscriptionStatus).toBe("active");
		expect(scheduledCancellation.autoRenew).toBe(false);
	});

	it("derives subscription expiry and canceled status from current item periods", () => {
		const active = normalizeStripeSubscription({
			eventId: "evt_items_active",
			eventType: "customer.subscription.updated",
			subscription: subscriptionFixture({
				current_period_end: undefined,
				items: {
					data: [
						{
							id: "si_123",
							current_period_end: futurePeriodEnd,
						},
					],
				},
			}),
			now,
		});
		const expired = normalizeStripeSubscription({
			eventId: "evt_items_canceled",
			eventType: "customer.subscription.updated",
			subscription: subscriptionFixture({
				status: "canceled",
				current_period_end: undefined,
				items: {
					data: [
						{
							id: "si_123",
							current_period_end: pastPeriodEnd,
						},
					],
				},
			}),
			now,
		});

		expect(active.expiresAt?.toISOString()).toBe("2026-06-30T00:00:00.000Z");
		expect(active.subscriptionStatus).toBe("active");
		expect(expired.expiresAt?.toISOString()).toBe("2026-05-31T00:00:00.000Z");
		expect(expired.subscriptionStatus).toBe("expired");
	});

	it("derives subscription product and price from current items before metadata", () => {
		const command = normalizeStripeSubscription({
			eventId: "evt_plan_changed",
			eventType: "customer.subscription.updated",
			subscription: subscriptionFixture({
				metadata: {
					billingAccountId: "user_1",
					externalProductId: "prod_old",
					externalPriceId: "price_old",
				},
				items: {
					data: [
						{
							id: "si_123",
							current_period_end: futurePeriodEnd,
							price: {
								id: "price_new",
								product: {
									id: "prod_new",
								},
							},
						},
					],
				},
			}),
			now,
		});

		expect(command).toMatchObject({
			externalProductId: "prod_new",
			externalPriceId: "price_new",
		});
	});

	it("uses event-scoped subscription keys for provider webhooks", () => {
		const active = normalizeStripeSubscription({
			eventId: "evt_subscription_active",
			eventType: "customer.subscription.updated",
			subscription: subscriptionFixture({
				status: "active",
			}),
			now,
		});
		const retry = normalizeStripeSubscription({
			eventId: "evt_subscription_retry",
			eventType: "customer.subscription.updated",
			subscription: subscriptionFixture({
				status: "past_due",
			}),
			now,
		});

		expect(active.projectionIdempotencyKey).toBe(
			"stripe:subscription:sub_123:customer.subscription.updated:evt_subscription_active:projection",
		);
		expect(retry.projectionIdempotencyKey).toBe(
			"stripe:subscription:sub_123:customer.subscription.updated:evt_subscription_retry:projection",
		);
		expect(active.projectionIdempotencyKey).not.toBe(retry.projectionIdempotencyKey);
	});

	it("uses deterministic state keys for subscription reconciliation", () => {
		const active = normalizeStripeSubscription({
			eventId: "evt_reconcile_active",
			eventType: "provider_reconciliation",
			projectionReason: "provider_reconciliation",
			subscription: subscriptionFixture({
				status: "active",
				current_period_end: futurePeriodEnd,
				cancel_at_period_end: false,
			}),
			now,
		});
		const retry = normalizeStripeSubscription({
			eventId: "evt_reconcile_retry",
			eventType: "provider_reconciliation",
			projectionReason: "provider_reconciliation",
			subscription: subscriptionFixture({
				status: "past_due",
				current_period_end: futurePeriodEnd,
				cancel_at_period_end: false,
			}),
			now,
		});
		const nonRenewing = normalizeStripeSubscription({
			eventId: "evt_reconcile_non_renewing",
			eventType: "provider_reconciliation",
			projectionReason: "provider_reconciliation",
			subscription: subscriptionFixture({
				status: "active",
				current_period_end: futurePeriodEnd,
				cancel_at_period_end: true,
			}),
			now,
		});
		const laterExpiry = normalizeStripeSubscription({
			eventId: "evt_reconcile_later_expiry",
			eventType: "provider_reconciliation",
			projectionReason: "provider_reconciliation",
			subscription: subscriptionFixture({
				status: "active",
				current_period_end: Math.floor(Date.parse("2026-07-31T00:00:00.000Z") / 1000),
				cancel_at_period_end: false,
			}),
			now,
		});

		expect(active.projectionIdempotencyKey).toBe(
			"stripe:subscription:sub_123:provider_reconciliation:prod_premium:price_premium_monthly:active:period_end:2026-06-30T00:00:00.000Z:auto_renew:true:projection",
		);
		expect(
			new Set([
				active.projectionIdempotencyKey,
				retry.projectionIdempotencyKey,
				nonRenewing.projectionIdempotencyKey,
				laterExpiry.projectionIdempotencyKey,
			]).size,
		).toBe(4);
	});

	it("uses current item periods in subscription reconciliation state keys", () => {
		const june = normalizeStripeSubscription({
			eventId: "evt_reconcile_items_june",
			eventType: "provider_reconciliation",
			projectionReason: "provider_reconciliation",
			subscription: subscriptionFixture({
				current_period_end: undefined,
				items: {
					data: [
						{
							id: "si_123",
							current_period_end: futurePeriodEnd,
						},
					],
				},
			}),
			now,
		});
		const july = normalizeStripeSubscription({
			eventId: "evt_reconcile_items_july",
			eventType: "provider_reconciliation",
			projectionReason: "provider_reconciliation",
			subscription: subscriptionFixture({
				current_period_end: undefined,
				items: {
					data: [
						{
							id: "si_123",
							current_period_end: Math.floor(Date.parse("2026-07-31T00:00:00.000Z") / 1000),
						},
					],
				},
			}),
			now,
		});

		expect(june.projectionIdempotencyKey).toContain("period_end:2026-06-30T00:00:00.000Z");
		expect(july.projectionIdempotencyKey).toContain("period_end:2026-07-31T00:00:00.000Z");
		expect(june.projectionIdempotencyKey).not.toBe(july.projectionIdempotencyKey);
	});
});
