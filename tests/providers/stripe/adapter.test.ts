import { describe, expect, it } from "bun:test";
import type { AutoTopupChargeResult, AutoTopupJob } from "../../../src/billing/auto-topup";
import type { StripeProrationBehavior } from "../../../src/billing/pricing";
import type { SubscriptionChangeOperation, UsageInvoiceJob } from "../../../src/billing/recurring";
import type {
	OperationTiming,
	ProviderAdapter,
	ProviderServiceSource,
} from "../../../src/providers/contract";
import {
	stripeAutoTopupTiming,
	stripeChangeTiming,
	stripeSettlementTiming,
	wrapStripeService,
} from "../../../src/providers/stripe/adapter";
import { stripeCapabilities } from "../../../src/providers/stripe/capabilities";

const serviceMethods = [
	"handleWebhook",
	"replayStoreEvent",
	"reconcileSubscription",
	"createCheckoutSession",
	"createRecurringCheckoutSession",
	"getCheckoutSessionStatus",
	"expireCheckoutSession",
	"createPortalSession",
	"previewCommercialAction",
	"executeCommercialAction",
	"requestSubscriptionChange",
	"applySubscriptionChange",
	"createUsageInvoice",
	"createAutoTopupCharge",
	"syncPromotionStripeObject",
	"getCatalog",
	"getBillingAccount",
] as const;

type ServiceMethod = (typeof serviceMethods)[number];

/** The methods every Stripe service surface has; everything else is optional on fakes. */
const requiredMethods: readonly ServiceMethod[] = [
	"handleWebhook",
	"createCheckoutSession",
	"getCheckoutSessionStatus",
	"createPortalSession",
];

function recordingService(
	methods: readonly ServiceMethod[] = serviceMethods,
	results: Partial<Record<ServiceMethod, unknown>> = {},
) {
	const calls: Array<{ method: string; args: unknown[]; receiver: unknown }> = [];
	const returned = new Map<string, unknown>();
	const service: Record<string, unknown> = {};
	for (const method of methods) {
		const result = Object.hasOwn(results, method) ? results[method] : { result: method };
		returned.set(method, result);
		service[method] = function (this: unknown, ...args: unknown[]) {
			calls.push({ method, args, receiver: this });
			return Promise.resolve(result);
		};
	}
	return {
		calls,
		results: returned,
		service: service as unknown as ProviderServiceSource<"stripe">,
	};
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("adapter group or method is missing");
	return value;
}

const passthroughCases: Array<
	[string, ServiceMethod, (adapter: ProviderAdapter<"stripe">, input: never) => Promise<unknown>]
> = [
	["webhooks.ingest", "handleWebhook", (adapter, input) => adapter.webhooks.ingest(input)],
	[
		"replay.replayStoreEvent",
		"replayStoreEvent",
		(adapter, input) => required(adapter.replay).replayStoreEvent(input),
	],
	[
		"reconciliation.reconcileSubscription",
		"reconcileSubscription",
		(adapter, input) => required(adapter.reconciliation).reconcileSubscription(input),
	],
	[
		"checkout.createHosted",
		"createCheckoutSession",
		(adapter, input) => required(adapter.checkout).createHosted(input),
	],
	[
		"checkout.createPlan",
		"createRecurringCheckoutSession",
		(adapter, input) => required(required(adapter.checkout).createPlan)(input),
	],
	[
		"checkout.status",
		"getCheckoutSessionStatus",
		(adapter, input) => required(adapter.checkout).status(input),
	],
	[
		"checkout.expire",
		"expireCheckoutSession",
		(adapter, input) => required(required(adapter.checkout).expire)(input),
	],
	[
		"portal.createSession",
		"createPortalSession",
		(adapter, input) => required(adapter.portal).createSession(input),
	],
	[
		"commercial.preview",
		"previewCommercialAction",
		(adapter, input) => required(required(adapter.commercial).preview)(input),
	],
	[
		"commercial.execute",
		"executeCommercialAction",
		(adapter, input) => required(required(adapter.commercial).execute)(input),
	],
	[
		"commercial.requestChange",
		"requestSubscriptionChange",
		(adapter, input) => required(required(adapter.commercial).requestChange)(input),
	],
	[
		"promotions.syncObject",
		"syncPromotionStripeObject",
		(adapter, input) => required(adapter.promotions).syncObject(input),
	],
	["reads.catalog", "getCatalog", (adapter) => required(required(adapter.reads).catalog)()],
	[
		"reads.billingAccount",
		"getBillingAccount",
		(adapter, input) => required(required(adapter.reads).billingAccount)(input),
	],
];

function subscriptionChange(
	overrides: Partial<SubscriptionChangeOperation> = {},
): SubscriptionChangeOperation {
	return {
		changeId: "11111111-1111-4111-8111-111111111111",
		projectInstanceId: "00000000-0000-4000-8000-000000000003",
		projectKey: "voysee",
		status: "processing",
		changeKind: "upgrade",
		effectiveMode: "immediate",
		effectiveAt: "2026-09-17T00:00:00.000Z",
		prorationBehavior: "create_prorations",
		externalSubscriptionId: "sub_123",
		targetPlanVersionId: "22222222-2222-4222-8222-222222222222",
		discountCouponId: null,
		promotionRedemption: null,
		items: [{ providerSubscriptionItemId: "si_1", externalPriceId: "price_pro", quantity: 1 }],
		...overrides,
	};
}

