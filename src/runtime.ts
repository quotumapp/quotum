import { createApp } from "./app";
import { createProjectProviderServiceResolver } from "./app/provider-services";
import type { AppDependencies } from "./app/types";
import { EntitlementService } from "./billing/entitlements";
import {
	createConnectionRepository,
	createRuntimeConnectionResolver,
} from "./composition/connections";
import { createMerchantBillingPort } from "./composition/merchant-billing";
import { attachMerchantRuntime, type MerchantRuntimeOptions } from "./composition/merchant-runtime";
import { PostgresProjectInstanceContextResolver } from "./composition/project-instance-persistence";
import {
	createRuntimeLifecycle,
	type QuotumRuntimeScheduler,
	type QuotumScheduledJob,
} from "./composition/runtime-lifecycle";
import { AdminBillingRepository } from "./db/admin-repository";
import { closePool, configureDefaultConnection, initializePostgresHealth } from "./db/client";
import { BillingRepository } from "./db/repository";
import {
	ProjectionSyncJobRepository,
	ProviderSubscriptionReconciliationRepository,
	StoreEventReplayJobRepository,
} from "./db/repository-domains";
import type { BillingEnv } from "./env";
import { createConsoleBillingLogger } from "./observability/logger";
import { createInMemoryBillingMetrics } from "./observability/metrics";
import {
	createSentryBillingLogger,
	createSentryRequestScope,
	initializeSentry,
	type SentryClientLike,
} from "./observability/sentry";
import { BillingAdminOperations } from "./operations/admin";
import { loadMerchantConfig } from "./platform/config";
import { ProjectionHttpClient } from "./projections/http-client";
import type { ApiProjectProjectionFetch } from "./projections/http-types";
import type { RuntimeConnectionResolver } from "./projects/connections";
import type { ProjectInstanceContext, ProjectInstanceContextResolver } from "./projects/context";
import { AppleStoreKitClient, buildAppleStoreKitConfig } from "./providers/apple/client";
import { AppleStoreKitService } from "./providers/apple/service";
import { GooglePlayDeveloperClient } from "./providers/google/client";
import { buildGooglePlayConfig } from "./providers/google/config";
import { GooglePlayBillingService } from "./providers/google/service";
import {
	buildStripeConfig,
	StripeBillingClient,
	type StripeBillingConfig,
} from "./providers/stripe/client";
import {
	type StripeBillingClientDependency,
	StripeBillingService,
} from "./providers/stripe/service";
import type { AutoTopupWorkerProvider } from "./workers/auto-topup";
import { AutoTopupWorker } from "./workers/auto-topup";
import { MeteringMaintenanceWorker } from "./workers/metering-maintenance";
import { ProjectionSyncWorker } from "./workers/projection-sync";
import type { RecurringBillingWorkerProvider } from "./workers/recurring-billing";
import { RecurringBillingWorker } from "./workers/recurring-billing";
import { startPollingRuntime } from "./workers/runtime";
import type { StoreEventReplayProvider } from "./workers/store-event-replay";
import { StoreEventReplayWorker } from "./workers/store-event-replay";
import type { SubscriptionReconciliationProvider } from "./workers/subscription-reconciliation";
import { SubscriptionReconciliationWorker } from "./workers/subscription-reconciliation";

type WorkerProjectProviders = {
	apple: (StoreEventReplayProvider & SubscriptionReconciliationProvider) | null;
	google: (StoreEventReplayProvider & SubscriptionReconciliationProvider) | null;
	stripe:
		| (StoreEventReplayProvider &
				SubscriptionReconciliationProvider &
				RecurringBillingWorkerProvider &
				AutoTopupWorkerProvider)
		| null;
};

export interface BillingRuntimeDependencies {
	scheduler?: QuotumRuntimeScheduler;
	projectionFetch?: ApiProjectProjectionFetch;
	connections?: RuntimeConnectionResolver;
	merchant?: MerchantRuntimeOptions;
	projectProviderServices?: AppDependencies["projectProviderServices"];
	sentry?: SentryClientLike;
	readinessCheck?: () => boolean | Promise<boolean>;
	projectContextResolver?: ProjectInstanceContextResolver;
	stripeClientFactory?: (
		config: StripeBillingConfig,
		projectInstanceKey: string,
	) => StripeBillingClientDependency;
}

