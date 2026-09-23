import { BillingApiError } from "../sdk/index";
import { ContractUnavailableError } from "./contracts";
import { McpRequestBlockedError } from "./guarded-fetch";

export interface ToolResult {
	[key: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export type DiagnosticLog = (line: string, error?: unknown) => void;

/** Large enough for a 25-row page, small enough to leave an agent's context usable. */
export const maxResultBytes = 100_000;

const hints: Readonly<Record<string, string>> = {
	RATE_LIMITED: "Do not retry before rateLimitResetAt.",
	STRIPE_NOT_CONFIGURED:
		"This project instance has no Stripe connection, so there is no purchasable catalog to read.",
	OPERATION_NOT_FOUND:
		"No operation with this id and kind was recorded for the account. Check the idempotency key and the operation kind.",
	OPERATION_RESULT_EXPIRED:
		"The operation ran, but its outcome is past the retention window and can no longer be read.",
	BILLING_ACCOUNT_NOT_FOUND: "Use find_customer to look the account up by another identifier.",
};

let activeRequests = 0;
const idleWaiters: Array<() => void> = [];

/** Resolves once no request is being answered, so shutdown does not drop a response in flight. */
export function whenIdle(): Promise<void> {
	return activeRequests === 0 ? Promise.resolve() : new Promise((done) => idleWaiters.push(done));
}

/** Counts a tool call or resource read as in flight until it settles. */
export async function trackRequest<T>(work: () => Promise<T>): Promise<T> {
	activeRequests += 1;
	try {
		return await work();
	} finally {
		activeRequests -= 1;
		if (activeRequests === 0) for (const done of idleWaiters.splice(0)) done();
	}
}

/**
 * Runs a tool body and turns every outcome into a tool result. The MCP SDK would otherwise return a
 * thrown error's raw message to the model, so nothing may escape this function.
 */
export async function runTool(
	body: () => Promise<unknown>,
	log: DiagnosticLog,
): Promise<ToolResult> {
	return trackRequest(async () => {
		try {
			const text = JSON.stringify(await body());
			if (Buffer.byteLength(text, "utf8") > maxResultBytes) {
				return errorResult({
					code: "RESULT_TOO_LARGE",
					message: "The result is too large to return. Lower `limit` or narrow the filters.",
				});
			}
			return { content: [{ type: "text", text }] };
		} catch (error) {
			return errorResult(describeError(error, log));
		}
	});
}

export interface ToolErrorBody {
	code: string;
	message: string;
	status?: number;
	rateLimitResetAt?: string;
	details?: Record<string, unknown>;
	hint?: string;
}

/** The whitelisted view of a failure; also used for one section of a multi-read tool. */
export function describeError(error: unknown, log: DiagnosticLog): ToolErrorBody {
	if (error instanceof BillingApiError) {
		return {
			code: error.code,
			status: error.status,
			message: error.message,
			...(error.rateLimitResetAt === undefined ? {} : { rateLimitResetAt: error.rateLimitResetAt }),
			...(error.details === undefined ? {} : { details: error.details }),
			...(hints[error.code] === undefined ? {} : { hint: hints[error.code] }),
		};
	}
	if (error instanceof McpRequestBlockedError) {
		return { code: "MCP_REQUEST_BLOCKED", message: error.message };
	}
	if (error instanceof ContractUnavailableError) {
		log(
			`contract unavailable: ${error.cause instanceof Error ? error.cause.message : "unknown"}`,
			error,
		);
		return { code: "CONTRACT_UNAVAILABLE", message: error.message };
	}
	log(
		`tool failure: ${error instanceof Error ? `${error.name}: ${error.message}` : "unknown"}`,
		error,
	);
	return {
		code: "BILLING_API_UNAVAILABLE",
		message: "The billing API could not be reached or returned an unreadable response.",
	};
}

function errorResult(error: ToolErrorBody): ToolResult {
	let text = JSON.stringify({ error });
	// An upstream error envelope is bounded only by the response cap, which is far above this.
	if (Buffer.byteLength(text, "utf8") > maxResultBytes) {
		text = JSON.stringify({
			error: {
				code: "RESULT_TOO_LARGE",
				message: "The billing API returned an error too large to show.",
				...(error.status === undefined ? {} : { status: error.status }),
			},
		});
	}
	return { content: [{ type: "text", text }], isError: true };
}

/** Drops the named keys at any depth. Used to keep merchant-supplied free-form data out by default. */
export function omitKeys(value: unknown, keys: ReadonlySet<string>): unknown {
	if (Array.isArray(value)) return value.map((item) => omitKeys(item, keys));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value)
			.filter(([key]) => !keys.has(key))
			.map(([key, item]) => [key, omitKeys(item, keys)]),
	);
}
