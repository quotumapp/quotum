import type { BillingFetch } from "../sdk/client";

export class McpRequestBlockedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpRequestBlockedError";
	}
}

export interface GuardedFetchOptions {
	baseUrl: string;
	fetch?: BillingFetch;
	timeoutMs?: number;
	maxResponseBytes?: number;
}

/**
 * Every request the server may send. Tool annotations are hints a host can ignore, so read-only is
 * enforced here: a tool added later cannot reach a route that is not listed.
 */
export const allowedRequests: ReadonlyArray<readonly ["GET" | "POST", RegExp]> = [
	["GET", /^\/v1\/catalog$/u],
	["GET", /^\/v1\/admin\/customers\/search$/u],
	["GET", /^\/v1\/admin\/customers\/by-billing-account\/[^/]+$/u],
	["GET", /^\/v1\/admin\/store-events$/u],
	["GET", /^\/v1\/admin\/store-events\/[^/]+$/u],
	["GET", /^\/v1\/admin\/projection-jobs$/u],
	["GET", /^\/v1\/admin\/stats\/summary$/u],
	["GET", /^\/v1\/admin\/providers\/capabilities$/u],
	["GET", /^\/v1\/billing-accounts\/[^/]+\/controls$/u],
	["GET", /^\/v1\/billing-accounts\/[^/]+\/balances\/[^/]+$/u],
	["GET", /^\/v1\/billing-accounts\/[^/]+\/billing-summary$/u],
	["GET", /^\/v1\/billing-accounts\/[^/]+\/available-actions$/u],
	["GET", /^\/v1\/billing-accounts\/[^/]+\/usage\/events$/u],
	["GET", /^\/v1\/billing-accounts\/[^/]+\/usage\/operations\/[^/]+\/[^/]+$/u],
	// check is a POST that writes nothing.
	["POST", /^\/v1\/billing-accounts\/[^/]+\/usage\/check$/u],
];

const forbiddenHeaders = ["x-billing-operator-key", "x-billing-actor", "idempotency-key"];
const forbiddenQueryParameters = ["includeRawPayload"];

export function createGuardedFetch(options: GuardedFetchOptions): BillingFetch {
	const base = new URL(options.baseUrl);
	const basePath = base.pathname.replace(/\/+$/u, "");
	const upstream = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? 15_000;
	const maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;

	return async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.origin !== base.origin || !url.pathname.startsWith(`${basePath}/`)) {
			throw new McpRequestBlockedError("Request leaves the configured billing API");
		}
		const path = url.pathname.slice(basePath.length);
		const allowed = allowedRequests.some(
			([method, pattern]) => method === request.method && pattern.test(path),
		);
		if (!allowed) {
			throw new McpRequestBlockedError(
				`${request.method} ${path} is not a read the MCP server allows`,
			);
		}
		for (const name of forbiddenQueryParameters) {
			if (url.searchParams.has(name)) {
				throw new McpRequestBlockedError(`Query parameter ${name} is not allowed`);
			}
		}
		for (const name of forbiddenHeaders) {
			if (request.headers.has(name)) {
				throw new McpRequestBlockedError(`Header ${name} is not allowed`);
			}
		}
		const response = await upstream(request.url, {
			method: request.method,
			headers: request.headers,
			body: request.method === "POST" ? await request.text() : undefined,
			redirect: "error",
			signal: AbortSignal.timeout(timeoutMs),
		});
		const body = await readCapped(response, maxResponseBytes);
		return new Response(body.byteLength === 0 ? null : body, {
			status: response.status,
			headers: response.headers,
		});
	};
}

async function readCapped(response: Response, maxBytes: number): Promise<ArrayBuffer> {
	if (response.body === null) return new ArrayBuffer(0);
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new McpRequestBlockedError("The billing API response exceeded the size limit");
		}
		chunks.push(value);
	}
	const buffer = new ArrayBuffer(total);
	const body = new Uint8Array(buffer);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return buffer;
}
