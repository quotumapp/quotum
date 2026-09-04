import { z } from "zod";
import {
	type BillingMetrics,
	createNoopBillingMetrics,
	safelyIncrementBillingMetric,
} from "../observability/metrics";
import type { ProjectRuntimeConfig } from "../projects/config";
import type { BillingProjectionInput, ProjectionDelivery } from "./delivery";
import {
	type ApiProjectProjectionFetch,
	type ApiProjectProjectionResponse,
	createProjectionSignatureHeaders,
} from "./http-types";

export interface ProjectionHttpClientOptions {
	projects: readonly ProjectRuntimeConfig[];
	fetch?: ApiProjectProjectionFetch;
	now?: () => Date;
	timeoutMs?: number;
	maxResponseBytes?: number;
	metrics?: BillingMetrics;
}

const defaultProjectionTimeoutMs = 10_000;
const defaultMaxProjectionResponseBytes = 4096;
const projectionResponseSchema = z.object({ success: z.literal(true) }).strict();

export class ProjectionHttpClient implements ProjectionDelivery {
	private readonly projects: readonly ProjectRuntimeConfig[];
	private readonly fetch: ApiProjectProjectionFetch;
	private readonly now: () => Date;
	private readonly timeoutMs: number;
	private readonly maxResponseBytes: number;
	private readonly metrics: BillingMetrics;

	constructor({
		projects,
		fetch = globalThis.fetch,
		now = () => new Date(),
		timeoutMs = defaultProjectionTimeoutMs,
		maxResponseBytes = defaultMaxProjectionResponseBytes,
		metrics = createNoopBillingMetrics(),
	}: ProjectionHttpClientOptions) {
		this.projects = projects;
		this.fetch = fetch;
		this.now = now;
		this.timeoutMs = timeoutMs;
		this.maxResponseBytes = maxResponseBytes;
		this.metrics = metrics;
	}

	async deliver(input: BillingProjectionInput): Promise<void> {
		const project = this.projectFor(input.projectKey);
		const url = projectionUrl(project);
		const body = JSON.stringify(input);

		let response: Response;
		try {
			response = await this.fetch(url, {
				method: "POST",
				redirect: "error",
				signal: AbortSignal.timeout(this.timeoutMs),
				headers: {
					authorization: `Bearer ${project.projectionSecret}`,
					"content-type": "application/json",
					...createProjectionSignatureHeaders({
						secret: project.projectionSecret,
						body,
						now: this.now,
					}),
				},
				body,
			});
		} catch (error) {
			this.recordDeliveryMetric(input.projectKey, "failed", "NETWORK");
			throw new Error(
				`Projection delivery failed for project ${input.projectKey}: ${errorMessage(error)}`,
			);
		}

		if (!response.ok) {
			this.recordDeliveryMetric(input.projectKey, "failed", `HTTP_${response.status}`);
			throw new Error(
				`Projection delivery failed for project ${input.projectKey} with status ${response.status}`,
			);
		}

		try {
			await parseProjectionResponse(response, input.projectKey, this.maxResponseBytes);
		} catch (error) {
			this.recordDeliveryMetric(input.projectKey, "failed", "INVALID_RESPONSE");
			throw error;
		}
		this.recordDeliveryMetric(input.projectKey, "succeeded", "OK");
	}

	private projectFor(projectKey: string): ProjectRuntimeConfig {
		const project = this.projects.find((candidate) => candidate.projectInstanceKey === projectKey);
		if (project === undefined) {
			throw new Error(`Billing project ${projectKey} is not configured`);
		}
		return project;
	}

	private recordDeliveryMetric(
		projectKey: string,
		result: "succeeded" | "failed",
		code: string,
	): void {
		safelyIncrementBillingMetric(this.metrics, "billing_projection_delivery_total", {
			project: projectKey,
			result,
			code,
		});
	}
}

function projectionUrl(project: ProjectRuntimeConfig): string {
	const url = new URL(project.projectionUrl);
	const basePath = url.pathname.replace(/\/+$/, "");
	url.pathname = `${basePath}/internal/billing/projections`;
	url.search = "";
	url.hash = "";
	return url.toString();
}

async function parseProjectionResponse(
	response: Response,
	projectKey: string,
	maxBytes: number,
): Promise<ApiProjectProjectionResponse> {
	const text = await readProjectionResponseText(response, projectKey, maxBytes);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`Projection delivery response for project ${projectKey} was invalid`);
	}

	const result = projectionResponseSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(`Projection delivery response for project ${projectKey} was invalid`);
	}

	return result.data;
}

async function readProjectionResponseText(
	response: Response,
	projectKey: string,
	maxBytes: number,
): Promise<string> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		const parsedContentLength = Number.parseInt(contentLength, 10);
		if (String(parsedContentLength) === contentLength && parsedContentLength > maxBytes) {
			throw new Error(`Projection delivery response for project ${projectKey} was too large`);
		}
	}

	if (response.body === null) {
		return "";
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		totalBytes += value.byteLength;
		if (totalBytes > maxBytes) {
			await reader.cancel();
			throw new Error(`Projection delivery response for project ${projectKey} was too large`);
		}

		chunks.push(value);
	}

	const body = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return new TextDecoder().decode(body);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
