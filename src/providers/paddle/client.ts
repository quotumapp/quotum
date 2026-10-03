import { RejectedProviderWrite } from "../../billing/provider-operations";
import type { PaddleConfig } from "./config";

const API_ORIGIN = "https://sandbox-api.paddle.com";
// All tenants sharing this process also share its egress IP. Respect the aggregate cooldown.
let sharedRetryAt = 0;

export class PaddleRequestRejected extends RejectedProviderWrite {
	constructor(
		readonly status: number,
		code: string,
		readonly retryAfterMs: number | null,
	) {
		super(code);
	}
}

export class PaddleWriteUncertain extends Error {
	constructor() {
		super("Paddle request outcome must be reconciled");
	}
}

export interface PaddleResponse<T> {
	data: T;
	meta?: { request_id?: string; pagination?: { next?: string | null; has_more?: boolean } };
}

export type PaddleFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Paddle API v1. No automatic write retries, redirects or arbitrary authenticated destinations. */
export class PaddleClient {
	constructor(
		private readonly config: Pick<PaddleConfig, "apiKey">,
		private readonly fetcher: PaddleFetch = fetch,
		private readonly now: () => number = Date.now,
		private readonly cooldown: { get: () => number; set: (value: number) => void } = {
			get: () => sharedRetryAt,
			set: (value) => {
				sharedRetryAt = Math.max(sharedRetryAt, value);
			},
		},
	) {
		if (!/^pdl_sdbx_[A-Za-z0-9_]+$/.test(config.apiKey))
			throw new Error("A Paddle sandbox API key is required");
	}

	async get<T>(path: string): Promise<PaddleResponse<T>> {
		return await this.request<T>("GET", path);
	}

	async write<T>(
		method: "POST" | "PATCH",
		path: string,
		body: Record<string, unknown>,
	): Promise<PaddleResponse<T>> {
		return await this.request<T>(method, path, body);
	}

	private async request<T>(
		method: "GET" | "POST" | "PATCH",
		path: string,
		body?: Record<string, unknown>,
	): Promise<PaddleResponse<T>> {
		if (
			!/^\/(customers|transactions|subscriptions|products|prices|adjustments|events|notification-settings)(\/|\?|$)/.test(
				path,
			) ||
			path.includes("\\") ||
			path.includes("#") ||
			path
				.split("?")[0]
				?.split("/")
				.some((part) => /[.%]/.test(part))
		)
			throw new Error("Invalid Paddle API path");
		const url = new URL(path, API_ORIGIN);
		if (url.origin !== API_ORIGIN || url.pathname.includes(".."))
			throw new Error("Invalid Paddle API destination");
		const retryAfterMs = this.cooldown.get() - this.now();
		if (retryAfterMs > 0) throw new PaddleRequestRejected(429, "PADDLE_RATE_LIMITED", retryAfterMs);
		let response: Response;
		try {
			response = await this.fetcher(url, {
				method,
				redirect: "error",
				signal: AbortSignal.timeout(20_000),
				headers: {
					authorization: `Bearer ${this.config.apiKey}`,
					"Paddle-Version": "1",
					"content-type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			throw new PaddleWriteUncertain();
		}
		const retrySeconds = Number(response.headers.get("retry-after"));
		const retryMs =
			response.status === 429
				? Number.isFinite(retrySeconds) && retrySeconds > 0
					? retrySeconds * 1000
					: 60_000
				: null;
		if (retryMs !== null) this.cooldown.set(this.now() + retryMs);
		let envelope: unknown;
		try {
			envelope = await response.json();
		} catch {
			throw new PaddleWriteUncertain();
		}
		if (!response.ok) {
			const error = isRecord(envelope) && isRecord(envelope.error) ? envelope.error : null;
			if (
				response.status >= 400 &&
				response.status < 500 &&
				response.status !== 408 &&
				error !== null &&
				typeof error.code === "string" &&
				/^[a-z0-9_]+$/.test(error.code)
			) {
				throw new PaddleRequestRejected(response.status, error.code, retryMs);
			}
			throw new PaddleWriteUncertain();
		}
		if (!isRecord(envelope) || !("data" in envelope)) throw new PaddleWriteUncertain();
		return envelope as unknown as PaddleResponse<T>;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
