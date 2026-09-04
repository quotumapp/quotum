import { createApp } from "./app";
import { EntitlementService } from "./billing/entitlements";
import { PostgresProjectInstanceContextResolver } from "./composition/project-instance-persistence";
import { closePool } from "./db/client";
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
	createSentryRequestMiddleware,
	type SentryClientLike,
} from "./observability/sentry";
import { BillingAdminOperations } from "./operations/admin";
import { ProjectionHttpClient } from "./projections/http-client";
import type { ProjectRuntimeConfig } from "./projects/config";
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
import { registerBillingRuntimeShutdown } from "./shutdown";
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
	sentry?: SentryClientLike;
	readinessCheck?: () => boolean | Promise<boolean>;
	projectContextResolver?: ProjectInstanceContextResolver;
	stripeClientFactory?: (
		config: StripeBillingConfig,
		projectInstanceKey: string,
	) => StripeBillingClientDependency;
}

export function createBillingRuntimeApp(
	env: BillingEnv,
	dependencies: BillingRuntimeDependencies = {},
) {
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
	const projectionDelivery = new ProjectionHttpClient({
		projects: env.projectRuntime,
		metrics,
	});
	const projectionSyncRepository = new ProjectionSyncJobRepository(billingRepository);
	const storeEventReplayRepository = new StoreEventReplayJobRepository(billingRepository);
	const subscriptionReconciliationRepository = new ProviderSubscriptionReconciliationRepository(
		billingRepository,
	);
	const projectRuntimeConfig = (project: ProjectInstanceContext): ProjectRuntimeConfig => {
		const config = env.projectRuntime.find(
			(candidate) => candidate.projectInstanceKey === project.projectInstanceKey,
		);
		if (config === undefined) {
			throw new Error(`Billing project instance is not configured: ${project.projectInstanceKey}`);
		}
		return config;
	};
	const stripeServiceCache = new Map<string, StripeBillingService>();
	const stripeServiceForProject = (
		project: ProjectInstanceContext,
	): StripeBillingService | null => {
		const runtimeConfig = projectRuntimeConfig(project);
		if (runtimeConfig.stripe === null || runtimeConfig.stripe === undefined) {
			return null;
		}
		const cached = stripeServiceCache.get(project.projectInstanceId);
		if (cached !== undefined) {
			return cached;
		}

		const config = buildStripeConfig(runtimeConfig.stripe);
		const service = new StripeBillingService({
			config: {
				...config,
				projectKey: project.projectInstanceKey,
				projectionContract: runtimeConfig.projectionContract ?? "billing_state_v1",
			},
			client:
				dependencies.stripeClientFactory?.(config, project.projectInstanceKey) ??
				new StripeBillingClient(config),
			repository: billingRepository.forProject(project),
		});
		stripeServiceCache.set(project.projectInstanceId, service);
		return service;
	};
	const projectProviderServices =
		dependencies.stripeClientFactory === undefined
			? undefined
			: Object.fromEntries(
					env.projectRuntime.map((config) => [
						config.projectInstanceKey,
						{
							stripeBillingService:
								config.stripe === null || config.stripe === undefined
									? null
									: createDeferredStripeBillingService(
											config.projectInstanceKey,
											projectContextResolver,
											stripeServiceForProject,
										),
						},
					]),
				);
	const workerProviderCache = new Map<string, WorkerProjectProviders>();
	const providersForProject = (project: ProjectInstanceContext): WorkerProjectProviders => {
		const cached = workerProviderCache.get(project.projectInstanceId);
		if (cached !== undefined) {
			return cached;
		}

		const runtimeConfig = projectRuntimeConfig(project);
		const apple = runtimeConfig.apple ?? null;
		const googlePlay = runtimeConfig.googlePlay ?? null;
		const stripe = runtimeConfig.stripe ?? null;
		const providers = {
			apple:
				apple === null
					? null
					: new AppleStoreKitService({
							bundleId: apple.bundleId,
							environment: apple.environment,
							client: new AppleStoreKitClient(buildAppleStoreKitConfig(apple)),
							repository: billingRepository.forProject(project),
						}),
			google:
				googlePlay === null
					? null
					: (() => {
							const config = buildGooglePlayConfig(googlePlay);
							return new GooglePlayBillingService({
								config,
								client: new GooglePlayDeveloperClient(config),
								repository: billingRepository.forProject(project),
							});
						})(),
			stripe: stripe === null ? null : stripeServiceForProject(project),
		};
		workerProviderCache.set(project.projectInstanceId, providers);
		return providers;
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
		providerForProject(project) {
			const stripe = providersForProject(project).stripe;
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
		providerForProject(project) {
			const stripe = providersForProject(project).stripe;
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

	const projectionSyncRuntime = startPollingRuntime({
		name: "projection_sync",
		worker: projectionSyncWorker,
		pollIntervalMs: env.workerPollIntervalMs,
		logger,
	});
	const storeEventReplayRuntime = startPollingRuntime({
		name: "store_event_replay",
		worker: storeEventReplayWorker,
		pollIntervalMs: env.storeEventReplayPollIntervalMs,
		logger,
	});
	const subscriptionReconciliationRuntime = startPollingRuntime({
		name: "subscription_reconciliation",
		worker: subscriptionReconciliationWorker,
		pollIntervalMs: env.subscriptionReconciliationPollIntervalMs,
		logger,
	});
	const meteringMaintenanceRuntime = startPollingRuntime({
		name: "metering_maintenance",
		worker: meteringMaintenanceWorker,
		pollIntervalMs: env.meteringMaintenancePollIntervalMs,
		logger,
	});
	const recurringBillingRuntime = startPollingRuntime({
		name: "recurring_billing",
		worker: recurringBillingWorker,
		pollIntervalMs: env.meteringMaintenancePollIntervalMs,
		logger,
	});
	const autoTopupRuntime = startPollingRuntime({
		name: "auto_topup",
		worker: autoTopupWorker,
		pollIntervalMs: env.meteringMaintenancePollIntervalMs,
		logger,
	});

	registerBillingRuntimeShutdown({
		process,
		runtimes: [
			projectionSyncRuntime,
			storeEventReplayRuntime,
			subscriptionReconciliationRuntime,
			meteringMaintenanceRuntime,
			recurringBillingRuntime,
			autoTopupRuntime,
		],
		cleanup: [
			() => closePool(),
			async () => {
				await dependencies.sentry?.flush?.(2_000);
			},
		],
	});

	return createApp({
		env,
		entitlementService: new EntitlementService(billingRepository),
		projectContextResolver,
		projectProviderServices,
		adminOperations,
		logger,
		metrics,
		readinessCheck: dependencies.readinessCheck,
		requestObservabilityMiddleware:
			dependencies.sentry === undefined || env.sentry.dsn === null
				? undefined
				: createSentryRequestMiddleware(dependencies.sentry),
	});
}

function createDeferredStripeBillingService(
	projectInstanceKey: string,
	projectContextResolver: ProjectInstanceContextResolver,
	serviceForProject: (project: ProjectInstanceContext) => StripeBillingService | null,
): StripeBillingService {
	return new Proxy({} as StripeBillingService, {
		get(_target, property) {
			if (property === "then") return undefined;
			return async (...args: unknown[]) => {
				const result = await projectContextResolver.resolveInstanceKey(projectInstanceKey);
				if (result.kind !== "resolved") {
					throw new Error(
						`Billing project instance could not be resolved for Stripe: ${result.kind}`,
					);
				}
				const service = serviceForProject(result.context);
				if (service === null) {
					throw new Error(`Stripe is not configured for ${projectInstanceKey}`);
				}
				const method = Reflect.get(service, property);
				if (typeof method !== "function") {
					throw new Error(`Stripe billing service method is unavailable: ${String(property)}`);
				}
				return await Reflect.apply(method, service, args);
			};
		},
	});
}
