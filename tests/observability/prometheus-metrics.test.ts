import { describe, expect, it } from "bun:test";
import { register } from "@prometheus-io/client";
import { createInMemoryBillingMetrics } from "../../src/observability/metrics";
import { createPrometheusMetricsRenderer } from "../../src/observability/prometheus-metrics";

function sample(text: string, name: string): number {
	const line = text.split("\n").find((line) => line.startsWith(`${name} `));
	if (!line) throw new Error(`Missing metric: ${name}`);
	return Number(line.slice(name.length + 1));
}

describe("Prometheus runtime metrics", () => {
	it("exports finite process readings with metric types, units, and the actual Bun version", async () => {
		const before = process.uptime();
		const renderMetrics = createPrometheusMetricsRenderer(createInMemoryBillingMetrics());
		const text = await renderMetrics();
		const after = process.uptime();
		const expectedStartTime = Date.now() / 1000 - after;
		for (const name of [
			"process_cpu_user_seconds_total",
			"process_cpu_system_seconds_total",
			"process_cpu_seconds_total",
		]) {
			expect(text).toContain(`# TYPE ${name} counter`);
			expect(sample(text, name)).toBeGreaterThanOrEqual(0);
		}
		for (const name of [
			"process_resident_memory_bytes",
			"nodejs_heap_size_total_bytes",
			"nodejs_heap_size_used_bytes",
			"nodejs_external_memory_bytes",
			"process_start_time_seconds",
			"process_uptime_seconds",
			"nodejs_eventloop_lag_seconds",
		]) {
			expect(text).toContain(`# TYPE ${name} gauge`);
			expect(Number.isFinite(sample(text, name))).toBe(true);
			expect(sample(text, name)).toBeGreaterThanOrEqual(0);
		}
		expect(sample(text, "process_resident_memory_bytes")).toBeGreaterThan(0);
		expect(sample(text, "process_uptime_seconds")).toBeGreaterThanOrEqual(before);
		expect(sample(text, "process_uptime_seconds")).toBeLessThanOrEqual(after);
		expect(sample(text, "process_start_time_seconds")).toBeCloseTo(expectedStartTime, 1);
		expect(sample(text, "process_cpu_seconds_total")).toBeCloseTo(
			sample(text, "process_cpu_user_seconds_total") +
				sample(text, "process_cpu_system_seconds_total"),
			6,
		);
		const cpu = process.cpuUsage();
		expect(sample(text, "process_cpu_seconds_total")).toBeLessThanOrEqual(
			(cpu.user + cpu.system) / 1e6,
		);
		expect(text).toContain(`bun_version_info{version="${Bun.version}"} 1`);
		expect(text).not.toMatch(/nodejs_(gc|active_|heap_space|version|eventloop_utilization)/);
		expect(text).not.toContain("NaN");
		expect(text).toEndWith("\n");
	});

	it("shares concurrent scrapes and keeps process counters monotonic across later scrapes", async () => {
		const renderMetrics = createPrometheusMetricsRenderer(createInMemoryBillingMetrics());
		const first = await renderMetrics();
		const concurrent = await Promise.all([renderMetrics(), renderMetrics(), renderMetrics()]);
		for (const text of concurrent) {
			expect(text).toBe(concurrent[0]);
			expect(sample(text, "process_cpu_seconds_total")).toBeGreaterThanOrEqual(
				sample(first, "process_cpu_seconds_total"),
			);
			expect(sample(text, "process_uptime_seconds")).toBeGreaterThanOrEqual(
				sample(first, "process_uptime_seconds"),
			);
			expect(sample(text, "process_start_time_seconds")).toBe(
				sample(first, "process_start_time_seconds"),
			);
		}
	});

	it("preserves billing series and isolates registries without registering global metrics", async () => {
		const globalNames = register.getMetricsAsArray().map((metric) => metric.name);
		const first = createInMemoryBillingMetrics();
		const second = createInMemoryBillingMetrics();
		const renderFirst = createPrometheusMetricsRenderer(first);
		const renderSecond = createPrometheusMetricsRenderer(second);
		first.increment("billing_http_errors_total", { code: 'BAD"CODE' });
		first.observe?.("billing_metering_operation_duration_ms", 8, { operation: "consume" });
		const [firstText, secondText] = await Promise.all([renderFirst(), renderSecond()]);
		expect(firstText).toContain('billing_http_errors_total{code="BAD\\"CODE"} 1\n');
		expect(firstText).toContain(
			'billing_metering_operation_duration_ms_bucket{le="10",operation="consume"} 1',
		);
		expect(firstText).toContain(
			'billing_metering_operation_duration_ms_bucket{le="+Inf",operation="consume"} 1',
		);
		expect(firstText).toContain(
			'billing_metering_operation_duration_ms_sum{operation="consume"} 8',
		);
		expect(secondText).not.toContain("billing_http_errors_total");
		expect(secondText).not.toContain("billing_metering_operation_duration_ms");
		expect(secondText).toContain("process_cpu_seconds_total");
		expect(register.getMetricsAsArray().map((metric) => metric.name)).toEqual(globalNames);
	});
});
