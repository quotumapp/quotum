import { describe, expect, it } from "bun:test";
import { createInMemoryBillingMetrics } from "../../src/observability/metrics";
import { verifyProjectionSignature } from "../../src/projections/http-types";
import type { ProjectConnectionFixture as ProjectRuntimeConfig } from "../../src/testing/connection-fixtures";
import { FixtureProjectionHttpClient as ProjectionHttpClient } from "../../src/testing/connection-fixtures";

const projects: ProjectRuntimeConfig[] = [
	{
		projectInstanceKey: "voysee",
		projectionUrl: "https://voysee.example.com/",
		projectionSecret: "voysee-projection-secret",
	},
	{
		projectInstanceKey: "wiseley",
		projectionUrl: "https://wiseley.example.com/app?ignored=true#fragment",
		projectionSecret: "wiseley-projection-secret",
	},
];

const projection = {
	schemaVersion: 1 as const,
	projectKey: "wiseley",
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
};

describe("ProjectionHttpClient", () => {
	it("posts signed projections to the selected project endpoint with timeout and redirect controls", async () => {
		const now = new Date("2026-06-07T12:00:00.000Z");
		const requests: Array<{ url: string; init: RequestInit }> = [];
		const adapter = new ProjectionHttpClient({
			projects,
			now: () => now,
			timeoutMs: 1234,
			fetch: async (url, init) => {
				requests.push({ url: String(url), init: init ?? {} });
				return new Response(JSON.stringify({ success: true }), { status: 200 });
			},
		});

		await adapter.deliver(projection);

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://wiseley.example.com/app/internal/billing/projections");
		expect(requests[0]?.init.method).toBe("POST");
		expect(requests[0]?.init.redirect).toBe("error");
		expect(requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
		const body = String(requests[0]?.init.body);
		const timestamp = String(Math.floor(now.getTime() / 1000));
		const signature = createExpectedProjectionSignature(
			"wiseley-projection-secret",
			timestamp,
			body,
		);
		expect(requests[0]?.init.headers).toEqual({
			authorization: "Bearer wiseley-projection-secret",
			"content-type": "application/json",
			"X-Billing-Signature": signature,
			"X-Billing-Timestamp": timestamp,
		});
		expect(JSON.parse(body)).toEqual(projection);
	});

	it("verifies projection signatures with a replay window and constant-time comparison", () => {
		const body = JSON.stringify(projection);
		const timestamp = "1780833600";
		const signature = createExpectedProjectionSignature(
			"wiseley-projection-secret",
			timestamp,
			body,
		);

		expect(
			verifyProjectionSignature({
				secret: "wiseley-projection-secret",
				body,
				timestamp,
				signature,
				now: () => new Date("2026-06-07T12:04:59.000Z"),
			}),
		).toBe(true);
		expect(
			verifyProjectionSignature({
				secret: "wiseley-projection-secret",
				body,
				timestamp,
				signature,
				now: () => new Date("2026-06-07T12:05:01.000Z"),
			}),
		).toBe(false);
		expect(
			verifyProjectionSignature({
				secret: "wiseley-projection-secret",
				body: `${body}\n`,
				timestamp,
				signature,
				now: () => new Date("2026-06-07T12:00:00.000Z"),
			}),
		).toBe(false);
		expect(
			verifyProjectionSignature({
				secret: "wrong-projection-secret",
				body,
				timestamp,
				signature,
				now: () => new Date("2026-06-07T12:00:00.000Z"),
			}),
		).toBe(false);
		const flipped = `${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
		expect(
			verifyProjectionSignature({
				secret: "wiseley-projection-secret",
				body,
				timestamp,
				signature: flipped,
				now: () => new Date("2026-06-07T12:00:00.000Z"),
			}),
		).toBe(false);
		expect(
			verifyProjectionSignature({
				secret: "wiseley-projection-secret",
				body,
				timestamp,
				signature: signature.replace("sha256=", ""),
				now: () => new Date("2026-06-07T12:00:00.000Z"),
			}),
		).toBe(false);
		for (const malformed of [
			"",
			"abc",
			"1780833600.5",
			"01780833600",
			" 1780833600",
			"1e9",
			"-1",
		]) {
			expect(
				verifyProjectionSignature({
					secret: "wiseley-projection-secret",
					body,
					timestamp: malformed,
					signature,
					now: () => new Date("2026-06-07T12:00:00.000Z"),
				}),
			).toBe(false);
		}
		const now = () => new Date(1_780_833_600_000);
		expect(
			verifyProjectionSignature({
				secret: "wiseley-projection-secret",
				body,
				timestamp,
				signature,
				now: () => new Date(now().getTime() - 301_000),
			}),
		).toBe(false);
		expect(
			verifyProjectionSignature({
				secret: "wiseley-projection-secret",
				body,
				timestamp,
				signature,
				now: () => new Date(now().getTime() - 299_000),
			}),
		).toBe(true);
	});

	it("treats non-2xx responses as retryable projection failures", async () => {
		const metrics = createInMemoryBillingMetrics();
		const adapter = new ProjectionHttpClient({
			projects,
			metrics,
			fetch: async () => new Response("unavailable", { status: 503 }),
		});

		await expect(adapter.deliver(projection)).rejects.toThrow(
			"Projection delivery failed for project wiseley with status 503",
		);
		expect(metrics.renderPrometheus()).toContain(
			'billing_projection_delivery_total{code="HTTP_503",project="wiseley",result="failed"} 1',
		);
	});

	it("records successful projection deliveries", async () => {
		const metrics = createInMemoryBillingMetrics();
		const adapter = new ProjectionHttpClient({
			projects,
			metrics,
			fetch: async () => new Response(JSON.stringify({ success: true }), { status: 200 }),
		});

		await adapter.deliver(projection);

		expect(metrics.renderPrometheus()).toContain(
			'billing_projection_delivery_total{code="OK",project="wiseley",result="succeeded"} 1',
		);
	});

	it("treats network failures as retryable projection failures", async () => {
		const adapter = new ProjectionHttpClient({
			projects,
			fetch: async () => {
				throw new Error("connection refused");
			},
		});

		await expect(adapter.deliver(projection)).rejects.toThrow(
			"Projection delivery failed for project wiseley: connection refused",
		);
	});

	it("rejects invalid success responses", async () => {
		const adapter = new ProjectionHttpClient({
			projects,
			fetch: async () =>
				new Response(JSON.stringify({ success: true, unexpected: true }), { status: 200 }),
		});

		await expect(adapter.deliver(projection)).rejects.toThrow(
			"Projection delivery response for project wiseley was invalid",
		);
	});

	it("rejects oversized projection responses before parsing them", async () => {
		const adapter = new ProjectionHttpClient({
			projects,
			maxResponseBytes: 16,
			fetch: async () =>
				new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { "content-length": "32" },
				}),
		});

		await expect(adapter.deliver(projection)).rejects.toThrow(
			"Projection delivery response for project wiseley was too large",
		);
	});
});

function createExpectedProjectionSignature(
	secret: string,
	timestamp: string,
	body: string,
): string {
	const digest = new Bun.CryptoHasher("sha256", secret)
		.update(`${timestamp}.${body}`)
		.digest("hex");
	return `sha256=${digest}`;
}
