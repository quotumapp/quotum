import { createApp } from "./app";
import { projectProviderServiceResolver } from "./app/provider-services";
import type { AppDependencies } from "./app/types";
import { EntitlementService } from "./billing/entitlements";
import {
	createConnectionRepository,
	createRuntimeConnectionResolver,
} from "./composition/connections";
import { createMerchantBillingPort } from "./composition/merchant-billing";
import { merchantSql } from "./composition/merchant-persistence";
import { attachMerchantRuntime, type MerchantRuntimeOptions } from "./composition/merchant-runtime";
import { PostgresProjectInstanceContextResolver } from "./composition/project-instance-persistence";
import {
	createRuntimeLifecycle,
	type QuotumRuntimeScheduler,
	type QuotumScheduledJob,
} from "./composition/runtime-lifecycle";
import { createWorkerProviderSelectors } from "./composition/worker-providers";
import { AdminBillingRepository } from "./db/admin-repository";
import { closePool, configureDefaultConnection, initializePostgresHealth, sql } from "./db/client";
import { BillingRepository } from "./db/repository";
import {
	ProjectionSyncJobRepository,
	ProviderSubscriptionReconciliationRepository,
	StoreEventReplayJobRepository,
} from "./db/repository-domains";
import type { BillingEnv } from "./env";
import { createPinoBillingLogger, safelyLogError } from "./observability/logger";
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
import type { ProjectInstanceContextResolver } from "./projects/context";
import { createProviderCapabilityReads } from "./providers/capability-reads";
import { createProviderRegistry } from "./providers/registry";
import type { StripeBillingConfig } from "./providers/stripe/client";
import type { StripeBillingClientDependency } from "./providers/stripe/service";
import { AutoTopupWorker } from "./workers/auto-topup";
import { MeteringMaintenanceWorker } from "./workers/metering-maintenance";
import { ProjectionSyncWorker } from "./workers/projection-sync";
import { PromotionMaintenanceWorker } from "./workers/promotion-maintenance";
import { RecurringBillingWorker } from "./workers/recurring-billing";
import { startPollingRuntime } from "./workers/runtime";
import { StoreEventReplayWorker } from "./workers/store-event-replay";
import { SubscriptionReconciliationWorker } from "./workers/subscription-reconciliation";

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
	const baseLogger = createPinoBillingLogger({ level: env.logLevel ?? "info" });
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
	const persistence = merchantSql(sql);
	const connectionRepository = createConnectionRepository(persistence);
	const connections =
		dependencies.connections ?? createRuntimeConnectionResolver(connectionRepository, persistence);
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
	const providerRegistry = createProviderRegistry({
		connections,
		getRepository: () => billingRepository,
		overrides: dependencies.projectProviderServices,
		clientFactories:
			dependencies.stripeClientFactory === undefined
				? {}
				: { stripe: dependencies.stripeClientFactory },
	});
	const workerProviders = createWorkerProviderSelectors(providerRegistry);
	const capabilityReads = createProviderCapabilityReads({
		registry: providerRegistry,
		facts: billingRepository,
	});
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
		providers: workerProviders.storeEventReplay,
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
		providers: workerProviders.subscriptionReconciliation,
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
		adapterForJob: workerProviders.recurringBilling,
		logger,
		metrics,
	});
	const autoTopupWorker = new AutoTopupWorker({
		workerId: env.workerId,
		repository: billingRepository,
		projectContextResolver,
		adapterForJob: workerProviders.autoTopup,
		logger,
		metrics,
	});
	const promotionMaintenanceWorker = new PromotionMaintenanceWorker({
		workerId: env.workerId,
		repository: {
			releaseExpiredPromotionReservations: (limit) =>
				billingRepository.promotions.releaseExpiredPromotionReservations(limit),
			reconcilePromotionCoupons: (limit) =>
				billingRepository.promotionProviders.reconcilePromotionCoupons(limit),
			ensureHostedPromotionCodeObjects: (limit) =>
				billingRepository.promotionProviders.ensureHostedPromotionCodeObjects(limit),
			claimStripeObjects: (workerId, limit, staleBefore) =>
				billingRepository.promotionProviders.claimStripeObjects(workerId, limit, staleBefore),
			markStripeObjectOutcome: (projectId, objectId, workerId, outcome) =>
				billingRepository.promotionProviders.markStripeObjectOutcome(
					projectId,
					objectId,
					workerId,
					outcome,
				),
		},
		projectContextResolver,
		adapterForJob: workerProviders.promotionMaintenance,
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
	jobs.push({
		name: "promotion_maintenance",
		runOnce: () => promotionMaintenanceWorker.runOnce(),
		pollIntervalMs: env.meteringMaintenancePollIntervalMs,
	});

	const sentry = env.sentry.dsn === null ? undefined : dependencies.sentry;
	const sentryRequestScope = sentry && createSentryRequestScope(sentry, { service: "billing" });
	const merchantSentryScope = sentry && createSentryRequestScope(sentry, { service: "merchant" });
	const mcpSentryScope = sentry && createSentryRequestScope(sentry, { service: "mcp" });
	const staff = createApp({
		env,
		entitlementService: new EntitlementService(billingRepository),
		projectContextResolver,
		providerRegistry,
		providerCapabilityReads: capabilityReads,
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
		providers: projectProviderServiceResolver(providerRegistry),
		capabilityReads,
		operations: adminOperations,
	});
	const app = attachMerchantRuntime(staff, merchantBilling, {
		...dependencies.merchant,
		config: merchantConfig,
		staffRequestScope: sentryRequestScope,
		merchantRequestScope: merchantSentryScope,
		mcpRequestScope: mcpSentryScope,
		onMcpUnexpectedError:
			dependencies.merchant?.onMcpUnexpectedError ??
			((error, report) => {
				safelyLogError(logger, "Remote MCP request failed", error, {
					requestId: report.requestId,
					method: report.request.method,
					path: new URL(report.request.url).pathname,
					route: report.route,
					status: String(report.status),
					code: report.code,
				});
			}),
		onMerchantUnexpectedError: (error, report) => {
			const url = new URL(report.request.url);
			safelyLogError(logger, "Merchant request failed", error, {
				requestId: report.requestId,
				method: report.request.method,
				path: url.pathname,
				route: report.route,
				status: String(report.status),
				code: report.code,
			});
		},
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
	let pollingLogger: ReturnType<typeof createPinoBillingLogger> | undefined;
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
