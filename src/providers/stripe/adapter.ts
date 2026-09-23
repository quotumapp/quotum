import type { AutoTopupChargeResult, AutoTopupJob } from "../../billing/auto-topup";
import { changeBillingPolicyFromStripe } from "../../billing/pricing";
import type { SubscriptionChangeOperation, UsageInvoiceJob } from "../../billing/recurring";
import type { ProviderRegistryEntry, ProviderServiceSource } from "../contract";
import { adapterGroup, type OperationTiming, type ProviderAdapter } from "../contract";
import { stripeCapabilities } from "./capabilities";
import { buildStripeConfig, StripeBillingClient } from "./client";
import { StripeBillingService } from "./service";

/** Wraps a Stripe billing service without changing what any of its methods do. */
export function wrapStripeService(
	service: ProviderServiceSource<"stripe">,
	accountIdentity: string | null = null,
): ProviderAdapter<"stripe"> {
	const applySubscriptionChange = service.applySubscriptionChange;
	const createUsageInvoice = service.createUsageInvoice;
	const createAutoTopupCharge = service.createAutoTopupCharge;
	return {
		provider: "stripe",
		declaration: stripeCapabilities,
		accountIdentity,
		webhooks: { ingest: service.handleWebhook.bind(service) },
		replay: adapterGroup({ replayStoreEvent: service.replayStoreEvent?.bind(service) }),
		reconciliation: adapterGroup({
			reconcileSubscription: service.reconcileSubscription?.bind(service),
		}),
		checkout: {
			createHosted: service.createCheckoutSession.bind(service),
			status: service.getCheckoutSessionStatus.bind(service),
			...(service.createRecurringCheckoutSession === undefined
				? {}
				: { createPlan: service.createRecurringCheckoutSession.bind(service) }),
			...(service.expireCheckoutSession === undefined
				? {}
				: { expire: service.expireCheckoutSession.bind(service) }),
		},
		portal: { createSession: service.createPortalSession.bind(service) },
		commercial: adapterGroup({
			preview: service.previewCommercialAction?.bind(service),
			execute: service.executeCommercialAction?.bind(service),
			requestChange: service.requestSubscriptionChange?.bind(service),
		}),
		paymentMethods: adapterGroup({
			setupSession: service.getPaymentSetupSession?.bind(service),
		}),
		changes:
			applySubscriptionChange === undefined
				? undefined
				: {
						async apply(operation) {
							const providerRequestId = await applySubscriptionChange.call(service, operation);
							return {
								outcome: "committed",
								providerRequestId,
								timing: stripeChangeTiming(operation),
							};
						},
					},
		settlement:
			createUsageInvoice === undefined
				? undefined
				: {
						async collectFinalizedCharge(job) {
							const externalChargeId = await createUsageInvoice.call(service, job);
							return {
								outcome: "committed",
								externalChargeId,
								timing: stripeSettlementTiming(job),
							};
						},
					},
		topups:
			createAutoTopupCharge === undefined
				? undefined
				: {
						async chargeAutomatic(job: AutoTopupJob) {
							const result = await createAutoTopupCharge.call(service, job);
							return { ...result, timing: stripeAutoTopupTiming(result) };
						},
					},
		promotions: adapterGroup({ syncObject: service.syncPromotionStripeObject?.bind(service) }),
		reads: adapterGroup({
			catalog: service.getCatalog?.bind(service),
			billingAccount: service.getBillingAccount?.bind(service),
		}),
	};
}

/**
 * An immediately invoiced change only attempts collection: the subscription update succeeds even
 * when Stripe cannot charge the proration invoice or the proration is a credit. A plan change can
 * also move the subscription to a price with another billing interval, which Stripe invoices
 * immediately whatever the proration behavior, and the operation does not carry the intervals.
 * Payment is therefore uncertain until invoice events confirm it, except for a quantity change on
 * the same plan version without an immediate invoice, which bills at the next renewal. The plan
 * version and entitlements follow the resulting customer.subscription.updated event, not the
 * update call.
 */
export function stripeChangeTiming(operation: SubscriptionChangeOperation): OperationTiming {
	const billsAtRenewal =
		operation.changeKind === "quantity" &&
		changeBillingPolicyFromStripe(operation.prorationBehavior).collection === "next_renewal";
	return {
		payment: { kind: billsAtRenewal ? "scheduled_next_renewal" : "uncertain" },
		entitlement: { kind: "awaiting_provider_event" },
	};
}

/**
 * The service asks Stripe to pay a positive usage invoice but keeps only the invoice id, and the
 * pay call can return an open invoice whose payment is still processing, so collection stays
 * uncertain until invoice events confirm it. A zero or negative invoice finalizes without payment.
 */
export function stripeSettlementTiming(job: UsageInvoiceJob): OperationTiming {
	return {
		payment: { kind: job.amountMinor > 0 ? "uncertain" : "not_required" },
		entitlement: { kind: "unchanged" },
	};
}

/**
 * The service returns `succeeded` only for a paid invoice, but the charge credits nothing: the
 * worker allocates the balance and recomputes entitlements afterwards, in its own transaction, so
 * entitlements stay unchanged here and a paid but uncredited top-up remains distinguishable. A
 * customer action (a saved payment method or authentication) leaves the charge pending on the
 * customer, and a voided over-budget invoice takes no payment.
 */
export function stripeAutoTopupTiming(result: AutoTopupChargeResult): OperationTiming {
	switch (result.status) {
		case "succeeded":
			return { payment: { kind: "collected" }, entitlement: { kind: "unchanged" } };
		case "action_required":
			return { payment: { kind: "pending_customer" }, entitlement: { kind: "unchanged" } };
		case "safety_limit_exceeded":
			return { payment: { kind: "not_required" }, entitlement: { kind: "unchanged" } };
	}
}

export const stripeRegistryEntry: ProviderRegistryEntry<"stripe"> = {
	provider: "stripe",
	declaration: stripeCapabilities,
	connectionKind: "stripe",
	overrideKey: "stripeBillingService",
	label: "Stripe",
	notConfiguredStatus: 503,
	accountIdentity: (config) => config.accountIdentity ?? config.connectedAccountId ?? null,
	build({ project, config, repository, clientFactories }) {
		const clientConfig = buildStripeConfig(config);
		return new StripeBillingService({
			config: {
				...clientConfig,
				projectKey: project.projectInstanceKey,
				projectionContract: "billing_state_v1",
			},
			client:
				clientFactories.stripe?.(clientConfig, project.projectInstanceKey) ??
				new StripeBillingClient(clientConfig),
			repository,
		});
	},
	wrap: wrapStripeService,
};
