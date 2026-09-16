import { setImmediate } from "node:timers/promises";
import { Counter, Gauge, Registry } from "@prometheus-io/client";
import type { BillingMetrics } from "./metrics";

/** Process-wide readings, with registry and billing state owned by this instance. */
export function createPrometheusMetricsRenderer(billing: BillingMetrics): () => Promise<string> {
	const registry = new Registry();
	const registers = [registry];
	const cpuUser = new Counter({
		name: "process_cpu_user_seconds_total",
		help: "Total user CPU time spent in seconds.",
		registers,
	});
	const cpuSystem = new Counter({
		name: "process_cpu_system_seconds_total",
		help: "Total system CPU time spent in seconds.",
		registers,
	});
	const cpuTotal = new Counter({
		name: "process_cpu_seconds_total",
		help: "Total user and system CPU time spent in seconds.",
		registers,
	});
	const memory = (
		[
			["process_resident_memory_bytes", "Resident memory size in bytes.", "rss"],
			["nodejs_heap_size_total_bytes", "Bun JavaScript heap size in bytes.", "heapTotal"],
			["nodejs_heap_size_used_bytes", "Bun JavaScript heap used in bytes.", "heapUsed"],
			["nodejs_external_memory_bytes", "Bun external memory size in bytes.", "external"],
		] as const
	).map(([name, help, key]) => ({
		gauge: new Gauge({ name, help, registers }),
		key,
	}));
	const startTime = new Gauge({
		name: "process_start_time_seconds",
		help: "Start time of the process since Unix epoch in seconds.",
		registers,
	});
	startTime.set(Date.now() / 1000 - process.uptime());
	const uptime = new Gauge({
		name: "process_uptime_seconds",
		help: "Process uptime in seconds.",
		registers,
	});
	const eventLoopLag = new Gauge({
		name: "nodejs_eventloop_lag_seconds",
		help: "Time to schedule an immediate callback during this scrape in seconds.",
		registers,
	});
	new Gauge({
		name: "bun_version_info",
		help: "Bun runtime version information.",
		labelNames: ["version"],
		registers,
	}).set({ version: Bun.version }, 1);

	let previousCpu = { user: 0, system: 0 };
	let pendingScrape: Promise<string> | undefined;
	async function collect(): Promise<string> {
		const started = process.hrtime.bigint();
		await setImmediate();
		eventLoopLag.set(Number(process.hrtime.bigint() - started) / 1e9);
		const cpu = process.cpuUsage();
		const userSeconds = (cpu.user - previousCpu.user) / 1e6;
		const systemSeconds = (cpu.system - previousCpu.system) / 1e6;
		previousCpu = cpu;
		cpuUser.inc(userSeconds);
		cpuSystem.inc(systemSeconds);
		cpuTotal.inc(userSeconds + systemSeconds);
		const usage = process.memoryUsage();
		for (const { gauge, key } of memory) gauge.set(usage[key]);
		uptime.set(process.uptime());
		return `${await registry.metrics()}${billing.renderPrometheus()}`;
	}

	return () => {
		// Share in-flight collection so concurrent scrapes cannot double-count CPU deltas.
		pendingScrape ??= collect().finally(() => {
			pendingScrape = undefined;
		});
		return pendingScrape;
	};
}
