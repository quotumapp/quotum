import { z } from "zod";
import type { EntitlementService } from "../billing/entitlements";
import { BillingError, isBillingError } from "../billing/errors";
import { projectScopedRateLimitGuard } from "../http/rate-limit";
import { type BillingLogger, safelyLogError } from "../observability/logger";
import { type BillingMetrics, safelyIncrementBillingMetric } from "../observability/metrics";
import { LENIENT_JSON_PARSE, operationDetail } from "../shared/http";
import * as responses from "./contracts/customer-responses";
import {
	requireAppleStoreKitService,
	requireGooglePlayBillingService,
	requireProviderMethod,
	requireStripeBillingService,
} from "./provider-services";
import { privateProject, rejectCallerProjectSelectorBody } from "./request-context";
import type {
	BillingElysia,
	PostAuthGuard,
	ProjectProviderServiceResolver,
	StripeBillingServiceLike,
} from "./types";

export interface CustomerRoutesDependencies {
	app: BillingElysia;
	verifyLimiter: { check(key: string): { allowed: boolean; remaining: number; resetAt: Date } };
	rateLimitKeyOptions: { trustProxyHeaders?: boolean };
	entitlementService: EntitlementService;
	providerServices: ProjectProviderServiceResolver;
	billingMetrics: BillingMetrics;
	billingLogger: BillingLogger;
	registerPostAuthGuard: (guard: PostAuthGuard) => void;
}

const stripeCheckoutSessionBodySchema = z
	.object({
		productKey: z.string().trim().min(1).optional(),
		planKey: z.string().trim().min(1).optional(),
		quantities: z.record(z.string().trim().min(1), z.number().int().positive()).optional(),
		email: z.string().trim().min(1).nullable().optional(),
		successUrl: z.string().trim().check(z.url()).nullable().optional(),
		cancelUrl: z.string().trim().check(z.url()).nullable().optional(),
		expiresAt: z.number().int().positive().optional(),
	})
	.strict()
	.refine((value) => (value.productKey === undefined) !== (value.planKey === undefined));

/** Portal sessions historically accept a request without a body. */
const stripePortalSessionBodySchema = z
	.object({ returnUrl: z.string().trim().check(z.url()).nullable().optional() })
	.optional();

const stripeCatalogQuerySchema = z
	.object({
		provider: z.literal("stripe").default("stripe"),
		channel: z.literal("web").default("web"),
	})
	.strict();

const stripeCustomerRouteParamsSchema = z.object({
	billingAccountId: z.string().trim().min(1),
});

const stripeCheckoutSessionRouteParamsSchema = stripeCustomerRouteParamsSchema.extend({
	sessionId: z.string().trim().min(1),
});

const stripeSubscriptionChangeParamsSchema = stripeCustomerRouteParamsSchema.extend({
	subscriptionId: z.string().trim().min(1),
});

const paymentSetupSessionRouteParamsSchema = stripeCustomerRouteParamsSchema.extend({
	sessionId: z.string().trim().min(1),
});

const stripeSubscriptionChangeBodySchema = z
	.object({
		targetPlanKey: z.string().trim().min(1),
		quantities: z.record(z.string().trim().min(1), z.number().int().positive()).default({}),
		effectiveMode: z.enum(["immediate", "period_end"]).optional(),
		prorationBehavior: z.enum(["always_invoice", "create_prorations", "none"]).optional(),
	})
	.strict();

const commercialActionIntentSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("checkout_plan"),
			planKey: z.string().trim().min(1),
			quantities: z.record(z.string().trim().min(1), z.number().int().positive()).default({}),
			email: z.string().trim().min(1).nullable().optional(),
			successUrl: z.string().trim().check(z.url()).nullable().optional(),
			cancelUrl: z.string().trim().check(z.url()).nullable().optional(),
			expiresAt: z.number().int().positive().optional(),
			promotionCode: z
				.string()
				.trim()
				.regex(/^[A-Za-z0-9-]{3,64}$/)
				.nullable()
				.optional(),
			allowPromotionCodes: z.boolean().optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("checkout_product"),
			productKey: z.string().trim().min(1),
			email: z.string().trim().min(1).nullable().optional(),
			successUrl: z.string().trim().check(z.url()).nullable().optional(),
			cancelUrl: z.string().trim().check(z.url()).nullable().optional(),
			expiresAt: z.number().int().positive().optional(),
			promotionCode: z
				.string()
				.trim()
				.regex(/^[A-Za-z0-9-]{3,64}$/)
				.nullable()
				.optional(),
			allowPromotionCodes: z.boolean().optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("subscription_change"),
			externalSubscriptionId: z.string().trim().min(1),
			targetPlanKey: z.string().trim().min(1),
			quantities: z.record(z.string().trim().min(1), z.number().int().positive()).default({}),
			effectiveMode: z.enum(["immediate", "period_end"]).optional(),
			prorationBehavior: z.enum(["always_invoice", "create_prorations", "none"]).optional(),
			promotionCode: z
				.string()
				.trim()
				.regex(/^[A-Za-z0-9-]{3,64}$/)
				.nullable()
				.optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("cancel"),
			externalSubscriptionId: z.string().trim().min(1),
			effectiveMode: z.enum(["immediate", "period_end"]),
		})
		.strict(),
	z
		.object({
			kind: z.literal("uncancel"),
			externalSubscriptionId: z.string().trim().min(1),
		})
		.strict(),
	z
		.object({
			kind: z.literal("setup_payment"),
			/** Selects the eligible setup methods; it does not bind the account to this currency. */
			currency: z
				.string()
				.trim()
				.regex(/^[A-Za-z]{3}$/),
			email: z.string().trim().min(1).max(320).nullable().optional(),
			successUrl: z.string().trim().max(2000).check(z.url()).nullable().optional(),
			cancelUrl: z.string().trim().max(2000).check(z.url()).nullable().optional(),
		})
		.strict(),
]);

export const commercialActionPreviewBodySchema = z
	.object({ intent: commercialActionIntentSchema })
	.strict();
export const commercialActionExecuteBodySchema = z.object({ previewToken: z.uuid() }).strict();

const purchaseVerificationSchema = z
	.discriminatedUnion("provider", [
		z.object({
			provider: z.literal("apple"),
			billingAccountId: z.string().trim().min(1),
			transactionId: z.string().trim().min(1),
		}),
		z.object({
			provider: z.literal("google"),
			billingAccountId: z.string().trim().min(1),
			purchaseKind: z.enum(["subscription", "consumable", "non_consumable"]),
			purchaseToken: z.string().trim().min(1),
			productId: z.string().trim().min(1).optional(),
		}),
	])
	.superRefine((body, context) => {
		if (
			body.provider === "google" &&
			body.purchaseKind !== "subscription" &&
			body.productId === undefined
		) {
			context.addIssue({
				code: "custom",
				message: "productId is required for one-time Google Play purchases",
				path: ["productId"],
			});
		}
	});

