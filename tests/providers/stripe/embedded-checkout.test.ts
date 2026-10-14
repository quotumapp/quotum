import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type Stripe from "stripe";
import type {
	CommercialActionIntent,
	CommercialPreviewDraft,
	StoredCommercialActionPreview,
} from "../../../src/billing/commercial";
import { sha256Hex, stableJson } from "../../../src/billing/decimal";
import type {
	CompleteStripeCheckoutRequestInput,
	PrepareStripeCheckoutRequestInput,
	StripeCheckoutRequestState,
	StripeRecurringCheckoutPlan,
	StripeWebStoreProductRow,
} from "../../../src/db/repository";
import { StripeBillingService } from "../../../src/providers/stripe/service";

type Dependencies = ConstructorParameters<typeof StripeBillingService>[0];

const successUrl = "https://app.acme.com/billing/success?session_id={CHECKOUT_SESSION_ID}";
const cancelUrl = "https://app.acme.com/billing";
const clientSecret = "cs_embedded_secret_created";
const previewToken = "11111111-1111-4111-8111-111111111111";

const product: StripeWebStoreProductRow = {
	storeProductId: "store_product_credits_100",
	productId: "internal_product_credits_100",
	productKey: "credits_100",
	productType: "consumable",
	creditAmount: 100,
	externalProductId: "prod_stripe_credits_100",
	externalPriceId: "price_credits_100",
	billingPeriod: "one_time",
	billingPeriodCount: 1,
	currency: "usd",
	priceAmount: 499,
};

function plan(trialDays: number | null = null): StripeRecurringCheckoutPlan {
	return {
		planVersionId: "42",
		planKey: "pro",
		name: "Pro",
		kind: "base",
		trialDays,
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
		],
	};
}

interface Receipt extends StripeCheckoutRequestState {
	requestHash: string;
}

function fixture(
	options: {
		taxMode?: "test";
		trialDays?: number;
		/** What Stripe answers as the client secret on create and on a later read. */
		createdSecret?: string | null;
		retrievedSecret?: string | null;
		/** The session Stripe answers on a read: open and embedded unless set. */
		retrievedSession?: { status?: string; payment_status?: string; ui_mode?: string };
	} = {},
) {
	const created: Stripe.Checkout.SessionCreateParams[] = [];
	const retrieved: string[] = [];
	const prepared: PrepareStripeCheckoutRequestInput[] = [];
	const completed: CompleteStripeCheckoutRequestInput[] = [];
	const receipts = new Map<string, Receipt>();
	const state: { stored: StoredCommercialActionPreview | null } = { stored: null };
	const stored = () => {
		if (state.stored === null) throw new Error("No preview was stored");
		return state.stored;
	};
	const service = new StripeBillingService({
		config: {
			checkoutSuccessUrl: successUrl,
			checkoutCancelUrl: cancelUrl,
			portalReturnUrl: "https://app.acme.com/account",
			...(options.taxMode === undefined ? {} : { taxMode: options.taxMode }),
		},
		client: {
			createCustomer: async () => ({ id: "cus_1" }),
			createCheckoutSession: async (params: Stripe.Checkout.SessionCreateParams) => {
				created.push(params);
				return params.ui_mode === "embedded_page"
					? {
							id: "cs_embedded",
							url: null,
							client_secret:
								options.createdSecret === undefined ? clientSecret : options.createdSecret,
						}
					: { id: "cs_hosted", url: "https://checkout.stripe.com/c/pay/cs_hosted" };
			},
			retrieveCheckoutSession: async (sessionId: string) => {
				retrieved.push(sessionId);
				return {
					id: sessionId,
					status: "open",
					payment_status: "unpaid",
					ui_mode: "embedded_page",
					client_reference_id: "acct_1",
					metadata: { billingAccountId: "acct_1" },
					client_secret:
						options.retrievedSecret === undefined
							? "cs_embedded_secret_read"
							: options.retrievedSecret,
					...options.retrievedSession,
				};
			},
		},
		repository: {
			getStripeWebStoreProductByKey: async () => product,
			getStripeRecurringCheckoutPlanByKey: async () => plan(options.trialDays ?? null),
			hasActiveBasePlan: async () => false,
			getStripeProviderCustomer: async () => "cus_1",
			prepareStripeCheckoutRequest: async (input: PrepareStripeCheckoutRequestInput) => {
				prepared.push(input);
				const receipt = receipts.get(input.idempotencyKey) ?? {
					status: "creating" as const,
					externalSessionId: null,
					sessionUrl: null,
					requestHash: input.requestHash,
				};
				if (receipt.requestHash !== input.requestHash) {
					throw Object.assign(new Error("Idempotency key was reused"), {
						code: "IDEMPOTENCY_CONFLICT",
					});
				}
				receipts.set(input.idempotencyKey, receipt);
				return { ...receipt };
			},
			completeStripeCheckoutRequest: async (input: CompleteStripeCheckoutRequestInput) => {
				completed.push(input);
				const receipt = {
					status: "created" as const,
					externalSessionId: input.externalSessionId,
					sessionUrl: input.sessionUrl,
					requestHash: input.requestHash,
				};
				receipts.set(input.idempotencyKey, receipt);
				return { ...receipt };
			},
			createCommercialActionPreview: async (draft: CommercialPreviewDraft) => {
				state.stored = {
					intent: draft.intent,
					preview: { ...draft.preview, previewToken, expiresAt: "2099-01-01T00:00:00.000Z" },
					status: "previewed",
					executionIdempotencyKey: null,
					executionResult: null,
				};
				return structuredClone(state.stored.preview);
			},
			getCommercialActionPreview: async () => structuredClone(stored()),
			beginCommercialActionExecution: async (input: { idempotencyKey: string }) => {
				const current = stored();
				if (current.status === "previewed") {
					current.status = "executing";
					current.executionIdempotencyKey = input.idempotencyKey;
				}
				return structuredClone(current);
			},
			completeCommercialActionExecution: async (input: {
				result: NonNullable<StoredCommercialActionPreview["executionResult"]>;
			}) => {
				const current = stored();
				current.status = "executed";
				current.executionResult ??= structuredClone(input.result);
				return structuredClone(current.executionResult);
			},
		} as unknown as Dependencies["repository"],
	} as unknown as Dependencies);
	return { service, created, retrieved, prepared, completed, stored };
}

