import type { BillingEnv } from "../../../src/env";
import type { BillingMetrics } from "../../../src/observability/metrics";
import { ProjectionHttpClient } from "../../../src/projections/http-client";
import type { ApiProjectProjectionFetch } from "../../../src/projections/http-types";
import {
	type ProjectionSyncRepository,
	ProjectionSyncWorker,
} from "../../../src/workers/projection-sync";
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
	now = () => new Date(Date.now() + 60_000),
	metrics,
}: {
	env: BillingEnv;
	repository: ProjectionSyncRepository;
	fetch?: ApiProjectProjectionFetch;
	workerId?: string;
	maxAttempts?: number;
	batchSize?: number;
	now?: () => Date;
	metrics?: BillingMetrics;
}) {
	const worker = new ProjectionSyncWorker({
		workerId,
		maxAttempts,
		batchSize,
		repository,
		delivery: new ProjectionHttpClient({ projects: env.projects, fetch }),
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
	now = () => new Date(Date.now() + 60_000),
}: {
	env: BillingEnv;
	repository: StoreEventReplayRepository;
	providers: StoreEventReplayProviders | StoreEventReplayProviderSelector;
	workerId?: string;
	maxAttempts?: number;
	batchSize?: number;
	now?: () => Date;
}) {
	const worker = new StoreEventReplayWorker({
		workerId,
		maxAttempts,
		batchSize,
		repository,
		providers,
		now,
		jitterMs: () => 0,
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
	now = () => new Date(Date.now() + 60_000),
}: {
	env: BillingEnv;
	repository: SubscriptionReconciliationRepository;
	providers: SubscriptionReconciliationProviders | SubscriptionReconciliationProviderSelector;
	workerId?: string;
	maxAttempts?: number;
	batchSize?: number;
	now?: () => Date;
}) {
	const worker = new SubscriptionReconciliationWorker({
		workerId,
		maxAttempts,
		batchSize,
		staleAfterMs: env.providerReconciliationStaleAfterMs,
		repository,
		providers,
		now,
		jitterMs: () => 0,
	});

	return await worker.runOnce();
}
