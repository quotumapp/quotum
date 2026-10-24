import { describe, expect, it } from "bun:test";
import { AutoTopupDefinitiveChargeError, type AutoTopupJob } from "../../../src/billing/auto-topup";
import { STRIPE_API_VERSION } from "../../../src/providers/stripe/client";
import { StripeBillingService } from "../../../src/providers/stripe/service";
import { FakeStripeBillingClient } from "../../../src/providers/stripe/testing/fake-client";

const config = {
	apiVersion: STRIPE_API_VERSION,
	secretKey: "sk_test_recovery",
	webhookSecret: "whsec_test",
	checkoutSuccessUrl: "https://example.test/success",
	checkoutCancelUrl: "https://example.test/cancel",
	portalReturnUrl: "https://example.test/billing",
};
const job: AutoTopupJob = {
	jobId: "topup-test",
	projectId: "project",
	projectKey: "acme",
	provider: "stripe",
	providerAccountId: "acct_test",
	policyId: "1",
	customerId: "customer",
	billingAccountId: "account",
	externalCustomerId: "cus_test",
	storeProductId: "store",
	externalPriceId: "price_test",
	amountMinor: 500,
	maximumChargeMinor: 1000,
	currency: "USD",
	attempts: 1,
	consecutiveFailures: 0,
	maxConsecutiveFailures: 3,
};
function fixture() {
	const client = new FakeStripeBillingClient(config, { priceAmountsMinor: { price_test: 500 } });
	return { client, service: new StripeBillingService({ config, client, repository: {} as never }) };
}
function snapshot(status = "open") {
	return {
		status,
		total: 500,
		amount_paid: status === "paid" ? 500 : 0,
		currency: "usd",
		metadata: { autoTopupJobId: job.jobId, billingAccountId: job.billingAccountId },
		payments: { data: [{ payment: { payment_intent: "pi_saved" } }] },
	};
}
describe("automatic top-up provider recovery phases", () => {
	it("aborts before finalization when the persisted checkpoint fails", async () => {
		const { client, service } = fixture();
		let finalized = 0;
		client.finalizeInvoice = async () => {
			finalized++;
			return snapshot();
		};
		await expect(
			service.createAutoTopupCharge(job, async () => {
				throw new Error("checkpoint unavailable");
			}),
		).rejects.toThrow("checkpoint unavailable");
		expect(finalized).toBe(0);
	});
	it("checkpoints reconciliation before finalization and collection, and completion after payment", async () => {
		const { client, service } = fixture();
		const order: string[] = [];
		client.finalizeInvoice = async () => {
			order.push("finalize");
			return snapshot();
		};
		client.payInvoice = async () => {
			order.push("pay");
			return snapshot("paid");
		};
		expect(
			(
				await service.createAutoTopupCharge(job, async (receipt) => {
					order.push(receipt.result ? "complete" : (receipt.phase ?? "charge"));
				})
			).status,
		).toBe("succeeded");
		expect(order).toEqual(["charge", "reconcile", "finalize", "reconcile", "pay", "complete"]);
	});
	it.each(["requires_payment_method", "canceled"] as const)(
		"routes a reconciled %s payment through ordinary charge failure",
		async (status) => {
			const { client, service } = fixture();
			client.retrieveInvoice = async () => snapshot();
			client.retrievePaymentIntent = async (id) => ({ id, latest_charge: "ch_saved", status });
			await expect(
				service.createAutoTopupCharge({
					...job,
					phase: "reconcile",
					externalInvoiceId: "in_saved",
				}),
			).rejects.toBeInstanceOf(AutoTopupDefinitiveChargeError);
		},
	);
	it.each(["processing", "requires_confirmation", "succeeded"] as const)(
		"does not collect again while invoice/payment %s is unresolved",
		async (status) => {
			const { client, service } = fixture();
			client.retrieveInvoice = async () => snapshot();
			client.retrievePaymentIntent = async (id) => ({ id, latest_charge: "ch_saved", status });
			let payments = 0;
			client.payInvoice = async () => {
				payments++;
				return snapshot("paid");
			};
			await expect(
				service.createAutoTopupCharge({
					...job,
					phase: "reconcile",
					externalInvoiceId: "in_saved",
				}),
			).rejects.toThrow("outcome is not yet known");
			expect(payments).toBe(0);
		},
	);
	it("returns customer action for a reconciled authentication requirement", async () => {
		const { client, service } = fixture();
		client.retrieveInvoice = async () => snapshot();
		client.retrievePaymentIntent = async (id) => ({
			id,
			latest_charge: "ch_saved",
			status: "requires_action",
		});
		expect(
			await service.createAutoTopupCharge({
				...job,
				phase: "reconcile",
				externalInvoiceId: "in_saved",
			}),
		).toMatchObject({ status: "action_required", externalPaymentId: "pi_saved" });
	});
});
