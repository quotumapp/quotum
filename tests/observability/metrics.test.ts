import { describe, expect, it } from "bun:test";
import { createInMemoryBillingMetrics } from "../../src/observability/metrics";

describe("createInMemoryBillingMetrics", () => {
	it("increments counters and renders Prometheus text", () => {
		const metrics = createInMemoryBillingMetrics();

		metrics.increment("billing_webhook_failures_total", {
			provider: "apple",
			code: "INVALID_REQUEST",
		});
		metrics.increment("billing_webhook_failures_total", {
			code: "INVALID_REQUEST",
			provider: "apple",
		});
		metrics.increment("billing_projection_sync_jobs_total", { result: "succeeded" });

		expect(metrics.renderPrometheus()).toBe(
			[
				'billing_projection_sync_jobs_total{result="succeeded"} 1',
				'billing_webhook_failures_total{code="INVALID_REQUEST",provider="apple"} 2',
				"",
			].join("\n"),
		);
	});

	it("escapes Prometheus label values", () => {
		const metrics = createInMemoryBillingMetrics();

		metrics.increment("billing_verification_failures_total", {
			code: 'BAD"CODE',
			provider: "apple\\ios\nsandbox",
		});

		expect(metrics.renderPrometheus()).toBe(
			'billing_verification_failures_total{code="BAD\\"CODE",provider="apple\\\\ios\\nsandbox"} 1\n',
		);
	});

	it("renders unlabeled counters", () => {
		const metrics = createInMemoryBillingMetrics();

		metrics.increment("billing_subscription_reconciliation_runs_total");

		expect(metrics.renderPrometheus()).toBe("billing_subscription_reconciliation_runs_total 1\n");
	});

	it("supports request, provider, job, and projection delivery counters", () => {
		const metrics = createInMemoryBillingMetrics();

		metrics.increment("billing_http_errors_total", {
			route_group: "customer",
			status: "500",
			code: "INTERNAL_ERROR",
			classification: "internal",
		});
		metrics.increment("billing_provider_operations_total", {
			provider: "stripe",
			operation: "webhook",
			result: "failed",
			code: "STRIPE_WEBHOOK_SIGNATURE_INVALID",
		});
		metrics.increment("billing_projection_delivery_total", {
			project: "voysee",
			result: "succeeded",
			code: "OK",
		});

		expect(metrics.renderPrometheus()).toContain(
			'billing_http_errors_total{classification="internal",code="INTERNAL_ERROR",route_group="customer",status="500"} 1',
		);
		expect(metrics.renderPrometheus()).toContain(
			'billing_provider_operations_total{code="STRIPE_WEBHOOK_SIGNATURE_INVALID",operation="webhook",provider="stripe",result="failed"} 1',
		);
		expect(metrics.renderPrometheus()).toContain(
			'billing_projection_delivery_total{code="OK",project="voysee",result="succeeded"} 1',
		);
	});

	it("renders metering latency histograms with cumulative buckets", () => {
		const metrics = createInMemoryBillingMetrics();

		metrics.observe?.("billing_metering_operation_duration_ms", 8, {
			operation: "consume",
			result: "completed",
		});
		metrics.observe?.("billing_metering_operation_duration_ms", 30, {
			result: "completed",
			operation: "consume",
		});

		const rendered = metrics.renderPrometheus();
		expect(rendered).toContain(
			'billing_metering_operation_duration_ms_bucket{le="5",operation="consume",result="completed"} 0',
		);
		expect(rendered).toContain(
			'billing_metering_operation_duration_ms_bucket{le="10",operation="consume",result="completed"} 1',
		);
		expect(rendered).toContain(
			'billing_metering_operation_duration_ms_bucket{le="50",operation="consume",result="completed"} 2',
		);
		expect(rendered).toContain(
			'billing_metering_operation_duration_ms_count{operation="consume",result="completed"} 2',
		);
	});
});