export function registerCustomerRoutes({
	app,
	verifyLimiter,
	rateLimitKeyOptions,
	entitlementService,
	providerServices,
	billingMetrics,
	billingLogger,
	registerPostAuthGuard,
}: CustomerRoutesDependencies): void {
	registerPostAuthGuard(
		projectScopedRateLimitGuard({
			limiter: verifyLimiter,
			matches: (path) => path === "/v1/purchases/verify",
			trustProxyHeaders: rateLimitKeyOptions.trustProxyHeaders,
		}),
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/entitlements",
		async ({ params, project }) => {
			const snapshot = await entitlementService.getSnapshot(
				privateProject(project),
				params.billingAccountId,
			);
			return { success: true, data: snapshot };
		},
		{
			params: stripeCustomerRouteParamsSchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdEntitlements",
				credentialAccess: "read_only",
				tags: ["customer"],
				path: "/v1/billing-accounts/:billingAccountId/entitlements",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdEntitlementsResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/catalog",
		async ({ project }) => {
			const getCatalog = requireProviderMethod(
				requireStripeBillingService(
					await providerServices.stripeBillingService(privateProject(project)),
				),
				"stripe",
				"reads.catalog",
				"Stripe catalog is not available",
			);
			const catalog = await getCatalog();
			return { success: true, data: catalog };
		},
		{
			query: stripeCatalogQuerySchema,
			detail: operationDetail({
				operationId: "getV1Catalog",
				credentialAccess: "read_only",
				tags: ["customer"],
				path: "/v1/catalog",
				responses: {
					200: responses.getV1CatalogResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/billing-account",
		async ({ params, project }) => {
			const getBillingAccount = requireProviderMethod(
				requireStripeBillingService(
					await providerServices.stripeBillingService(privateProject(project)),
				),
				"stripe",
				"reads.billingAccount",
				"Stripe billing account is not available",
			);
			const account = await getBillingAccount(params.billingAccountId);
			return { success: true, data: account };
		},
		{
			params: stripeCustomerRouteParamsSchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdBillingAccount",
				credentialAccess: "read_only",
				tags: ["customer"],
				path: "/v1/billing-accounts/:billingAccountId/billing-account",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdBillingAccountResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/commercial-actions/preview",
		async ({ params, body, project }) => {
			const previewCommercialAction = requireProviderMethod(
				requireStripeBillingService(
					await providerServices.stripeBillingService(privateProject(project)),
				),
				"stripe",
				"commercial.preview",
				"Commercial previews are not available",
			);
			const preview = await previewCommercialAction({
				billingAccountId: params.billingAccountId,
				intent: body.intent,
			});
			return { success: true, data: preview };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: stripeCustomerRouteParamsSchema,
			body: commercialActionPreviewBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdCommercialActionsPreview",
				tags: ["customer"],
				path: "/v1/billing-accounts/:billingAccountId/commercial-actions/preview",
				responses: {
					200: responses.postV1BillingAccountsByBillingAccountIdCommercialActionsPreviewResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/commercial-actions",
		async ({ params, body, request, set, project }) => {
			const idempotencyKey = request.headers.get("idempotency-key")?.trim();
			if (idempotencyKey === undefined || idempotencyKey === "") {
				throw new BillingError("Invalid commercial action execution", "INVALID_REQUEST", 400);
			}
			const executeCommercialAction = requireProviderMethod(
				requireStripeBillingService(
					await providerServices.stripeBillingService(privateProject(project)),
				),
				"stripe",
				"commercial.execute",
				"Commercial actions are not available",
			);
			const result = await executeCommercialAction({
				billingAccountId: params.billingAccountId,
				previewToken: body.previewToken,
				idempotencyKey,
			});
			// Only a queued subscription change is accepted for later work; a cancellation is done.
			set.status = result.kind === "subscription_change" ? 202 : 200;
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: stripeCustomerRouteParamsSchema,
			body: commercialActionExecuteBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdCommercialActions",
				tags: ["customer"],
				path: "/v1/billing-accounts/:billingAccountId/commercial-actions",
				responses: {
					200: responses.postV1BillingAccountsByBillingAccountIdCommercialActionsResponse200Schema,
					202: responses.postV1BillingAccountsByBillingAccountIdCommercialActionsResponse202Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/payment-setup-sessions/:sessionId",
		async ({ params, project }) => {
			const getPaymentSetupSession = requireProviderMethod(
				requireStripeBillingService(
					await providerServices.stripeBillingService(privateProject(project)),
				),
				"stripe",
				"paymentMethods.setupSession",
				"Payment method setup is not available",
			);
			return {
				success: true,
				data: await getPaymentSetupSession({
					billingAccountId: params.billingAccountId,
					sessionId: params.sessionId,
				}),
			};
		},
		{
			params: paymentSetupSessionRouteParamsSchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdPaymentSetupSessionsBySessionId",
				tags: ["customer"],
				path: "/v1/billing-accounts/:billingAccountId/payment-setup-sessions/:sessionId",
				description:
					"Persisted state only. While the setup is open the response carries the reusable hosted link, so it needs full project credentials; a read-only credential is refused.",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdPaymentSetupSessionsBySessionIdResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/providers/apple/account-token",
		async ({ params, project }) => {
			const appAccountToken = await requireAppleStoreKitService(
				await providerServices.appleStoreKitService(privateProject(project)),
			).getOrCreateAppAccountToken(params.billingAccountId);
			return { success: true, data: { appAccountToken } };
		},
		{
			params: stripeCustomerRouteParamsSchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdProvidersAppleAccountToken",
				tags: ["customer"],
				path: "/v1/billing-accounts/:billingAccountId/providers/apple/account-token",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdProvidersAppleAccountTokenResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/providers/google/account-link",
		async ({ params, project }) => {
			const accountLink = await requireGooglePlayBillingService(
				await providerServices.googlePlayBillingService(privateProject(project)),
			).getAccountLink(params.billingAccountId);
			return { success: true, data: accountLink };
		},
		{
			params: stripeCustomerRouteParamsSchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdProvidersGoogleAccountLink",
				tags: ["customer"],
				path: "/v1/billing-accounts/:billingAccountId/providers/google/account-link",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdProvidersGoogleAccountLinkResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions",
		async ({ params, body, request, project }) => {
			const stripe = requireStripeBillingService(
				await providerServices.stripeBillingService(privateProject(project)),
			);
			const sessionInput = {
				billingAccountId: params.billingAccountId,
				email: body.email,
				expiresAt: body.expiresAt,
			};
			const idempotencyKey = request.headers.get("idempotency-key") ?? undefined;
			let session: Awaited<ReturnType<StripeBillingServiceLike["createCheckoutSession"]>>;
			if (body.planKey === undefined) {
				if (body.productKey === undefined) {
					throw new BillingError("A Checkout target is required", "INVALID_REQUEST", 400);
				}
				session = await stripe.createCheckoutSession({
					...sessionInput,
					productKey: body.productKey,
					idempotencyKey,
					successUrl: body.successUrl,
					cancelUrl: body.cancelUrl,
				});
			} else {
				session = await requireProviderMethod(
					stripe,
					"stripe",
					"checkout.createPlan",
					"Plan Checkout is not available",
				)({
					...sessionInput,
					planKey: body.planKey,
					quantities: body.quantities,
					idempotencyKey,
					successUrl: body.successUrl,
					cancelUrl: body.cancelUrl,
				});
			}
			return { success: true, data: session };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: stripeCustomerRouteParamsSchema,
			body: stripeCheckoutSessionBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdProvidersStripeCheckoutSessions",
				tags: ["customer"],
				path: "/v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions",
				responses: {
					200: responses.postV1BillingAccountsByBillingAccountIdProvidersStripeCheckoutSessionsResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/providers/stripe/portal-sessions",
		async ({ params, body, project }) => {
			const session = await requireStripeBillingService(
				await providerServices.stripeBillingService(privateProject(project)),
			).createPortalSession({
				billingAccountId: params.billingAccountId,
				returnUrl: body?.returnUrl,
			});
			return { success: true, data: session };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: stripeCustomerRouteParamsSchema,
			body: stripePortalSessionBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdProvidersStripePortalSessions",
				tags: ["customer"],
				path: "/v1/billing-accounts/:billingAccountId/providers/stripe/portal-sessions",
				responses: {
					200: responses.postV1BillingAccountsByBillingAccountIdProvidersStripePortalSessionsResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/subscriptions/:subscriptionId/changes",
		async ({ params, body, request, set, project }) => {
			const idempotencyKey = request.headers.get("idempotency-key")?.trim();
			if (idempotencyKey === undefined || idempotencyKey === "") {
				throw new BillingError(
					"Invalid Stripe subscription change request",
					"INVALID_REQUEST",
					400,
				);
			}
			const requestSubscriptionChange = requireProviderMethod(
				requireStripeBillingService(
					await providerServices.stripeBillingService(privateProject(project)),
				),
				"stripe",
				"commercial.requestChange",
				"Subscription changes are not available",
			);
			const change = await requestSubscriptionChange({
				billingAccountId: params.billingAccountId,
				externalSubscriptionId: params.subscriptionId,
				targetPlanKey: body.targetPlanKey,
				quantities: body.quantities,
				effectiveMode: body.effectiveMode,
				prorationBehavior: body.prorationBehavior,
				idempotencyKey,
			});
			set.status = 202;
			return { success: true, data: withoutJobProviderIdentity(change) };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: stripeSubscriptionChangeParamsSchema,
			body: stripeSubscriptionChangeBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdSubscriptionsBySubscriptionIdChanges",
				tags: ["customer"],
				path: "/v1/billing-accounts/:billingAccountId/subscriptions/:subscriptionId/changes",
				responses: {
					202: responses.postV1BillingAccountsByBillingAccountIdSubscriptionsBySubscriptionIdChangesResponse202Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions/:sessionId",
		async ({ params, project }) => {
			const session = await requireStripeBillingService(
				await providerServices.stripeBillingService(privateProject(project)),
			).getCheckoutSessionStatus({
				billingAccountId: params.billingAccountId,
				sessionId: params.sessionId,
			});
			return { success: true, data: session };
		},
		{
			params: stripeCheckoutSessionRouteParamsSchema,
			detail: operationDetail({
				operationId:
					"getV1BillingAccountsByBillingAccountIdProvidersStripeCheckoutSessionsBySessionId",
				tags: ["customer"],
				path: "/v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions/:sessionId",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdProvidersStripeCheckoutSessionsBySessionIdResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions/:sessionId/expire",
		async ({ params, project }) => {
			const expireCheckoutSession = requireProviderMethod(
				requireStripeBillingService(
					await providerServices.stripeBillingService(privateProject(project)),
				),
				"stripe",
				"checkout.expire",
				"Checkout expiration is unavailable",
			);
			return { success: true, data: await expireCheckoutSession(params) };
		},
		{
			parse: "none",
			params: stripeCheckoutSessionRouteParamsSchema,
			detail: operationDetail({
				operationId: "expireStripeCheckoutSession",
				tags: ["customer"],
				path: "/v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions/:sessionId/expire",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdProvidersStripeCheckoutSessionsBySessionIdResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/purchases/verify",
		async ({ body, project }) => {
			rejectCallerProjectSelectorBody({ body });
			const context = privateProject(project);
			let provider = "unknown";

			const verifyPurchase = async () => {
				provider = providerFromRequestBody(body);
				const parsed = purchaseVerificationSchema.safeParse(body);
				if (!parsed.success) {
					throw new BillingError("Invalid purchase verification body", "INVALID_REQUEST", 400);
				}

				provider = parsed.data.provider;
				return parsed.data.provider === "apple"
					? await requireAppleStoreKitService(
							await providerServices.appleStoreKitService(context),
						).verifyPurchase({
							billingAccountId: parsed.data.billingAccountId,
							transactionId: parsed.data.transactionId,
						})
					: await requireGooglePlayBillingService(
							await providerServices.googlePlayBillingService(context),
						).verifyPurchase({
							billingAccountId: parsed.data.billingAccountId,
							purchaseKind: parsed.data.purchaseKind,
							purchaseToken: parsed.data.purchaseToken,
							productId: parsed.data.productId,
						});
			};

			try {
				const snapshot = await verifyPurchase();
				return { success: true, data: snapshot };
			} catch (error) {
				recordVerificationFailure(
					billingMetrics,
					billingLogger,
					provider,
					error,
					context.projectInstanceKey,
				);
				throw error;
			}
		},
		{
			parse: [LENIENT_JSON_PARSE],
			detail: operationDetail({
				operationId: "postV1PurchasesVerify",
				tags: ["customer"],
				path: "/v1/purchases/verify",
				responses: {
					200: responses.postV1PurchasesVerifyResponse200Schema,
				},
				// Validated in the handler so failed verifications are still recorded per provider.
				request: { body: purchaseVerificationSchema },
			}),
		},
	);
}

/** The queued change keeps its provider identity internally; the response never included it. */
function withoutJobProviderIdentity(change: unknown): unknown {
	if (typeof change !== "object" || change === null) return change;
	const {
		provider: _provider,
		providerAccountId: _providerAccountId,
		...data
	} = change as Record<string, unknown>;
	return data;
}

function recordVerificationFailure(
	metrics: BillingMetrics,
	logger: BillingLogger,
	provider: string,
	error: unknown,
	projectKey: string,
): void {
	const code = billingErrorCode(error);
	safelyIncrementBillingMetric(metrics, "billing_verification_failures_total", { provider, code });
	safelyIncrementBillingMetric(metrics, "billing_provider_operations_total", {
		provider,
		operation: "purchase_verification",
		result: "failed",
		code,
	});
	safelyLogError(logger, "Purchase verification failed", error, { provider, code, projectKey });
}

function billingErrorCode(error: unknown): string {
	return isBillingError(error) ? error.code : "INTERNAL_ERROR";
}

function providerFromRequestBody(body: unknown): string {
	if (
		typeof body === "object" &&
		body !== null &&
		"provider" in body &&
		typeof body.provider === "string"
	) {
		return body.provider === "apple" || body.provider === "google" ? body.provider : "unknown";
	}

	return "unknown";
}
