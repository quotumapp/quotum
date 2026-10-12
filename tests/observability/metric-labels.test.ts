import { describe, expect, it } from "bun:test";
import type { ProjectionSyncJobRow, StoreEventReplayJobRow } from "../../src/db/repository";
import { createInMemoryBillingMetrics } from "../../src/observability/metrics";
import { createPrometheusMetricsRenderer } from "../../src/observability/prometheus-metrics";
import { ProjectionHttpClient } from "../../src/projections/http-client";
import { ProjectionSyncWorker } from "../../src/workers/projection-sync";
import { StoreEventReplayWorker } from "../../src/workers/store-event-replay";
import { projectContextResolver, projectInstanceContext } from "../helpers/project-context";

// `/metrics` is unauthenticated, so a series must never identify the tenant that produced it.
const identityLabelNames = [
	"project",
	"project_key",
	"projectKey",
	"project_id",
	"projectId",
	"project_instance",
	"projectInstanceKey",
	"customer",
	"customer_id",
	"customerId",
	"account",
	"account_id",
	"accountId",
	"billing_account_id",
	"billingAccountId",
	"organization",
	"organization_id",
	"email",
];

const tenantKeys = ["acme", "globex"];
const syncJobIds = ["job_acme", "job_globex"];
const clock = () => new Date("2026-05-31T00:00:00.000Z");

const resolver = projectContextResolver({
	contexts: [
		projectInstanceContext("acme", { projectInstanceId: "project_acme" }),
		projectInstanceContext("globex", { projectInstanceId: "project_globex" }),
	],
});

function syncJob(projectKey: string, id: string): ProjectionSyncJobRow {
	return {
		id,
		project_id: `project_${projectKey}`,
		project_key: projectKey,
		customer_id: "customer_1",
		idempotency_key: `stripe:${id}:projection`,
		reason: "provider_webhook",
		payload: {
			billingAccountId: "user_1",
			generatedAt: "2026-05-31T00:00:00.000Z",
			balances: [],
			reason: "provider_webhook",
			entitlements: {
				billingAccountId: "user_1",
				generatedAt: "2026-05-31T00:00:00.000Z",
				entitlements: [],
			},
		},
		status: "processing",
		attempts: 0,
		last_error: null,
		reprojection_requested: false,
		next_attempt_at: null,
		locked_at: "2026-05-31T00:00:00.000Z",
		locked_by: "worker-a",
		created_at: "2026-05-31T00:00:00.000Z",
		updated_at: "2026-05-31T00:00:00.000Z",
	};
}

function storeEvent(projectKey: string, id: string): StoreEventReplayJobRow {
	return {
		id,
		project_id: `project_${projectKey}`,
		project_key: projectKey,
		provider: "apple",
		channel: "ios",
		external_event_id: `notification_${id}`,
		event_type: "DID_RENEW",
		customer_id: null,
		store_product_id: "premium_monthly",
		transaction_id: "200000000000001",
		purchase_kind: "subscription",
		processing_status: "processing",
		processing_error: null,
		attempts: 0,
		next_attempt_at: null,
		raw_payload: {},
		processed_at: null,
		locked_at: "2026-05-31T00:00:00.000Z",
		locked_by: "worker-a",
		created_at: "2026-05-31T00:00:00.000Z",
		updated_at: "2026-05-31T00:00:00.000Z",
	};
}

