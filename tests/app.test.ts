import { describe, expect, it } from "bun:test";
import type {
	AdminBillingReader,
	AdminCatalogProduct,
	AdminCatalogStoreProduct,
	AdminCustomerDetail,
	AdminCustomerSearchResult,
	AdminProjectionJob,
	AdminPurchase,
	AdminStoreEvent,
	AdminSubscription,
} from "../src/admin/types";
import { createApp as createBillingApp } from "../src/app";
import type { AppDependencies } from "../src/app/types";
import { EntitlementService } from "../src/billing/entitlements";
import { BillingError, InternalBillingError } from "../src/billing/errors";
import type { BillingEnv } from "../src/env";
import type { BillingLogger } from "../src/observability/logger";
import { type BillingMetrics, createInMemoryBillingMetrics } from "../src/observability/metrics";
import { BillingAdminOperations } from "../src/operations/admin";
import { withOpenApiAssertions } from "./helpers/openapi";
import { projectContextResolver, projectInstanceContext } from "./helpers/project-context";

const env: BillingEnv = {
	postgresUri: "postgresql://postgres:postgres@127.0.0.1:5432/postgres",
	authMode: "api_key",
	operatorApiKey: "operator-secret-key",
	projectRuntime: [
		{
			projectInstanceKey: "voysee",
			projectionUrl: "https://voysee.example.com",
			projectionSecret: "voysee-projection-secret",
		},
	],
	runtimeEnvironment: "development",
	workerId: "worker-a",
	workerPollIntervalMs: 5000,
	projectionSyncMaxAttempts: 10,
	storeEventReplayMaxAttempts: 10,
	storeEventReplayPollIntervalMs: 5000,
	subscriptionReconciliationMaxAttempts: 10,
	subscriptionReconciliationPollIntervalMs: 60000,
	providerReconciliationStaleAfterMs: 21600000,
	meteringMaintenancePollIntervalMs: 60000,
	rateLimit: {
		windowMs: 60000,
		verifyLimit: 120,
		webhookLimit: 600,
		adminLimit: 60,
		meteringLimit: 6000,
		trustProxyHeaders: false,
	},
	trustGatewayProjectHeader: false,
	sentry: {
		dsn: null,
		enableLogs: true,
		tracesSampleRate: 0.01,
		logLevel: "warn",
		captureExpectedErrors: false,
	},
};
const validStoreEventId = "123e4567-e89b-12d3-a456-426614174000";
const validCustomerId = "123e4567-e89b-12d3-a456-426614174001";
const validProjectionJobId = "123e4567-e89b-12d3-a456-426614174002";
const validProductId = "123e4567-e89b-12d3-a456-426614174003";
const validStoreProductId = "123e4567-e89b-12d3-a456-426614174004";
const validPurchaseId = "123e4567-e89b-12d3-a456-426614174005";
const validSubscriptionId = "123e4567-e89b-12d3-a456-426614174006";
const adminCreatedAt = "2026-05-31T00:00:00.000Z";

function withRateLimit(rateLimit: Partial<BillingEnv["rateLimit"]>): BillingEnv {
	return {
		...env,
		rateLimit: {
			...env.rateLimit,
			...rateLimit,
		},
	};
}

function withAuthMode(authMode: BillingEnv["authMode"]): BillingEnv {
	return {
		...env,
		authMode,
		trustGatewayProjectHeader: authMode === "gateway",
	};
}

function withProjects(projectRuntime: BillingEnv["projectRuntime"]): BillingEnv {
	return {
		...env,
		projectRuntime,
	};
}

function createApp(dependencies: AppDependencies) {
	const contexts = dependencies.env.projectRuntime.map((project) =>
		projectInstanceContext(project.projectInstanceKey),
	);
	return withOpenApiAssertions(
		createBillingApp({
			...dependencies,
			projectContextResolver:
				dependencies.projectContextResolver ??
				projectContextResolver({
					contexts,
					credentials: {
						secret: "voysee",
						"voysee-service-key-123456": "voysee",
						"wiseley-service-key-123456": "wiseley",
						"inactive-project-key-123456": "inactive",
					},
				}),
		}),
	);
}

function createRecordingLogger() {
	const errors: Array<{ message: string; error: unknown; context?: Record<string, unknown> }> = [];
	const infos: Array<{ message: string; context?: Record<string, unknown> }> = [];
	const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
	const logger: BillingLogger = {
		info(message, context) {
			infos.push({ message, context });
		},
		warn(message, context) {
			warnings.push({ message, context });
		},
		error(message, error, context) {
			errors.push({ message, error, context });
		},
	};

	return { logger, errors, infos, warnings };
}

function createThrowingLogger(): BillingLogger {
	return {
		info() {
			throw new Error("logger info failed");
		},
		warn() {
			throw new Error("logger warn failed");
		},
		error() {
			throw new Error("logger error failed");
		},
	};
}

function createThrowingMetrics(): BillingMetrics {
	return {
		increment() {
			throw new Error("metrics increment failed");
		},
		renderPrometheus() {
			throw new Error("metrics render failed");
		},
	};
}

function createAdminCustomerDetail(
	overrides: Partial<AdminCustomerDetail["customer"]> = {},
): AdminCustomerDetail {
	const customer = {
		id: validCustomerId,
		projectKey: "voysee",
		billingAccountId: "user_1",
		email: null,
		metadata: {},
		createdAt: adminCreatedAt,
		updatedAt: adminCreatedAt,
		...overrides,
	};

	return {
		customer,
		entitlementSnapshot: {
			billingAccountId: customer.billingAccountId,
			entitlements: [],
			generatedAt: adminCreatedAt,
		},
		providerCustomers: [],
		activeSubscriptions: [],
		recentPurchases: [],
		recentStoreEvents: [],
		recentProjectionJobs: [],
	};
}

function createAdminPurchase(overrides: Partial<AdminPurchase> = {}): AdminPurchase {
	return {
		id: validPurchaseId,
		customerId: validCustomerId,
		billingAccountId: "user_1",
		provider: "stripe",
		channel: "web",
		purchaseKind: "subscription",
		status: "completed",
		transactionId: "txn_1",
		originalTransactionId: null,
		productKey: "pro_monthly",
		entitlementKey: "pro",
		externalProductId: "prod_1",
		externalPriceId: "price_1",
		purchasedAt: adminCreatedAt,
		invalidatedAt: null,
		invalidationReason: null,
		createdAt: adminCreatedAt,
		...overrides,
	};
}

function createAdminSubscription(overrides: Partial<AdminSubscription> = {}): AdminSubscription {
	return {
		id: validSubscriptionId,
		customerId: validCustomerId,
		billingAccountId: "user_1",
		provider: "stripe",
		channel: "web",
		status: "active",
		externalSubscriptionId: "sub_1",
		externalProductId: "prod_1",
		externalPriceId: "price_1",
		productKey: "pro_monthly",
		entitlementKey: "pro",
		startsAt: adminCreatedAt,
		expiresAt: null,
		autoRenew: true,
		latestTransactionId: "txn_1",
		providerReconciliationAttempts: 0,
		providerReconciliationError: null,
		providerReconciliationNextAttemptAt: null,
		providerReconciledAt: null,
		needsAttention: false,
		createdAt: adminCreatedAt,
		updatedAt: adminCreatedAt,
		...overrides,
	};
}

function createAdminStoreEvent(overrides: Partial<AdminStoreEvent> = {}): AdminStoreEvent {
	return {
		id: validStoreEventId,
		provider: "stripe",
		channel: "web",
		externalEventId: "evt_1",
		eventType: "checkout.session.completed",
		customerId: validCustomerId,
		billingAccountId: "user_1",
		storeProductId: validStoreProductId,
		transactionId: "txn_1",
		purchaseKind: "subscription",
		processingStatus: "processed",
		processingError: null,
		attempts: 1,
		nextAttemptAt: null,
		processedAt: adminCreatedAt,
		createdAt: adminCreatedAt,
		updatedAt: adminCreatedAt,
		...overrides,
	};
}

function createAdminProjectionJob(overrides: Partial<AdminProjectionJob> = {}): AdminProjectionJob {
	return {
		id: validProjectionJobId,
		customerId: validCustomerId,
		billingAccountId: "user_1",
		idempotencyKey: "projection:user_1",
		reason: "purchase_verified",
		status: "pending",
		attempts: 0,
		lastError: null,
		nextAttemptAt: null,
		lockedAt: null,
		lockedBy: null,
		payload: {
			billingAccountId: "user_1",
			generatedAt: adminCreatedAt,
			balances: [],
			entitlements: {
				billingAccountId: "user_1",
				entitlements: [],
				generatedAt: adminCreatedAt,
			},
			reason: "purchase_verified",
		},
		createdAt: adminCreatedAt,
		updatedAt: adminCreatedAt,
		...overrides,
	};
}

function createAdminCatalogProduct(
	overrides: Partial<AdminCatalogProduct> = {},
): AdminCatalogProduct {
	return {
		id: validProductId,
		key: "pro_monthly",
		entitlementKey: "pro",
		creditAmount: 0,
		name: "Pro Monthly",
		description: null,
		type: "subscription",
		active: true,
		metadata: {},
		createdAt: adminCreatedAt,
		updatedAt: adminCreatedAt,
		...overrides,
	};
}

function createAdminCatalogStoreProduct(
	overrides: Partial<AdminCatalogStoreProduct> = {},
): AdminCatalogStoreProduct {
	return {
		id: validStoreProductId,
		productId: validProductId,
		productKey: "pro_monthly",
		provider: "stripe",
		channel: "web",
		externalProductId: "prod_1",
		externalPriceId: "price_1",
		billingPeriod: "month",
		currency: "usd",
		priceAmount: 999,
		active: true,
		metadata: {},
		createdAt: adminCreatedAt,
		updatedAt: adminCreatedAt,
		...overrides,
	};
}

