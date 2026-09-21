import { describe, expect, it } from "bun:test";
import { postV1BillingAccountsByBillingAccountIdCommercialActionsPreviewResponse200Schema as previewResponseSchema } from "../../../src/app/contracts/customer-responses";
import type {
	CommercialActionIntent,
	CommercialPreviewDraft,
} from "../../../src/billing/commercial";
import { sha256Hex, stableJson } from "../../../src/billing/decimal";
import type {
	SubscriptionCancellationContext,
	SubscriptionChangePreview,
} from "../../../src/billing/recurring";
import type {
	StripeRecurringCheckoutPlan,
	StripeWebStoreProductRow,
} from "../../../src/db/repository";
import {
	admittedProviders,
	commercialActionOperations,
	implementsOperation,
	providerCapabilityDeclaration,
} from "../../../src/providers/capabilities";
import {
	StripeBillingService,
	type StripeBillingServiceDependencies,
} from "../../../src/providers/stripe/service";

/**
 * Commercial previews report the provider their declaration admits instead of a hard-coded string.
 * The provider never feeds `intentHash` or `stateFingerprint`, so a stored preview keeps matching
 * on execution; both hashes are recomputed here from the intent and the provider state alone.
 */

type Repository = StripeBillingServiceDependencies["repository"];

const billingAccountId = "user_1";

const product: StripeWebStoreProductRow = {
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
};

const plan: StripeRecurringCheckoutPlan = {
	planVersionId: "42",
	planKey: "pro",
	name: "Pro",
	kind: "base",
	trialDays: null,
	trialRequiresPaymentMethod: false,
	trialEndBehavior: "cancel",
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
	],
};

const change: SubscriptionChangePreview = {
	stateFingerprint: "state-fingerprint-1",
	changeKind: "upgrade",
	effectiveMode: "immediate",
	effectiveAt: "2026-09-17T00:00:00.000Z",
	prorationBehavior: "create_prorations",
	fromPlanVersionId: "41",
	toPlanVersionId: "42",
	lineItems: [
		{
			key: "base",
			label: "Pro",
			quantity: 1,
			unitAmountMinor: 999,
			currency: "USD",
			interval: "month",
			pricingModel: "flat",
		},
	],
};

const cancellation: SubscriptionCancellationContext = {
	customerId: "customer-1",
	externalSubscriptionId: "sub_123",
	status: "active",
	planKind: "base",
	planVersionId: "42",
	cancelAtPeriodEnd: true,
	currentPeriodEnd: "2026-10-17T00:00:00.000Z",
	pendingChange: null,
	activeAddOnSubscriptionIds: [],
	postpaidUsageSettlesAt: null,
	stateFingerprint: "cancellation-fingerprint-1",
};

function previewService(): { service: StripeBillingService; drafts: CommercialPreviewDraft[] } {
	const drafts: CommercialPreviewDraft[] = [];
	const repository: Partial<Repository> = {
		getStripeWebStoreProductByKey(productKey: string) {
			expect(productKey).toBe(product.productKey);
			return Promise.resolve(product);
		},
		getStripeRecurringCheckoutPlanByKey(planKey: string) {
			expect(planKey).toBe(plan.planKey);
			return Promise.resolve(plan);
		},
		hasActiveBasePlan() {
			return Promise.resolve(false);
		},
		previewSubscriptionChange() {
			return Promise.resolve(change);
		},
		previewSubscriptionCancellation() {
			return Promise.resolve(cancellation);
		},
		createCommercialActionPreview(draft: CommercialPreviewDraft) {
			drafts.push(draft);
			return Promise.resolve({
				...draft.preview,
				previewToken: "preview_1",
				expiresAt: "2026-09-17T00:30:00.000Z",
			});
		},
		getCommercialActionPreview() {
			throw new Error("previews are not read in this test");
		},
		beginCommercialActionExecution() {
			throw new Error("previews are not executed in this test");
		},
		completeCommercialActionExecution() {
			throw new Error("previews are not executed in this test");
		},
	};
	const service = new StripeBillingService({
		config: {
			checkoutSuccessUrl: "https://app.example.com/billing/success",
			checkoutCancelUrl: "https://app.example.com/billing",
			portalReturnUrl: "https://app.example.com/account/billing",
		},
		client: {} as StripeBillingServiceDependencies["client"],
		repository: repository as Repository,
	});
	return { service, drafts };
}