function labelNames(rendered: string): string[] {
	const names = new Set<string>();
	for (const line of rendered.split("\n")) {
		if (line.startsWith("#") || !line.startsWith("billing_")) continue;
		const labels = line.slice(line.indexOf("{") + 1, line.lastIndexOf("}"));
		for (const pair of labels.matchAll(/([A-Za-z_][A-Za-z0-9_]*)="/g)) names.add(pair[1] ?? "");
	}
	return [...names].sort();
}

describe("public metric labels", () => {
	it("keeps tenant identity out of every series the recording paths emit", async () => {
		const metrics = createInMemoryBillingMetrics();
		const renderMetrics = createPrometheusMetricsRenderer(metrics);

		// Projection delivery: one success and one failure for each tenant.
		let status = 200;
		const delivery = new ProjectionHttpClient({
			resolveProject: async (projectKey) => ({
				projectionUrl: `https://${projectKey}.example.com/`,
				projectionSecret: `${projectKey}-projection-secret`,
				projectionContract: "billing_state_v1",
			}),
			fetch: async () => new Response(JSON.stringify({ success: true }), { status }),
			metrics,
		});
		const projection = (projectKey: string) => ({
			schemaVersion: 1 as const,
			projectKey,
			jobId: "job_1",
			idempotencyKey: "projection:key",
			billingAccountId: "user_1",
			generatedAt: "2026-05-31T00:00:00.000Z",
			balances: [],
			reason: "provider_webhook" as const,
			entitlements: {
				billingAccountId: "user_1",
				generatedAt: "2026-05-31T00:00:00.000Z",
				entitlements: [],
			},
		});
		for (const projectKey of tenantKeys) {
			status = 200;
			await delivery.deliver(projection(projectKey));
			status = 503;
			await expect(delivery.deliver(projection(projectKey))).rejects.toThrow();
		}

		// Projection sync worker: both tenants succeed, one fails.
		const syncWorker = new ProjectionSyncWorker({
			projectContextResolver: resolver,
			workerId: "worker-a",
			maxAttempts: 10,
			batchSize: 5,
			concurrency: 1,
			repository: {
				buildUsageProjection: async (): Promise<never> => {
					throw new Error("usage projections are not expected here");
				},
				claimProjectionSyncJobs: async () =>
					tenantKeys.map((projectKey, index) => syncJob(projectKey, syncJobIds[index] ?? "")),
				markProjectionSyncJobSucceeded: async () => {},
				markProjectionSyncJobFailed: async () => {},
			},
			delivery: {
				deliver: async ({ projectKey }) => {
					if (projectKey === "globex") throw new Error("delivery refused");
				},
			},
			now: clock,
			jitterMs: () => 0,
			metrics,
		});
		expect(await syncWorker.runOnce()).toEqual({ claimed: 2, succeeded: 1, failed: 1 });

		// Store event replay worker: one processed event and one failure for each tenant.
		const replayWorker = new StoreEventReplayWorker({
			projectContextResolver: resolver,
			workerId: "worker-a",
			maxAttempts: 3,
			batchSize: 5,
			repository: {
				claimStoreEventReplayJobs: async () =>
					tenantKeys.flatMap((projectKey) => [
						storeEvent(projectKey, `${projectKey}_ok`),
						storeEvent(projectKey, `${projectKey}_fails`),
					]),
				claimStoreEventReplayJobById: async () => {
					throw new Error("not expected");
				},
				markStoreEventReplayJobSucceeded: async () => {},
				markStoreEventReplayJobFailed: async () => {},
			},
			providers: {
				apple: {
					replayStoreEvent: async (event) => {
						if (event.id.endsWith("_fails")) throw new Error("provider refused");
						return { status: "processed" };
					},
				},
				google: null,
				stripe: null,
			},
			now: clock,
			jitterMs: () => 0,
			metrics,
		});
		expect(await replayWorker.runOnce()).toMatchObject({ claimed: 4, processed: 2, failed: 2 });

		const rendered = await renderMetrics();
		const names = labelNames(rendered);

		// No series names a label that identifies a tenant, and no tenant key appears as a value.
		expect(names.length).toBeGreaterThan(0);
		for (const identity of identityLabelNames) expect(names).not.toContain(identity);
		for (const tenantKey of tenantKeys) expect(rendered).not.toContain(tenantKey);

		// The series that identified the tenant must still exist, by their remaining labels.
		expect(rendered).toContain('billing_projection_delivery_total{code="OK",result="succeeded"} 2');
		expect(rendered).toContain(
			'billing_projection_delivery_total{code="HTTP_503",result="failed"} 2',
		);
		expect(rendered).toContain(
			'billing_worker_jobs_total{result="succeeded",worker="projection_sync"} 1',
		);
		expect(rendered).toContain(
			'billing_worker_jobs_total{result="failed",worker="projection_sync"} 1',
		);
		expect(rendered).toContain(
			'billing_worker_jobs_total{provider="apple",result="processed",worker="store_event_replay"} 2',
		);
		expect(rendered).toContain(
			'billing_worker_jobs_total{provider="apple",result="failed",worker="store_event_replay"} 2',
		);
	});
});
