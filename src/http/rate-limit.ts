import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";

export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	resetAt: Date;
}

interface RateLimitBucket {
	windowStart: number;
	count: number;
}

interface RequestRateLimitKeyOptions {
	trustProxyHeaders?: boolean;
	knownProjectKeys?: ReadonlySet<string>;
	remoteAddress?: (c: Context) => string | null;
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

export function rateLimitMiddleware(options: {
	limiter: { check(key: string): RateLimitResult };
	key: (c: Context) => string;
}): MiddlewareHandler {
	return async (c, next) => {
		const result = options.limiter.check(options.key(c));
		c.header("ratelimit-remaining", String(result.remaining));
		c.header("ratelimit-reset", result.resetAt.toISOString());

		if (!result.allowed) {
			return c.json(
				{
					success: false,
					error: { code: "RATE_LIMITED", message: "Too many requests" },
				},
				429,
			);
		}

		await next();
	};
}

export function requestIpAndPath(c: Context, options: RequestRateLimitKeyOptions = {}): string {
	const ip = requestClientIp(c, options);
	const pathname = normalizedRateLimitPath(new URL(c.req.url).pathname);

	return `${ip}:${pathname}`;
}

export function requestProjectIpAndPath(
	c: Context,
	options: RequestRateLimitKeyOptions = {},
): string {
	const ip = requestClientIp(c, options);
	const pathname = normalizedRateLimitPath(new URL(c.req.url).pathname);
	const projectKey = rateLimitProjectKey(c, pathname, options.knownProjectKeys);

	return `${projectKey}:${ip}:${pathname}`;
}

function requestClientIp(c: Context, options: RequestRateLimitKeyOptions): string {
	const forwardedFor = c.req.header("x-forwarded-for");
	const firstForwardedIp = forwardedFor?.split(",")[0]?.trim();
	const cloudflareIp = c.req.header("cf-connecting-ip")?.trim();
	if (options.trustProxyHeaders === true && (cloudflareIp || firstForwardedIp)) {
		return cloudflareIp || firstForwardedIp || "unknown";
	}

	try {
		return options.remoteAddress?.(c) ?? getConnInfo(c).remote.address ?? "unknown";
	} catch {
		return "unknown";
	}
}

function rateLimitProjectKey(
	c: Context,
	pathname: string,
	knownProjectKeys?: ReadonlySet<string>,
): string {
	const contextProject = c.get("project") as { projectKey?: unknown } | undefined;
	if (typeof contextProject?.projectKey === "string" && contextProject.projectKey.trim() !== "") {
		return `project:${contextProject.projectKey}`;
	}

	const paramProjectKey = c.req.param("projectKey")?.trim();
	if (
		paramProjectKey !== undefined &&
		paramProjectKey !== "" &&
		(knownProjectKeys === undefined || knownProjectKeys.has(paramProjectKey))
	) {
		return `project:${paramProjectKey}`;
	}

	if (/^\/v1\/webhooks\/(?:apple|google|stripe)$/.test(pathname)) {
		return "project:voysee";
	}

	return "project:unknown";
}

function normalizedRateLimitPath(pathname: string): string {
	return pathname.replace(
		/^\/v1\/projects\/[^/]+\/webhooks\/(apple|google|stripe)$/,
		"/v1/projects/:projectKey/webhooks/$1",
	);
}
