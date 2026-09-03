import { describe, expect, it } from "bun:test";
import type Stripe from "stripe";
import type { AutoTopupJob } from "../../../src/billing/auto-topup";
import type {
	ProviderSubscriptionReconciliationRow,
	StoreEventReplayJobRow,
	StripeCatalog,
	StripeRecordingResult,
	StripeRecurringCheckoutPlan,
	StripeWebStoreProductRow,
} from "../../../src/db/repository";
import { StripeBillingService } from "../../../src/providers/stripe/service";

const config = {
	checkoutSuccessUrl: "https://app.voysee.com/billing/success?session_id={CHECKOUT_SESSION_ID}",
	checkoutCancelUrl: "https://app.voysee.com/billing",
	portalReturnUrl: "https://app.voysee.com/account/billing",
};

const checkoutUrl = "https://checkout.stripe.com/c/pay/cs_123";
const portalUrl = "https://billing.stripe.com/session/bps_123";
const entitlementSnapshot = {
	billingAccountId: "user_1",
	generatedAt: "2026-06-01T00:00:00.000Z",
	entitlements: [],
};

function stripeProduct(
	overrides: Partial<StripeWebStoreProductRow> = {},
): StripeWebStoreProductRow {
	return {
		storeProductId: "store_product_credits_100",
		productId: "internal_product_credits_100",
		productKey: "credits_100",
		productType: "consumable",
		creditAmount: 100,
		externalProductId: "prod_stripe_credits_100",
		externalPriceId: "price_credits_100",
		billingPeriod: "one_time",
		currency: "usd",
		priceAmount: 499,
		...overrides,
	};
}

function serviceFixture(
	overrides: {
		products?: Record<string, StripeWebStoreProductRow>;
		checkoutSession?: Partial<Stripe.Checkout.Session>;
		portalSession?: Partial<Stripe.BillingPortal.Session>;
		statusSession?: {
			id?: string;
			status?: string | null;
			payment_status?: string | null;
			client_reference_id?: string | null;
			customer_email?: string | null;
			customer_details?: { email?: string | null } | null;
			metadata?: Stripe.Metadata | null;
		};
		webhookEvent?: unknown;
		constructWebhookError?: unknown;
		retrievedSubscription?: Record<string, unknown>;
		recordingResult?: "processed" | "skipped" | "ignored";
		customerId?: string;
		existingCustomerId?: string | null;
		linkedCustomerId?: string;
		catalog?: StripeCatalog;
		recurringPlan?: StripeRecurringCheckoutPlan;
		defaultPaymentMethod?: string | null;
		finalizedInvoice?: Record<string, unknown>;
		paidInvoice?: Record<string, unknown>;
		payInvoiceError?: unknown;
	} = {},
) {
	const calls: unknown[] = [];
	const repositoryInputs: unknown[] = [];
	const products = overrides.products ?? {
		credits_100: stripeProduct(),
		premium_monthly: stripeProduct({
			storeProductId: "store_product_premium_monthly",
			productId: "internal_product_premium",
			productKey: "premium_monthly",
			productType: "subscription",
			creditAmount: 0,
			externalProductId: "prod_stripe_premium",
			externalPriceId: "price_premium_monthly",
			billingPeriod: "month",
			priceAmount: 999,
		}),
	};
	const checkoutSession = {
		id: "cs_123",
		url: checkoutUrl,
		...overrides.checkoutSession,
	} as Stripe.Checkout.Session;
	const portalSession = {
		id: "bps_123",
		url: portalUrl,
		...overrides.portalSession,
	} as Stripe.BillingPortal.Session;
	const statusSession = {
		id: "cs_123",
		status: "complete",
		payment_status: "paid",
		client_reference_id: "user_1",
		metadata: { billingAccountId: "user_1" },
		...overrides.statusSession,
	} as Stripe.Checkout.Session;
	const customerId = overrides.customerId ?? "cus_123";
	const existingCustomerId = overrides.existingCustomerId ?? null;
	const linkedCustomerId = overrides.linkedCustomerId;
	const recordingResult = (): StripeRecordingResult =>
		overrides.recordingResult === "skipped"
			? { processingStatus: "skipped", billingAccountId: null, entitlements: null }
			: overrides.recordingResult === "ignored"
				? { processingStatus: "ignored", billingAccountId: null, entitlements: null }
				: {
						processingStatus: "processed",
						billingAccountId: "user_1",
						entitlements: entitlementSnapshot,
					};

	const service = new StripeBillingService({
		config,
		client: {
			createCustomer(input) {
				calls.push({ method: "createCustomer", input });
				return Promise.resolve({ id: customerId } as Stripe.Customer);
			},
			createCheckoutSession(params) {
				calls.push({ method: "createCheckoutSession", params });
				return Promise.resolve(checkoutSession);
			},
			createPortalSession(params) {
				calls.push({ method: "createPortalSession", params });
				return Promise.resolve(portalSession);
			},
			retrieveCheckoutSession(sessionId) {
				calls.push({ method: "retrieveCheckoutSession", sessionId });
				return Promise.resolve(statusSession);
			},
			constructWebhookEvent(rawBody, signature) {
				calls.push({ method: "constructWebhookEvent", rawBody, signature });
				if (overrides.constructWebhookError !== undefined) {
					throw overrides.constructWebhookError;
				}

				return (
					overrides.webhookEvent ??
					stripeEvent("checkout.session.completed", checkoutSessionObject())
				);
			},
			retrieveSubscription(subscriptionId) {
				calls.push({ method: "retrieveSubscription", subscriptionId });
				return Promise.resolve(overrides.retrievedSubscription ?? subscriptionObject());
			},
			retrieveDefaultPaymentMethod(stripeCustomerId) {
				calls.push({ method: "retrieveDefaultPaymentMethod", stripeCustomerId });
				return Promise.resolve(
					overrides.defaultPaymentMethod === undefined
						? "pm_default"
						: overrides.defaultPaymentMethod,
				);
			},
			updateSubscription(subscriptionId, params, idempotencyKey) {
				calls.push({ method: "updateSubscription", subscriptionId, params, idempotencyKey });
				return Promise.resolve({ id: subscriptionId });
			},
			createInvoice(params, idempotencyKey) {
				calls.push({ method: "createInvoice", params, idempotencyKey });
				return Promise.resolve({ id: "in_usage" });
			},
			addInvoiceLines(invoiceId, params, idempotencyKey) {
				calls.push({ method: "addInvoiceLines", invoiceId, params, idempotencyKey });
				return Promise.resolve({});
			},
			finalizeInvoice(invoiceId, idempotencyKey) {
				calls.push({ method: "finalizeInvoice", invoiceId, idempotencyKey });
				return Promise.resolve(
					overrides.finalizedInvoice ?? {
						id: invoiceId,
						status: "open",
						total: 500,
						amount_paid: 0,
						currency: "usd",
						payments: { data: [] },
					},
				);
			},
			payInvoice(invoiceId, idempotencyKey) {
				calls.push({ method: "payInvoice", invoiceId, idempotencyKey });
				if (overrides.payInvoiceError !== undefined) throw overrides.payInvoiceError;
				return Promise.resolve(
					overrides.paidInvoice ?? {
						id: invoiceId,
						status: "paid",
						total: 500,
						amount_paid: 500,
						currency: "usd",
						payments: {
							data: [{ payment: { type: "payment_intent", payment_intent: "pi_topup" } }],
						},
					},
				);
			},
			voidInvoice(invoiceId, idempotencyKey) {
				calls.push({ method: "voidInvoice", invoiceId, idempotencyKey });
				return Promise.resolve({ id: invoiceId, status: "void" });
			},
		},
		repository: {
			listStripeCatalog() {
				return Promise.resolve(
					overrides.catalog ?? {
						schemaVersion: 1 as const,
						plans: [],
						oneTimePurchases: [],
					},
				);
			},
			getStripeBillingAccountSummary() {
				return Promise.resolve({
					schemaVersion: 1 as const,
					customerExists: false,
					subscriptions: [],
					recentInvoices: [],
				});
			},
			prepareStripeCheckoutRequest(_input) {
				return Promise.resolve({
					status: "creating" as const,
					externalSessionId: null,
					sessionUrl: null,
				});
			},
			completeStripeCheckoutRequest(input) {
				return Promise.resolve({
					status: "created" as const,
					externalSessionId: input.externalSessionId,
					sessionUrl: input.sessionUrl,
				});
			},
			getStripeWebStoreProductByKey(productKey) {
				calls.push({ method: "getStripeWebStoreProductByKey", productKey });
				const product = products[productKey];
				if (product === undefined) {
					throw new Error(`Missing product ${productKey}`);
				}
				return Promise.resolve(product);
			},
			getStripeRecurringCheckoutPlanByKey() {
				if (overrides.recurringPlan === undefined) throw new Error("Missing recurring plan");
				return Promise.resolve(overrides.recurringPlan);
			},
			hasActiveBasePlan() {
				return Promise.resolve(true);
			},
			getStripeProviderCustomer(input) {
				calls.push({ method: "getStripeProviderCustomer", input });
				return Promise.resolve(existingCustomerId);
			},
			linkStripeProviderCustomer(input) {
				calls.push({ method: "linkStripeProviderCustomer", input });
				return Promise.resolve(linkedCustomerId ?? input.stripeCustomerId);
			},
			recordStripeCreditPurchaseAndEnqueueProjection(input) {
				calls.push({ method: "recordStripeCreditPurchaseAndEnqueueProjection", input });
				repositoryInputs.push(input);
				return Promise.resolve(recordingResult());
			},
			recordStripeSubscriptionAndEnqueueProjection(input) {
				calls.push({ method: "recordStripeSubscriptionAndEnqueueProjection", input });
				repositoryInputs.push(input);
				return Promise.resolve(recordingResult());
			},
			recordStripeCreditReversalAndEnqueueProjection(input) {
				calls.push({ method: "recordStripeCreditReversalAndEnqueueProjection", input });
				repositoryInputs.push(input);
				return Promise.resolve(recordingResult());
			},
			recordStripeSkippedEvent(input) {
				calls.push({ method: "recordStripeSkippedEvent", input });
				repositoryInputs.push(input);
				return Promise.resolve({
					processingStatus: "skipped",
					billingAccountId: null,
					entitlements: null,
				});
			},
		},
	});

	return { calls, repositoryInputs, service };
}