function createFakeAdminBillingReader(
	calls: Array<{ method: string; input: unknown }>,
): AdminBillingReader {
	const listResult = <T>(item: T) => Promise.resolve({ items: [item], nextCursor: "next_1" });

	return {
		getCustomerByBillingAccountId(_project, billingAccountId) {
			calls.push({ method: "getCustomerByBillingAccountId", input: billingAccountId });
			return Promise.resolve(createAdminCustomerDetail({ billingAccountId }));
		},
		getCustomerById(_project, customerId) {
			calls.push({ method: "getCustomerById", input: customerId });
			return Promise.resolve(createAdminCustomerDetail({ id: customerId }));
		},
		searchCustomers(_project, input) {
			calls.push({ method: "searchCustomers", input });
			const result: AdminCustomerSearchResult = {
				customer: createAdminCustomerDetail().customer,
				matchType: "billing_account_id",
				matchedValue: input.query,
			};
			return listResult(result);
		},
		listPurchases(_project, input) {
			calls.push({ method: "listPurchases", input });
			return listResult(createAdminPurchase({ customerId: input.customerId ?? validCustomerId }));
		},
		listSubscriptions(_project, input) {
			calls.push({ method: "listSubscriptions", input });
			return listResult(
				createAdminSubscription({ customerId: input.customerId ?? validCustomerId }),
			);
		},
		listStoreEvents(_project, input) {
			calls.push({ method: "listStoreEvents", input });
			return listResult(createAdminStoreEvent({ customerId: input.customerId ?? validCustomerId }));
		},
		getStoreEvent(_project, input) {
			calls.push({ method: "getStoreEvent", input });
			const event = createAdminStoreEvent({ id: input.eventId });
			return Promise.resolve(
				input.includeRawPayload ? { ...event, rawPayload: { source: "raw" } } : event,
			);
		},
		listProjectionJobs(_project, input) {
			calls.push({ method: "listProjectionJobs", input });
			return listResult(
				createAdminProjectionJob({ customerId: input.customerId ?? validCustomerId }),
			);
		},
		listCatalogProducts(_project, input) {
			calls.push({ method: "listCatalogProducts", input });
			return listResult(createAdminCatalogProduct());
		},
		listCatalogStoreProducts(_project, input) {
			calls.push({ method: "listCatalogStoreProducts", input });
			return listResult(createAdminCatalogStoreProduct());
		},
		getStatsSummary(_project, input) {
			calls.push({ method: "getStatsSummary", input });
			return Promise.resolve({
				storeEvents: { pending: 0, processing: 0, processed: 0, skipped: 0, failed: 0 },
				projectionJobs: { pending: 0, processing: 0, succeeded: 0, failed: 0 },
				subscriptions: { active: 0, gracePeriod: 0, needsAttention: 0 },
				providers: {},
				recentStoreEvents: [],
			});
		},
	};
}