function usageInvoiceJob(overrides: Partial<UsageInvoiceJob> = {}): UsageInvoiceJob {
	return {
		jobKind: "period",
		jobId: "33333333-3333-4333-8333-333333333333",
		periodId: "33333333-3333-4333-8333-333333333333",
		adjustmentId: null,
		projectInstanceId: "00000000-0000-4000-8000-000000000003",
		projectKey: "voysee",
		billingAccountId: "user_1",
		externalCustomerId: "cus_123",
		externalSubscriptionId: "sub_123",
		externalProductId: "prod_usage",
		featureKey: "ai_tokens",
		periodStartAt: "2026-08-01T00:00:00.000Z",
		periodEndAt: "2026-09-01T00:00:00.000Z",
		usageQuantity: "1200",
		adjustmentQuantity: null,
		includedQuantity: "1000",
		billableQuantity: "200",
		amountMinor: 400,
		currency: "usd",
		...overrides,
	};
}

const autoTopupJob: AutoTopupJob = {
	jobId: "44444444-4444-4444-8444-444444444444",
	projectId: "00000000-0000-4000-8000-000000000003",
	projectKey: "voysee",
	policyId: "55555555-5555-4555-8555-555555555555",
	customerId: "66666666-6666-4666-8666-666666666666",
	billingAccountId: "user_1",
	externalCustomerId: "cus_123",
	storeProductId: "77777777-7777-4777-8777-777777777777",
	externalPriceId: "price_topup",
	amountMinor: 1000,
	maximumChargeMinor: 1500,
	currency: "USD",
	attempts: 0,
	consecutiveFailures: 0,
	maxConsecutiveFailures: 3,
};

