import { verifyProjectionSignature } from "../../src/projections/http-types";

const projectionPath = "/internal/billing/projections";

export interface ReceivedProjection {
	rawBody: string;
	body: Record<string, unknown>;
	bearerOk: boolean;
	signatureOk: boolean;
	timestamp: string;
}

export interface ProjectionReceiverResponse {
	status: number;
	body?: unknown;
}

export interface LocalProjectionReceiver {
	url: string;
	requests: ReceivedProjection[];
	queueResponses(...responses: ProjectionReceiverResponse[]): void;
	holdNextResponse(): {
		requestStarted: Promise<void>;
		release(status?: number): void;
	};
	waitForRequests(count: number, timeoutMs: number): Promise<void>;
	stop(): void;
}

interface HoldNextResponse {
	requestStarted: Promise<void>;
	markRequestStarted(): void;
	response: Promise<Response>;
	release(status?: number): void;
}

export function createLocalProjectionReceiver({
	secret,
}: {
	secret: string;
}): LocalProjectionReceiver {
	const requests: ReceivedProjection[] = [];
	const queuedResponses: ProjectionReceiverResponse[] = [];
	const waiters: Array<{ count: number; resolve: () => void }> = [];
	let nextHold: HoldNextResponse | null = null;

	const notifyWaiters = () => {
		for (let index = waiters.length - 1; index >= 0; index -= 1) {
			const waiter = waiters[index];
			if (requests.length >= waiter.count) {
				waiters.splice(index, 1);
				waiter.resolve();
			}
		}
	};

	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (req.method !== "POST" || url.pathname !== projectionPath) {
				return Response.json({ success: false, error: "not_found" }, { status: 404 });
			}

			const rawBody = await req.text();
			const timestamp = req.headers.get("x-billing-timestamp") ?? "";
			const signature = req.headers.get("x-billing-signature") ?? "";
			const received: ReceivedProjection = {
				rawBody,
				body: parseJsonObject(rawBody),
				bearerOk: req.headers.get("authorization") === `Bearer ${secret}`,
				signatureOk: verifyProjectionSignature({ secret, body: rawBody, timestamp, signature }),
				timestamp,
			};
			requests.push(received);
			notifyWaiters();

			const hold = nextHold;
			if (hold !== null) {
				nextHold = null;
				hold.markRequestStarted();
				return await hold.response;
			}

			const queued = queuedResponses.shift();
			return jsonResponse(queued?.status ?? 200, queued?.body ?? { success: true });
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		requests,
		queueResponses(...responses) {
			queuedResponses.push(...responses);
		},
		holdNextResponse() {
			if (nextHold !== null) {
				throw new Error("A projection receiver response is already held");
			}
			nextHold = createHold();
			return {
				requestStarted: nextHold.requestStarted,
				release: nextHold.release,
			};
		},
		async waitForRequests(count, timeoutMs) {
			if (requests.length >= count) {
				return;
			}

			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(() => {
					const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
					if (index >= 0) {
						waiters.splice(index, 1);
					}
					reject(new Error(`Timed out waiting for ${count} projection requests`));
				}, timeoutMs);
				waiters.push({
					count,
					resolve: () => {
						clearTimeout(timeout);
						resolve();
					},
				});
			});
		},
		stop() {
			server.stop(true);
		},
	};
}

function createHold(): HoldNextResponse {
	let markRequestStarted!: () => void;
	const requestStarted = new Promise<void>((resolve) => {
		markRequestStarted = resolve;
	});
	let release!: (status?: number) => void;
	const response = new Promise<Response>((resolve) => {
		release = (status = 200) => {
			resolve(jsonResponse(status, { success: status >= 200 && status < 300 }));
		};
	});

	return { requestStarted, markRequestStarted, response, release };
}

function parseJsonObject(rawBody: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(rawBody) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

function jsonResponse(status: number, body: unknown): Response {
	return Response.json(body, { status });
}
