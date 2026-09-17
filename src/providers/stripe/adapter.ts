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
 * An immediately invoiced change collects payment now; other proration behaviors bill at the next
 * renewal. Immediate changes take effect now and period-end changes at their effective time.
 */
export function stripeChangeTiming(operation: SubscriptionChangeOperation): OperationTiming {
	return {
		payment: {
			kind:
				changeBillingPolicyFromStripe(operation.prorationBehavior).collection === "immediate"
					? "collected"
					: "scheduled_next_renewal",
		},
		entitlement:
			operation.effectiveMode === "period_end"
				? { kind: "effective_at", at: operation.effectiveAt }
				: { kind: "effective_now" },
	};
}

/** The service pays a positive usage invoice; a zero or negative one finalizes without payment. */
export function stripeSettlementTiming(job: UsageInvoiceJob): OperationTiming {
	return {
		payment: { kind: job.amountMinor > 0 ? "collected" : "not_required" },
		entitlement: { kind: "unchanged" },
	};
}

/**
 * A paid top-up credits the balance now. A customer action (a saved payment method or
 * authentication) leaves the charge pending on the customer, and a voided over-budget invoice
 * takes no payment.
 */
export function stripeAutoTopupTiming(result: AutoTopupChargeResult): OperationTiming {
	switch (result.status) {
		case "succeeded":
			return { payment: { kind: "collected" }, entitlement: { kind: "effective_now" } };
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
	accountIdentity: (config) => config.connectedAccountId ?? null,
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