function composeBillingRuntime(env: BillingEnv, dependencies: BillingRuntimeDependencies = {}) {
	const merchantConfig = dependencies.merchant?.config ?? loadMerchantConfig();
	const jobs: QuotumScheduledJob[] = [];
	const billingRepository = new BillingRepository();
	const baseLogger = createConsoleBillingLogger();
	const logger =
		dependencies.sentry === undefined
			? baseLogger
			: createSentryBillingLogger({
					baseLogger,
					sentry: dependencies.sentry,
					config: env.sentry,
				});
	const metrics = createInMemoryBillingMetrics();
	const projectContextResolver =
		dependencies.projectContextResolver ?? new PostgresProjectInstanceContextResolver();
	const connectionRepository = createConnectionRepository();
	const connections =
		dependencies.connections ?? createRuntimeConnectionResolver(connectionRepository);
	const projectionDelivery = new ProjectionHttpClient({
		fetch: dependencies.projectionFetch,
		async resolveProject(key) {
			const lookup = await projectContextResolver.resolveInstanceKey(key);
			if (lookup.kind !== "resolved") return null;
			return connections.resolve(lookup.context, "projection", "recovery");
		},
		metrics,
	});
	const projectionSyncRepository = new ProjectionSyncJobRepository(billingRepository);
	const storeEventReplayRepository = new StoreEventReplayJobRepository(billingRepository);
	const subscriptionReconciliationRepository = new ProviderSubscriptionReconciliationRepository(
		billingRepository,
	);
	const projectProviderServices = dependencies.projectProviderServices;
	const providersForProject = async (
		project: ProjectInstanceContext,
		kind: "apple" | "google" | "stripe",
	): Promise<WorkerProjectProviders> => {
		const [apple, googlePlay, stripe] = await Promise.all([
			kind === "apple" ? connections.resolve(project, "apple", "recovery") : null,
			kind === "google" ? connections.resolve(project, "google", "recovery") : null,
			kind === "stripe" ? connections.resolve(project, "stripe", "recovery") : null,
		]);
		const stripeConfig = stripe ? buildStripeConfig(stripe) : null;
		return {
			apple: apple
				? new AppleStoreKitService({
						bundleId: apple.bundleId,
						environment: apple.environment,
						client: new AppleStoreKitClient(buildAppleStoreKitConfig(apple)),
						repository: billingRepository.forProject(project),
					})
				: null,
			google: googlePlay
				? new GooglePlayBillingService({
						config: buildGooglePlayConfig(googlePlay),
						client: new GooglePlayDeveloperClient(buildGooglePlayConfig(googlePlay)),
						repository: billingRepository.forProject(project),
					})
				: null,
			stripe: stripeConfig
				? new StripeBillingService({
						config: {
							...stripeConfig,
							projectKey: project.projectInstanceKey,
							projectionContract: "billing_state_v1",
						},
						client:
							dependencies.stripeClientFactory?.(stripeConfig, project.projectInstanceKey) ??
							new StripeBillingClient(stripeConfig),
						repository: billingRepository.forProject(project),
					})
				: null,
		};
	};
	const projectionSyncWorker = new ProjectionSyncWorker({
		workerId: env.workerId,
		maxAttempts: env.projectionSyncMaxAttempts,
		batchSize: 25,
		concurrency: 5,
		repository: projectionSyncRepository,
		delivery: projectionDelivery,
		projectContextResolver,
		logger,
		metrics,
	});
	const storeEventReplayWorker = new StoreEventReplayWorker({
		workerId: env.workerId,
		maxAttempts: env.storeEventReplayMaxAttempts,
		batchSize: 25,
		repository: storeEventReplayRepository,
		providers: providersForProject,
		projectContextResolver,
		logger,
		metrics,
	});
	const subscriptionReconciliationWorker = new SubscriptionReconciliationWorker({
		workerId: env.workerId,
		maxAttempts: env.subscriptionReconciliationMaxAttempts,
		batchSize: 25,
		staleAfterMs: env.providerReconciliationStaleAfterMs,
		repository: subscriptionReconciliationRepository,
		providers: providersForProject,
		projectContextResolver,
		logger,
		metrics,
	});
	const meteringMaintenanceWorker = new MeteringMaintenanceWorker({
		repository: billingRepository,
		logger,
		metrics,
	});
	const recurringBillingWorker = new RecurringBillingWorker({
		workerId: env.workerId,
		repository: billingRepository,
		projectContextResolver,
		async providerForProject(project) {
			const stripe = (await providersForProject(project, "stripe")).stripe;
			if (stripe === null) {
				throw new Error(`Stripe is not configured for ${project.projectInstanceKey}`);
			}
			return stripe;
		},
		logger,
		metrics,
	});
	const autoTopupWorker = new AutoTopupWorker({
		workerId: env.workerId,
		repository: billingRepository,
		projectContextResolver,
		async providerForProject(project) {
			const stripe = (await providersForProject(project, "stripe")).stripe;
			if (stripe === null) {
				throw new Error(`Stripe is not configured for ${project.projectInstanceKey}`);
			}
			return stripe;
		},
		logger,
		metrics,
	});
	const adminOperations = new BillingAdminOperations({
		replayWorker: storeEventReplayWorker,
		reconciliationWorker: subscriptionReconciliationWorker,
		projectionRepository: billingRepository,
	});

	jobs.push({
		name: "projection_sync",
		runOnce: () => projectionSyncWorker.runOnce(),
		pollIntervalMs: env.workerPollIntervalMs,
	});
	jobs.push({
		name: "store_event_replay",
		runOnce: () => storeEventReplayWorker.runOnce(),
		pollIntervalMs: env.storeEventReplayPollIntervalMs,
	});
	jobs.push({
		name: "subscription_reconciliation",
		runOnce: () => subscriptionReconciliationWorker.runOnce(),
		pollIntervalMs: env.subscriptionReconciliationPollIntervalMs,
	});
	jobs.push({
		name: "metering_maintenance",
		runOnce: () => meteringMaintenanceWorker.runOnce(),
		pollIntervalMs: env.meteringMaintenancePollIntervalMs,
	});
	jobs.push({
		name: "recurring_billing",
		runOnce: () => recurringBillingWorker.runOnce(),
		pollIntervalMs: env.meteringMaintenancePollIntervalMs,
	});
	jobs.push({
		name: "auto_topup",
		runOnce: () => autoTopupWorker.runOnce(),
		pollIntervalMs: env.meteringMaintenancePollIntervalMs,
	});

	const sentryRequestScope =
		dependencies.sentry === undefined || env.sentry.dsn === null
			? undefined
			: createSentryRequestScope(dependencies.sentry);
	const staff = createApp({
		env,
		connections,
		entitlementService: new EntitlementService(billingRepository),
		projectContextResolver,
		projectProviderServices,
		adminOperations,
		logger,
		metrics,
		readinessCheck: dependencies.readinessCheck,
		requestObservabilityMiddleware: sentryRequestScope?.plugin,
	});
	const merchantBilling = createMerchantBillingPort({
		repository: billingRepository,
		reader: new AdminBillingRepository({
			providerReconciliationStaleAfterMs: env.providerReconciliationStaleAfterMs,
		}),
		resolver: projectContextResolver,
		providers: createProjectProviderServiceResolver({
			connections,
			getRepository: () => billingRepository,
			projectProviderServices,
			legacyServices: {
				appleStoreKitService: undefined,
				googlePlayBillingService: undefined,
				stripeBillingService: undefined,
			},
		}),
		operations: adminOperations,
	});
	const app = attachMerchantRuntime(staff, merchantBilling, {
		...dependencies.merchant,
		config: merchantConfig,
		staffRequestScope: sentryRequestScope,
		registerBackground: (worker) => {
			jobs.push({
				name: "stripe_app_events",
				runOnce: () => worker.runOnce(),
				pollIntervalMs: env.storeEventReplayPollIntervalMs,
			});
		},
	});
	return { app, jobs, logger };
}

let runtimeActive = false;

export function createBillingRuntime(
	env: BillingEnv,
	dependencies: BillingRuntimeDependencies = {},
) {
	let pollingLogger: ReturnType<typeof createConsoleBillingLogger> | undefined;
	return createRuntimeLifecycle({
		acquire() {
			if (runtimeActive) throw new Error("Only one active Quotum runtime is supported per process");
			runtimeActive = true;
			return () => {
				runtimeActive = false;
			};
		},
		async initialize() {
			configureDefaultConnection(env);
			if (dependencies.sentry) initializeSentry(dependencies.sentry, env.sentry);
			await initializePostgresHealth();
		},
		compose: () => {
			const composed = composeBillingRuntime(env, dependencies);
			pollingLogger = composed.logger;
			return composed;
		},
		scheduler: dependencies.scheduler ?? {
			schedule(job) {
				return startPollingRuntime({
					...job,
					worker: { runOnce: job.runOnce },
					logger: pollingLogger,
				});
			},
		},
		cleanup: [
			() => closePool(),
			async () => {
				await dependencies.sentry?.flush?.(2_000);
			},
		],
	});
}