function checkoutMetadata(product: StripeWebStoreProductRow) {
	return {
		billingAccountId: "user_1",
		productKey: product.productKey,
		storeProductId: product.storeProductId,
		purchaseKind: product.productType,
		billingEnvironment: "web",
		externalProductId: product.externalProductId,
		externalPriceId: product.externalPriceId,
	};
}

function stripeEvent(type: string, object: Record<string, unknown>, id = "evt_123") {
	return {
		id,
		type,
		data: { object },
	};
}

function checkoutSessionObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "cs_123",
		mode: "payment",
		payment_status: "paid",
		customer: "cus_123",
		payment_intent: "pi_123",
		charge: "ch_123",
		created: 1_780_185_600,
		metadata: {
			billingAccountId: "user_1",
			productKey: "credits_100",
			purchaseKind: "consumable",
			externalProductId: "prod_credits_100",
			externalPriceId: "price_credits_100",
		},
		...overrides,
	};
}

function invoiceObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "in_123",
		status: "paid",
		customer: "cus_123",
		subscription: "sub_123",
		created: 1_780_185_600,
		metadata: {
			billingAccountId: "user_1",
			externalProductId: "prod_premium",
			externalPriceId: "price_premium_monthly",
		},
		lines: {
			data: [
				{
					type: "subscription",
					period: { end: 1_782_777_600 },
					price: { id: "price_premium_monthly", product: "prod_premium" },
				},
			],
		},
		...overrides,
	};
}

function subscriptionObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "sub_123",
		status: "active",
		customer: "cus_123",
		latest_invoice: "in_123",
		created: 1_780_185_600,
		current_period_end: 1_782_777_600,
		cancel_at_period_end: false,
		metadata: {
			billingAccountId: "user_1",
			externalProductId: "prod_premium",
			externalPriceId: "price_premium_monthly",
		},
		...overrides,
	};
}

function refundObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "re_123",
		status: "succeeded",
		amount: 499,
		currency: "usd",
		customer: "cus_123",
		payment_intent: "pi_123",
		charge: "ch_123",
		created: 1_780_185_600,
		metadata: { billingAccountId: "user_1" },
		...overrides,
	};
}

function disputeObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "dp_123",
		amount: 499,
		currency: "usd",
		customer: "cus_123",
		payment_intent: "pi_123",
		charge: "ch_123",
		created: 1_780_185_600,
		metadata: { billingAccountId: "user_1" },
		...overrides,
	};
}

function storeEvent(overrides: Partial<StoreEventReplayJobRow> = {}): StoreEventReplayJobRow {
	return {
		id: "event_1",
		project_id: "project_1",
		project_key: "voysee",
		provider: "stripe",
		channel: "web",
		external_event_id: "evt_123",
		event_type: "checkout.session.completed",
		customer_id: null,
		store_product_id: null,
		transaction_id: "pi_123",
		purchase_kind: "consumable",
		processing_status: "processing",
		processing_error: "Stripe customer could not be resolved",
		attempts: 1,
		next_attempt_at: null,
		raw_payload: checkoutSessionObject(),
		processed_at: null,
		locked_at: "2026-06-01T00:00:00.000Z",
		locked_by: "worker-a",
		created_at: "2026-06-01T00:00:00.000Z",
		updated_at: "2026-06-01T00:00:00.000Z",
		...overrides,
	};
}