/** The idempotency hash a hosted product request had before embedded Checkout existed. */
function hostedProductRequestHash(): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				billingAccountId: "acct_1",
				targetKey: "credits_100",
				targetKind: "product",
				quantities: {},
				email: null,
				successUrl,
				cancelUrl,
			}),
		)
		.digest("hex");
}

describe("embedded Stripe Checkout", () => {
	it("creates an embedded session that returns to the success URL and answers its client secret", async () => {
		const f = fixture();

		const session = await f.service.createCheckoutSession({
			billingAccountId: "acct_1",
			productKey: "credits_100",
			idempotencyKey: "buy-1",
			uiMode: "embedded",
		});

		expect(session).toEqual({ sessionId: "cs_embedded", clientSecret, duplicate: false });
		expect(Object.keys(session)).not.toContain("url");
		expect(Object.keys(f.created[0] ?? {}).sort()).toEqual([
			"client_reference_id",
			"customer",
			"integration_identifier",
			"line_items",
			"metadata",
			"mode",
			"payment_intent_data",
			"return_url",
			"ui_mode",
		]);
		expect(f.created[0]).toMatchObject({
			ui_mode: "embedded_page",
			return_url: successUrl,
			customer: "cus_1",
			mode: "payment",
			client_reference_id: "acct_1",
			line_items: [{ price: "price_credits_100", quantity: 1 }],
			metadata: { billingAccountId: "acct_1", productKey: "credits_100" },
			integration_identifier: "qfmxzjpa",
		});
		// The receipt records the session with no URL, and the secret is stored nowhere.
		expect(f.completed).toEqual([
			{
				billingAccountId: "acct_1",
				idempotencyKey: "buy-1",
				requestHash: expect.any(String),
				externalSessionId: "cs_embedded",
				sessionUrl: null,
			},
		]);
		expect(JSON.stringify([f.prepared, f.completed])).not.toContain(clientSecret);
	});

	it("keeps every hosted request's Stripe parameters and idempotency hash", async () => {
		const f = fixture();
		const create = (idempotencyKey: string, uiMode?: "hosted" | "embedded") =>
			f.service.createCheckoutSession({
				billingAccountId: "acct_1",
				productKey: "credits_100",
				idempotencyKey,
				...(uiMode === undefined ? {} : { uiMode }),
			});

		expect(await create("default")).toEqual({
			sessionId: "cs_hosted",
			url: "https://checkout.stripe.com/c/pay/cs_hosted",
			duplicate: false,
		});
		await create("hosted", "hosted");
		await create("embedded", "embedded");

		const [byDefault, hosted, embedded] = f.prepared.map((input) => input.requestHash);
		expect([byDefault, hosted]).toEqual([hostedProductRequestHash(), hostedProductRequestHash()]);
		expect(embedded).not.toBe(hostedProductRequestHash());
		for (const params of f.created.slice(0, 2)) {
			expect(Object.keys(params).sort()).toEqual([
				"cancel_url",
				"client_reference_id",
				"customer",
				"integration_identifier",
				"line_items",
				"metadata",
				"mode",
				"payment_intent_data",
				"success_url",
			]);
			expect(params).toMatchObject({ success_url: successUrl, cancel_url: cancelUrl });
		}
		expect(f.completed[0]?.sessionUrl).toBe("https://checkout.stripe.com/c/pay/cs_hosted");
	});

	it("keeps tax, trial and expiry settings on an embedded plan Checkout", async () => {
		const f = fixture({ taxMode: "test", trialDays: 7 });

		await f.service.createRecurringCheckoutSession({
			billingAccountId: "acct_1",
			planKey: "pro",
			uiMode: "embedded",
		});
		await f.service.createCheckoutSession({
			billingAccountId: "acct_1",
			planKey: "pro",
			expiresAt: 1_900_000_000,
			uiMode: "embedded",
		});

		for (const params of f.created) {
			expect(params).toMatchObject({
				ui_mode: "embedded_page",
				return_url: successUrl,
				mode: "subscription",
				line_items: [{ price: "price_pro", quantity: 1 }],
				automatic_tax: { enabled: true },
				tax_id_collection: { enabled: true },
				customer_update: { address: "auto", name: "auto" },
				payment_method_collection: "if_required",
				subscription_data: {
					metadata: { billingAccountId: "acct_1" },
					trial_period_days: 7,
					trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
				},
			});
			expect(params).not.toHaveProperty("success_url");
			expect(params).not.toHaveProperty("cancel_url");
		}
		expect(f.created[1]?.expires_at).toBe(1_900_000_000);
	});

	it("answers a replayed embedded request with the secret Stripe holds now, not a stored one", async () => {
		const f = fixture();
		const request = {
			billingAccountId: "acct_1",
			productKey: "credits_100",
			idempotencyKey: "buy-1",
			uiMode: "embedded" as const,
		};

		await f.service.createCheckoutSession(request);
		const replay = await f.service.createCheckoutSession(request);

		expect(replay).toEqual({
			sessionId: "cs_embedded",
			clientSecret: "cs_embedded_secret_read",
			duplicate: true,
		});
		expect(f.created).toHaveLength(1);
		expect(f.retrieved).toEqual(["cs_embedded"]);
	});

	it("replays a hosted request from its stored URL without reading Stripe", async () => {
		const f = fixture();
		const request = { billingAccountId: "acct_1", productKey: "credits_100", idempotencyKey: "a" };

		await f.service.createCheckoutSession(request);

		expect(await f.service.createCheckoutSession(request)).toEqual({
			sessionId: "cs_hosted",
			url: "https://checkout.stripe.com/c/pay/cs_hosted",
			duplicate: true,
		});
		expect([f.created.length, f.retrieved]).toEqual([1, []]);
	});

	it("refuses a cancel URL or an unknown mode before anything is created", async () => {
		const f = fixture();

		await expect(
			f.service.createCheckoutSession({
				billingAccountId: "acct_1",
				productKey: "credits_100",
				idempotencyKey: "buy-1",
				cancelUrl: "https://app.acme.com/cancelled",
				uiMode: "embedded",
			}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
		await expect(
			f.service.createCheckoutSession({
				billingAccountId: "acct_1",
				productKey: "credits_100",
				uiMode: "popup" as never,
			}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
		// The return URL is the success URL, so it still needs the session placeholder.
		await expect(
			f.service.createCheckoutSession({
				billingAccountId: "acct_1",
				productKey: "credits_100",
				successUrl: "https://app.acme.com/billing/success",
				uiMode: "embedded",
			}),
		).rejects.toMatchObject({ code: "RETURN_URL_NOT_ALLOWED", status: 400 });
		expect([f.created, f.prepared]).toEqual([[], []]);
	});

	it("answers a gateway error when Stripe gives no client secret", async () => {
		const missing = fixture({ createdSecret: null });
		await expect(
			missing.service.createCheckoutSession({
				billingAccountId: "acct_1",
				productKey: "credits_100",
				idempotencyKey: "buy-1",
				uiMode: "embedded",
			}),
		).rejects.toMatchObject({ code: "STRIPE_CHECKOUT_CLIENT_SECRET_MISSING", status: 502 });
		expect(missing.completed).toEqual([]);

		const unreadable = fixture({ retrievedSecret: null });
		const request = {
			billingAccountId: "acct_1",
			productKey: "credits_100",
			idempotencyKey: "buy-1",
			uiMode: "embedded" as const,
		};
		await unreadable.service.createCheckoutSession(request);
		await expect(unreadable.service.createCheckoutSession(request)).rejects.toMatchObject({
			code: "STRIPE_CHECKOUT_CLIENT_SECRET_MISSING",
		});
	});
});

describe("embedded Checkout status", () => {
	const read = (f: ReturnType<typeof fixture>) =>
		f.service.getCheckoutSessionStatus({ billingAccountId: "acct_1", sessionId: "cs_embedded" });

	it("answers the client secret of an open embedded session only", async () => {
		expect(await read(fixture())).toEqual({
			sessionId: "cs_embedded",
			status: "open",
			paymentStatus: "unpaid",
			customerEmail: null,
			productKey: null,
			clientSecret: "cs_embedded_secret_read",
		});
		for (const retrievedSession of [
			{ status: "complete", payment_status: "paid" },
			{ status: "expired" },
			// Stripe answers no secret for a hosted session; a stray one is still not passed on.
			{ ui_mode: "hosted_page" },
		]) {
			expect((await read(fixture({ retrievedSession }))).clientSecret).toBeNull();
		}
		expect((await read(fixture({ retrievedSecret: " " }))).clientSecret).toBeNull();
	});

	it("never answers a secret when expiring a session", async () => {
		const f = fixture({ retrievedSession: { status: "expired" } });

		expect(
			await f.service.expireCheckoutSession({
				billingAccountId: "acct_1",
				sessionId: "cs_embedded",
			}),
		).toMatchObject({ status: "expired", clientSecret: null });
	});
});

describe("embedded commercial checkout", () => {
	const intent = (overrides: Partial<CommercialActionIntent> = {}) =>
		({
			kind: "checkout_plan",
			planKey: "pro",
			quantities: {},
			...overrides,
		}) as CommercialActionIntent;

	it("hashes the mode into an embedded intent only", async () => {
		const f = fixture();

		const hosted = await f.service.previewCommercialAction({
			billingAccountId: "acct_1",
			intent: intent(),
		});
		const explicit = await f.service.previewCommercialAction({
			billingAccountId: "acct_1",
			intent: intent({ uiMode: "hosted" }),
		});
		const embedded = await f.service.previewCommercialAction({
			billingAccountId: "acct_1",
			intent: intent({ uiMode: "embedded" }),
		});

		const hostedHash = sha256Hex(
			stableJson({
				kind: "checkout_plan",
				planKey: "pro",
				quantities: {},
				email: null,
				successUrl: null,
				cancelUrl: null,
			}),
		);
		expect([hosted.intentHash, explicit.intentHash]).toEqual([hostedHash, hostedHash]);
		expect(embedded.intentHash).not.toBe(hostedHash);
		expect(f.stored().intent).toMatchObject({ uiMode: "embedded" });
		await expect(
			f.service.previewCommercialAction({
				billingAccountId: "acct_1",
				intent: intent({ uiMode: "embedded", cancelUrl: "https://app.acme.com/cancelled" }),
			}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST" });
	});

	it("executes an embedded checkout, stores no secret and reads it again on replay", async () => {
		const f = fixture();
		await f.service.previewCommercialAction({
			billingAccountId: "acct_1",
			intent: intent({ uiMode: "embedded", expiresAt: 1_900_000_000 }),
		});
		const execute = () =>
			f.service.executeCommercialAction({
				billingAccountId: "acct_1",
				previewToken,
				idempotencyKey: "intro-1",
			});

		expect(await execute()).toEqual({
			kind: "checkout",
			sessionId: "cs_embedded",
			clientSecret,
			duplicate: false,
			promotionRedemption: null,
		});
		expect(f.created[0]).toMatchObject({
			ui_mode: "embedded_page",
			return_url: successUrl,
			expires_at: 1_900_000_000,
		});
		expect(f.created[0]).not.toHaveProperty("success_url");
		expect(f.stored().executionResult).toEqual({
			kind: "checkout",
			sessionId: "cs_embedded",
			duplicate: false,
			promotionRedemption: null,
		});
		expect(f.retrieved).toEqual([]);

		expect(await execute()).toEqual({
			kind: "checkout",
			sessionId: "cs_embedded",
			clientSecret: "cs_embedded_secret_read",
			duplicate: false,
			promotionRedemption: null,
		});
		expect([f.created.length, f.retrieved]).toEqual([1, ["cs_embedded"]]);
	});

	it("stores and replays a hosted checkout's URL unchanged", async () => {
		const f = fixture();
		await f.service.previewCommercialAction({ billingAccountId: "acct_1", intent: intent() });
		const execute = () =>
			f.service.executeCommercialAction({
				billingAccountId: "acct_1",
				previewToken,
				idempotencyKey: "intro-1",
			});
		const hosted = {
			kind: "checkout" as const,
			sessionId: "cs_hosted",
			url: "https://checkout.stripe.com/c/pay/cs_hosted",
			duplicate: false,
			promotionRedemption: null,
		};

		expect(await execute()).toEqual(hosted);
		expect(await execute()).toEqual(hosted);
		expect(f.stored().executionResult).toEqual(hosted);
		expect(f.retrieved).toEqual([]);
	});
});
