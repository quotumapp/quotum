import { describe, expect, it } from "bun:test";
import type Stripe from "stripe";
import type { StripeRecurringCheckoutPlan } from "../../../src/db/repository";
import { StripeBillingService } from "../../../src/providers/stripe/service";

type Dependencies = ConstructorParameters<typeof StripeBillingService>[0];

const previewToken = "11111111-1111-4111-8111-111111111111";
/** The largest value of a Postgres `integer`, which holds a subscription item quantity. */
const maxLicensedQuantity = 2_147_483_647;

function plan(
	seat: { maximumQuantity: number | null; unitAmountMinor?: number } = { maximumQuantity: null },
): StripeRecurringCheckoutPlan {
	return {
		planVersionId: "42",
		planKey: "pro",
		name: "Pro",
		kind: "base",
		trialDays: null,
		trialRequiresPaymentMethod: false,
		trialEndBehavior: "cancel",
		trialUsed: false,
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
				billingIntervalCount: 1,
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
				maximumQuantity: seat.maximumQuantity,
				unitAmountMinor: seat.unitAmountMinor ?? 200,
				pricingModel: "flat",
				currency: "USD",
				billingInterval: "month",
				billingIntervalCount: 1,
			},
		],
	};
}

function fixture(recurringPlan: StripeRecurringCheckoutPlan) {
	const checkouts: Stripe.Checkout.SessionCreateParams[] = [];
	const changePreviews: Array<{ quantities: Record<string, number> }> = [];
	const service = new StripeBillingService({
		config: {
			checkoutSuccessUrl: "https://app.acme.com/billing/success?session_id={CHECKOUT_SESSION_ID}",
			checkoutCancelUrl: "https://app.acme.com/billing",
			portalReturnUrl: "https://app.acme.com/account/billing",
		},
		client: {
			createCustomer: async () => ({ id: "cus_1" }),
			createCheckoutSession: async (params: Stripe.Checkout.SessionCreateParams) => {
				checkouts.push(params);
				return { id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" };
			},
		},
		repository: {
			getStripeRecurringCheckoutPlanByKey: async () => recurringPlan,
			hasActiveBasePlan: async () => false,
			getStripeProviderCustomer: async () => "cus_1",
			previewSubscriptionChange: async (input: { quantities: Record<string, number> }) => {
				changePreviews.push(input);
				return {
					stateFingerprint: "fingerprint",
					changeKind: "quantity",
					effectiveMode: "immediate",
					effectiveAt: "2026-10-01T00:00:00.000Z",
					prorationBehavior: "create_prorations",
					fromPlanVersionId: "42",
					toPlanVersionId: "42",
					lineItems: [
						{
							key: "seat",
							label: "seats",
							quantity: input.quantities.seats ?? 0,
							unitAmountMinor: 200,
							currency: "USD",
							interval: "month",
							intervalCount: 1,
							pricingModel: "flat",
						},
					],
				};
			},
			createCommercialActionPreview: async (draft: { preview: object }) => ({
				...draft.preview,
				previewToken,
				expiresAt: "2026-10-01T00:15:00.000Z",
			}),
			getCommercialActionPreview: async () => {
				throw new Error("unread");
			},
			beginCommercialActionExecution: async () => {
				throw new Error("unexecuted");
			},
			completeCommercialActionExecution: async () => {
				throw new Error("unexecuted");
			},
		} as unknown as Dependencies["repository"],
	} as unknown as Dependencies);
	return { service, checkouts, changePreviews };
}

describe("licensed quantity bound", () => {
	it("creates Checkout at the largest quantity and refuses one more, without a configured maximum", async () => {
		const { service, checkouts } = fixture(plan());

		await service.createRecurringCheckoutSession({
			billingAccountId: "acct_1",
			planKey: "pro",
			quantities: { seats: maxLicensedQuantity },
		});
		expect(checkouts.at(-1)?.line_items).toEqual([
			{ price: "price_pro", quantity: 1 },
			{ price: "price_seat", quantity: maxLicensedQuantity },
		]);

		for (const seats of [maxLicensedQuantity + 1, Number.MAX_SAFE_INTEGER]) {
			await expect(
				service.createRecurringCheckoutSession({
					billingAccountId: "acct_1",
					planKey: "pro",
					quantities: { seats },
				}),
			).rejects.toMatchObject({ code: "INVALID_QUANTITY", status: 400 });
		}
		expect(checkouts).toHaveLength(1);
	});

	it("keeps a configured maximum below the integer bound in force", async () => {
		const { service, checkouts } = fixture(plan({ maximumQuantity: 100 }));

		await expect(
			service.createRecurringCheckoutSession({
				billingAccountId: "acct_1",
				planKey: "pro",
				quantities: { seats: 101 },
			}),
		).rejects.toMatchObject({ code: "INVALID_QUANTITY", status: 400 });
		expect(checkouts).toHaveLength(0);
	});

	it("refuses checkout_plan, subscription_change and setup_payment intents above the bound", async () => {
		const { service, changePreviews } = fixture(plan());
		const tooMany = { seats: maxLicensedQuantity + 1 };
		const intents = [
			{ kind: "checkout_plan" as const, planKey: "pro", quantities: tooMany },
			{
				kind: "subscription_change" as const,
				externalSubscriptionId: "sub_1",
				targetPlanKey: "pro",
				quantities: tooMany,
			},
			{
				kind: "setup_payment" as const,
				currency: "usd",
				plan: { planKey: "pro", quantities: tooMany },
			},
		];

		for (const intent of intents) {
			await expect(
				service.previewCommercialAction({ billingAccountId: "acct_1", intent }),
			).rejects.toMatchObject({
				code: "INVALID_QUANTITY",
				status: 400,
				message: `Quantity for seats cannot exceed ${maxLicensedQuantity}`,
			});
		}
		// The refusal comes before any catalog or subscription read.
		expect(changePreviews).toHaveLength(0);
	});

	it("previews the largest quantity with its exact total", async () => {
		const { service } = fixture(plan());

		const preview = await service.previewCommercialAction({
			billingAccountId: "acct_1",
			intent: { kind: "checkout_plan", planKey: "pro", quantities: { seats: maxLicensedQuantity } },
		});

		expect(preview).toMatchObject({
			amountStatus: "exact",
			subtotalMinor: 999 + 200 * maxLicensedQuantity,
			estimatedTotalMinor: 999 + 200 * maxLicensedQuantity,
		});
		expect(Number.isSafeInteger(preview.subtotalMinor)).toBe(true);
	});

	it("refuses a preview whose flat total JavaScript numbers cannot hold exactly", async () => {
		// 5,000,000 minor units a seat at 2,147,483,647 seats is about 1.07e16, past 2^53 - 1.
		const { service } = fixture(plan({ maximumQuantity: null, unitAmountMinor: 5_000_000 }));

		await expect(
			service.previewCommercialAction({
				billingAccountId: "acct_1",
				intent: {
					kind: "checkout_plan",
					planKey: "pro",
					quantities: { seats: maxLicensedQuantity },
				},
			}),
		).rejects.toMatchObject({ code: "INVALID_QUANTITY", status: 400 });

		const smaller = await service.previewCommercialAction({
			billingAccountId: "acct_1",
			intent: { kind: "checkout_plan", planKey: "pro", quantities: { seats: 1_000_000_000 } },
		});
		expect(smaller.subtotalMinor).toBe(999 + 5_000_000 * 1_000_000_000);
	});
});
