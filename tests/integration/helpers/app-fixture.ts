import { createApp } from "../../../src/app";
import { EntitlementService } from "../../../src/billing/entitlements";
import { MeteringService } from "../../../src/billing/metering";
import type { BillingRepository } from "../../../src/db/repository";
import type { BillingLogger } from "../../../src/observability/logger";
import { createInMemoryBillingMetrics } from "../../../src/observability/metrics";
import type { BillingAdminOperations } from "../../../src/operations/admin";
import type { ProjectProviderServiceOverrides } from "../../../src/projects/providers";
import { AppleStoreKitService } from "../../../src/providers/apple/service";
import { createGoogleObfuscatedAccountId } from "../../../src/providers/google/account-link";
import { GooglePlayBillingService } from "../../../src/providers/google/service";
import { StripeBillingService } from "../../../src/providers/stripe/service";
import type { FixtureBillingEnv as BillingEnv } from "../../../src/testing/connection-fixtures";
import { withOpenApiAssertions } from "../../helpers/openapi";
import {
	createFakeAppleStoreKitClient,
	createFakeGooglePlayClient,
	createFakeStripeBillingClient,
} from "./fake-provider-clients";
import { integrationProjectContext, integrationProjectCredential } from "./platform-fixture";

type StripeEventFixture = ReturnType<typeof import("./fake-provider-clients").stripeEvent>;

export interface CreateIntegrationAppOptions {
	env: BillingEnv;
	repository: BillingRepository;
	stripeEvent?: StripeEventFixture;
	stripeConstructWebhookError?: Error;
	stripeCheckoutSessionFailures?: number;
	stripeCheckoutSession?: Record<string, unknown>;
	googleRtdn?: "subscription" | "one_time" | "voided";
	googleVoidedPurchaseToken?: string;
	googleProductQuantity?: number;
	googleProductRefundableQuantity?: number;
	googleVoidedRefundType?: 1 | 2;
	googleVoidedEventTimeMillis?: string;
	adminOperations?: BillingAdminOperations;
	logger?: BillingLogger;
}

export function createIntegrationApp({
	env,
	repository,
	stripeEvent,
	stripeConstructWebhookError,
	stripeCheckoutSessionFailures,
	stripeCheckoutSession,
	googleRtdn = "subscription",
	googleVoidedPurchaseToken = "purchase_token_1",
	googleProductQuantity,
	googleProductRefundableQuantity,
	googleVoidedRefundType = 1,
	googleVoidedEventTimeMillis = "1780185600000",
	adminOperations,
	logger,
}: CreateIntegrationAppOptions) {
	const metrics = createInMemoryBillingMetrics();
	const apple = createFakeAppleStoreKitClient({
		transactionId: "200000000000001",
		originalTransactionId: "100000000000001",
	});
	const expectedGoogleAccountId = createGoogleObfuscatedAccountId(
		"integration_user",
		"google-account-link-secret",
	);
	const google = createFakeGooglePlayClient({
		obfuscatedAccountId: expectedGoogleAccountId,
		quantity: googleProductQuantity,
		refundableQuantity: googleProductRefundableQuantity,
	});
	const stripe = createFakeStripeBillingClient({
		event: stripeEvent,
		constructWebhookError: stripeConstructWebhookError,
		createCheckoutSessionFailures: stripeCheckoutSessionFailures,
		checkoutSession: stripeCheckoutSession,
	});
	const projectProviderServices: ProjectProviderServiceOverrides<
		AppleStoreKitService,
		GooglePlayBillingService,
		StripeBillingService
	> = {};

	for (const project of env.connectionFixtures) {
		const projectContext = integrationProjectContext(project.projectInstanceKey);
		const projectRepository = repository.forProject(projectContext);

		projectProviderServices[project.projectInstanceKey] = {
			appleStoreKitService: new AppleStoreKitService({
				bundleId: "com.voysee.app",
				environment: "sandbox",
				client: apple.client,
				repository: projectRepository,
			}),
			googlePlayBillingService: new GooglePlayBillingService({
				config: {
					packageName: "com.voysee.app",
					obfuscatedAccountIdSecret: "google-account-link-secret",
					previousObfuscatedAccountIdSecrets: [],
					rtdnAudience: "https://billing.integration.test/v1/projects/voysee/webhooks/google",
					rtdnServiceAccountEmail: "pubsub-push@example.iam.gserviceaccount.com",
					rtdnAuthorizedParty: "pubsub-push-client-id",
					enablePublisherMutations: true,
				},
				client: google.client,
				repository: projectRepository,
				verifyRtdnAuthorization: async () => undefined,
				verifyRtdn: async () =>
					googleRtdn === "voided"
						? {
								messageId: "message_voided",
								externalEventId: "google:message_voided",
								notification: {
									version: "1.0",
									packageName: "com.voysee.app",
									eventTimeMillis: googleVoidedEventTimeMillis,
									voidedPurchaseNotification: {
										purchaseToken: googleVoidedPurchaseToken,
										orderId: "GPA.1111-2222-3333-44444",
										productType: 2,
										refundType: googleVoidedRefundType,
									},
								},
							}
						: googleRtdn === "one_time"
							? {
									messageId: "message_product",
									externalEventId: "google:message_product",
									notification: {
										version: "1.0",
										packageName: "com.voysee.app",
										eventTimeMillis: "1780185600000",
										oneTimeProductNotification: {
											version: "1.0",
											notificationType: 1,
											purchaseToken: "purchase_token_1",
											sku: "echo_credits_10",
										},
									},
								}
							: {
									messageId: "message_1",
									externalEventId: "google:message_1",
									notification: {
										version: "1.0",
										packageName: "com.voysee.app",
										eventTimeMillis: "1780185600000",
										subscriptionNotification: {
											version: "1.0",
											notificationType: 4,
											purchaseToken: "purchase_token_1",
										},
									},
								},
			}),
			stripeBillingService: new StripeBillingService({
				config: {
					projectKey: project.projectInstanceKey,
					projectionContract: project.projectionContract ?? "billing_state_v1",
					checkoutSuccessUrl:
						"https://app.integration.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
					checkoutCancelUrl: "https://app.integration.test/billing",
					portalReturnUrl: "https://app.integration.test/account/billing",
				},
				client: stripe.client,
				repository: projectRepository,
			}),
		};
	}

	const app = withOpenApiAssertions(
		createApp({
			env,
			entitlementService: new EntitlementService(repository),
			meteringService: new MeteringService(repository),
			controlsEnterpriseService: repository.controlsEnterprise,
			billingInsightsService: {
				listUsageEvents: (...args) => repository.listUsageEvents(...args),
				getUsageSeries: (...args) => repository.getUsageSeries(...args),
				getCustomerBillingSummary: (...args) => repository.getCustomerBillingSummary(...args),
			},
			catalogControlPlane: {
				getPublished: (...args) => repository.getPublishedCatalog(...args),
				preview: (...args) => repository.previewCatalog(...args),
				publish: (...args) => repository.publishCatalog(...args),
			},
			projectProviderServices,
			adminOperations,
			logger,
			metrics,
		}),
	);

	return {
		app,
		metrics,
		apple,
		google,
		stripe,
		authHeaders(projectKey = "voysee"): HeadersInit {
			const project = env.connectionFixtures.find(
				(candidate) => candidate.projectInstanceKey === projectKey,
			);
			if (project === undefined) {
				throw new Error(`unknown integration project ${projectKey}`);
			}

			return { authorization: `Bearer ${integrationProjectCredential(projectKey)}` };
		},
	};
}