describe("billing app", () => {
	const appleStoreKitService = {
		getOrCreateAppAccountToken(billingAccountId: string) {
			return Promise.resolve(`token-for-${billingAccountId}`);
		},
		verifyPurchase(input: { billingAccountId: string; transactionId: string }) {
			return Promise.resolve({
				billingAccountId: input.billingAccountId,
				generatedAt: "2026-05-31T00:00:00.000Z",
				entitlements: [],
			});
		},
		handleNotification() {
			return Promise.resolve({
				status: "processed" as const,
				entitlements: {
					billingAccountId: "user_1",
					generatedAt: "2026-05-31T00:00:00.000Z",
					entitlements: [],
				},
			});
		},
	};
	const googlePlayBillingService = {
		getAccountLink(billingAccountId: string) {
			return Promise.resolve({ obfuscatedAccountId: `gpa-for-${billingAccountId}` });
		},
		verifyPurchase(input: { billingAccountId: string }) {
			return Promise.resolve({
				billingAccountId: input.billingAccountId,
				generatedAt: "2026-05-31T00:00:00.000Z",
				entitlements: [],
			});
		},
		handleRtdn() {
			return Promise.resolve({
				processed: true,
				eventType: "SUBSCRIPTION_PURCHASED",
				messageId: "message_1",
				entitlements: {
					billingAccountId: "user_1",
					generatedAt: "2026-05-31T00:00:00.000Z",
					entitlements: [],
				},
			});
		},
	};
	const stripeBillingService = {
		getCatalog() {
			return Promise.resolve({
				schemaVersion: 1 as const,
				plans: [],
				oneTimePurchases: [
					{
						key: "credits_100",
						name: "Credits 100",
						kind: "topup" as const,
						currency: "USD",
						amountMinor: 499,
						credits: 100,
					},
				],
			});
		},
		getBillingAccount(billingAccountId: string) {
			return Promise.resolve({
				schemaVersion: 1 as const,
				customerExists: billingAccountId === "user_1",
				subscriptions: [],
				recentInvoices: [],
			});
		},
		previewCommercialAction(input: { billingAccountId: string; intent: { kind: string } }) {
			return Promise.resolve({
				schemaVersion: 1 as const,
				previewToken: "11111111-1111-4111-8111-111111111111",
				intentHash: "a".repeat(64),
				stateFingerprint: "b".repeat(64),
				expiresAt: "2026-08-28T12:15:00.000Z",
				billingAccountId: input.billingAccountId,
				action: input.intent.kind as "checkout_product",
				provider: "stripe" as const,
				lineItems: [],
				estimatedTotalMinor: 499,
				currency: "USD",
				amountStatus: "exact" as const,
				effectiveMode: null,
				effectiveAt: null,
				prorationBehavior: null,
				changeKind: null,
				fromPlanVersionId: null,
				toPlanVersionId: null,
				targetId: "store-product-1",
				warnings: [],
			});
		},
		executeCommercialAction() {
			return Promise.resolve({
				kind: "checkout" as const,
				sessionId: "cs_previewed",
				url: "https://checkout.stripe.com/c/pay/cs_previewed",
				duplicate: false,
			});
		},
		createCheckoutSession(input: {
			billingAccountId: string;
			productKey: string;
			email?: string | null;
		}) {
			return Promise.resolve({
				sessionId: `cs_for_${input.billingAccountId}_${input.productKey}`,
				url: "https://checkout.stripe.com/c/pay/cs_test_123",
			});
		},
		createPortalSession(input: { billingAccountId: string }) {
			return Promise.resolve({
				url: `https://billing.stripe.com/session/bps_for_${input.billingAccountId}`,
			});
		},
		getCheckoutSessionStatus(input: { billingAccountId: string; sessionId: string }) {
			return Promise.resolve({
				sessionId: input.sessionId,
				status: "complete",
				paymentStatus: "paid",
				customerEmail: null,
				productKey: null,
			});
		},
		handleWebhook() {
			return Promise.resolve({
				status: "processed" as const,
				eventType: "checkout.session.completed",
				entitlements: {
					billingAccountId: "user_1",
					generatedAt: "2026-05-31T00:00:00.000Z",
					entitlements: [],
				},
			});
		},
	};

	it("exposes public health", async () => {
		const app = createApp({ env });
		const response = await app.request("/health");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});

	it("sets request ids on responses and preserves caller supplied ids", async () => {
		const app = createApp({ env });

		const generated = await app.request("/health");
		const generatedRequestId = generated.headers.get("x-request-id");
		const forwarded = await app.request("/health", {
			headers: { "x-request-id": "caller-request-1" },
		});

		expect(generatedRequestId).toBeString();
		expect(generatedRequestId).not.toBe("");
		expect(forwarded.headers.get("x-request-id")).toBe("caller-request-1");
	});

	it("classifies unexpected request errors with request ids and HTTP error metrics", async () => {
		const metrics = createInMemoryBillingMetrics();
		const { logger, errors } = createRecordingLogger();
		const app = createApp({
			env,
			metrics,
			logger,
			entitlementService: {
				getSnapshot() {
					throw new InternalBillingError("Entitlement read failed");
				},
			} as unknown as EntitlementService,
		});

		const response = await app.request("/v1/billing-accounts/user_1/entitlements", {
			headers: {
				authorization: "Bearer secret",
				"x-request-id": "request-123",
			},
		});

		expect(response.status).toBe(500);
		expect(response.headers.get("x-request-id")).toBe("request-123");
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "INTERNAL_ERROR", message: "Billing request failed" },
		});
		expect(metrics.renderPrometheus()).toContain(
			'billing_http_errors_total{classification="internal",code="INTERNAL_ERROR",route_group="customer",status="500"} 1',
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("Billing request failed");
		expect(errors[0]?.context).toEqual({
			classification: "internal",
			code: "INTERNAL_ERROR",
			method: "GET",
			path: "/v1/billing-accounts/user_1/entitlements",
			requestId: "request-123",
			routeGroup: "customer",
			status: "500",
		});
	});

	it("splits liveness and readiness checks", async () => {
		const unavailable = createApp({
			env,
			readinessCheck: async () => false,
		});
		const available = createApp({
			env,
			readinessCheck: async () => true,
		});

		const livez = await unavailable.request("/livez");
		const notReady = await unavailable.request("/ready");
		const ready = await available.request("/ready");

		expect(livez.status).toBe(200);
		expect(await livez.json()).toEqual({ status: "ok" });
		expect(notReady.status).toBe(503);
		expect(await notReady.json()).toEqual({ status: "unavailable" });
		expect(ready.status).toBe(200);
		expect(await ready.json()).toEqual({ status: "ok" });
	});

	it("protects entitlement reads with API key auth", async () => {
		const app = createApp({ env });
		const response = await app.request("/v1/billing-accounts/user_1/entitlements");
		expect(response.status).toBe(401);
	});

	it("rate limits unknown credentials before another database-backed resolution", async () => {
		let credentialResolutionCalls = 0;
		const app = createApp({
			env: withRateLimit({
				verifyLimit: 1,
				adminLimit: 1,
				meteringLimit: 1,
				trustProxyHeaders: true,
			}),
			projectContextResolver: {
				async resolveCredential() {
					credentialResolutionCalls += 1;
					return { kind: "not_found" as const };
				},
				async resolveInstanceKey() {
					throw new Error("Gateway resolution should not be called in API-key mode");
				},
				async resolveInstanceId() {
					throw new Error("Worker resolution should not be called by HTTP authentication");
				},
			},
		});
		const unknownCredential = (suffix: number) =>
			`qpk_v1.00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}.${"A".repeat(43)}`;
		const request = (suffix: number, ip: string) =>
			app.request("/v1/catalog", {
				headers: {
					authorization: `Bearer ${unknownCredential(suffix)}`,
					"cf-connecting-ip": ip,
				},
			});

		for (let suffix = 1; suffix <= 3; suffix += 1) {
			const response = await request(suffix, "203.0.113.50");
			expect(response.status).toBe(401);
			expect(response.headers.get("ratelimit-remaining")).toBeNull();
		}
		const limited = await request(4, "203.0.113.50");
		const otherIp = await request(5, "203.0.113.51");

		expect(limited.status).toBe(429);
		expect(limited.headers.get("ratelimit-remaining")).toBe("0");
		expect(await limited.json()).toEqual({
			success: false,
			error: { code: "RATE_LIMITED", message: "Too many requests" },
		});
		expect(otherIp.status).toBe(401);
		expect(credentialResolutionCalls).toBe(4);
	});

	it("rate limits unknown gateway projects before another database-backed resolution", async () => {
		let projectResolutionCalls = 0;
		const gatewayEnv = withAuthMode("gateway");
		const app = createApp({
			env: {
				...gatewayEnv,
				rateLimit: {
					...gatewayEnv.rateLimit,
					verifyLimit: 1,
					adminLimit: 1,
					meteringLimit: 1,
					trustProxyHeaders: true,
				},
			},
			projectContextResolver: {
				async resolveCredential() {
					throw new Error("Credential resolution should not be called in gateway mode");
				},
				async resolveInstanceKey() {
					projectResolutionCalls += 1;
					return { kind: "not_found" as const };
				},
				async resolveInstanceId() {
					throw new Error("Worker resolution should not be called by HTTP authentication");
				},
			},
		});
		const request = (suffix: number, ip: string) =>
			app.request("/v1/catalog", {
				headers: {
					"x-billing-project-key": `unknown-${suffix}`,
					"cf-connecting-ip": ip,
				},
			});

		for (let suffix = 1; suffix <= 3; suffix += 1) {
			expect((await request(suffix, "203.0.113.60")).status).toBe(404);
		}
		expect((await request(4, "203.0.113.60")).status).toBe(429);
		expect((await request(5, "203.0.113.61")).status).toBe(404);
		expect(projectResolutionCalls).toBe(4);
	});

	it("protects admin replay routes with API key auth", async () => {
		const calls: string[] = [];
		const app = createApp({
			env,
			adminOperations: new BillingAdminOperations({
				replayWorker: {
					runOne(_project, eventId: string) {
						calls.push(eventId);
						return Promise.resolve({ eventId, status: "processed" as const });
					},
				},
				reconciliationWorker: {
					runOnce() {
						throw new Error("Unexpected reconciliation run");
					},
				},
			}),
		});

		const response = await app.request(`/v1/admin/store-events/${validStoreEventId}/replay`, {
			method: "POST",
			headers: { "x-billing-operator-key": "operator-secret-key" },
		});

		expect(response.status).toBe(401);
		expect(calls).toEqual([]);
	});

	it("protects admin operation routes with operator key auth", async () => {
		const calls: string[] = [];
		const app = createApp({
			env,
			adminOperations: new BillingAdminOperations({
				replayWorker: {
					runOne(_project, eventId: string) {
						calls.push(eventId);
						return Promise.resolve({ eventId, status: "processed" as const });
					},
				},
				reconciliationWorker: {
					runOnce() {
						calls.push("reconcile");
						return Promise.resolve({
							outcome: "succeeded" as const,
							expiredSubscriptions: 0,
							affectedCustomers: 0,
							providerClaimed: 0,
							providerProcessed: 0,
							providerSkipped: 0,
							providerFailed: 0,
						});
					},
				},
			}),
		});

		for (const path of [
			`/v1/admin/store-events/${validStoreEventId}/replay`,
			"/v1/admin/reconciliation/subscriptions/run",
			`/v1/admin/projection-jobs/${validProjectionJobId}/retry`,
		]) {
			const response = await app.request(path, {
				method: "POST",
				headers: { authorization: "Bearer secret" },
			});

			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({
				success: false,
				error: {
					code: "UNAUTHORIZED",
					message: "Invalid billing operator key",
				},
			});
		}

		expect(calls).toEqual([]);
	});

	it("rejects gateway auth mode service routes without trusted project context", async () => {
		const app = createApp({
			env: withAuthMode("gateway"),
			entitlementService: new EntitlementService({
				getEntitlementSnapshot() {
					throw new Error("entitlement service should not be called");
				},
			}),
			appleStoreKitService,
			googlePlayBillingService,
			stripeBillingService,
		});

		const response = await app.request("/v1/billing-accounts/user_1/entitlements");

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "BILLING_PROJECT_REQUIRED",
				message: "Billing project context is required",
			},
		});
	});

	it("allows non-webhook service routes with trusted project headers in gateway auth mode", async () => {
		const service = new EntitlementService({
			getEntitlementSnapshot(project, billingAccountId) {
				return Promise.resolve({
					billingAccountId: `${project.projectInstanceKey}:${billingAccountId}`,
					generatedAt: "2026-05-31T00:00:00.000Z",
					entitlements: [],
				});
			},
		});
		const app = createApp({
			env: withAuthMode("gateway"),
			entitlementService: service,
			appleStoreKitService,
			googlePlayBillingService,
			stripeBillingService,
			adminOperations: new BillingAdminOperations({
				replayWorker: {
					runOne(_project, eventId: string) {
						return Promise.resolve({ eventId, status: "processed" as const });
					},
				},
				reconciliationWorker: {
					runOnce() {
						throw new Error("Unexpected reconciliation run");
					},
				},
			}),
		});

		const gatewayHeaders = { "x-billing-project-key": "voysee" };
		const entitlement = await app.request("/v1/billing-accounts/user_1/entitlements", {
			headers: gatewayHeaders,
		});
		const apple = await app.request("/v1/billing-accounts/user_1/providers/apple/account-token", {
			headers: gatewayHeaders,
		});
		const google = await app.request("/v1/billing-accounts/user_1/providers/google/account-link", {
			headers: gatewayHeaders,
		});
		const stripe = await app.request(
			"/v1/billing-accounts/user_1/providers/stripe/checkout-sessions",
			{
				method: "POST",
				headers: { ...gatewayHeaders, "content-type": "application/json" },
				body: JSON.stringify({ productKey: "credits_100" }),
			},
		);
		const replay = await app.request(`/v1/admin/store-events/${validStoreEventId}/replay`, {
			method: "POST",
			headers: { ...gatewayHeaders, "x-billing-operator-key": "operator-secret-key" },
		});

		expect(entitlement.status).toBe(200);
		expect((await entitlement.json()).data.billingAccountId).toBe("voysee:user_1");
		expect(apple.status).toBe(200);
		expect(google.status).toBe(200);
		expect(stripe.status).toBe(200);
		expect(replay.status).toBe(200);
	});

	it("rejects inactive project credentials while allowing provider webhooks to drain", async () => {
		const entitlementCalls: string[] = [];
		const webhookCalls: string[] = [];
		const inactiveEnv = withProjects([
			{
				projectInstanceKey: "voysee",
				projectionUrl: "https://voysee.example.com",
				projectionSecret: "voysee-projection-secret",
			},
		]);
		const inactiveContext = projectInstanceContext("voysee", { lifecycleStatus: "inactive" });
		const app = createApp({
			env: inactiveEnv,
			projectContextResolver: projectContextResolver({
				contexts: [inactiveContext],
				credentials: { "inactive-project-key-123456": "voysee" },
			}),
			entitlementService: new EntitlementService({
				getEntitlementSnapshot(_project, billingAccountId) {
					entitlementCalls.push(billingAccountId);
					return Promise.resolve({
						billingAccountId,
						generatedAt: "2026-05-31T00:00:00.000Z",
						entitlements: [],
					});
				},
			}),
			appleStoreKitService: {
				...appleStoreKitService,
				handleNotification() {
					webhookCalls.push("apple");
					return appleStoreKitService.handleNotification();
				},
			},
		});

		const privateRoute = await app.request("/v1/billing-accounts/user_1/entitlements", {
			headers: { authorization: "Bearer inactive-project-key-123456" },
		});
		const webhook = await app.request("/v1/projects/voysee/webhooks/apple", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ signedPayload: "signed-payload" }),
		});

		expect(privateRoute.status).toBe(401);
		expect(await privateRoute.json()).toEqual({
			success: false,
			error: { code: "UNAUTHORIZED", message: "Invalid billing API key" },
		});
		expect(webhook.status).toBe(200);
		expect(entitlementCalls).toEqual([]);
		expect(webhookCalls).toEqual(["apple"]);
	});

	it("fails gateway and webhook project resolution closed when persistence is unavailable", async () => {
		const webhookCalls: string[] = [];
		const app = createApp({
			env: withAuthMode("gateway"),
			projectContextResolver: projectContextResolver({ unavailable: true }),
			appleStoreKitService: {
				...appleStoreKitService,
				handleNotification() {
					webhookCalls.push("apple");
					return appleStoreKitService.handleNotification();
				},
			},
		});

		const gateway = await app.request("/v1/billing-accounts/user_1/entitlements", {
			headers: { "x-billing-project-key": "voysee" },
		});
		const webhook = await app.request("/v1/projects/voysee/webhooks/apple", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ signedPayload: "signed-payload" }),
		});

		for (const response of [gateway, webhook]) {
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({
				success: false,
				error: {
					code: "BILLING_PROJECT_CONTEXT_UNAVAILABLE",
					message: "Billing project context is unavailable",
				},
			});
		}
		expect(webhookCalls).toEqual([]);
	});

	it("isolates purchase verification rate limits by authenticated project", async () => {
		const app = createApp({
			env: {
				...withProjects([
					{
						projectInstanceKey: "voysee",
						projectionUrl: "https://voysee.example.com",
						projectionSecret: "voysee-projection-secret",
					},
					{
						projectInstanceKey: "wiseley",
						projectionUrl: "https://wiseley.example.com",
						projectionSecret: "wiseley-projection-secret",
					},
				]),
				rateLimit: {
					...env.rateLimit,
					verifyLimit: 1,
				},
			},
			appleStoreKitService,
		});
		const body = JSON.stringify({
			provider: "apple",
			billingAccountId: "user_1",
			transactionId: "txn_1",
		});

		const voysee = await app.request("/v1/purchases/verify", {
			method: "POST",
			headers: {
				authorization: "Bearer voysee-service-key-123456",
				"content-type": "application/json",
			},
			body,
		});
		const wiseley = await app.request("/v1/purchases/verify", {
			method: "POST",
			headers: {
				authorization: "Bearer wiseley-service-key-123456",
				"content-type": "application/json",
			},
			body,
		});

		expect(voysee.status).toBe(200);
		expect(wiseley.status).toBe(200);
	});

	it("keeps provider webhooks outside API-key and gateway auth", async () => {
		const app = createApp({
			env: withAuthMode("gateway"),
			appleStoreKitService,
			stripeBillingService,
		});

		const apple = await app.request("/v1/projects/voysee/webhooks/apple", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ signedPayload: "signed-payload" }),
		});
		const stripe = await app.request("/v1/projects/voysee/webhooks/stripe", {
			method: "POST",
			headers: { "stripe-signature": "t=123,v1=abc" },
			body: "{}",
		});

		expect(apple.status).toBe(200);
		expect(stripe.status).toBe(200);
	});

	it("replays store events through injected admin operations", async () => {
		const calls: Array<{ projectKey: string; eventId: string }> = [];
		const { logger, infos } = createRecordingLogger();
		const app = createApp({
			env,
			logger,
			adminOperations: new BillingAdminOperations({
				replayWorker: {
					runOne(project, eventId: string) {
						calls.push({ projectKey: project.projectInstanceKey, eventId });
						return Promise.resolve({ eventId, status: "processed" as const });
					},
				},
				reconciliationWorker: {
					runOnce() {
						throw new Error("Unexpected reconciliation run");
					},
				},
			}),
		});

		const response = await app.request(`/v1/admin/store-events/${validStoreEventId}/replay`, {
			method: "POST",
			headers: {
				authorization: "Bearer secret",
				"x-billing-operator-key": "operator-secret-key",
			},
		});

		expect(response.status).toBe(200);
		expect(calls).toEqual([{ projectKey: "voysee", eventId: validStoreEventId }]);
		expect(infos).toContainEqual({
			message: "Billing admin store event replay requested",
			context: { projectKey: "voysee", eventId: validStoreEventId },
		});
		expect(await response.json()).toEqual({
			success: true,
			data: { eventId: validStoreEventId, status: "processed" },
		});
	});

	it("returns invalid request for malformed admin replay ids", async () => {
		const calls: string[] = [];
		const app = createApp({
			env,
			adminOperations: new BillingAdminOperations({
				replayWorker: {
					runOne(_project, eventId: string) {
						calls.push(eventId);
						return Promise.resolve({ eventId, status: "processed" as const });
					},
				},
				reconciliationWorker: {
					runOnce() {
						throw new Error("Unexpected reconciliation run");
					},
				},
			}),
		});

		const response = await app.request("/v1/admin/store-events/not-a-uuid/replay", {
			method: "POST",
			headers: {
				authorization: "Bearer secret",
				"x-billing-operator-key": "operator-secret-key",
			},
		});

		expect(response.status).toBe(400);
		expect(calls).toEqual([]);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "INVALID_REQUEST", message: "Invalid store event id" },
		});
	});

	it("runs subscription reconciliation through injected admin operations", async () => {
		let calls = 0;
		const { logger, infos } = createRecordingLogger();
		const reconciliationResult = {
			outcome: "succeeded" as const,
			expiredSubscriptions: 2,
			affectedCustomers: 1,
			providerClaimed: 3,
			providerProcessed: 2,
			providerSkipped: 1,
			providerFailed: 0,
		};
		const app = createApp({
			env,
			logger,
			adminOperations: new BillingAdminOperations({
				replayWorker: {
					runOne() {
						throw new Error("Unexpected replay run");
					},
				},
				reconciliationWorker: {
					runOnce() {
						calls += 1;
						return Promise.resolve(reconciliationResult);
					},
				},
			}),
		});

		const response = await app.request("/v1/admin/reconciliation/subscriptions/run", {
			method: "POST",
			headers: {
				authorization: "Bearer secret",
				"x-billing-operator-key": "operator-secret-key",
			},
		});

		expect(response.status).toBe(200);
		expect(calls).toBe(1);
		expect(infos).toContainEqual({
			message: "Billing admin subscription reconciliation requested",
			context: { projectKey: "voysee" },
		});
		expect(await response.json()).toEqual({
			success: true,
			data: reconciliationResult,
		});
	});

	it("requeues a terminal projection job through the operator route", async () => {
		const calls: Array<{ projectKey: string; jobId: string }> = [];
		const app = createApp({
			env,
			adminOperations: new BillingAdminOperations({
				replayWorker: {
					runOne() {
						throw new Error("Unexpected replay run");
					},
				},
				reconciliationWorker: {
					runOnce() {
						throw new Error("Unexpected reconciliation run");
					},
				},
				projectionRepository: {
					retryProjectionSyncJob(project, jobId) {
						calls.push({ projectKey: project.projectInstanceKey, jobId });
						return Promise.resolve({ jobId, status: "pending" as const });
					},
				},
			}),
		});

		const response = await app.request(`/v1/admin/projection-jobs/${validProjectionJobId}/retry`, {
			method: "POST",
			headers: {
				authorization: "Bearer secret",
				"x-billing-operator-key": "operator-secret-key",
			},
		});

		expect(response.status).toBe(200);
		expect(calls).toEqual([{ projectKey: "voysee", jobId: validProjectionJobId }]);
		expect(await response.json()).toEqual({
			success: true,
			data: { jobId: validProjectionJobId, status: "pending" },
		});
	});

	it("returns not-configured errors for admin routes without injected operations", async () => {
		const app = createApp({ env });

		for (const path of [
			`/v1/admin/store-events/${validStoreEventId}/replay`,
			"/v1/admin/reconciliation/subscriptions/run",
			`/v1/admin/projection-jobs/${validProjectionJobId}/retry`,
		]) {
			const response = await app.request(path, {
				method: "POST",
				headers: {
					authorization: "Bearer secret",
					"x-billing-operator-key": "operator-secret-key",
				},
			});

			expect(response.status).toBe(501);
			expect(await response.json()).toEqual({
				success: false,
				error: {
					code: "BILLING_ADMIN_NOT_CONFIGURED",
					message: "Billing admin operations are not configured",
				},
			});
		}
	});

	it("returns customer drilldowns through injected admin reader routes", async () => {
		const calls: Array<{ method: string; input: unknown }> = [];
		const app = createApp({ env, adminBillingReader: createFakeAdminBillingReader(calls) });

		const byBillingAccount = await app.request(
			"/v1/admin/customers/by-billing-account/%20account_1%20",
			{
				headers: { authorization: "Bearer secret" },
			},
		);
		const byCustomerId = await app.request(`/v1/admin/customers/${validCustomerId}`, {
			headers: { authorization: "Bearer secret" },
		});

		expect(byBillingAccount.status).toBe(200);
		expect(byCustomerId.status).toBe(200);
		expect(calls).toEqual([
			{ method: "getCustomerByBillingAccountId", input: "account_1" },
			{ method: "getCustomerById", input: validCustomerId },
		]);
		expect(await byBillingAccount.json()).toEqual({
			success: true,
			data: createAdminCustomerDetail({ billingAccountId: "account_1" }),
		});
		expect(await byCustomerId.json()).toEqual({
			success: true,
			data: createAdminCustomerDetail({ id: validCustomerId }),
		});
	});

	it("returns search and global admin list responses with pagination", async () => {
		const calls: Array<{ method: string; input: unknown }> = [];
		const app = createApp({ env, adminBillingReader: createFakeAdminBillingReader(calls) });
		const headers = { authorization: "Bearer secret" };

		for (const path of [
			"/v1/admin/customers/search?q=%20user_1%20&limit=2",
			"/v1/admin/purchases?provider=stripe&limit=3",
			"/v1/admin/subscriptions?needsAttention=true&limit=4",
			"/v1/admin/store-events?processingStatus=processed&limit=5",
			"/v1/admin/projection-jobs?status=pending&limit=6",
			"/v1/admin/catalog/products?limit=7",
			"/v1/admin/catalog/store-products?provider=stripe&channel=web&limit=8",
		]) {
			const response = await app.request(path, { headers });

			expect(response.status).toBe(200);
			const body = await response.json();
			expect(body.success).toBe(true);
			expect(body.data).toHaveLength(1);
			expect(body.pagination).toEqual({ nextCursor: "next_1" });
		}

		expect(calls).toEqual([
			{ method: "searchCustomers", input: { query: "user_1", limit: 2, cursor: null } },
			{
				method: "listPurchases",
				input: { limit: 3, cursor: null, provider: "stripe" },
			},
			{
				method: "listSubscriptions",
				input: {
					limit: 4,
					cursor: null,
					needsAttention: true,
					staleBefore: expect.any(String),
				},
			},
			{
				method: "listStoreEvents",
				input: { limit: 5, cursor: null, processingStatus: "processed" },
			},
			{
				method: "listProjectionJobs",
				input: { limit: 6, cursor: null, status: "pending" },
			},
			{ method: "listCatalogProducts", input: { limit: 7, cursor: null } },
			{
				method: "listCatalogStoreProducts",
				input: { limit: 8, cursor: null, provider: "stripe", channel: "web" },
			},
		]);
	});

	it("returns a windowed admin stats summary as a detail response", async () => {
		const calls: Array<{ method: string; input: unknown }> = [];
		const app = createApp({ env, adminBillingReader: createFakeAdminBillingReader(calls) });
		const headers = { authorization: "Bearer secret" };

		const response = await app.request(
			"/v1/admin/stats/summary?provider=stripe&from=2026-01-01T00%3A00%3A00.000Z",
			{ headers },
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.success).toBe(true);
		expect(body.data).toEqual({
			storeEvents: { pending: 0, processing: 0, processed: 0, skipped: 0, failed: 0 },
			projectionJobs: { pending: 0, processing: 0, succeeded: 0, failed: 0 },
			subscriptions: { active: 0, gracePeriod: 0, needsAttention: 0 },
			providers: {},
			recentStoreEvents: [],
		});
		expect(body.pagination).toBeUndefined();
		expect(calls).toEqual([
			{
				method: "getStatsSummary",
				input: { provider: "stripe", from: "2026-01-01T00:00:00.000Z" },
			},
		]);
	});

	it("passes authenticated project context into admin readers", async () => {
		const reader = createFakeAdminBillingReader([]);
		const projects: string[] = [];
		const app = createApp({
			env: {
				...env,
				projectRuntime: [
					{
						projectInstanceKey: "voysee",
						projectionUrl: "https://voysee.example.com",
						projectionSecret: "voysee-projection-secret",
					},
					{
						projectInstanceKey: "wiseley",
						projectionUrl: "https://wiseley.example.com",
						projectionSecret: "wiseley-projection-secret",
					},
				],
			},
			adminBillingReader: {
				...reader,
				listPurchases(project, input) {
					projects.push(project.projectInstanceKey);
					return reader.listPurchases(project, input);
				},
			},
		});

		const response = await app.request("/v1/admin/purchases", {
			headers: { authorization: "Bearer wiseley-service-key-123456" },
		});

		expect(response.status).toBe(200);
		expect(projects).toEqual(["wiseley"]);
	});

	it("passes parsed customer ids into child admin list routes", async () => {
		const calls: Array<{ method: string; input: unknown }> = [];
		const app = createApp({ env, adminBillingReader: createFakeAdminBillingReader(calls) });
		const headers = { authorization: "Bearer secret" };

		for (const path of [
			`/v1/admin/customers/${validCustomerId}/purchases?status=completed`,
			`/v1/admin/customers/${validCustomerId}/subscriptions?status=active`,
			`/v1/admin/customers/${validCustomerId}/store-events?eventType=checkout.session.completed`,
			`/v1/admin/customers/${validCustomerId}/projection-jobs?reason=purchase_verified`,
		]) {
			const response = await app.request(path, { headers });

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				success: true,
				data: expect.any(Array),
				pagination: { nextCursor: "next_1" },
			});
		}

		expect(calls).toEqual([
			{
				method: "listPurchases",
				input: { limit: 25, cursor: null, status: "completed", customerId: validCustomerId },
			},
			{
				method: "listSubscriptions",
				input: {
					limit: 25,
					cursor: null,
					status: "active",
					staleBefore: expect.any(String),
					customerId: validCustomerId,
				},
			},
			{
				method: "listStoreEvents",
				input: {
					limit: 25,
					cursor: null,
					eventType: "checkout.session.completed",
					customerId: validCustomerId,
				},
			},
			{
				method: "listProjectionJobs",
				input: {
					limit: 25,
					cursor: null,
					reason: "purchase_verified",
					customerId: validCustomerId,
				},
			},
		]);
	});

	it("controls raw payload inclusion on admin store event details", async () => {
		const calls: Array<{ method: string; input: unknown }> = [];
		const logs = createRecordingLogger();
		const app = createApp({
			env,
			adminBillingReader: createFakeAdminBillingReader(calls),
			logger: logs.logger,
		});
		const headers = { authorization: "Bearer secret" };

		const withoutRawPayload = await app.request(`/v1/admin/store-events/${validStoreEventId}`, {
			headers,
		});
		const withRawPayload = await app.request(
			`/v1/admin/store-events/${validStoreEventId}?includeRawPayload=true`,
			{ headers },
		);

		expect(withoutRawPayload.status).toBe(200);
		expect(withRawPayload.status).toBe(200);
		expect(await withoutRawPayload.json()).toEqual({
			success: true,
			data: createAdminStoreEvent({ id: validStoreEventId }),
		});
		expect(await withRawPayload.json()).toEqual({
			success: true,
			data: {
				...createAdminStoreEvent({ id: validStoreEventId }),
				rawPayload: { source: "raw" },
			},
		});
		expect(calls).toEqual([
			{
				method: "getStoreEvent",
				input: { eventId: validStoreEventId, includeRawPayload: false },
			},
			{
				method: "getStoreEvent",
				input: { eventId: validStoreEventId, includeRawPayload: true },
			},
		]);
		expect(logs.infos).toContainEqual({
			message: "Billing admin raw store event payload read",
			context: { projectKey: "voysee", eventId: validStoreEventId },
		});
	});

	it("rejects invalid admin read filters before calling the admin reader", async () => {
		const calls: Array<{ method: string; input: unknown }> = [];
		const app = createApp({ env, adminBillingReader: createFakeAdminBillingReader(calls) });
		const headers = { authorization: "Bearer secret" };

		const response = await app.request("/v1/admin/purchases?provider=not-a-provider", {
			headers,
		});
		const cursorResponse = await app.request("/v1/admin/purchases?cursor=not-base64", {
			headers,
		});

		expect(response.status).toBe(400);
		expect(cursorResponse.status).toBe(400);
		expect(calls).toEqual([]);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "INVALID_REQUEST", message: "Invalid purchase filters" },
		});
		expect(await cursorResponse.json()).toEqual({
			success: false,
			error: { code: "INVALID_REQUEST", message: "Invalid cursor" },
		});
	});

	it("does not create default billing repositories before routes need them", async () => {
		const service = new EntitlementService({
			getEntitlementSnapshot() {
				throw new Error("Unexpected entitlement read");
			},
		});
		const app = createApp({
			env: { ...env, postgresUri: "not-a-url" },
			entitlementService: service,
		});

		const response = await app.request("/health");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});

	it("returns not-configured errors for explicitly disabled admin read routes", async () => {
		const app = createApp({ env, adminBillingReader: null });

		const response = await app.request("/v1/admin/customers/search?q=user_1", {
			headers: { authorization: "Bearer secret" },
		});

		expect(response.status).toBe(501);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "BILLING_ADMIN_NOT_CONFIGURED",
				message: "Billing admin reader is not configured",
			},
		});
	});

	it("returns entitlement snapshots", async () => {
		const service = new EntitlementService({
			getEntitlementSnapshot(_project, billingAccountId) {
				return Promise.resolve({
					billingAccountId,
					generatedAt: "2026-05-31T00:00:00.000Z",
					entitlements: [],
				});
			},
		});
		const app = createApp({ env, entitlementService: service });

		const response = await app.request("/v1/billing-accounts/user_1/entitlements", {
			headers: { authorization: "Bearer secret" },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			data: {
				billingAccountId: "user_1",
				generatedAt: "2026-05-31T00:00:00.000Z",
				entitlements: [],
			},
		});
	});

	it("returns Apple app account tokens through API-key protected routes", async () => {
		const app = createApp({ env, appleStoreKitService });

		const unauthorized = await app.request(
			"/v1/billing-accounts/user_1/providers/apple/account-token",
		);
		expect(unauthorized.status).toBe(401);

		const response = await app.request(
			"/v1/billing-accounts/user_1/providers/apple/account-token",
			{
				headers: { authorization: "Bearer secret" },
			},
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			data: { appAccountToken: "token-for-user_1" },
		});
	});

	it("verifies Apple purchases through API-key protected routes", async () => {
		const app = createApp({ env, appleStoreKitService });
		const response = await app.request("/v1/purchases/verify", {
			method: "POST",
			headers: {
				authorization: "Bearer secret",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				provider: "apple",
				billingAccountId: "user_1",
				transactionId: "200000000000001",
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			data: {
				billingAccountId: "user_1",
				generatedAt: "2026-05-31T00:00:00.000Z",
				entitlements: [],
			},
		});
	});

	it("returns Google account links through API-key protected routes", async () => {
		const app = createApp({ env, googlePlayBillingService });

		const unauthorized = await app.request(
			"/v1/billing-accounts/user_1/providers/google/account-link",
		);
		expect(unauthorized.status).toBe(401);

		const response = await app.request(
			"/v1/billing-accounts/user_1/providers/google/account-link",
			{
				headers: { authorization: "Bearer secret" },
			},
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			data: { obfuscatedAccountId: "gpa-for-user_1" },
		});
	});

	it("returns the Stripe web catalog and customer billing account", async () => {
		const app = createApp({ env, stripeBillingService });
		const headers = { authorization: "Bearer secret" };
		const catalog = await app.request("/v1/catalog?provider=stripe&channel=web", { headers });
		const account = await app.request("/v1/billing-accounts/user_1/billing-account", { headers });

		expect(catalog.status).toBe(200);
		expect(await catalog.json()).toEqual({
			success: true,
			data: {
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
			},
		});
		expect(account.status).toBe(200);
		expect(await account.json()).toEqual({
			success: true,
			data: {
				schemaVersion: 1,
				customerExists: true,
				subscriptions: [],
				recentInvoices: [],
			},
		});
	});

	it("previews and executes a token-bound commercial action", async () => {
		const app = createApp({ env, stripeBillingService });
		const headers = { authorization: "Bearer secret", "content-type": "application/json" };
		const preview = await app.request("/v1/billing-accounts/user_1/commercial-actions/preview", {
			method: "POST",
			headers,
			body: JSON.stringify({
				intent: { kind: "checkout_product", productKey: "credits_100" },
			}),
		});
		expect(preview.status).toBe(200);
		expect((await preview.json()).data).toMatchObject({
			previewToken: "11111111-1111-4111-8111-111111111111",
			action: "checkout_product",
			estimatedTotalMinor: 499,
		});

		const execute = await app.request("/v1/billing-accounts/user_1/commercial-actions", {
			method: "POST",
			headers: { ...headers, "idempotency-key": "buy-credits-1" },
			body: JSON.stringify({ previewToken: "11111111-1111-4111-8111-111111111111" }),
		});
		expect(execute.status).toBe(200);
		expect(await execute.json()).toEqual({
			success: true,
			data: {
				kind: "checkout",
				sessionId: "cs_previewed",
				url: "https://checkout.stripe.com/c/pay/cs_previewed",
				duplicate: false,
			},
		});
	});

	it("serves bounded usage exploration and a provider-neutral billing summary", async () => {
		const calls: string[] = [];
		const app = createApp({
			env,
			billingInsightsService: {
				listUsageEvents(_project, input) {
					calls.push(`events:${input.billingAccountId}:${input.featureKey}`);
					return Promise.resolve({
						items: [
							{
								id: "22222222-2222-4222-8222-222222222222",
								recordedAt: "2026-08-28T10:00:00.000Z",
								occurredAt: null,
								effectiveAt: "2026-08-28T10:00:00.000Z",
								operation: "consume",
								featureKey: "api_calls",
								featureUnit: "request",
								entityId: null,
								quantity: "4",
								walletQuantity: "4",
								filterKey: null,
								metadata: {},
							},
						],
						nextCursor: null,
					});
				},
				getUsageSeries() {
					return Promise.resolve([]);
				},
				getCustomerBillingSummary(_project, billingAccountId) {
					calls.push(`summary:${billingAccountId}`);
					return Promise.resolve({
						schemaVersion: 1 as const,
						billingAccountId,
						customerExists: true,
						generatedAt: "2026-08-28T10:00:00.000Z",
						subscriptions: [],
						balances: [],
						usage: [],
						recentInvoices: [],
					});
				},
			},
		});
		const headers = { authorization: "Bearer secret" };
		const events = await app.request(
			"/v1/billing-accounts/user_1/usage/events?featureKey=api_calls&limit=25",
			{ headers },
		);
		const summary = await app.request("/v1/billing-accounts/user_1/billing-summary", {
			headers,
		});
		expect(events.status).toBe(200);
		expect((await events.json()).data[0]).toMatchObject({
			featureKey: "api_calls",
			quantity: "4",
		});
		expect(summary.status).toBe(200);
		expect((await summary.json()).data).toMatchObject({
			billingAccountId: "user_1",
			customerExists: true,
		});
		expect(calls).toEqual(["events:user_1:api_calls", "summary:user_1"]);
	});

	it("rejects malformed or unbounded usage insight queries before repository work", async () => {
		let calls = 0;
		const app = createApp({
			env,
			billingInsightsService: {
				listUsageEvents() {
					calls += 1;
					return Promise.resolve({ items: [], nextCursor: null });
				},
				getUsageSeries() {
					calls += 1;
					return Promise.resolve([]);
				},
				getCustomerBillingSummary(_project, billingAccountId) {
					return Promise.resolve({
						schemaVersion: 1 as const,
						billingAccountId,
						customerExists: false,
						generatedAt: "2026-08-30T00:00:00.000Z",
						subscriptions: [],
						balances: [],
						usage: [],
						recentInvoices: [],
					});
				},
			},
		});
		const headers = { authorization: "Bearer secret" };
		const paths = [
			"/v1/billing-accounts/user_1/usage/events?limit=0",
			"/v1/billing-accounts/user_1/usage/events?limit=201",
			"/v1/billing-accounts/user_1/usage/events?cursor=not-json",
			"/v1/billing-accounts/user_1/usage/events?from=2026-08-30T00:00:00.000Z&to=2026-08-30T00:00:00.000Z",
			"/v1/billing-accounts/user_1/usage/events?from=2026-01-01T00:00:00.000Z&to=2026-08-30T00:00:00.000Z",
			"/v1/billing-accounts/user_1/usage/events?unknown=true",
			"/v1/billing-accounts/user_1/usage/series?interval=month",
			"/v1/billing-accounts/user_1/usage/series?from=2026-01-01T00:00:00.000Z&to=2026-08-30T00:00:00.000Z",
		];

		for (const path of paths) {
			const response = await app.request(path, { headers });
			expect(response.status).toBe(400);
			expect((await response.json()).error.code).toBe("INVALID_REQUEST");
		}
		expect(calls).toBe(0);
	});

	it("rejects obsolete schema selectors and unknown Stripe catalog query parameters", async () => {
		const app = createApp({ env, stripeBillingService });
		for (const query of ["schemaVersion=1", "schemaVersion=2", "foo=bar"]) {
			const response = await app.request(`/v1/catalog?provider=stripe&channel=web&${query}`, {
				headers: { authorization: "Bearer secret" },
			});

			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				success: false,
				error: { code: "INVALID_REQUEST", message: "Invalid billing catalog query" },
			});
		}
	});

	it("creates Stripe Checkout sessions through API-key protected routes", async () => {
		const calls: Array<{ billingAccountId: string; productKey: string; email?: string | null }> =
			[];
		const app = createApp({
			env,
			stripeBillingService: {
				...stripeBillingService,
				createCheckoutSession(input) {
					calls.push(input);
					return Promise.resolve({
						sessionId: "cs_test_123",
						url: "https://checkout.stripe.com/c/pay/cs_test_123",
					});
				},
			},
		});

		const response = await app.request(
			"/v1/billing-accounts/user_1/providers/stripe/checkout-sessions",
			{
				method: "POST",
				headers: {
					authorization: "Bearer secret",
					"content-type": "application/json",
				},
				body: JSON.stringify({ productKey: "credits_100", email: "user@example.com" }),
			},
		);

		expect(response.status).toBe(200);
		expect(calls).toEqual([
			{ billingAccountId: "user_1", productKey: "credits_100", email: "user@example.com" },
		]);
		expect(await response.json()).toEqual({
			success: true,
			data: {
				sessionId: "cs_test_123",
				url: "https://checkout.stripe.com/c/pay/cs_test_123",
			},
		});
	});

	it("selects Stripe services from the authenticated project key", async () => {
		const calls: string[] = [];
		const app = createApp({
			env: {
				...env,
				projectRuntime: [
					{
						projectInstanceKey: "voysee",
						projectionUrl: "https://voysee.example.com",
						projectionSecret: "voysee-projection-secret",
					},
					{
						projectInstanceKey: "wiseley",
						projectionUrl: "https://wiseley.example.com",
						projectionSecret: "wiseley-projection-secret",
					},
				],
			},
			projectProviderServices: {
				voysee: {
					stripeBillingService: {
						...stripeBillingService,
						createCheckoutSession() {
							calls.push("voysee");
							return Promise.resolve({
								sessionId: "cs_voysee",
								url: "https://checkout.stripe.com/c/pay/cs_voysee",
							});
						},
					},
				},
				wiseley: {
					stripeBillingService: {
						...stripeBillingService,
						createCheckoutSession() {
							calls.push("wiseley");
							return Promise.resolve({
								sessionId: "cs_wiseley",
								url: "https://checkout.stripe.com/c/pay/cs_wiseley",
							});
						},
					},
				},
			},
		});

		const response = await app.request(
			"/v1/billing-accounts/user_1/providers/stripe/checkout-sessions",
			{
				method: "POST",
				headers: {
					authorization: "Bearer wiseley-service-key-123456",
					"content-type": "application/json",
				},
				body: JSON.stringify({ productKey: "credits_100" }),
			},
		);

		expect(response.status).toBe(200);
		expect(calls).toEqual(["wiseley"]);
		expect(await response.json()).toEqual({
			success: true,
			data: {
				sessionId: "cs_wiseley",
				url: "https://checkout.stripe.com/c/pay/cs_wiseley",
			},
		});
	});

	it("selects Stripe webhook services from the project webhook route", async () => {
		const calls: string[] = [];
		const app = createApp({
			env: {
				...env,
				projectRuntime: [
					{
						projectInstanceKey: "voysee",
						projectionUrl: "https://voysee.example.com",
						projectionSecret: "voysee-projection-secret",
					},
					{
						projectInstanceKey: "wiseley",
						projectionUrl: "https://wiseley.example.com",
						projectionSecret: "wiseley-projection-secret",
					},
				],
			},
			projectProviderServices: {
				voysee: {
					stripeBillingService: {
						...stripeBillingService,
						handleWebhook() {
							calls.push("voysee");
							return Promise.resolve({
								status: "processed",
								eventType: "checkout.session.completed",
								entitlements: null,
							});
						},
					},
				},
				wiseley: {
					stripeBillingService: {
						...stripeBillingService,
						handleWebhook(input) {
							if (input.signatureHeader === "voysee-signature") {
								throw new BillingError(
									"Stripe webhook signature is invalid",
									"STRIPE_WEBHOOK_SIGNATURE_INVALID",
									400,
								);
							}
							calls.push("wiseley");
							return Promise.resolve({
								status: "processed",
								eventType: "checkout.session.completed",
								entitlements: null,
							});
						},
					},
				},
			},
		});

		const accepted = await app.request("/v1/projects/wiseley/webhooks/stripe", {
			method: "POST",
			headers: { "stripe-signature": "wiseley-signature" },
			body: "{}",
		});
		const rejected = await app.request("/v1/projects/wiseley/webhooks/stripe", {
			method: "POST",
			headers: { "stripe-signature": "voysee-signature" },
			body: "{}",
		});

		expect(accepted.status).toBe(200);
		expect(rejected.status).toBe(400);
		expect(calls).toEqual(["wiseley"]);
		expect(await rejected.json()).toEqual({
			success: false,
			error: {
				code: "STRIPE_WEBHOOK_SIGNATURE_INVALID",
				message: "Stripe webhook signature is invalid",
			},
		});
	});

	it("selects Apple webhook services from the project webhook route", async () => {
		const calls: string[] = [];
		const app = createApp({
			env: {
				...env,
				projectRuntime: [
					{
						projectInstanceKey: "voysee",
						projectionUrl: "https://voysee.example.com",
						projectionSecret: "voysee-projection-secret",
					},
					{
						projectInstanceKey: "wiseley",
						projectionUrl: "https://wiseley.example.com",
						projectionSecret: "wiseley-projection-secret",
					},
				],
			},
			projectProviderServices: {
				voysee: {
					appleStoreKitService: {
						...appleStoreKitService,
						handleNotification() {
							calls.push("voysee");
							return Promise.resolve({ status: "ignored" as const, entitlements: null });
						},
					},
				},
				wiseley: {
					appleStoreKitService: {
						...appleStoreKitService,
						handleNotification() {
							calls.push("wiseley");
							return Promise.resolve({ status: "ignored" as const, entitlements: null });
						},
					},
				},
			},
		});

		const response = await app.request("/v1/projects/wiseley/webhooks/apple", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ signedPayload: "signed-payload" }),
		});

		expect(response.status).toBe(200);
		expect(calls).toEqual(["wiseley"]);
	});

	it("creates Stripe Portal sessions through API-key protected routes", async () => {
		const calls: Array<{ billingAccountId: string }> = [];
		const app = createApp({
			env,
			stripeBillingService: {
				...stripeBillingService,
				createPortalSession(input) {
					calls.push(input);
					return Promise.resolve({
						url: "https://billing.stripe.com/session/bps_test_123",
					});
				},
			},
		});

		const response = await app.request(
			"/v1/billing-accounts/user_1/providers/stripe/portal-sessions",
			{
				method: "POST",
				headers: { authorization: "Bearer secret" },
			},
		);

		expect(response.status).toBe(200);
		expect(calls).toEqual([{ billingAccountId: "user_1" }]);
		expect(await response.json()).toEqual({
			success: true,
			data: { url: "https://billing.stripe.com/session/bps_test_123" },
		});
	});

	it("returns Stripe Checkout session status through API-key protected routes", async () => {
		const calls: Array<{ billingAccountId: string; sessionId: string }> = [];
		const app = createApp({
			env,
			stripeBillingService: {
				...stripeBillingService,
				getCheckoutSessionStatus(input) {
					calls.push(input);
					return Promise.resolve({
						sessionId: input.sessionId,
						status: "open",
						paymentStatus: "unpaid",
						customerEmail: null,
						productKey: null,
					});
				},
			},
		});

		const response = await app.request(
			"/v1/billing-accounts/user_1/providers/stripe/checkout-sessions/cs_test_123",
			{
				headers: { authorization: "Bearer secret" },
			},
		);

		expect(response.status).toBe(200);
		expect(calls).toEqual([{ billingAccountId: "user_1", sessionId: "cs_test_123" }]);
		expect(await response.json()).toEqual({
			success: true,
			data: {
				sessionId: "cs_test_123",
				status: "open",
				paymentStatus: "unpaid",
				customerEmail: null,
				productKey: null,
			},
		});
	});

	it("passes exact raw Stripe webhook bodies and signatures through a public route", async () => {
		const calls: Array<{ rawBody: string; signatureHeader: string | null }> = [];
		const rawBody = '{\n  "id": "evt_123",\n  "data": {"object": {"id": "cs_123"}}\n}';
		const app = createApp({
			env,
			stripeBillingService: {
				...stripeBillingService,
				handleWebhook(input) {
					calls.push(input);
					return Promise.resolve({
						status: "processed" as const,
						eventType: "checkout.session.completed",
						entitlements: null,
					});
				},
			},
		});

		const response = await app.request("/v1/projects/voysee/webhooks/stripe", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"stripe-signature": "t=123,v1=abc",
			},
			body: rawBody,
		});

		expect(response.status).toBe(200);
		expect(calls).toEqual([{ rawBody, signatureHeader: "t=123,v1=abc" }]);
		expect(await response.json()).toEqual({
			success: true,
			data: {
				status: "processed",
				eventType: "checkout.session.completed",
				entitlements: null,
			},
		});
	});

	it("records Stripe webhook failures with metrics and logs", async () => {
		const metrics = createInMemoryBillingMetrics();
		const { logger, errors } = createRecordingLogger();
		const app = createApp({
			env,
			metrics,
			logger,
			stripeBillingService: {
				...stripeBillingService,
				handleWebhook() {
					throw new BillingError(
						"Stripe webhook signature is invalid",
						"STRIPE_WEBHOOK_SIGNATURE_INVALID",
						400,
					);
				},
			},
		});

		const response = await app.request("/v1/projects/voysee/webhooks/stripe", {
			method: "POST",
			headers: { "stripe-signature": "t=123,v1=abc" },
			body: "{}",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "STRIPE_WEBHOOK_SIGNATURE_INVALID",
				message: "Stripe webhook signature is invalid",
			},
		});
		expect(metrics.renderPrometheus()).toContain(
			'billing_webhook_failures_total{code="STRIPE_WEBHOOK_SIGNATURE_INVALID",provider="stripe"} 1',
		);
		expect(metrics.renderPrometheus()).toContain(
			'billing_provider_operations_total{code="STRIPE_WEBHOOK_SIGNATURE_INVALID",operation="webhook",provider="stripe",result="failed"} 1',
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("Stripe webhook failed");
		expect(errors[0]?.context).toEqual({
			provider: "stripe",
			code: "STRIPE_WEBHOOK_SIGNATURE_INVALID",
			projectKey: "voysee",
		});
	});

	it("returns provider-not-configured for disabled Stripe routes", async () => {
		const app = createApp({ env, stripeBillingService: null });

		for (const request of [
			new Request("http://localhost/v1/projects/voysee/webhooks/stripe", {
				method: "POST",
				body: "{}",
			}),
			new Request(
				"http://localhost/v1/billing-accounts/user_1/providers/stripe/checkout-sessions",
				{
					method: "POST",
					headers: {
						authorization: "Bearer secret",
						"content-type": "application/json",
					},
					body: JSON.stringify({ productKey: "credits_100" }),
				},
			),
			new Request("http://localhost/v1/billing-accounts/user_1/providers/stripe/portal-sessions", {
				method: "POST",
				headers: { authorization: "Bearer secret" },
			}),
			new Request(
				"http://localhost/v1/billing-accounts/user_1/providers/stripe/checkout-sessions/cs_test_123",
				{ headers: { authorization: "Bearer secret" } },
			),
		]) {
			const response = await app.request(request);

			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({
				success: false,
				error: {
					code: "BILLING_PROVIDER_NOT_CONFIGURED",
					message: "Stripe provider is not configured",
				},
			});
		}
	});

	it("rejects invalid Stripe Checkout session bodies before calling the service", async () => {
		let called = false;
		const app = createApp({
			env,
			stripeBillingService: {
				...stripeBillingService,
				createCheckoutSession() {
					called = true;
					return Promise.resolve({
						sessionId: "cs_test_123",
						url: "https://checkout.stripe.com/c/pay/cs_test_123",
					});
				},
			},
		});

		const response = await app.request(
			"/v1/billing-accounts/user_1/providers/stripe/checkout-sessions",
			{
				method: "POST",
				headers: {
					authorization: "Bearer secret",
					"content-type": "application/json",
				},
				body: JSON.stringify({ productKey: "" }),
			},
		);

		expect(response.status).toBe(400);
		expect(called).toBe(false);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "INVALID_REQUEST", message: "Invalid Stripe Checkout session body" },
		});
	});

	it("rejects caller-supplied project selectors on private billing routes", async () => {
		let checkoutCalled = false;
		let verifyCalled = false;
		let entitlementCalled = false;
		const app = createApp({
			env,
			entitlementService: new EntitlementService({
				getEntitlementSnapshot() {
					entitlementCalled = true;
					return Promise.resolve({
						billingAccountId: "user_1",
						generatedAt: "2026-05-31T00:00:00.000Z",
						entitlements: [],
					});
				},
			}),
			stripeBillingService: {
				...stripeBillingService,
				createCheckoutSession() {
					checkoutCalled = true;
					return Promise.resolve({
						sessionId: "cs_test_123",
						url: "https://checkout.stripe.com/c/pay/cs_test_123",
					});
				},
			},
			appleStoreKitService: {
				...appleStoreKitService,
				verifyPurchase() {
					verifyCalled = true;
					return Promise.resolve({
						billingAccountId: "user_1",
						generatedAt: "2026-05-31T00:00:00.000Z",
						entitlements: [],
					});
				},
			},
		});

		const checkout = await app.request(
			"/v1/billing-accounts/user_1/providers/stripe/checkout-sessions",
			{
				method: "POST",
				headers: {
					authorization: "Bearer secret",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					project_id: "wiseley",
					productKey: "credits_100",
				}),
			},
		);
		const purchase = await app.request("/v1/purchases/verify", {
			method: "POST",
			headers: {
				authorization: "Bearer secret",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				projectId: "wiseley",
				provider: "apple",
				billingAccountId: "user_1",
				transactionId: "200000000000001",
			}),
		});
		const nestedCheckout = await app.request(
			"/v1/billing-accounts/user_1/providers/stripe/checkout-sessions",
			{
				method: "POST",
				headers: {
					authorization: "Bearer secret",
					"content-type": "application/json",
				},
				body: JSON.stringify({
					productKey: "credits_100",
					metadata: [{ projectId: "wiseley" }],
				}),
			},
		);
		const entitlement = await app.request(
			"/v1/billing-accounts/user_1/entitlements?project_id=wiseley",
			{
				headers: { authorization: "Bearer secret" },
			},
		);

		for (const response of [checkout, purchase, nestedCheckout, entitlement]) {
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				success: false,
				error: {
					code: "INVALID_REQUEST",
					message: "Project is resolved from billing credentials",
				},
			});
		}
		expect(checkoutCalled).toBe(false);
		expect(verifyCalled).toBe(false);
		expect(entitlementCalled).toBe(false);
	});

	it("protects Stripe customer routes with API key auth", async () => {
		let calls = 0;
		const app = createApp({
			env,
			stripeBillingService: {
				...stripeBillingService,
				createCheckoutSession() {
					calls += 1;
					return Promise.resolve({
						sessionId: "cs_test_123",
						url: "https://checkout.stripe.com/c/pay/cs_test_123",
					});
				},
				createPortalSession() {
					calls += 1;
					return Promise.resolve({
						url: "https://billing.stripe.com/session/bps_test_123",
					});
				},
				getCheckoutSessionStatus() {
					calls += 1;
					return Promise.resolve({
						sessionId: "cs_test_123",
						status: "open",
						paymentStatus: "unpaid",
						customerEmail: null,
						productKey: null,
					});
				},
			},
		});

		for (const request of [
			new Request(
				"http://localhost/v1/billing-accounts/user_1/providers/stripe/checkout-sessions",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ productKey: "credits_100" }),
				},
			),
			new Request("http://localhost/v1/billing-accounts/user_1/providers/stripe/portal-sessions", {
				method: "POST",
			}),
			new Request(
				"http://localhost/v1/billing-accounts/user_1/providers/stripe/checkout-sessions/cs_test_123",
			),
		]) {
			const response = await app.request(request);
			expect(response.status).toBe(401);
		}

		expect(calls).toBe(0);
	});

	it("verifies Google purchases through API-key protected routes", async () => {
		const app = createApp({ env, googlePlayBillingService });
		const response = await app.request("/v1/purchases/verify", {
			method: "POST",
			headers: {
				authorization: "Bearer secret",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				provider: "google",
				billingAccountId: "user_1",
				purchaseKind: "subscription",
				purchaseToken: "purchase_token_1",
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			data: {
				billingAccountId: "user_1",
				generatedAt: "2026-05-31T00:00:00.000Z",
				entitlements: [],
			},
		});
	});

	it("rejects Google one-time purchase verification without product ids", async () => {
		const app = createApp({ env, googlePlayBillingService });
		const response = await app.request("/v1/purchases/verify", {
			method: "POST",
			headers: {
				authorization: "Bearer secret",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				provider: "google",
				billingAccountId: "user_1",
				purchaseKind: "consumable",
				purchaseToken: "purchase_token_1",
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "INVALID_REQUEST", message: "Invalid purchase verification body" },
		});
	});

	it("returns provider-not-configured for Google purchase verification without Google service", async () => {
		const app = createApp({ env });
		const response = await app.request("/v1/purchases/verify", {
			method: "POST",
			headers: {
				authorization: "Bearer secret",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				provider: "google",
				billingAccountId: "user_1",
				purchaseKind: "subscription",
				purchaseToken: "purchase_token_1",
			}),
		});

		expect(response.status).toBe(501);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "BILLING_PROVIDER_NOT_CONFIGURED",
				message: "Google Play provider is not configured",
			},
		});
	});

	it("returns provider-not-configured for Apple purchase verification without Apple service", async () => {
		const app = createApp({ env });
		const response = await app.request("/v1/purchases/verify", {
			method: "POST",
			headers: {
				authorization: "Bearer secret",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				provider: "apple",
				billingAccountId: "user_1",
				transactionId: "200000000000001",
			}),
		});

		expect(response.status).toBe(501);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "BILLING_PROVIDER_NOT_CONFIGURED",
				message: "Apple StoreKit provider is not configured",
			},
		});
	});

	it("records purchase verification failures with metrics and logs", async () => {
		const metrics = createInMemoryBillingMetrics();
		const { logger, errors } = createRecordingLogger();
		const app = createApp({
			env,
			metrics,
			logger,
			appleStoreKitService: {
				...appleStoreKitService,
				verifyPurchase() {
					throw new BillingError(
						"Apple transaction was rejected",
						"APPLE_TRANSACTION_INVALID",
						400,
					);
				},
			},
		});

		const response = await app.request("/v1/purchases/verify", {
			method: "POST",
			headers: {
				authorization: "Bearer secret",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				provider: "apple",
				billingAccountId: "user_1",
				transactionId: "200000000000001",
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "APPLE_TRANSACTION_INVALID", message: "Apple transaction was rejected" },
		});
		expect(metrics.renderPrometheus()).toContain(
			'billing_verification_failures_total{code="APPLE_TRANSACTION_INVALID",provider="apple"} 1',
		);
		expect(metrics.renderPrometheus()).toContain(
			'billing_provider_operations_total{code="APPLE_TRANSACTION_INVALID",operation="purchase_verification",provider="apple",result="failed"} 1',
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("Purchase verification failed");
		expect(errors[0]?.context).toEqual({
			provider: "apple",
			code: "APPLE_TRANSACTION_INVALID",
			projectKey: "voysee",
		});
	});

	it("preserves purchase verification errors when observability fails", async () => {
		const app = createApp({
			env,
			metrics: createThrowingMetrics(),
			logger: createThrowingLogger(),
			appleStoreKitService: {
				...appleStoreKitService,
				verifyPurchase() {
					throw new BillingError(
						"Apple transaction was rejected",
						"APPLE_TRANSACTION_INVALID",
						400,
					);
				},
			},
		});

		const response = await app.request("/v1/purchases/verify", {
			method: "POST",
			headers: {
				authorization: "Bearer secret",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				provider: "apple",
				billingAccountId: "user_1",
				transactionId: "200000000000001",
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "APPLE_TRANSACTION_INVALID", message: "Apple transaction was rejected" },
		});
	});

	it("accepts public Apple webhooks without API key auth", async () => {
		const app = createApp({ env, appleStoreKitService });
		const response = await app.request("/v1/projects/voysee/webhooks/apple", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ signedPayload: "signed-notification" }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			data: {
				status: "processed",
				entitlements: {
					billingAccountId: "user_1",
					generatedAt: "2026-05-31T00:00:00.000Z",
					entitlements: [],
				},
			},
		});
	});

	it("accepts public Google webhooks without API key auth", async () => {
		const app = createApp({ env, googlePlayBillingService });
		const response = await app.request("/v1/projects/voysee/webhooks/google", {
			method: "POST",
			headers: {
				authorization: "Bearer google-oidc-token",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				message: { data: "abc", messageId: "message_1" },
				subscription: "sub",
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			data: {
				processed: true,
				eventType: "SUBSCRIPTION_PURCHASED",
				messageId: "message_1",
				entitlements: {
					billingAccountId: "user_1",
					generatedAt: "2026-05-31T00:00:00.000Z",
					entitlements: [],
				},
			},
		});
	});

	it("rejects invalid Google webhook bodies before calling the service", async () => {
		let called = false;
		const metrics = createInMemoryBillingMetrics();
		const { logger, errors } = createRecordingLogger();
		const app = createApp({
			env,
			metrics,
			logger,
			googlePlayBillingService: {
				...googlePlayBillingService,
				handleRtdn() {
					called = true;
					return Promise.resolve({
						processed: false,
						eventType: "TEST",
						messageId: "message_1",
						entitlements: null,
					});
				},
			},
		});

		const response = await app.request("/v1/projects/voysee/webhooks/google", {
			method: "POST",
			headers: {
				authorization: "Bearer google-oidc-token",
				"content-type": "application/json",
			},
			body: JSON.stringify({}),
		});

		expect(response.status).toBe(400);
		expect(called).toBe(false);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "INVALID_REQUEST", message: "Invalid Google webhook body" },
		});
		expect(metrics.renderPrometheus()).toContain(
			'billing_webhook_failures_total{code="INVALID_REQUEST",provider="google"} 1',
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("Google webhook failed");
		expect(errors[0]?.context).toEqual({
			provider: "google",
			code: "INVALID_REQUEST",
			projectKey: "voysee",
		});
	});

	it("rejects Google webhooks without bearer tokens before body validation", async () => {
		let called = false;
		const app = createApp({
			env,
			googlePlayBillingService: {
				...googlePlayBillingService,
				handleRtdn() {
					called = true;
					return Promise.resolve({
						processed: false,
						eventType: "TEST",
						messageId: "message_1",
						entitlements: null,
					});
				},
			},
		});

		const response = await app.request("/v1/projects/voysee/webhooks/google", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		});

		expect(response.status).toBe(401);
		expect(called).toBe(false);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "GOOGLE_PLAY_RTDN_UNAUTHORIZED",
				message: "Google Pub/Sub push token is required",
			},
		});
	});

	it("records Apple webhook failures with metrics and logs", async () => {
		const metrics = createInMemoryBillingMetrics();
		const { logger, errors } = createRecordingLogger();
		const app = createApp({ env, appleStoreKitService, metrics, logger });

		const response = await app.request("/v1/projects/voysee/webhooks/apple", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "INVALID_REQUEST", message: "Invalid Apple webhook body" },
		});
		expect(metrics.renderPrometheus()).toContain(
			'billing_webhook_failures_total{code="INVALID_REQUEST",provider="apple"} 1',
		);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("Apple webhook failed");
		expect(errors[0]?.context).toEqual({
			provider: "apple",
			code: "INVALID_REQUEST",
			projectKey: "voysee",
		});
	});

	it("protects and renders admin metrics", async () => {
		const metrics = createInMemoryBillingMetrics();
		metrics.increment("billing_webhook_failures_total", {
			provider: "apple",
			code: "INVALID_REQUEST",
		});
		const app = createApp({ env, metrics });

		const unauthorized = await app.request("/v1/admin/metrics");
		expect(unauthorized.status).toBe(401);
		const publicResponse = await app.request("/metrics");
		expect(publicResponse.status).toBe(200);
		expect(publicResponse.headers.get("content-type")).toBe("text/plain; version=0.0.4");
		expect(await publicResponse.text()).toBe(
			'billing_webhook_failures_total{code="INVALID_REQUEST",provider="apple"} 1\n',
		);

		const response = await app.request("/v1/admin/metrics", {
			headers: {
				authorization: "Bearer secret",
				"x-billing-operator-key": "operator-secret-key",
			},
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/plain; version=0.0.4");
		expect(await response.text()).toBe(
			'billing_webhook_failures_total{code="INVALID_REQUEST",provider="apple"} 1\n',
		);
	});

	it("verifies Google webhook authorization before body validation", async () => {
		let authorizationChecked = false;
		let called = false;
		const app = createApp({
			env,
			googlePlayBillingService: {
				...googlePlayBillingService,
				verifyRtdnAuthorization() {
					authorizationChecked = true;
					throw new BillingError(
						"Google Pub/Sub push token is invalid",
						"GOOGLE_PLAY_RTDN_UNAUTHORIZED",
						401,
					);
				},
				handleRtdn() {
					called = true;
					return Promise.resolve({
						processed: false,
						eventType: "TEST",
						messageId: "message_1",
						entitlements: null,
					});
				},
			},
		});

		const response = await app.request("/v1/projects/voysee/webhooks/google", {
			method: "POST",
			headers: {
				authorization: "Bearer invalid-google-token",
				"content-type": "application/json",
			},
			body: "{",
		});

		expect(response.status).toBe(401);
		expect(authorizationChecked).toBe(true);
		expect(called).toBe(false);
		expect(await response.json()).toEqual({
			success: false,
			error: {
				code: "GOOGLE_PLAY_RTDN_UNAUTHORIZED",
				message: "Google Pub/Sub push token is invalid",
			},
		});
	});

	it("rejects oversized public webhook bodies", async () => {
		const app = createApp({ env, appleStoreKitService });
		const response = await app.request("/v1/projects/voysee/webhooks/apple", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"content-length": String(300 * 1024),
			},
			body: JSON.stringify({ signedPayload: "signed-notification" }),
		});

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "REQUEST_BODY_TOO_LARGE", message: "Request body is too large" },
		});
	});

	it("rejects invalid Apple webhook bodies before calling the service", async () => {
		let called = false;
		const app = createApp({
			env,
			appleStoreKitService: {
				...appleStoreKitService,
				handleNotification() {
					called = true;
					return Promise.resolve({ status: "ignored" as const, entitlements: null });
				},
			},
		});

		const response = await app.request("/v1/projects/voysee/webhooks/apple", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ signedPayload: "" }),
		});

		expect(response.status).toBe(400);
		expect(called).toBe(false);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "INVALID_REQUEST", message: "Invalid Apple webhook body" },
		});
	});

	it("limits purchase verification requests by the verify route limit", async () => {
		const app = createApp({
			env: withRateLimit({ verifyLimit: 1 }),
			appleStoreKitService,
		});
		const request = {
			method: "POST",
			headers: {
				authorization: "Bearer secret",
				"content-type": "application/json",
				"x-forwarded-for": "203.0.113.10",
			},
			body: JSON.stringify({
				provider: "apple",
				billingAccountId: "user_1",
				transactionId: "200000000000001",
			}),
		};

		const allowed = await app.request("/v1/purchases/verify", request);
		const limited = await app.request("/v1/purchases/verify", request);

		expect(allowed.status).toBe(200);
		expect(limited.status).toBe(429);
		expect(limited.headers.get("ratelimit-remaining")).toBe("0");
		expect(await limited.json()).toEqual({
			success: false,
			error: { code: "RATE_LIMITED", message: "Too many requests" },
		});
	});

	it("rejects oversized purchase verification bodies before provider work", async () => {
		let called = false;
		const app = createApp({
			env,
			appleStoreKitService: {
				...appleStoreKitService,
				verifyPurchase() {
					called = true;
					return Promise.resolve({
						billingAccountId: "user_1",
						generatedAt: "2026-05-31T00:00:00.000Z",
						entitlements: [],
					});
				},
			},
		});

		const response = await app.request("/v1/purchases/verify", {
			method: "POST",
			headers: {
				authorization: "Bearer secret",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				provider: "apple",
				billingAccountId: "user_1",
				transactionId: "2".repeat(300_000),
			}),
		});

		expect(response.status).toBe(413);
		expect(called).toBe(false);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "REQUEST_BODY_TOO_LARGE", message: "Request body is too large" },
		});
	});

	it("limits public webhooks by IP and path with separate Apple, Google, and Stripe buckets", async () => {
		let projectResolutionCalls = 0;
		const resolver = projectContextResolver();
		const app = createApp({
			env: withRateLimit({ webhookLimit: 1 }),
			appleStoreKitService,
			googlePlayBillingService,
			stripeBillingService,
			projectContextResolver: {
				resolveCredential: (credential) => resolver.resolveCredential(credential),
				resolveInstanceKey: async (projectInstanceKey) => {
					projectResolutionCalls += 1;
					return await resolver.resolveInstanceKey(projectInstanceKey);
				},
				resolveInstanceId: (projectInstanceId) => resolver.resolveInstanceId(projectInstanceId),
			},
		});

		const appleHeaders = {
			"content-type": "application/json",
			"x-forwarded-for": "203.0.113.20",
		};
		const googleHeaders = {
			authorization: "Bearer google-oidc-token",
			"content-type": "application/json",
			"x-forwarded-for": "203.0.113.20",
		};
		const stripeHeaders = {
			"stripe-signature": "t=123,v1=abc",
			"x-forwarded-for": "203.0.113.20",
		};

		const appleAllowed = await app.request("/v1/projects/voysee/webhooks/apple", {
			method: "POST",
			headers: appleHeaders,
			body: JSON.stringify({ signedPayload: "signed-notification" }),
		});
		const googleAllowed = await app.request("/v1/projects/voysee/webhooks/google", {
			method: "POST",
			headers: googleHeaders,
			body: JSON.stringify({
				message: { data: "abc", messageId: "message_1" },
				subscription: "sub",
			}),
		});
		const stripeAllowed = await app.request("/v1/projects/voysee/webhooks/stripe", {
			method: "POST",
			headers: stripeHeaders,
			body: "{}",
		});
		const appleLimited = await app.request("/v1/projects/voysee/webhooks/apple", {
			method: "POST",
			headers: appleHeaders,
			body: JSON.stringify({ signedPayload: "signed-notification" }),
		});
		const stripeLimited = await app.request("/v1/projects/voysee/webhooks/stripe", {
			method: "POST",
			headers: stripeHeaders,
			body: "{}",
		});

		expect(appleAllowed.status).toBe(200);
		expect(googleAllowed.status).toBe(200);
		expect(stripeAllowed.status).toBe(200);
		expect(appleLimited.status).toBe(429);
		expect(stripeLimited.status).toBe(429);
		expect(projectResolutionCalls).toBe(3);
		expect(await appleLimited.json()).toEqual({
			success: false,
			error: { code: "RATE_LIMITED", message: "Too many requests" },
		});
		expect(await stripeLimited.json()).toEqual({
			success: false,
			error: { code: "RATE_LIMITED", message: "Too many requests" },
		});
	});

	it("uses Cloudflare IP before x-forwarded-for when keying app route limits", async () => {
		const app = createApp({
			env: withRateLimit({ webhookLimit: 1, trustProxyHeaders: true }),
			appleStoreKitService,
		});

		const first = await app.request("/v1/projects/voysee/webhooks/apple", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-for": "203.0.113.30, 198.51.100.10",
				"cf-connecting-ip": "198.51.100.20",
			},
			body: JSON.stringify({ signedPayload: "signed-notification" }),
		});
		const sameFirstIp = await app.request("/v1/projects/voysee/webhooks/apple", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-for": "203.0.113.31, 198.51.100.99",
				"cf-connecting-ip": "198.51.100.20",
			},
			body: JSON.stringify({ signedPayload: "signed-notification" }),
		});
		const differentCloudflareIp = await app.request("/v1/projects/voysee/webhooks/apple", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-for": "203.0.113.30, 198.51.100.10",
				"cf-connecting-ip": "198.51.100.21",
			},
			body: JSON.stringify({ signedPayload: "signed-notification" }),
		});

		expect(first.status).toBe(200);
		expect(sameFirstIp.status).toBe(429);
		expect(differentCloudflareIp.status).toBe(200);
	});

	it("authenticates admin routes before consuming admin rate limits", async () => {
		const metrics = createInMemoryBillingMetrics();
		const app = createApp({
			env: withRateLimit({ adminLimit: 1 }),
			metrics,
		});

		const unauthorized = await app.request("/v1/admin/metrics", {
			headers: { "x-forwarded-for": "203.0.113.40" },
		});
		const allowed = await app.request("/v1/admin/metrics", {
			headers: {
				authorization: "Bearer secret",
				"x-billing-operator-key": "operator-secret-key",
				"x-forwarded-for": "203.0.113.40",
			},
		});
		const limited = await app.request("/v1/admin/metrics", {
			headers: {
				authorization: "Bearer secret",
				"x-billing-operator-key": "operator-secret-key",
				"x-forwarded-for": "203.0.113.40",
			},
		});

		expect(unauthorized.status).toBe(401);
		expect(unauthorized.headers.get("ratelimit-remaining")).toBeNull();
		expect(allowed.status).toBe(200);
		expect(limited.status).toBe(429);
		expect(await limited.json()).toEqual({
			success: false,
			error: { code: "RATE_LIMITED", message: "Too many requests" },
		});
	});

	it("does not expose the retired project provisioning route", async () => {
		const app = createApp({ env });
		const response = await app.request("/v1/admin/projects", {
			method: "POST",
			headers: { authorization: "Bearer secret", "content-type": "application/json" },
			body: JSON.stringify({ name: "Voysee" }),
		});

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			success: false,
			error: { code: "NOT_FOUND", message: "Route not found" },
		});
	});
});
