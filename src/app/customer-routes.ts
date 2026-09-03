import type { Context, Hono } from "hono";
import { z } from "zod";
import type { EntitlementService } from "../billing/entitlements";
import { BillingError, isBillingError } from "../billing/errors";
import { type RateLimitResult, rateLimitMiddleware } from "../http/rate-limit";
import { type BillingLogger, safelyLogError } from "../observability/logger";
import { type BillingMetrics, safelyIncrementBillingMetric } from "../observability/metrics";
import type { ProjectContext } from "../projects/context";
import {
	requireAppleStoreKitService,
	requireGooglePlayBillingService,
	requireStripeBillingService,
} from "./provider-services";
import type {
	BillingContext,
	BillingHonoEnv,
	ProjectProviderServiceResolver,
	StripeBillingServiceLike,
} from "./types";

type RateLimiter = { check(key: string): RateLimitResult };

export interface CustomerRoutesDependencies {
	app: Hono<BillingHonoEnv>;
	verifyLimiter: RateLimiter;
	rateLimitKey: (c: Context) => string;
	entitlementService: EntitlementService;
	providerServices: ProjectProviderServiceResolver;
	billingMetrics: BillingMetrics;
	billingLogger: BillingLogger;
	parsePrivateJson(request: Request): Promise<unknown>;
}

const stripeCheckoutSessionBodySchema = z
	.object({
		productKey: z.string().trim().min(1).optional(),
		planKey: z.string().trim().min(1).optional(),
		quantities: z.record(z.string().trim().min(1), z.number().int().positive().safe()).optional(),
		email: z.string().trim().min(1).nullable().optional(),
		successUrl: z.string().trim().url().nullable().optional(),
		cancelUrl: z.string().trim().url().nullable().optional(),
	})
	.strict()
	.refine((value) => (value.productKey === undefined) !== (value.planKey === undefined));

const stripePortalSessionBodySchema = z.object({
	returnUrl: z.string().trim().url().nullable().optional(),
});

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

const stripeSubscriptionChangeBodySchema = z
	.object({
		targetPlanKey: z.string().trim().min(1),
		quantities: z.record(z.string().trim().min(1), z.number().int().positive().safe()).default({}),
		effectiveMode: z.enum(["immediate", "period_end"]).optional(),
		prorationBehavior: z.enum(["always_invoice", "create_prorations", "none"]).optional(),
	})
	.strict();

const commercialActionIntentSchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("checkout_plan"),
			planKey: z.string().trim().min(1),
			quantities: z
				.record(z.string().trim().min(1), z.number().int().positive().safe())
				.default({}),
			email: z.string().trim().min(1).nullable().optional(),
			successUrl: z.string().trim().url().nullable().optional(),
			cancelUrl: z.string().trim().url().nullable().optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("checkout_product"),
			productKey: z.string().trim().min(1),
			email: z.string().trim().min(1).nullable().optional(),
			successUrl: z.string().trim().url().nullable().optional(),
			cancelUrl: z.string().trim().url().nullable().optional(),
		})
		.strict(),
	z
		.object({
			kind: z.literal("subscription_change"),
			externalSubscriptionId: z.string().trim().min(1),
			targetPlanKey: z.string().trim().min(1),
			quantities: z
				.record(z.string().trim().min(1), z.number().int().positive().safe())
				.default({}),
			effectiveMode: z.enum(["immediate", "period_end"]).optional(),
			prorationBehavior: z.enum(["always_invoice", "create_prorations", "none"]).optional(),
		})
		.strict(),
]);

const commercialActionPreviewBodySchema = z
	.object({ intent: commercialActionIntentSchema })
	.strict();