describe("commercial preview provider", () => {
	it("reports the declared provider for every action and hashes only the intent", async () => {
		const { service, drafts } = previewService();
		const intents: CommercialActionIntent[] = [
			{ kind: "checkout_product", productKey: product.productKey },
			{ kind: "checkout_plan", planKey: plan.planKey, quantities: {} },
			{
				kind: "subscription_change",
				externalSubscriptionId: "sub_123",
				targetPlanKey: plan.planKey,
				quantities: {},
			},
			{ kind: "cancel", externalSubscriptionId: "sub_123", effectiveMode: "immediate" },
			{ kind: "uncancel", externalSubscriptionId: "sub_123" },
		];

		const previews = [];
		for (const intent of intents) {
			previews.push(await service.previewCommercialAction({ billingAccountId, intent }));
		}

		expect(previews.map((preview) => preview.provider)).toEqual([
			"stripe",
			"stripe",
			"stripe",
			"stripe",
			"stripe",
		]);
		expect(previews.map((preview) => preview.action)).toEqual([
			"checkout_product",
			"checkout_plan",
			"subscription_change",
			"cancel",
			"uncancel",
		]);
		// Every hash is a function of the intent or the provider state, neither of which names a
		// provider, so the reported provider cannot move a stored preview's identity.
		for (const draft of drafts) {
			expect(Object.keys(draft.intent)).not.toContain("provider");
			expect(draft.intentHash).toBe(sha256Hex(stableJson(draft.intent)));
			expect(draft.preview.intentHash).toBe(draft.intentHash);
			expect(draft.preview.stateFingerprint).toBe(draft.stateFingerprint);
		}
		expect(drafts.map((draft) => draft.stateFingerprint)).toEqual([
			sha256Hex(stableJson(product)),
			sha256Hex(stableJson({ plan, hasActiveBasePlan: false })),
			change.stateFingerprint,
			cancellation.stateFingerprint,
			cancellation.stateFingerprint,
		]);
		expect(drafts.map((draft) => draft.intentHash)).toEqual([
			sha256Hex(
				stableJson({
					kind: "checkout_product",
					productKey: product.productKey,
					email: null,
					successUrl: null,
					cancelUrl: null,
				}),
			),
			sha256Hex(
				stableJson({
					kind: "checkout_plan",
					planKey: plan.planKey,
					quantities: {},
					email: null,
					successUrl: null,
					cancelUrl: null,
				}),
			),
			sha256Hex(
				stableJson({
					kind: "subscription_change",
					externalSubscriptionId: "sub_123",
					targetPlanKey: plan.planKey,
					quantities: {},
				}),
			),
			sha256Hex(
				stableJson({
					kind: "cancel",
					externalSubscriptionId: "sub_123",
					effectiveMode: "immediate",
				}),
			),
			sha256Hex(stableJson({ kind: "uncancel", externalSubscriptionId: "sub_123" })),
		]);
	});

	it("keeps the wire literal equal to the providers that implement every commercial action", () => {
		const operations = Object.values(commercialActionOperations);
		const implementers = admittedProviders().filter((provider) =>
			operations.every((operation) =>
				implementsOperation(providerCapabilityDeclaration(provider), operation),
			),
		);

		const wireProviders: string[] = [previewResponseSchema.shape.data.shape.provider.value];

		expect(implementers).toEqual(["stripe"]);
		expect(wireProviders).toEqual(implementers);
	});
});
