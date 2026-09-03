export type BillingMetricName =
	| "billing_verification_failures_total"
	| "billing_webhook_failures_total"
	| "billing_http_errors_total"
	| "billing_provider_operations_total"
	| "billing_projection_delivery_total"
	| "billing_projection_sync_jobs_total"
	| "billing_store_event_replay_jobs_total"
	| "billing_subscription_reconciliation_runs_total"
	| "billing_metering_maintenance_runs_total"
	| "billing_metering_operations_total"
	| "billing_worker_jobs_total";

export type BillingHistogramName = "billing_metering_operation_duration_ms";

export interface BillingMetrics {
	increment(name: BillingMetricName, labels?: Record<string, string>): void;
	observe?(name: BillingHistogramName, value: number, labels?: Record<string, string>): void;
	renderPrometheus(): string;
}

interface CounterEntry {
	name: BillingMetricName;
	labels: Array<[string, string]>;
	value: number;
}

interface HistogramEntry {
	name: BillingHistogramName;
	labels: Array<[string, string]>;
	count: number;
	sum: number;
	buckets: number[];
}

const meteringDurationBuckets = [5, 10, 25, 50, 100, 250, 500, 1000, 5000];

export function createInMemoryBillingMetrics(): BillingMetrics {
	const counters = new Map<string, CounterEntry>();
	const histograms = new Map<string, HistogramEntry>();

	return {
		increment(name, labels = {}) {
			const sortedLabels = sortLabels(labels);
			const key = counterKey(name, sortedLabels);
			const existing = counters.get(key);

			if (existing === undefined) {
				counters.set(key, { name, labels: sortedLabels, value: 1 });
				return;
			}

			existing.value += 1;
		},
		observe(name, value, labels = {}) {
			if (!Number.isFinite(value) || value < 0) return;
			const sortedLabels = sortLabels(labels);
			const key = counterKey(name, sortedLabels);
			const entry = histograms.get(key) ?? {
				name,
				labels: sortedLabels,
				count: 0,
				sum: 0,
				buckets: meteringDurationBuckets.map(() => 0),
			};
			entry.count += 1;
			entry.sum += value;
			for (let index = 0; index < meteringDurationBuckets.length; index += 1) {
				if (value <= (meteringDurationBuckets[index] ?? 0)) entry.buckets[index] += 1;
			}
			histograms.set(key, entry);
		},
		renderPrometheus() {
			const countersText = Array.from(counters.values())
				.sort(compareCounterEntries)
				.map(renderCounterEntry)
				.join("\n");
			const histogramsText = Array.from(histograms.values())
				.sort((left, right) =>
					counterKey(left.name, left.labels).localeCompare(counterKey(right.name, right.labels)),
				)
				.flatMap(renderHistogramEntry)
				.join("\n");
			const rendered = [countersText, histogramsText].filter((value) => value !== "").join("\n");
			return rendered === "" ? "" : `${rendered}\n`;
		},
	};
}

export function createNoopBillingMetrics(): BillingMetrics {
	return {
		increment() {},
		observe() {},
		renderPrometheus() {
			return "";
		},
	};
}

export function safelyObserveBillingMetric(
	metrics: BillingMetrics,
	name: BillingHistogramName,
	value: number,
	labels?: Record<string, string>,
): void {
	try {
		metrics.observe?.(name, value, labels);
	} catch {
		// Observability must not alter billing behavior.
	}
}

export function safelyIncrementBillingMetric(
	metrics: BillingMetrics,
	name: BillingMetricName,
	labels?: Record<string, string>,
): void {
	try {
		metrics.increment(name, labels);
	} catch {
		// Observability must not alter billing behavior.
	}
}

function sortLabels(labels: Record<string, string>): Array<[string, string]> {
	return Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
}

function counterKey(
	name: BillingMetricName | BillingHistogramName,
	labels: Array<[string, string]>,
): string {
	return JSON.stringify([name, labels]);
}

function compareCounterEntries(left: CounterEntry, right: CounterEntry): number {
	const nameComparison = left.name.localeCompare(right.name);
	if (nameComparison !== 0) {
		return nameComparison;
	}

	return renderLabels(left.labels).localeCompare(renderLabels(right.labels));
}

function renderCounterEntry(entry: CounterEntry): string {
	const labels = renderLabels(entry.labels);
	return labels.length === 0
		? `${entry.name} ${entry.value}`
		: `${entry.name}{${labels}} ${entry.value}`;
}

function renderHistogramEntry(entry: HistogramEntry): string[] {
	const baseLabels = Object.fromEntries(entry.labels);
	const buckets = meteringDurationBuckets.map((upperBound, index) => {
		const labels = renderLabels(sortLabels({ ...baseLabels, le: String(upperBound) }));
		return `${entry.name}_bucket{${labels}} ${entry.buckets[index] ?? 0}`;
	});
	const infiniteLabels = renderLabels(sortLabels({ ...baseLabels, le: "+Inf" }));
	const labels = renderLabels(entry.labels);
	const suffix = labels === "" ? "" : `{${labels}}`;
	return [
		...buckets,
		`${entry.name}_bucket{${infiniteLabels}} ${entry.count}`,
		`${entry.name}_sum${suffix} ${entry.sum}`,
		`${entry.name}_count${suffix} ${entry.count}`,
	];
}

function renderLabels(labels: Array<[string, string]>): string {
	return labels.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",");
}

function escapeLabelValue(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}
