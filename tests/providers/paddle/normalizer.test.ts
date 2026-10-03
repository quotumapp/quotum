import { describe, expect, it } from "bun:test";
import { normalizePaddleEvent } from "../../../src/providers/paddle/normalizer";
import { event, id, subscription, transaction } from "./fixtures";

describe("Paddle event normalization", () => {
	it("preserves negative proration quantities and totals on completed change transactions", () => {
		const credit = {
			...transaction,
			origin: "subscription_update",
			details: {
				totals: { total: "-500", tax: "0", grand_total: "0", currency_code: "USD" },
				line_items: [
					{
						...transaction.details.line_items[0],
						quantity: -1,
						totals: { total: "-500", tax: "0" },
					},
				],
			},
		};
		expect(normalizePaddleEvent(event("transaction.completed", credit))).toMatchObject({
			kind: "transaction",
			transaction: credit,
		});
	});
	it("separates paid transaction facts from subscription access, including trials", () => {
		expect(
			normalizePaddleEvent(
				event("subscription.trialing", {
					...subscription,
					status: "trialing",
					items: [
						{
							...subscription.items[0],
							trial_dates: {
								starts_at: "2026-10-01T03:00:00+03:00",
								ends_at: "2026-10-08T03:00:00+03:00",
							},
						},
					],
				}),
			),
		).toMatchObject({
			kind: "subscription",
			status: "active",
			trial: { startsAt: "2026-10-01T00:00:00.000Z", endsAt: "2026-10-08T00:00:00.000Z" },
		});
		expect(normalizePaddleEvent(event("transaction.completed", transaction))).toMatchObject({
			kind: "transaction",
		});
		expect(
			normalizePaddleEvent(event("transaction.paid", { ...transaction, status: "paid" })),
		).toMatchObject({ kind: "ignored" });
		expect(() =>
			normalizePaddleEvent(event("transaction.completed", { ...transaction, status: "paid" })),
		).toThrow("incomplete transaction");
	});
	it("distinguishes retry, canceled and paused access while retaining cancellation timing", () => {
		for (const [remote, local] of [
			["past_due", "billing_retry"],
			["canceled", "cancelled"],
			["paused", "expired"],
		]) {
			expect(
				normalizePaddleEvent(event("subscription.updated", { ...subscription, status: remote })),
			).toMatchObject({
				kind: "subscription",
				status: local,
				effectiveAt: subscription.updated_at,
			});
		}
		expect(
			normalizePaddleEvent(
				event("subscription.updated", {
					...subscription,
					scheduled_change: { action: "cancel", effective_at: "2026-11-01T00:00:00Z" },
				}),
			),
		).toMatchObject({ cancelAtPeriodEnd: true });
	});
	it("waits for adjustment approval and reconciles reversals without a second debit", () => {
		const adjustment = {
			id: id("adj"),
			transaction_id: transaction.id,
			customer_id: id("ctm"),
			action: "refund",
			status: "pending_approval",
			currency_code: "USD",
			updated_at: subscription.updated_at,
			totals: { total: "1000", tax: "0" },
			items: [{ item_id: id("txnitm"), totals: { total: "1000", tax: "0" } }],
		};
		for (const status of ["pending_approval", "rejected"])
			expect(
				normalizePaddleEvent(event("adjustment.updated", { ...adjustment, status })),
			).toMatchObject({ requiresPurchaseReconciliation: false });
		for (const status of ["approved", "reversed"])
			expect(
				normalizePaddleEvent(event("adjustment.updated", { ...adjustment, status })),
			).toMatchObject({ requiresPurchaseReconciliation: true });
		expect(
			normalizePaddleEvent(
				event("adjustment.created", {
					...adjustment,
					action: "chargeback_warning_reverse",
					status: "approved",
				}),
			),
		).toMatchObject({ requiresPurchaseReconciliation: true });
	});
	it("rejects malformed known events and ignores unrelated event types", () => {
		expect(() => normalizePaddleEvent(event("subscription.updated", {}))).toThrow();
		expect(normalizePaddleEvent(event("customer.updated", {}))).toMatchObject({ kind: "ignored" });
	});
});