function reconciliationSubscription(
	overrides: Partial<ProviderSubscriptionReconciliationRow> = {},
): ProviderSubscriptionReconciliationRow {
	return {
		id: "subscription_1",
		project_id: "project_1",
		project_key: "voysee",
		provider: "stripe",
		channel: "web",
		external_subscription_id: "sub_123",
		external_product_id: "prod_premium",
		external_price_id: "price_premium_monthly",
		latest_transaction_id: "in_123",
		status: "active",
		expires_at: "2026-06-30T00:00:00.000Z",
		provider_reconciliation_attempts: 1,
		...overrides,
	};
}

function autoTopupJob(): AutoTopupJob {
	return {
		jobId: "topup-job-1",
		projectId: "project-1",
		projectKey: "voysee",
		policyId: "7",
		customerId: "customer-1",
		billingAccountId: "user_1",
		externalCustomerId: "cus_123",
		storeProductId: "store-topup",
		externalPriceId: "price_topup",
		amountMinor: 500,
		maximumChargeMinor: 600,
		currency: "USD",
		attempts: 1,
		consecutiveFailures: 0,
		maxConsecutiveFailures: 3,
	};
}

describe("StripeBillingService", () => {
	it("returns the canonical recurring catalog without version negotiation", async () => {
		const catalog: StripeCatalog = {
			schemaVersion: 1,
			plans: [],
			oneTimePurchases: [
				{
					key: "credits_100",
					name: "Credits 100",
					kind: "topup",
					currency: "USD",
					amountMinor: 499,
					credits: 100,
				},
			],
		};
		const { service } = serviceFixture({ catalog });

		expect(await service.getCatalog()).toEqual(catalog);
	});

	it("creates payment Checkout Sessions for consumables with session and PaymentIntent metadata", async () => {
		const product = stripeProduct();
		const { calls, service } = serviceFixture({ products: { credits_100: product } });

		const result = await service.createCheckoutSession({
			billingAccountId: " user_1 ",
			productKey: " credits_100 ",
			email: "reader@example.com",
		});

		const metadata = checkoutMetadata(product);
		expect(result).toEqual({ sessionId: "cs_123", url: checkoutUrl, duplicate: false });
		expect(calls).toEqual([
			{ method: "getStripeWebStoreProductByKey", productKey: "credits_100" },
			{
				method: "getStripeProviderCustomer",
				input: { billingAccountId: "user_1", email: "reader@example.com" },
			},
			{
				method: "createCustomer",
				input: { billingAccountId: "user_1", email: "reader@example.com" },
			},
			{
				method: "linkStripeProviderCustomer",
				input: {
					billingAccountId: "user_1",
					stripeCustomerId: "cus_123",
					email: "reader@example.com",
				},
			},
			{
				method: "createCheckoutSession",
				params: {
					customer: "cus_123",
					mode: "payment",
					line_items: [{ price: "price_credits_100", quantity: 1 }],
					success_url: config.checkoutSuccessUrl,
					cancel_url: config.checkoutCancelUrl,
					client_reference_id: "user_1",
					integration_identifier: "qfmxzjpa",
					metadata,
					payment_intent_data: { metadata },
				},
			},
		]);
	});

	it("creates subscription Checkout Sessions with subscription metadata only", async () => {
		const product = stripeProduct({
			storeProductId: "store_product_premium_monthly",
			productId: "internal_product_premium",
			productKey: "premium_monthly",
			productType: "subscription",
			creditAmount: 0,
			externalProductId: "prod_stripe_premium",
			externalPriceId: "price_premium_monthly",
			billingPeriod: "month",
			priceAmount: 999,
		});
		const { calls, service } = serviceFixture({ products: { premium_monthly: product } });

		const result = await service.createCheckoutSession({
			billingAccountId: "user_1",
			productKey: "premium_monthly",
		});

		const metadata = checkoutMetadata(product);
		const checkoutCall = calls.at(-1) as {
			method: "createCheckoutSession";
			params: Stripe.Checkout.SessionCreateParams;
		};
		expect(result).toEqual({ sessionId: "cs_123", url: checkoutUrl, duplicate: false });
		expect(checkoutCall).toEqual({
			method: "createCheckoutSession",
			params: {
				customer: "cus_123",
				mode: "subscription",
				line_items: [{ price: "price_premium_monthly", quantity: 1 }],
				success_url: config.checkoutSuccessUrl,
				cancel_url: config.checkoutCancelUrl,
				client_reference_id: "user_1",
				integration_identifier: "qfmxzjpa",
				metadata,
				subscription_data: { metadata },
			},
		});
		expect("payment_intent_data" in checkoutCall.params).toBe(false);
	});

	it("creates hybrid recurring Checkout with explicit seats and trial behavior", async () => {
		const { calls, service } = serviceFixture({
			recurringPlan: {
				planVersionId: "42",
				planKey: "pro",
				name: "Pro",
				kind: "base",
				trialDays: 14,
				trialRequiresPaymentMethod: false,
				trialEndBehavior: "pause",
				components: [
					{
						priceComponentId: "1",
						priceKey: "base",
						componentKind: "base",
						featureKey: null,
						externalProductId: "prod_pro",
						externalPriceId: "price_pro",
						defaultQuantity: 1,
						minimumQuantity: 1,
						maximumQuantity: 1,
						unitAmountMinor: 999,
						pricingModel: "flat",
						currency: "USD",
						billingInterval: "month",
					},
					{
						priceComponentId: "2",
						priceKey: "seat",
						componentKind: "licensed",
						featureKey: "seats",
						externalProductId: "prod_seat",
						externalPriceId: "price_seat",
						defaultQuantity: 1,
						minimumQuantity: 1,
						maximumQuantity: 100,
						unitAmountMinor: 200,
						pricingModel: "flat",
						currency: "USD",
						billingInterval: "month",
					},
				],
			},
		});
		await service.createRecurringCheckoutSession({
			billingAccountId: "user_1",
			planKey: "pro",
			quantities: { seats: 8 },
		});
		const call = calls.at(-1) as { params: Stripe.Checkout.SessionCreateParams };
		expect(call.params).toMatchObject({
			mode: "subscription",
			line_items: [
				{ price: "price_pro", quantity: 1 },
				{ price: "price_seat", quantity: 8 },
			],
			payment_method_collection: "if_required",
			subscription_data: {
				trial_period_days: 14,
				trial_settings: { end_behavior: { missing_payment_method: "pause" } },
			},
		});
	});

	it("creates, lines, finalizes, and pays one idempotent usage invoice", async () => {
		const { calls, service } = serviceFixture();
		expect(
			await service.createUsageInvoice({
				jobKind: "period",
				jobId: "period-1",
				periodId: "period-1",
				adjustmentId: null,
				projectKey: "voysee",
				billingAccountId: "user_1",
				externalCustomerId: "cus_123",
				externalSubscriptionId: "sub_123",
				externalProductId: "prod_usage",
				featureKey: "api_calls",
				periodStartAt: "2026-01-01T00:00:00.000Z",
				periodEndAt: "2026-02-01T00:00:00.000Z",
				usageQuantity: "1250",
				adjustmentQuantity: null,
				includedQuantity: "1000",
				billableQuantity: "250",
				amountMinor: 125,
				currency: "usd",
			}),
		).toBe("in_usage");
		expect(calls.slice(-4).map((call) => (call as { method: string }).method)).toEqual([
			"createInvoice",
			"addInvoiceLines",
			"finalizeInvoice",
			"payInvoice",
		]);
		expect(calls.at(-3)).toMatchObject({
			params: {
				lines: [
					{
						price_data: { product: "prod_usage", currency: "usd", unit_amount: 125 },
						quantity: 1,
					},
				],
			},
		});
	});

	it("creates a negative late-correction line without attempting payment", async () => {
		const { calls, service } = serviceFixture();
		expect(
			await service.createUsageInvoice({
				jobKind: "adjustment",
				jobId: "42",
				periodId: "period-1",
				adjustmentId: "42",
				projectKey: "voysee",
				billingAccountId: "user_1",
				externalCustomerId: "cus_123",
				externalSubscriptionId: "sub_123",
				externalProductId: "prod_usage",
				featureKey: "api_calls",
				periodStartAt: "2026-01-01T00:00:00.000Z",
				periodEndAt: "2026-02-01T00:00:00.000Z",
				usageQuantity: "1250",
				adjustmentQuantity: "-300",
				includedQuantity: "1000",
				billableQuantity: "250",
				amountMinor: -125,
				currency: "usd",
			}),
		).toBe("in_usage");
		expect(calls.slice(-3).map((call) => (call as { method: string }).method)).toEqual([
			"createInvoice",
			"addInvoiceLines",
			"finalizeInvoice",
		]);
		expect(calls.at(-2)).toMatchObject({
			params: { lines: [{ amount: -125, quantity: 1 }] },
		});
	});

	it("charges a saved Stripe payment method for one idempotent automatic top-up", async () => {
		const { calls, service } = serviceFixture();
		expect(await service.createAutoTopupCharge(autoTopupJob())).toEqual({
			status: "succeeded",
			externalInvoiceId: "in_usage",
			externalPaymentId: "pi_topup",
			amountPaidMinor: 500,
			currency: "USD",
		});
		expect(calls.slice(-5).map((call) => (call as { method: string }).method)).toEqual([
			"retrieveDefaultPaymentMethod",
			"createInvoice",
			"addInvoiceLines",
			"finalizeInvoice",
			"payInvoice",
		]);
		expect(calls.at(-4)).toMatchObject({
			params: {
				customer: "cus_123",
				currency: "usd",
				collection_method: "charge_automatically",
				default_payment_method: "pm_default",
			},
			idempotencyKey: "billing:auto-topup:topup-job-1:create",
		});
		expect(calls.at(-3)).toMatchObject({
			params: { lines: [{ pricing: { price: "price_topup" }, quantity: 1 }] },
			idempotencyKey: "billing:auto-topup:topup-job-1:line",
		});
	});

	it("requires a saved default payment method before an automatic top-up", async () => {
		const { calls, service } = serviceFixture({ defaultPaymentMethod: null });
		expect(await service.createAutoTopupCharge(autoTopupJob())).toEqual({
			status: "action_required",
			externalInvoiceId: null,
			externalPaymentId: null,
			reason: "A saved default payment method is required for automatic top-ups",
		});
		expect(calls.at(-1)).toEqual({
			method: "retrieveDefaultPaymentMethod",
			stripeCustomerId: "cus_123",
		});
	});

	it("voids an automatic top-up invoice before payment when tax exceeds the safety budget", async () => {
		const { calls, service } = serviceFixture({
			finalizedInvoice: {
				id: "in_usage",
				status: "open",
				total: 601,
				amount_paid: 0,
				currency: "usd",
				payments: { data: [] },
			},
		});
		expect(await service.createAutoTopupCharge(autoTopupJob())).toEqual({
			status: "safety_limit_exceeded",
			externalInvoiceId: "in_usage",
			externalPaymentId: null,
			reason: "The finalized Stripe invoice exceeded the automatic top-up safety budget",
		});
		expect(calls.slice(-2).map((call) => (call as { method: string }).method)).toEqual([
			"finalizeInvoice",
			"voidInvoice",
		]);
	});

	it("returns action-required when Stripe requests off-session authentication", async () => {
		const paymentError = Object.assign(new Error("Customer authentication is required"), {
			code: "invoice_payment_intent_requires_action",
			payment_intent: { id: "pi_action" },
		});
		const { service } = serviceFixture({ payInvoiceError: paymentError });
		expect(await service.createAutoTopupCharge(autoTopupJob())).toEqual({
			status: "action_required",
			externalInvoiceId: "in_usage",
			externalPaymentId: "pi_action",
			reason: "Customer authentication is required",
		});
	});

	it("reuses linked Stripe customers for repeat Checkout Sessions", async () => {
		const product = stripeProduct();
		const { calls, service } = serviceFixture({
			products: { credits_100: product },
			existingCustomerId: "cus_existing",
		});

		const result = await service.createCheckoutSession({
			billingAccountId: "user_1",
			productKey: "credits_100",
			email: "reader@example.com",
		});

		expect(result).toEqual({ sessionId: "cs_123", url: checkoutUrl, duplicate: false });
		expect(calls).toEqual([
			{ method: "getStripeWebStoreProductByKey", productKey: "credits_100" },
			{
				method: "getStripeProviderCustomer",
				input: { billingAccountId: "user_1", email: "reader@example.com" },
			},
			{
				method: "createCheckoutSession",
				params: {
					customer: "cus_existing",
					mode: "payment",
					line_items: [{ price: "price_credits_100", quantity: 1 }],
					success_url: config.checkoutSuccessUrl,
					cancel_url: config.checkoutCancelUrl,
					client_reference_id: "user_1",
					integration_identifier: "qfmxzjpa",
					metadata: checkoutMetadata(product),
					payment_intent_data: { metadata: checkoutMetadata(product) },
				},
			},
		]);
	});

	it("uses the linked Stripe customer returned by the repository for Checkout Sessions", async () => {
		const product = stripeProduct();
		const { calls, service } = serviceFixture({
			products: { credits_100: product },
			customerId: "cus_loser",
			linkedCustomerId: "cus_winner",
		});

		const result = await service.createCheckoutSession({
			billingAccountId: "user_1",
			productKey: "credits_100",
		});

		expect(result).toEqual({ sessionId: "cs_123", url: checkoutUrl, duplicate: false });
		expect(calls).toEqual([
			{ method: "getStripeWebStoreProductByKey", productKey: "credits_100" },
			{ method: "getStripeProviderCustomer", input: { billingAccountId: "user_1", email: null } },
			{ method: "createCustomer", input: { billingAccountId: "user_1", email: null } },
			{
				method: "linkStripeProviderCustomer",
				input: { billingAccountId: "user_1", stripeCustomerId: "cus_loser", email: null },
			},
			{
				method: "createCheckoutSession",
				params: {
					customer: "cus_winner",
					mode: "payment",
					line_items: [{ price: "price_credits_100", quantity: 1 }],
					success_url: config.checkoutSuccessUrl,
					cancel_url: config.checkoutCancelUrl,
					client_reference_id: "user_1",
					integration_identifier: "qfmxzjpa",
					metadata: checkoutMetadata(product),
					payment_intent_data: { metadata: checkoutMetadata(product) },
				},
			},
		]);
	});

	it("creates and links Stripe customers for Portal Sessions when none exists", async () => {
		const { calls, service } = serviceFixture();

		const result = await service.createPortalSession({ billingAccountId: " user_1 " });

		expect(result).toEqual({ url: portalUrl });
		expect(calls).toEqual([
			{ method: "getStripeProviderCustomer", input: { billingAccountId: "user_1", email: null } },
			{ method: "createCustomer", input: { billingAccountId: "user_1", email: null } },
			{
				method: "linkStripeProviderCustomer",
				input: { billingAccountId: "user_1", stripeCustomerId: "cus_123", email: null },
			},
			{
				method: "createPortalSession",
				params: { customer: "cus_123", return_url: config.portalReturnUrl },
			},
		]);
	});

	it("uses the linked Stripe customer returned by the repository for Portal Sessions", async () => {
		const { calls, service } = serviceFixture({
			customerId: "cus_loser",
			linkedCustomerId: "cus_winner",
		});

		const result = await service.createPortalSession({ billingAccountId: "user_1" });

		expect(result).toEqual({ url: portalUrl });
		expect(calls).toEqual([
			{ method: "getStripeProviderCustomer", input: { billingAccountId: "user_1", email: null } },
			{ method: "createCustomer", input: { billingAccountId: "user_1", email: null } },
			{
				method: "linkStripeProviderCustomer",
				input: { billingAccountId: "user_1", stripeCustomerId: "cus_loser", email: null },
			},
			{
				method: "createPortalSession",
				params: { customer: "cus_winner", return_url: config.portalReturnUrl },
			},
		]);
	});

	it("reuses linked Stripe customers for Portal Sessions", async () => {
		const { calls, service } = serviceFixture({ existingCustomerId: "cus_existing" });

		const result = await service.createPortalSession({ billingAccountId: "user_1" });

		expect(result).toEqual({ url: portalUrl });
		expect(calls).toEqual([
			{ method: "getStripeProviderCustomer", input: { billingAccountId: "user_1", email: null } },
			{
				method: "createPortalSession",
				params: { customer: "cus_existing", return_url: config.portalReturnUrl },
			},
		]);
	});

	it("returns Checkout Session status when metadata owns the session", async () => {
		const { calls, service } = serviceFixture({
			statusSession: {
				id: "cs_456",
				status: "open",
				payment_status: "unpaid",
				client_reference_id: null,
				metadata: { billingAccountId: "user_1" },
			},
		});

		const result = await service.getCheckoutSessionStatus({
			billingAccountId: " user_1 ",
			sessionId: " cs_456 ",
		});

		expect(result).toEqual({
			sessionId: "cs_456",
			status: "open",
			paymentStatus: "unpaid",
			customerEmail: null,
			productKey: null,
		});
		expect(calls).toEqual([{ method: "retrieveCheckoutSession", sessionId: "cs_456" }]);
	});

	it("returns Checkout Session status when only client reference owns the session", async () => {
		const { calls, service } = serviceFixture({
			statusSession: {
				id: "cs_client_ref",
				status: "complete",
				payment_status: "paid",
				client_reference_id: "user_1",
				metadata: null,
			},
		});

		const result = await service.getCheckoutSessionStatus({
			billingAccountId: "user_1",
			sessionId: "cs_client_ref",
		});

		expect(result).toEqual({
			sessionId: "cs_client_ref",
			status: "complete",
			paymentStatus: "paid",
			customerEmail: null,
			productKey: null,
		});
		expect(calls).toEqual([{ method: "retrieveCheckoutSession", sessionId: "cs_client_ref" }]);
	});

	it("returns the paying email and product key only after Checkout is paid", async () => {
		const { service } = serviceFixture({
			statusSession: {
				id: "cs_paid_email",
				status: "complete",
				payment_status: "paid",
				client_reference_id: "user_1",
				customer_email: "Buyer@Example.com",
				customer_details: { email: "  Payer@Example.com " },
				metadata: { billingAccountId: "user_1", productKey: "kmp_source" },
			},
		});

		await expect(
			service.getCheckoutSessionStatus({
				billingAccountId: "user_1",
				sessionId: "cs_paid_email",
			}),
		).resolves.toEqual({
			sessionId: "cs_paid_email",
			status: "complete",
			paymentStatus: "paid",
			customerEmail: "payer@example.com",
			productKey: "kmp_source",
		});
	});

	it("omits unpaid Checkout email and product key even when Stripe already has them", async () => {
		const { service } = serviceFixture({
			statusSession: {
				id: "cs_unpaid_email",
				status: "open",
				payment_status: "unpaid",
				client_reference_id: "user_1",
				customer_email: "early@example.com",
				metadata: { billingAccountId: "user_1", productKey: "kmp_source" },
			},
		});

		await expect(
			service.getCheckoutSessionStatus({
				billingAccountId: "user_1",
				sessionId: "cs_unpaid_email",
			}),
		).resolves.toEqual({
			sessionId: "cs_unpaid_email",
			status: "open",
			paymentStatus: "unpaid",
			customerEmail: null,
			productKey: null,
		});
	});

	it("rejects Checkout Session status when owner markers conflict", async () => {
		const { service } = serviceFixture({
			statusSession: {
				id: "cs_conflict",
				client_reference_id: "user_1",
				metadata: { billingAccountId: "other_user" },
			},
		});

		await expect(
			service.getCheckoutSessionStatus({ billingAccountId: "user_1", sessionId: "cs_conflict" }),
		).rejects.toMatchObject({
			code: "INVALID_REQUEST",
			status: 403,
		});
	});

	it("rejects Checkout Session status when client reference belongs to another user", async () => {
		const { service } = serviceFixture({
			statusSession: {
				id: "cs_789",
				client_reference_id: "other_user",
				metadata: null,
			},
		});

		await expect(
			service.getCheckoutSessionStatus({ billingAccountId: "user_1", sessionId: "cs_789" }),
		).rejects.toMatchObject({
			code: "INVALID_REQUEST",
			status: 403,
		});
	});

	it("rejects Checkout Session status without an owner marker", async () => {
		const { service } = serviceFixture({
			statusSession: {
				id: "cs_no_owner",
				client_reference_id: null,
				metadata: {},
			},
		});

		await expect(
			service.getCheckoutSessionStatus({ billingAccountId: "user_1", sessionId: "cs_no_owner" }),
		).rejects.toMatchObject({
			code: "INVALID_REQUEST",
			status: 403,
		});
	});

	it("creates payment Checkout Sessions for non-consumable one-time purchases", async () => {
		const { calls, service } = serviceFixture({
			products: {
				lifetime: stripeProduct({ productKey: "lifetime", productType: "non_consumable" }),
			},
		});

		expect(
			await service.createCheckoutSession({
				billingAccountId: "user_1",
				productKey: "lifetime",
			}),
		).toMatchObject({ sessionId: "cs_123" });
		expect(calls.at(-1)).toMatchObject({
			method: "createCheckoutSession",
			params: {
				mode: "payment",
				metadata: { purchaseKind: "non_consumable", productKey: "lifetime" },
				line_items: [{ price: "price_credits_100", quantity: 1 }],
			},
		});
	});

	it("raises a Stripe gateway error when Checkout returns a null URL", async () => {
		const { service } = serviceFixture({
			checkoutSession: { id: "cs_null_url", url: null },
		});

		await expect(
			service.createCheckoutSession({ billingAccountId: "user_1", productKey: "credits_100" }),
		).rejects.toMatchObject({
			code: "STRIPE_CHECKOUT_URL_MISSING",
			status: 502,
		});
	});

	it("rejects blank Stripe session inputs before touching dependencies", async () => {
		const { calls, service } = serviceFixture();

		await expect(
			service.createCheckoutSession({ billingAccountId: " ", productKey: "credits_100" }),
		).rejects.toMatchObject({
			code: "INVALID_REQUEST",
			status: 400,
		});
		await expect(
			service.getCheckoutSessionStatus({ billingAccountId: "user_1", sessionId: " " }),
		).rejects.toMatchObject({
			code: "INVALID_REQUEST",
			status: 400,
		});
		expect(calls).toEqual([]);
	});

	it("verifies webhook signatures and records Stripe credit purchases from Checkout events", async () => {
		const { calls, repositoryInputs, service } = serviceFixture({
			webhookEvent: stripeEvent("checkout.session.completed", checkoutSessionObject()),
		});

		const result = await service.handleWebhook({
			rawBody: '{"id":"evt_123"}',
			signatureHeader: " stripe-signature ",
		});

		expect(result).toEqual({
			status: "processed",
			eventType: "checkout.session.completed",
			entitlements: entitlementSnapshot,
		});
		expect(calls[0]).toEqual({
			method: "constructWebhookEvent",
			rawBody: '{"id":"evt_123"}',
			signature: "stripe-signature",
		});
		expect(calls.map((call) => (call as { method: string }).method)).toContain(
			"recordStripeCreditPurchaseAndEnqueueProjection",
		);
		expect(repositoryInputs[0]).toMatchObject({
			billingAccountId: "user_1",
			stripeCustomerId: "cus_123",
			externalProductId: "prod_credits_100",
			externalPriceId: "price_credits_100",
			paymentIntentId: "pi_123",
			chargeId: "ch_123",
			checkoutSessionId: "cs_123",
			amountPaidCents: null,
			currency: null,
			eventType: "checkout.session.completed",
			externalEventId: "evt_123",
			projectionIdempotencyKey: "stripe:payment:pi_123:projection",
		});
	});

	it("records async payment Checkout webhooks through credit purchase recording", async () => {
		const { repositoryInputs, service } = serviceFixture({
			webhookEvent: stripeEvent(
				"checkout.session.async_payment_succeeded",
				checkoutSessionObject({ payment_intent: "pi_async" }),
				"evt_checkout_async",
			),
		});

		const result = await service.handleWebhook({
			rawBody: "{}",
			signatureHeader: "stripe-signature",
		});

		expect(result).toMatchObject({
			status: "processed",
			eventType: "checkout.session.async_payment_succeeded",
		});
		expect(repositoryInputs[0]).toMatchObject({
			paymentIntentId: "pi_async",
			eventType: "checkout.session.async_payment_succeeded",
			externalEventId: "evt_checkout_async",
			projectionIdempotencyKey: "stripe:payment:pi_async:projection",
		});
	});

	it("records invoice and subscription webhook commands through the subscription repository", async () => {
		const invoice = serviceFixture({
			webhookEvent: stripeEvent("invoice.paid", invoiceObject(), "evt_invoice"),
		});
		const invoiceResult = await invoice.service.handleWebhook({
			rawBody: "{}",
			signatureHeader: "stripe-signature",
		});

		expect(invoiceResult.status).toBe("processed");
		expect(invoice.repositoryInputs[0]).toMatchObject({
			billingAccountId: "user_1",
			stripeCustomerId: "cus_123",
			stripeSubscriptionId: "sub_123",
			invoiceId: "in_123",
			externalProductId: "prod_premium",
			externalPriceId: "price_premium_monthly",
			subscriptionStatus: "active",
			eventType: "invoice.paid",
			externalEventId: "evt_invoice",
			projectionReason: "provider_webhook",
		});

		const subscription = serviceFixture({
			webhookEvent: stripeEvent(
				"customer.subscription.deleted",
				subscriptionObject({
					status: "canceled",
					cancel_at_period_end: false,
					current_period_end: 1_779_926_400,
				}),
				"evt_subscription",
			),
		});
		const subscriptionResult = await subscription.service.handleWebhook({
			rawBody: "{}",
			signatureHeader: "stripe-signature",
		});

		expect(subscriptionResult.status).toBe("processed");
		expect(subscription.repositoryInputs[0]).toMatchObject({
			stripeSubscriptionId: "sub_123",
			invoiceId: "in_123",
			subscriptionStatus: "expired",
			eventType: "customer.subscription.deleted",
			externalEventId: "evt_subscription",
			projectionReason: "provider_webhook",
		});
	});

	it("records failed invoice webhooks as billing retry subscription commands", async () => {
		const { repositoryInputs, service } = serviceFixture({
			webhookEvent: stripeEvent(
				"invoice.payment_failed",
				invoiceObject({ id: "in_failed", status: "open" }),
				"evt_invoice_failed",
			),
		});

		const result = await service.handleWebhook({
			rawBody: "{}",
			signatureHeader: "stripe-signature",
		});

		expect(result).toMatchObject({
			status: "processed",
			eventType: "invoice.payment_failed",
		});
		expect(repositoryInputs[0]).toMatchObject({
			stripeSubscriptionId: "sub_123",
			invoiceId: "in_failed",
			subscriptionStatus: "billing_retry",
			eventType: "invoice.payment_failed",
			externalEventId: "evt_invoice_failed",
			projectionReason: "provider_webhook",
		});
	});

	it("records subscription updated webhooks through subscription recording", async () => {
		const { repositoryInputs, service } = serviceFixture({
			webhookEvent: stripeEvent(
				"customer.subscription.updated",
				subscriptionObject({ status: "past_due" }),
				"evt_subscription_updated",
			),
		});

		const result = await service.handleWebhook({
			rawBody: "{}",
			signatureHeader: "stripe-signature",
		});

		expect(result).toMatchObject({
			status: "processed",
			eventType: "customer.subscription.updated",
		});
		expect(repositoryInputs[0]).toMatchObject({
			stripeSubscriptionId: "sub_123",
			subscriptionStatus: "billing_retry",
			eventType: "customer.subscription.updated",
			externalEventId: "evt_subscription_updated",
			projectionReason: "provider_webhook",
		});
	});

	it("records subscription created webhooks through subscription recording", async () => {
		const { repositoryInputs, service } = serviceFixture({
			webhookEvent: stripeEvent(
				"customer.subscription.created",
				subscriptionObject({ latest_invoice: null }),
				"evt_subscription_created",
			),
		});

		const result = await service.handleWebhook({
			rawBody: "{}",
			signatureHeader: "stripe-signature",
		});

		expect(result).toMatchObject({
			status: "processed",
			eventType: "customer.subscription.created",
		});
		expect(repositoryInputs[0]).toMatchObject({
			stripeSubscriptionId: "sub_123",
			invoiceId: null,
			subscriptionStatus: "active",
			eventType: "customer.subscription.created",
			externalEventId: "evt_subscription_created",
			projectionReason: "provider_webhook",
		});
	});

	it("records refund and dispute reversals while ignoring charge.refunded", async () => {
		const refund = serviceFixture({
			webhookEvent: stripeEvent("refund.created", refundObject(), "evt_refund"),
		});

		expect(
			await refund.service.handleWebhook({ rawBody: "{}", signatureHeader: "stripe-signature" }),
		).toMatchObject({ status: "processed", eventType: "refund.created" });
		expect(refund.repositoryInputs[0]).toMatchObject({
			reversalReason: "refund",
			reversalId: "re_123",
			paymentIntentId: "pi_123",
			chargeId: "ch_123",
			reversalAmount: 499,
			reversalCurrency: "usd",
			eventType: "refund.created",
			externalEventId: "evt_refund",
		});

		const dispute = serviceFixture({
			webhookEvent: stripeEvent("charge.dispute.created", disputeObject(), "evt_dispute"),
		});

		expect(
			await dispute.service.handleWebhook({ rawBody: "{}", signatureHeader: "stripe-signature" }),
		).toMatchObject({ status: "processed", eventType: "charge.dispute.created" });
		expect(dispute.repositoryInputs[0]).toMatchObject({
			reversalReason: "dispute",
			reversalId: "dp_123",
			paymentIntentId: "pi_123",
			reversalAmount: 499,
			reversalCurrency: "usd",
			eventType: "charge.dispute.created",
			externalEventId: "evt_dispute",
		});

		const chargeRefunded = serviceFixture({
			webhookEvent: stripeEvent(
				"charge.refunded",
				{
					id: "ch_123",
					payment_intent: "pi_123",
					amount_refunded: 499,
					currency: "usd",
					created: 1_780_185_600,
				},
				"evt_charge",
			),
		});

		expect(
			await chargeRefunded.service.handleWebhook({
				rawBody: "{}",
				signatureHeader: "stripe-signature",
			}),
		).toEqual({
			status: "ignored",
			eventType: "charge.refunded",
			entitlements: null,
		});
		expect(chargeRefunded.repositoryInputs).toEqual([]);
	});

	it("records succeeded refund updated webhooks through reversal recording", async () => {
		const { repositoryInputs, service } = serviceFixture({
			webhookEvent: stripeEvent(
				"refund.updated",
				refundObject({ id: "re_updated" }),
				"evt_refund_updated",
			),
		});

		const result = await service.handleWebhook({
			rawBody: "{}",
			signatureHeader: "stripe-signature",
		});

		expect(result).toMatchObject({
			status: "processed",
			eventType: "refund.updated",
		});
		expect(repositoryInputs[0]).toMatchObject({
			reversalReason: "refund",
			reversalId: "re_updated",
			paymentIntentId: "pi_123",
			reversalAmount: 499,
			reversalCurrency: "usd",
			eventType: "refund.updated",
			externalEventId: "evt_refund_updated",
			projectionIdempotencyKey: "stripe:refund:re_updated:reversal",
		});
	});

	it("links identity-only subscription Checkout events without granting entitlements", async () => {
		const { calls, repositoryInputs, service } = serviceFixture({
			webhookEvent: stripeEvent(
				"checkout.session.completed",
				checkoutSessionObject({
					mode: "subscription",
					customer: "cus_subscription",
					metadata: {
						billingAccountId: "user_1",
						productKey: "premium_monthly",
						purchaseKind: "subscription",
					},
				}),
			),
		});

		const result = await service.handleWebhook({
			rawBody: "{}",
			signatureHeader: "stripe-signature",
		});

		expect(result).toEqual({
			status: "processed",
			eventType: "checkout.session.completed",
			entitlements: null,
		});
		expect(calls).toContainEqual({
			method: "linkStripeProviderCustomer",
			input: { billingAccountId: "user_1", stripeCustomerId: "cus_subscription", email: null },
		});
		expect(repositoryInputs).toEqual([]);
	});

	it("rejects missing Stripe signatures before verifying or recording", async () => {
		const { calls, service } = serviceFixture();

		await expect(
			service.handleWebhook({ rawBody: "not-json", signatureHeader: "   " }),
		).rejects.toMatchObject({
			code: "INVALID_REQUEST",
			status: 400,
		});
		expect(calls).toEqual([]);
	});

	it("maps plain Stripe signature verifier errors to invalid signature billing errors", async () => {
		const { calls, service } = serviceFixture({
			constructWebhookError: new Error("No signatures found matching the expected signature"),
		});

		await expect(
			service.handleWebhook({ rawBody: "not-json", signatureHeader: "stripe-signature" }),
		).rejects.toMatchObject({
			code: "STRIPE_WEBHOOK_SIGNATURE_INVALID",
			status: 400,
			message: "Stripe webhook signature is invalid",
		});
		expect(calls).toEqual([
			{
				method: "constructWebhookEvent",
				rawBody: "not-json",
				signature: "stripe-signature",
			},
		]);
	});

	it("ignores unsupported valid Stripe events without DB writes", async () => {
		const { repositoryInputs, service } = serviceFixture({
			webhookEvent: stripeEvent("payment_intent.succeeded", { id: "pi_123" }, "evt_unsupported"),
		});

		const result = await service.handleWebhook({
			rawBody: "{}",
			signatureHeader: "stripe-signature",
		});

		expect(result).toEqual({
			status: "ignored",
			eventType: "payment_intent.succeeded",
			entitlements: null,
		});
		expect(repositoryInputs).toEqual([]);
	});

	it("stores retryable skipped Stripe events when supported event normalization fails", async () => {
		const { repositoryInputs, service } = serviceFixture({
			webhookEvent: stripeEvent(
				"checkout.session.completed",
				checkoutSessionObject({ metadata: {} }),
				"evt_missing_metadata",
			),
		});

		const result = await service.handleWebhook({
			rawBody: "{}",
			signatureHeader: "stripe-signature",
		});

		expect(result).toEqual({
			status: "skipped",
			eventType: "checkout.session.completed",
			entitlements: null,
		});
		expect(repositoryInputs[0]).toMatchObject({
			eventType: "checkout.session.completed",
			externalEventId: "evt_missing_metadata",
			transactionId: "pi_123",
			purchaseKind: "consumable",
			rawPayload: checkoutSessionObject({ metadata: {} }),
		});
		expect((repositoryInputs[0] as { processingError: string }).processingError).toContain(
			"Stripe Checkout session product key is required",
		);
	});

	it("validates Stripe replay provider/channel and processes stored raw payload without signatures", async () => {
		const { calls, repositoryInputs, service } = serviceFixture();

		await expect(
			service.replayStoreEvent(storeEvent({ provider: "google", channel: "android" })),
		).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });

		const result = await service.replayStoreEvent(storeEvent());

		expect(result).toEqual({ status: "processed" });
		expect(calls.map((call) => (call as { method: string }).method)).not.toContain(
			"constructWebhookEvent",
		);
		expect(repositoryInputs[0]).toMatchObject({
			paymentIntentId: "pi_123",
			eventType: "checkout.session.completed",
			externalEventId: "evt_123",
		});
	});

	it("returns retryable when replayed Stripe recordings still skip", async () => {
		const { service } = serviceFixture({ recordingResult: "skipped" });

		const result = await service.replayStoreEvent(storeEvent());

		expect(result).toEqual({
			status: "retryable",
			reason: "stripe_recording_skipped",
		});
	});

	it("ignores unsupported stored Stripe replay events without signature verification", async () => {
		const { calls, repositoryInputs, service } = serviceFixture();

		const result = await service.replayStoreEvent(
			storeEvent({
				external_event_id: "evt_unsupported_replay",
				event_type: "payment_intent.succeeded",
				transaction_id: "pi_replay",
				raw_payload: { id: "pi_replay" },
			}),
		);

		expect(result).toEqual({
			status: "ignored",
			reason: "stripe_store_event_not_recordable",
		});
		expect(calls.map((call) => (call as { method: string }).method)).not.toContain(
			"constructWebhookEvent",
		);
		expect(repositoryInputs).toEqual([]);
	});

	it("rejects replay rows whose full Stripe payload event type conflicts with the row", async () => {
		const { repositoryInputs, service } = serviceFixture();

		await expect(
			service.replayStoreEvent(
				storeEvent({
					external_event_id: "evt_row",
					event_type: "invoice.paid",
					raw_payload: stripeEvent("refund.created", refundObject(), "evt_row"),
				}),
			),
		).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
		expect(repositoryInputs).toEqual([]);
	});

	it("rejects replay rows whose full Stripe payload event id conflicts with the row", async () => {
		const { repositoryInputs, service } = serviceFixture();

		await expect(
			service.replayStoreEvent(
				storeEvent({
					external_event_id: "evt_row",
					event_type: "invoice.paid",
					raw_payload: stripeEvent("invoice.paid", invoiceObject(), "evt_other"),
				}),
			),
		).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
		expect(repositoryInputs).toEqual([]);
	});

	it("retrieves provider subscriptions and records provider reconciliation commands", async () => {
		const { calls, repositoryInputs, service } = serviceFixture({
			retrievedSubscription: subscriptionObject(),
		});

		const result = await service.reconcileSubscription(reconciliationSubscription());

		expect(result).toEqual({ status: "processed" });
		expect(calls).toContainEqual({
			method: "retrieveSubscription",
			subscriptionId: "sub_123",
		});
		expect(repositoryInputs[0]).toMatchObject({
			billingAccountId: "user_1",
			stripeCustomerId: "cus_123",
			stripeSubscriptionId: "sub_123",
			eventType: "provider_reconciliation",
			externalEventId: null,
			projectionReason: "provider_reconciliation",
		});
	});

	it("returns skipped when Stripe subscription reconciliation recording skips", async () => {
		const { repositoryInputs, service } = serviceFixture({
			recordingResult: "skipped",
			retrievedSubscription: subscriptionObject(),
		});

		const result = await service.reconcileSubscription(reconciliationSubscription());

		expect(result).toEqual({ status: "skipped" });
		expect(repositoryInputs[0]).toMatchObject({
			stripeSubscriptionId: "sub_123",
			eventType: "provider_reconciliation",
			projectionReason: "provider_reconciliation",
		});
	});

	it("rejects non-web Stripe provider subscription reconciliation rows", async () => {
		const { calls, service } = serviceFixture();

		await expect(
			service.reconcileSubscription(reconciliationSubscription({ channel: "ios" })),
		).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
		expect(calls).toEqual([]);
	});

	it("rejects non-Stripe provider subscription reconciliation rows", async () => {
		const { service } = serviceFixture();

		await expect(
			service.reconcileSubscription(
				reconciliationSubscription({ provider: "google", channel: "android" }),
			),
		).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
	});
});
