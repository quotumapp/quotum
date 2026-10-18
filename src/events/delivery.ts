import {
	DestinationError,
	type DestinationPostDependencies,
	type DestinationResponse,
	postToDestination,
} from "../shared/safe-http";
import { createWebhookHeaders } from "./signing";

export interface WebhookRequest {
	url: string;
	webhookId: string;
	body: string;
	/** The current secret first; a replaced secret follows while its overlap lasts. */
	secrets: readonly string[];
}

/**
 * The outcome of one attempt. Any 2xx status is a success and the body is ignored; anything else,
 * or no answer, is a failure the worker retries with backoff.
 */
export type WebhookAttemptResult =
	| { ok: true; statusCode: number }
	| { ok: false; statusCode: number | null; error: string; retryAfterSeconds: number | null };

export type WebhookPost = (
	url: string,
	body: string,
	headers: Record<string, string>,
) => Promise<DestinationResponse>;

/** Posts through the destination policy: public HTTPS, or a private network a headless operator approved. */
export function createWebhookPost(deps: DestinationPostDependencies = {}): WebhookPost {
	return async (url, body, headers) =>
		await postToDestination(url, body, headers, { ...deps, oversizedResponse: "truncate" });
}

export async function sendWebhook(
	post: WebhookPost,
	request: WebhookRequest,
	now: () => Date = () => new Date(),
): Promise<WebhookAttemptResult> {
	const headers = {
		"content-type": "application/json",
		"user-agent": "Quotum-Webhooks/1",
		...createWebhookHeaders({
			webhookId: request.webhookId,
			body: request.body,
			secrets: request.secrets,
			now,
		}),
	};
	let response: DestinationResponse;
	try {
		response = await post(request.url, request.body, headers);
	} catch (error) {
		const message =
			error instanceof DestinationError ? error.message : "Webhook delivery failed locally";
		return { ok: false, statusCode: null, error: message, retryAfterSeconds: null };
	}
	if (response.status >= 200 && response.status < 300) {
		return { ok: true, statusCode: response.status };
	}
	return {
		ok: false,
		statusCode: response.status,
		error: `Receiver answered ${response.status}`,
		retryAfterSeconds:
			response.status === 429 || response.status === 503
				? parseRetryAfter(response.retryAfter, now())
				: null,
	};
}

/** Seconds from `now`, from either form `Retry-After` takes: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | undefined, now: Date): number | null {
	if (value === undefined) return null;
	const trimmed = value.trim();
	if (/^\d{1,10}$/.test(trimmed)) return Number(trimmed);
	const date = Date.parse(trimmed);
	if (Number.isNaN(date)) return null;
	return Math.max(0, Math.ceil((date - now.getTime()) / 1000));
}