describe("Stripe adapter wrapper", () => {
	it("identifies the provider with its declaration and the given account identity", () => {
		const adapter = wrapStripeService(recordingService().service, "acct_123");

		expect(adapter.provider).toBe("stripe");
		expect(adapter.declaration).toBe(stripeCapabilities);
		expect(adapter.accountIdentity).toBe("acct_123");
		expect(adapter.purchases).toBeUndefined();
		expect(wrapStripeService(recordingService().service).accountIdentity).toBeNull();
	});

	it.each(passthroughCases)(
		"%s forwards its argument unchanged to %s and returns its result",
		async (_group, method, invoke) => {
			const { calls, results, service } = recordingService();
			const input = { marker: method };

			const result = await invoke(wrapStripeService(service), input as never);

			expect(calls).toHaveLength(1);
			expect(calls[0]?.method).toBe(method);
			expect(calls[0]?.args).toEqual(method === "getCatalog" ? [] : [input]);
			if (method !== "getCatalog") expect(calls[0]?.args[0]).toBe(input);
			expect(calls[0]?.receiver).toBe(service);
			expect(result).toBe(results.get(method));
		},
	);

	it("changes.apply forwards the operation and reports a committed write with change timing", async () => {
		const { calls, service } = recordingService(serviceMethods, {
			applySubscriptionChange: "sub_123",
		});
		const operation = subscriptionChange({
			prorationBehavior: "always_invoice",
			effectiveMode: "immediate",
		});

		const result = await required(wrapStripeService(service).changes).apply(operation);

		expect(calls).toEqual([
			{ method: "applySubscriptionChange", args: [operation], receiver: service },
		]);
		expect(calls[0]?.args[0]).toBe(operation);
		expect(result).toEqual({
			outcome: "committed",
			providerRequestId: "sub_123",
			timing: { payment: { kind: "uncertain" }, entitlement: { kind: "effective_now" } },
		});
	});

	it("settlement.collectFinalizedCharge forwards the job and reports the invoice as the charge", async () => {
		const { calls, service } = recordingService(serviceMethods, {
			createUsageInvoice: "in_123",
		});
		const job = usageInvoiceJob();

		const result = await required(wrapStripeService(service).settlement).collectFinalizedCharge(
			job,
		);

		expect(calls).toEqual([{ method: "createUsageInvoice", args: [job], receiver: service }]);
		expect(calls[0]?.args[0]).toBe(job);
		expect(result).toEqual({
			outcome: "committed",
			externalChargeId: "in_123",
			timing: { payment: { kind: "collected" }, entitlement: { kind: "unchanged" } },
		});
	});

	it("topups.chargeAutomatic forwards the job and keeps the charge result beside its timing", async () => {
		const charge: AutoTopupChargeResult = {
			status: "action_required",
			externalInvoiceId: null,
			externalPaymentId: null,
			reason: "A saved default payment method is required for automatic top-ups",
		};
		const { calls, service } = recordingService(serviceMethods, { createAutoTopupCharge: charge });

		const result = await required(wrapStripeService(service).topups).chargeAutomatic(autoTopupJob);

		expect(calls).toEqual([
			{ method: "createAutoTopupCharge", args: [autoTopupJob], receiver: service },
		]);
		expect(result).toEqual({
			...charge,
			timing: { payment: { kind: "pending_customer" }, entitlement: { kind: "unchanged" } },
		});
	});

	it("maps change timing from the proration behavior and effective mode", () => {
		const cases: Array<
			[StripeProrationBehavior, "immediate" | "period_end", OperationTiming["payment"]["kind"]]
		> = [
			["always_invoice", "immediate", "uncertain"],
			["create_prorations", "immediate", "scheduled_next_renewal"],
			["none", "immediate", "scheduled_next_renewal"],
			["always_invoice", "period_end", "uncertain"],
			["create_prorations", "period_end", "scheduled_next_renewal"],
			["none", "period_end", "scheduled_next_renewal"],
		];

		for (const [prorationBehavior, effectiveMode, payment] of cases) {
			const operation = subscriptionChange({
				prorationBehavior,
				effectiveMode,
				effectiveAt: "2026-10-01T00:00:00.000Z",
			});
			expect(stripeChangeTiming(operation)).toEqual({
				payment: { kind: payment },
				entitlement:
					effectiveMode === "immediate"
						? { kind: "effective_now" }
						: { kind: "effective_at", at: "2026-10-01T00:00:00.000Z" },
			});
		}
	});

	it("never reports an immediately invoiced change as collected, whatever its direction", () => {
		// The update succeeds with a declined or credit proration invoice; only invoice events confirm payment.
		for (const changeKind of ["upgrade", "downgrade", "quantity"] as const) {
			expect(
				stripeChangeTiming(subscriptionChange({ changeKind, prorationBehavior: "always_invoice" }))
					.payment,
			).toEqual({ kind: "uncertain" });
		}
	});

	it("maps settlement timing from the invoice amount", () => {
		expect(stripeSettlementTiming(usageInvoiceJob({ amountMinor: 1 })).payment.kind).toBe(
			"collected",
		);
		for (const amountMinor of [0, -250]) {
			expect(
				stripeSettlementTiming(usageInvoiceJob({ jobKind: "adjustment", amountMinor })),
			).toEqual({ payment: { kind: "not_required" }, entitlement: { kind: "unchanged" } });
		}
	});

	it("maps automatic top-up timing from the charge status", () => {
		expect(
			stripeAutoTopupTiming({
				status: "succeeded",
				externalInvoiceId: "in_1",
				externalPaymentId: "pi_1",
				amountPaidMinor: 1000,
				currency: "USD",
			}),
		).toEqual({ payment: { kind: "collected" }, entitlement: { kind: "effective_now" } });
		expect(
			stripeAutoTopupTiming({
				status: "action_required",
				externalInvoiceId: "in_1",
				externalPaymentId: "pi_1",
				reason: "authentication_required",
			}),
		).toEqual({ payment: { kind: "pending_customer" }, entitlement: { kind: "unchanged" } });
		expect(
			stripeAutoTopupTiming({
				status: "safety_limit_exceeded",
				externalInvoiceId: "in_1",
				externalPaymentId: null,
				reason: "over budget",
			}),
		).toEqual({ payment: { kind: "not_required" }, entitlement: { kind: "unchanged" } });
	});

	it("never reports an uncertain write", async () => {
		const { service } = recordingService(serviceMethods, {
			applySubscriptionChange: "sub_123",
			createUsageInvoice: "in_123",
		});
		const adapter = wrapStripeService(service);

		for (const operation of [
			subscriptionChange(),
			subscriptionChange({ effectiveMode: "period_end", prorationBehavior: "none" }),
		]) {
			expect((await required(adapter.changes).apply(operation)).outcome).toBe("committed");
		}
		for (const job of [usageInvoiceJob(), usageInvoiceJob({ amountMinor: 0 })]) {
			expect((await required(adapter.settlement).collectFinalizedCharge(job)).outcome).toBe(
				"committed",
			);
		}
	});

	it("leaves groups and methods undefined when a partial service lacks them", () => {
		const adapter = wrapStripeService(recordingService(requiredMethods).service);

		expect(adapter.webhooks.ingest).toBeFunction();
		expect(Object.keys(required(adapter.checkout)).sort()).toEqual(["createHosted", "status"]);
		expect(adapter.portal?.createSession).toBeFunction();
		for (const group of [
			"replay",
			"reconciliation",
			"commercial",
			"changes",
			"settlement",
			"topups",
			"promotions",
			"reads",
		] as const) {
			expect(adapter[group]).toBeUndefined();
		}
	});

	it("keeps only the commercial methods a partial service has", () => {
		const adapter = wrapStripeService(
			recordingService([...requiredMethods, "previewCommercialAction"]).service,
		);

		expect(Object.keys(required(adapter.commercial))).toEqual(["preview"]);
	});
});
