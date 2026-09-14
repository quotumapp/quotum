/**
 * Fixed-window rate limiting for the staff surface. Limiters run ahead of request validation:
 * webhook and aggregate gates execute from `onRequest` hooks, and project-keyed group gates run
 * inside the authentication `derive` and signal rejection by throwing `RateLimitExceeded`.
 */

export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	resetAt: Date;
}

export type RateLimiter = { check(key: string): RateLimitResult };

/** Structural subset of Bun's server used for client IP resolution. */
export interface RateLimitServer {
	requestIP(request: Request): { address: string } | null;
}

interface RequestRateLimitKeyOptions {
	trustProxyHeaders?: boolean;
	knownProjectKeys?: ReadonlySet<string>;
	remoteAddress?: (request: Request) => string | null;
}

export function createFixedWindowRateLimiter(options: {
	windowMs: number;
	limit: number;
	maxBuckets?: number;
	now?: () => number;
}): { check(key: string): RateLimitResult; size(): number } {
	const { windowMs, limit, maxBuckets = 10_000, now = Date.now } = options;
	if (!Number.isFinite(windowMs) || windowMs <= 0) {
		throw new Error("windowMs must be a positive finite number");
	}
	if (!Number.isFinite(limit) || limit <= 0) {
		throw new Error("limit must be a positive finite number");
	}
	if (!Number.isSafeInteger(maxBuckets) || maxBuckets <= 0) {
		throw new Error("maxBuckets must be a positive integer");
	}

	const buckets = new Map<string, RateLimitBucket>();
	let overflowBucket: RateLimitBucket | null = null;
	let activeWindowStart: number | null = null;

	return {
		check(key: string): RateLimitResult {
			const currentTime = now();
			const windowStart = Math.floor(currentTime / windowMs) * windowMs;
			const resetAt = new Date(windowStart + windowMs);
			if (activeWindowStart !== windowStart) {
				buckets.clear();
				overflowBucket = null;
				activeWindowStart = windowStart;
			}

			let bucket = buckets.get(key);

			if (bucket === undefined) {
				if (buckets.size >= maxBuckets) {
					overflowBucket ??= { windowStart, count: 0 };
					bucket = overflowBucket;
				} else {
					bucket = { windowStart, count: 0 };
					buckets.set(key, bucket);
				}
			}

			if (bucket.count >= limit) {
				return { allowed: false, remaining: 0, resetAt };
			}

			bucket.count += 1;
			return {
				allowed: true,
				remaining: Math.max(0, limit - bucket.count),
				resetAt,
			};
		},
		size(): number {
			return buckets.size + (overflowBucket === null ? 0 : 1);
		},
	};
}

interface RateLimitBucket {
	windowStart: number;
	count: number;
}

/** Thrown by derive-phase gates; the shell maps it onto the 429 envelope with limiter headers. */
export class RateLimitExceeded extends Error {
	readonly result: RateLimitResult;

	constructor(result: RateLimitResult) {
		super("Too many requests");
		this.name = "RateLimitExceeded";
		this.result = result;
	}
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
	return {
		"ratelimit-remaining": String(result.remaining),
		"ratelimit-reset": result.resetAt.toISOString(),
	};
}

export function rateLimitResponse(result: RateLimitResult): Response {
	return new Response(
		JSON.stringify({
			success: false,
			error: { code: "RATE_LIMITED", message: "Too many requests" },
		}),
		{ status: 429, headers: { "content-type": "application/json", ...rateLimitHeaders(result) } },
	);
}

export interface RateLimitTarget {
	request: Request;
	/** The routed path; falls back to the URL pathname for callers outside the router. */
	path?: string;
	server?: RateLimitServer | null;
	/** Resolved project instance key (or a known path parameter) when the caller has one. */
	projectKey?: string | null;
}

export function requestIp(
	target: Pick<RateLimitTarget, "request" | "server">,
	options: RequestRateLimitKeyOptions = {},
): string {
	const forwardedFor = target.request.headers.get("x-forwarded-for");
	const firstForwardedIp = forwardedFor?.split(",")[0]?.trim();
	const cloudflareIp = target.request.headers.get("cf-connecting-ip")?.trim();
	if (options.trustProxyHeaders === true && (cloudflareIp || firstForwardedIp)) {
		return cloudflareIp || firstForwardedIp || "unknown";
	}

	try {
		return options.remoteAddress?.(target.request) ?? serverIp(target.server, target.request);
	} catch {
		return "unknown";
	}
}

function serverIp(server: RateLimitServer | null | undefined, request: Request): string {
	return server?.requestIP(request)?.address ?? "unknown";
}

export function requestIpAndPath(
	target: RateLimitTarget,
	options: RequestRateLimitKeyOptions = {},
): string {
	const ip = requestIp(target, options);
	const pathname = normalizedRateLimitPath(targetPath(target));

	return `${ip}:${pathname}`;
}

export function requestProjectIpAndPath(
	target: RateLimitTarget,
	options: RequestRateLimitKeyOptions = {},
): string {
	const ip = requestIp(target, options);
	const pathname = normalizedRateLimitPath(targetPath(target));
	const projectKey = target.projectKey?.trim()
		? `project:${target.projectKey.trim()}`
		: "project:unknown";

	return `${projectKey}:${ip}:${pathname}`;
}

function targetPath(target: RateLimitTarget): string {
	return target.path ?? new URL(target.request.url).pathname;
}

export function normalizedRateLimitPath(pathname: string): string {
	return pathname.replace(
		/^\/v1\/projects\/[^/]+\/webhooks\/(apple|google|stripe)$/,
		"/v1/projects/:projectKey/webhooks/$1",
	);
}

/** Post-authentication guard shape shared with the shell's derive pipeline. */
export interface PostAuthRateLimitGuard {
	matches(path: string): boolean;
	guard(input: {
		request: Request;
		path: string;
		server: { requestIP(request: Request): { address: string } | null } | null;
		projectKey: string;
		set: { headers: Record<string, string> };
	}): void;
}

/**
 * Post-authentication rate-limit guard for path groups; throws `RateLimitExceeded` so the shell
 * renders the 429 envelope, and mirrors limiter headers onto successful responses by default.
 */
export function projectScopedRateLimitGuard(options: {
	limiter: RateLimiter;
	matches(path: string): boolean;
	headers?: "always" | "rejected_only";
	trustProxyHeaders?: boolean;
}): PostAuthRateLimitGuard {
	return {
		matches: options.matches,
		guard(input) {
			const result = options.limiter.check(
				requestProjectIpAndPath(
					{
						request: input.request,
						path: input.path,
						server: input.server,
						projectKey: input.projectKey,
					},
					{ trustProxyHeaders: options.trustProxyHeaders },
				),
			);
			if (!result.allowed) {
				throw new RateLimitExceeded(result);
			}
			if (options.headers !== "rejected_only") {
				Object.assign(input.set.headers, rateLimitHeaders(result));
			}
		},
	};
}
