import type { BillingMetrics } from "../../../src/observability/metrics";
import type { ApiProjectProjectionFetch } from "../../../src/projections/http-types";
import type { FixtureBillingEnv as BillingEnv } from "../../../src/testing/connection-fixtures";
import { FixtureProjectionHttpClient as ProjectionHttpClient } from "../../../src/testing/connection-fixtures";
import {
	AutoTopupWorker,
	type AutoTopupWorkerProvider,
	type AutoTopupWorkerRepository,
} from "../../../src/workers/auto-topup";
import {
	type ProjectionSyncRepository,
	ProjectionSyncWorker,
} from "../../../src/workers/projection-sync";
import {
	RecurringBillingWorker,
	type RecurringBillingWorkerProvider,
	type RecurringBillingWorkerRepository,
} from "../../../src/workers/recurring-billing";
import {
	type StoreEventReplayProviderSelector,
	type StoreEventReplayProviders,
	type StoreEventReplayRepository,
	StoreEventReplayWorker,
} from "../../../src/workers/store-event-replay";
import {
	type SubscriptionReconciliationProviderSelector,
	type SubscriptionReconciliationProviders,
	type SubscriptionReconciliationRepository,
	SubscriptionReconciliationWorker,
} from "../../../src/workers/subscription-reconciliation";
import { integrationProjectContextResolver } from "./platform-fixture";

const noopWorkerLogger = {
	error() {},
};

export interface ProjectionRequest {
	url: string;
	init: RequestInit;
	rawBody: string;
	body: Record<string, unknown>;
}

export function createRecordingProjectionFetch(
	response: Response | Error = new Response(JSON.stringify({ success: true }), { status: 200 }),
): { requests: ProjectionRequest[]; fetch: ApiProjectProjectionFetch } {
	const requests: ProjectionRequest[] = [];
	const fakeFetch: ApiProjectProjectionFetch = async (url, init) => {
		const rawBody = String(init?.body ?? "{}");
		requests.push({
			url: String(url),
			init: init ?? {},
			rawBody,
			body: JSON.parse(rawBody) as Record<string, unknown>,
		});

		if (response instanceof Error) {
			throw response;
		}

		return response.clone();
	};

	return { requests, fetch: fakeFetch };
}

export async function runProjectionWorkerOnce({
	env,
	repository,
	fetch = globalThis.fetch as ApiProjectProjectionFetch,
	workerId = "integration-worker",
	maxAttempts = env.projectionSyncMaxAttempts,
	batchSize = 25,
	now = () => new Date(),
	metrics,
	timeoutMs,
}: {
	env: BillingEnv;
	repository: ProjectionSyncRepository;
	fetch?: ApiProjectProjectionFetch;
	workerId?: string;
	maxAttempts?: number;
	batchSize?: number;
	now?: () => Date;
	metrics?: BillingMetrics;
	timeoutMs?: number;
}) {
	const worker = new ProjectionSyncWorker({
		workerId,
		maxAttempts,
		batchSize,
		repository,
		delivery: new ProjectionHttpClient({ projects: env.connectionFixtures, fetch, timeoutMs }),
		projectContextResolver: integrationProjectContextResolver(),
		now,
		jitterMs: () => 0,
		metrics,
	});

	return await worker.runOnce();
}

export async function runStoreEventReplayWorkerOnce({
	env,
	repository,
	providers,
	workerId = "integration-worker",
	maxAttempts = env.storeEventReplayMaxAttempts,
	batchSize = 25,
	now = () => new Date(),
	leaseHeartbeatIntervalMs,
}: {
	env: BillingEnv;
	repository: StoreEventReplayRepository;
	providers: StoreEventReplayProviders | StoreEventReplayProviderSelector;
	workerId?: string;
	maxAttempts?: number;
	batchSize?: number;
	now?: () => Date;
	leaseHeartbeatIntervalMs?: number;
}) {
	const worker = new StoreEventReplayWorker({
		workerId,
		maxAttempts,
		batchSize,
		repository,
		providers,
		projectContextResolver: integrationProjectContextResolver(),
		now,
		jitterMs: () => 0,
		leaseHeartbeatIntervalMs,
	});

	return await worker.runOnce();
}

export async function runSubscriptionReconciliationWorkerOnce({
	env,
	repository,
	providers,
	workerId = "integration-worker",
	maxAttempts = env.subscriptionReconciliationMaxAttempts,
	batchSize = 25,
	now = () => new Date(),
	leaseHeartbeatIntervalMs,
}: {
	env: BillingEnv;
	repository: SubscriptionReconciliationRepository;
	providers: SubscriptionReconciliationProviders | SubscriptionReconciliationProviderSelector;
	workerId?: string;
	maxAttempts?: number;
	batchSize?: number;
	now?: () => Date;
	leaseHeartbeatIntervalMs?: number;
}) {
	const worker = new SubscriptionReconciliationWorker({
		workerId,
		maxAttempts,
		batchSize,
		staleAfterMs: env.providerReconciliationStaleAfterMs,
		repository,
		providers,
		projectContextResolver: integrationProjectContextResolver(),
		now,
		jitterMs: () => 0,
		leaseHeartbeatIntervalMs,
	});

	return await worker.runOnce();
}

export async function runAutoTopupWorkerOnce({
	repository,
	provider,
	workerId = "integration-worker",
	batchSize = 25,
	staleAfterMs,
}: {
	repository: AutoTopupWorkerRepository;
	provider: AutoTopupWorkerProvider;
	workerId?: string;
	batchSize?: number;
	staleAfterMs?: number;
}) {
	const worker = new AutoTopupWorker({
		workerId,
		batchSize,
		staleAfterMs,
		repository,
		projectContextResolver: integrationProjectContextResolver(),
		providerForProject: async () => provider,
		logger: noopWorkerLogger,
	});
	return await worker.runOnce();
}

export async function runRecurringBillingWorkerOnce({
	repository,
	provider,
	workerId = "integration-worker",
	batchSize = 25,
}: {
	repository: RecurringBillingWorkerRepository;
	provider: RecurringBillingWorkerProvider;
	workerId?: string;
	batchSize?: number;
}) {
	const worker = new RecurringBillingWorker({
		workerId,
		batchSize,
		repository,
		projectContextResolver: integrationProjectContextResolver(),
		providerForProject: async () => provider,
		logger: noopWorkerLogger,
	});
	return await worker.runOnce();
}
