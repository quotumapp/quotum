import { type RateLimiter, rateLimitHeaders, requestIpAndPath } from "../http/rate-limit";
import { bodyTooLargeError, isBodyTooLarge, readCappedText } from "../shared/body-limit";

/** Plain JSON response for the setup-only ingresses, which do not use the billing envelope. */
export function rawJsonResponse(status: number, payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Reads a raw ingress body under a byte cap; signature verification needs the exact text. */
export async function readCappedRawBody(
	request: Request,
	maxBytes: number,
): Promise<{ body: string } | { tooLarge: true }> {
	try {
		return { body: await readCappedText(request, maxBytes, bodyTooLargeError) };
	} catch (error) {
		if (isBodyTooLarge(error)) return { tooLarge: true };
		throw error;
	}
}

// Elysia infers hook context per route; a shared gate cannot name it structurally.
// biome-ignore lint/suspicious/noExplicitAny: Elysia hook contexts are route-inferred.
type IpRateLimitGate = (context: any) => Response | undefined;

/**
 * Per-client limiter for unauthenticated ingress, keyed by client IP and the routed pattern, so
 * path values cannot mint buckets. `boundedParams` names parameters whose accepted values form a
 * fixed set: each accepted value keeps its own bucket and anything else shares the pattern's.
 */
export function ipRateLimitGate(
	limiter: RateLimiter,
	options: {
		trustProxyHeaders?: boolean;
		boundedParams?: Readonly<Record<string, readonly string[]>>;
	} = {},
): IpRateLimitGate {
	const boundedParams = options.boundedParams ?? {};
	return (context) => {
		const { request, server, set } = context;
		const route: string = typeof context.route === "string" ? context.route : "unrouted";
		const path = route.replace(/:(\w+)/g, (placeholder, name: string) => {
			const accepted = Object.hasOwn(boundedParams, name) ? boundedParams[name] : undefined;
			const value: unknown = context.params?.[name];
			return typeof value === "string" && accepted?.includes(value) === true ? value : placeholder;
		});
		const result = limiter.check(
			requestIpAndPath({ request, path, server }, { trustProxyHeaders: options.trustProxyHeaders }),
		);
		if (!result.allowed) {
			Object.assign(set.headers, rateLimitHeaders(result));
			return rawJsonResponse(429, {
				success: false,
				error: { code: "RATE_LIMITED", message: "Too many requests" },
			});
		}
		Object.assign(set.headers, rateLimitHeaders(result));
		return undefined;
	};
}