const commercialActionExecuteBodySchema = z.object({ previewToken: z.string().uuid() }).strict();

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
	rateLimitKey,
	entitlementService,
	providerServices,
	billingMetrics,
	billingLogger,
	parsePrivateJson,
}: CustomerRoutesDependencies): void {
	app.use(
		"/v1/purchases/verify",
		rateLimitMiddleware({ limiter: verifyLimiter, key: rateLimitKey }),
	);

	app.get("/v1/billing-accounts/:billingAccountId/entitlements", async (c) => {
		const snapshot = await entitlementService.getSnapshot(
			privateProject(c),
			c.req.param("billingAccountId"),
		);
		return c.json({ success: true, data: snapshot });
	});

	app.get("/v1/catalog", async (c) => {
		const parsed = stripeCatalogQuerySchema.safeParse(c.req.query());
		if (!parsed.success) {
			throw new BillingError("Invalid billing catalog query", "INVALID_REQUEST", 400);
		}
		const stripe = requireStripeBillingService(
			providerServices.stripeBillingService(privateProject(c)),
		);
		if (stripe.getCatalog === undefined) {
			throw new BillingError("Stripe catalog is not available", "STRIPE_NOT_CONFIGURED", 503);
		}
		const catalog = await stripe.getCatalog();
		return c.json({ success: true, data: catalog });
	});

	app.get("/v1/billing-accounts/:billingAccountId/billing-account", async (c) => {
		const params = parseStripeCustomerRouteParams(c.req.param());
		const stripe = requireStripeBillingService(
			providerServices.stripeBillingService(privateProject(c)),
		);
		if (stripe.getBillingAccount === undefined) {
			throw new BillingError(
				"Stripe billing account is not available",
				"STRIPE_NOT_CONFIGURED",
				503,
			);
		}
		const account = await stripe.getBillingAccount(params.billingAccountId);
		return c.json({ success: true, data: account });
	});

	app.post("/v1/billing-accounts/:billingAccountId/commercial-actions/preview", async (c) => {
		const params = parseStripeCustomerRouteParams(c.req.param());
		const body = commercialActionPreviewBodySchema.safeParse(await parsePrivateJson(c.req.raw));
		if (!body.success) {
			throw new BillingError("Invalid commercial action preview", "INVALID_REQUEST", 400);
		}
		const stripe = requireStripeBillingService(
			providerServices.stripeBillingService(privateProject(c)),
		);
		if (stripe.previewCommercialAction === undefined) {
			throw new BillingError("Commercial previews are not available", "STRIPE_NOT_CONFIGURED", 503);
		}
		const preview = await stripe.previewCommercialAction({
			billingAccountId: params.billingAccountId,
			intent: body.data.intent,
		});
		return c.json({ success: true, data: preview });
	});

	app.post("/v1/billing-accounts/:billingAccountId/commercial-actions", async (c) => {
		const params = parseStripeCustomerRouteParams(c.req.param());
		const body = commercialActionExecuteBodySchema.safeParse(await parsePrivateJson(c.req.raw));
		const idempotencyKey = c.req.header("idempotency-key")?.trim();
		if (!body.success || idempotencyKey === undefined || idempotencyKey === "") {
			throw new BillingError("Invalid commercial action execution", "INVALID_REQUEST", 400);
		}
		const stripe = requireStripeBillingService(
			providerServices.stripeBillingService(privateProject(c)),
		);
		if (stripe.executeCommercialAction === undefined) {
			throw new BillingError("Commercial actions are not available", "STRIPE_NOT_CONFIGURED", 503);
		}
		const result = await stripe.executeCommercialAction({
			billingAccountId: params.billingAccountId,
			previewToken: body.data.previewToken,
			idempotencyKey,
		});
		return c.json({ success: true, data: result }, result.kind === "checkout" ? 200 : 202);
	});

	app.get("/v1/billing-accounts/:billingAccountId/providers/apple/account-token", async (c) => {
		const appAccountToken = await requireAppleStoreKitService(
			providerServices.appleStoreKitService(privateProject(c)),
		).getOrCreateAppAccountToken(c.req.param("billingAccountId"));
		return c.json({ success: true, data: { appAccountToken } });
	});

	app.get("/v1/billing-accounts/:billingAccountId/providers/google/account-link", async (c) => {
		const accountLink = await requireGooglePlayBillingService(
			providerServices.googlePlayBillingService(privateProject(c)),
		).getAccountLink(c.req.param("billingAccountId"));
		return c.json({ success: true, data: accountLink });
	});

	app.post(
		"/v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions",
		async (c) => {
			const params = parseStripeCustomerRouteParams(c.req.param());
			const body = await parsePrivateJson(c.req.raw);
			const parsed = stripeCheckoutSessionBodySchema.safeParse(body);

			if (!parsed.success) {
				throw new BillingError("Invalid Stripe Checkout session body", "INVALID_REQUEST", 400);
			}

			const stripe = requireStripeBillingService(
				providerServices.stripeBillingService(privateProject(c)),
			);
			const sessionInput = {
				billingAccountId: params.billingAccountId,
				email: parsed.data.email,
			};
			const idempotencyKey = c.req.header("idempotency-key");
			let session: Awaited<ReturnType<StripeBillingServiceLike["createCheckoutSession"]>>;
			if (parsed.data.planKey === undefined) {
				if (parsed.data.productKey === undefined) {
					throw new BillingError("A Checkout target is required", "INVALID_REQUEST", 400);
				}
				session = await stripe.createCheckoutSession({
					...sessionInput,
					productKey: parsed.data.productKey,
					idempotencyKey,
					successUrl: parsed.data.successUrl,
					cancelUrl: parsed.data.cancelUrl,
				});
			} else {
				session = await requireRecurringCheckout(stripe)({
					...sessionInput,
					planKey: parsed.data.planKey,
					quantities: parsed.data.quantities,
					idempotencyKey,
					successUrl: parsed.data.successUrl,
					cancelUrl: parsed.data.cancelUrl,
				});
			}
			return c.json({ success: true, data: session });
		},
	);

	app.post("/v1/billing-accounts/:billingAccountId/providers/stripe/portal-sessions", async (c) => {
		const params = parseStripeCustomerRouteParams(c.req.param());
		const body = await optionalPrivateJson(c.req.raw, parsePrivateJson);
		const parsed = stripePortalSessionBodySchema.safeParse(body);
		if (!parsed.success) {
			throw new BillingError("Invalid Stripe portal session body", "INVALID_REQUEST", 400);
		}
		const session = await requireStripeBillingService(
			providerServices.stripeBillingService(privateProject(c)),
		).createPortalSession({
			billingAccountId: params.billingAccountId,
			returnUrl: parsed.data.returnUrl,
		});
		return c.json({ success: true, data: session });
	});

	app.post(
		"/v1/billing-accounts/:billingAccountId/subscriptions/:subscriptionId/changes",
		async (c) => {
			const params = stripeSubscriptionChangeParamsSchema.safeParse(c.req.param());
			const body = stripeSubscriptionChangeBodySchema.safeParse(await parsePrivateJson(c.req.raw));
			const idempotencyKey = c.req.header("idempotency-key")?.trim();
			if (
				!params.success ||
				!body.success ||
				idempotencyKey === undefined ||
				idempotencyKey === ""
			) {
				throw new BillingError(
					"Invalid Stripe subscription change request",
					"INVALID_REQUEST",
					400,
				);
			}
			const stripe = requireStripeBillingService(
				providerServices.stripeBillingService(privateProject(c)),
			);
			if (stripe.requestSubscriptionChange === undefined) {
				throw new BillingError(
					"Subscription changes are not available",
					"STRIPE_NOT_CONFIGURED",
					503,
				);
			}
			const change = await stripe.requestSubscriptionChange({
				billingAccountId: params.data.billingAccountId,
				externalSubscriptionId: params.data.subscriptionId,
				targetPlanKey: body.data.targetPlanKey,
				quantities: body.data.quantities,
				effectiveMode: body.data.effectiveMode,
				prorationBehavior: body.data.prorationBehavior,
				idempotencyKey,
			});
			return c.json({ success: true, data: change }, 202);
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/providers/stripe/checkout-sessions/:sessionId",
		async (c) => {
			const params = parseStripeCheckoutSessionRouteParams(c.req.param());
			const session = await requireStripeBillingService(
				providerServices.stripeBillingService(privateProject(c)),
			).getCheckoutSessionStatus({
				billingAccountId: params.billingAccountId,
				sessionId: params.sessionId,
			});
			return c.json({ success: true, data: session });
		},
	);

	app.post("/v1/purchases/verify", async (c) => {
		const project = privateProject(c);
		let provider = "unknown";

		const verifyPurchase = async () => {
			const body = await parsePrivateJson(c.req.raw);
			provider = providerFromRequestBody(body);
			const parsed = purchaseVerificationSchema.safeParse(body);
			if (!parsed.success) {
				throw new BillingError("Invalid purchase verification body", "INVALID_REQUEST", 400);
			}

			provider = parsed.data.provider;
			return parsed.data.provider === "apple"
				? await requireAppleStoreKitService(
						providerServices.appleStoreKitService(project),
					).verifyPurchase({
						billingAccountId: parsed.data.billingAccountId,
						transactionId: parsed.data.transactionId,
					})
				: await requireGooglePlayBillingService(
						providerServices.googlePlayBillingService(project),
					).verifyPurchase({
						billingAccountId: parsed.data.billingAccountId,
						purchaseKind: parsed.data.purchaseKind,
						purchaseToken: parsed.data.purchaseToken,
						productId: parsed.data.productId,
					});
		};

		try {
			const snapshot = await verifyPurchase();
			return c.json({ success: true, data: snapshot });
		} catch (error) {
			recordVerificationFailure(billingMetrics, billingLogger, provider, error, project.projectKey);
			throw error;
		}
	});
}

function requireRecurringCheckout(
	service: StripeBillingServiceLike,
): NonNullable<StripeBillingServiceLike["createRecurringCheckoutSession"]> {
	if (service.createRecurringCheckoutSession === undefined) {
		throw new BillingError("Plan Checkout is not available", "STRIPE_NOT_CONFIGURED", 503);
	}
	return service.createRecurringCheckoutSession.bind(service);
}

async function optionalPrivateJson(
	request: Request,
	parsePrivateJson: (request: Request) => Promise<unknown>,
): Promise<unknown> {
	if (request.body === null) {
		return {};
	}
	return await parsePrivateJson(request);
}

function privateProject(c: BillingContext): ProjectContext {
	const project = c.get("project");
	if (project === undefined) {
		throw new BillingError("Billing project context is required", "BILLING_PROJECT_REQUIRED", 401);
	}
	return project;
}

function parseStripeCustomerRouteParams(params: Record<string, string>): {
	billingAccountId: string;
} {
	const parsed = stripeCustomerRouteParamsSchema.safeParse(params);

	if (!parsed.success) {
		throw new BillingError("Invalid Stripe customer route parameters", "INVALID_REQUEST", 400);
	}

	return parsed.data;
}

function parseStripeCheckoutSessionRouteParams(params: Record<string, string>): {
	billingAccountId: string;
	sessionId: string;
} {
	const parsed = stripeCheckoutSessionRouteParamsSchema.safeParse(params);

	if (!parsed.success) {
		throw new BillingError(
			"Invalid Stripe Checkout session route parameters",
			"INVALID_REQUEST",
			400,
		);
	}

	return parsed.data;
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
