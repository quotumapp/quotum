import type {
	Breadcrumb,
	BreadcrumbHint,
	DataCollection,
	ErrorEvent,
	EventHint,
	Integration,
	Log,
	SpanJSON,
	TransactionEvent,
} from "@sentry/core";
import type { Elysia } from "elysia";
import { BillingError, isBillingError } from "../billing/errors";
import { isBillingProvider } from "../billing/types";
import type { SentryEnv } from "../env";
import type { BillingLogger } from "./logger";
import {
	describeThrown,
	FILTERED,
	maskPath,
	scrubBreadcrumb,
	scrubEvent,
	scrubLog,
	scrubRecord,
	scrubSpan,
	scrubString,
	stripUndefined,
} from "./sentry-scrub";

type SentryLogLevel = "info" | "warn" | "error";
type SentryBreadcrumbLevel = "info" | "warning" | "error";

export const SENTRY_DATA_COLLECTION: DataCollection = {
	userInfo: false,
	cookies: false,
	httpHeaders: { request: false, response: false },
	httpBodies: [],
	urlQueryParams: false,
	databaseQueryData: false,
	stackFrameVariables: false,
};

export interface SentryInitOptions {
	dsn: string;
	environment: string;
	release?: string;
	enableLogs: boolean;
	tracesSampleRate: number;
	dataCollection: DataCollection;
	maxValueLength: number;
	normalizeDepth: number;
	integrations(defaults: Integration[]): Integration[];
	beforeSend(event: ErrorEvent, hint: EventHint): ErrorEvent | null;
	beforeSendTransaction(event: TransactionEvent, hint: EventHint): TransactionEvent | null;
	beforeSendSpan(span: SpanJSON): SpanJSON;
	beforeBreadcrumb(breadcrumb: Breadcrumb, hint?: BreadcrumbHint): Breadcrumb | null;
	beforeSendLog(log: Log): Log | null;
}

export interface SentryClientLike {
	init(options: SentryInitOptions): void;

	logger?: {
		info(message: string, attributes?: Record<string, unknown>): void;
		warn(message: string, attributes?: Record<string, unknown>): void;
		error(message: string, attributes?: Record<string, unknown>): void;
	};

	addBreadcrumb?(breadcrumb: SentryBreadcrumb): void;

	captureException?(error: unknown): void;

	flush?(timeout?: number): Promise<boolean>;

	withScope?<T>(callback: (scope: SentryScopeLike) => T): T;

	withIsolationScope?<T>(callback: (scope: SentryScopeLike) => T): T;
}

export interface SentryScopeLike {
	setTag(key: string, value: string): unknown;
	setContext(key: string, context: Record<string, unknown> | null): unknown;
}

export interface SentryBreadcrumb {
	category: string;
	message: string;
	level: SentryBreadcrumbLevel;
	data?: Record<string, unknown>;
}

export interface SentryBillingLoggerOptions {
	baseLogger: BillingLogger;
	sentry: SentryClientLike;
	config: SentryEnv;
}

export interface SentryRequestMiddlewareOptions {
	service?: string;
}

export function initializeSentry(sentry: SentryClientLike, config: SentryEnv): void {
	if (config.dsn === null) {
		return;
	}

	sentry.init({
		dsn: config.dsn,
		environment: config.environment,
		...(config.release === null ? {} : { release: config.release }),
		enableLogs: config.enableLogs,
		tracesSampleRate: config.tracesSampleRate,
		dataCollection: SENTRY_DATA_COLLECTION,
		maxValueLength: 1024,
		normalizeDepth: 5,
		integrations: (defaults) => defaults.filter((integration) => integration.name !== "Console"),
		beforeSend: guarded((event) => scrubEvent(event)),
		beforeSendTransaction: guarded((event) => scrubEvent(event)),
		beforeSendSpan: (span) => {
			try {
				return scrubSpan(span);
			} catch {
				try {
					return { ...span, description: FILTERED, data: {} };
				} catch {
					return {
						span_id: "filtered",
						trace_id: "filtered",
						start_timestamp: 0,
						description: FILTERED,
						data: {},
					};
				}
			}
		},
		beforeBreadcrumb: guarded((breadcrumb) => scrubBreadcrumb(breadcrumb)),
		beforeSendLog: (log) => {
			try {
				if (!shouldSendSentryLog(log, config)) {
					return null;
				}
				return scrubLog(log);
			} catch {
				return null;
			}
		},
	});
}

export function createSentryBillingLogger({
	baseLogger,
	sentry,
	config,
}: SentryBillingLoggerOptions): BillingLogger {
	if (config.dsn === null) {
		return baseLogger;
	}

	return {
		info(message, context) {
			callSafely(() => baseLogger.info(message, context));
			recordSentryLog(sentry, config, "info", message, context);
		},
		warn(message, context) {
			callSafely(() => baseLogger.warn(message, context));
			recordSentryLog(sentry, config, "warn", message, context);
		},
		error(message, error, context) {
			callSafely(() => baseLogger.error(message, error, context));
			recordSentryLog(sentry, config, "error", message, context, error);
		},
	};
}

export interface SentryRequestScope {
	/** Elysia hooks that tag the scope `run` opened for the request; install them on the app. */
	plugin(app: Elysia): Elysia;
	/**
	 * Runs one request inside a fresh isolation scope. Elysia hooks cannot wrap the rest of the
	 * request, so the dispatcher that calls `app.fetch` must call this; events captured while the
	 * request runs then carry its `billing.request` tags. Without `run`, the hooks tag nothing,
	 * which keeps request tags from leaking onto the process-wide scope.
	 */
	run<T>(request: Request, dispatch: () => T): T;
}

export function createSentryRequestScope(
	sentry: SentryClientLike,
	{ service = "billing" }: SentryRequestMiddlewareOptions = {},
): SentryRequestScope {
	const scopes = new WeakMap<Request, SentryScopeLike>();
	const contexts = new WeakMap<Request, Record<string, unknown>>();
	const tag = (request: Request, extra: Record<string, unknown>) => {
		const scope = scopes.get(request);
		const previous = contexts.get(request);
		if (scope !== undefined && previous !== undefined) {
			const merged = { ...previous, ...extra };
			contexts.set(request, merged);
			applyScopeContext(scope, "billing.request", merged);
		}
	};

	return {
		plugin: (app) =>
			app
				.onRequest(({ request }) => {
					contexts.set(request, inferRequestContext(request, service));
					tag(request, {});
				})
				.onBeforeHandle(({ request, route }) => {
					tag(request, routeTag(route));
				})
				.onAfterHandle(({ request, set, route }) => {
					tag(request, { ...routeTag(route), status: set.status ?? 200 });
				})
				.onError(({ request, error, route }) => {
					tag(request, { ...routeTag(route), ...normalizeErrorAttributes(error) });
				}),
		run(request, dispatch) {
			const isolate = sentry.withIsolationScope ?? sentry.withScope;
			if (typeof isolate !== "function") return dispatch();
			let dispatched = false;
			try {
				return isolate((scope) => {
					scopes.set(request, scope);
					dispatched = true;
					return dispatch();
				});
			} catch (error) {
				// A Sentry failure before dispatch must not fail the request; handler errors propagate.
				if (dispatched) throw error;
				return dispatch();
			}
		},
	};
}

function routeTag(route: string | undefined): Record<string, unknown> {
	if (route === undefined || route === "") {
		return {};
	}
	return { route };
}

function guarded<T extends (...args: never[]) => unknown>(fn: T): T {
	return ((...args: Parameters<T>) => {
		try {
			return (fn as unknown as (...parameters: Parameters<T>) => unknown)(...args);
		} catch {
			return null;
		}
	}) as T;
}

function recordSentryLog(
	sentry: SentryClientLike,
	config: SentryEnv,
	level: "info" | "warn" | "error",
	message: string,
	context?: Record<string, unknown>,
	error?: unknown,
): void {
	const attributes = createSentryAttributes(message, context, error);
	const category = breadcrumbCategory(attributes);
	const run = (scope: SentryScopeLike) => {
		applyScopeContext(scope, "billing", attributes);
		addBreadcrumbSafely(sentry, {
			category,
			message,
			level: level === "warn" ? "warning" : level,
			data: attributes,
		});
		if (config.enableLogs) {
			writeSentryLog(sentry, level, message, attributes);
		}
		if (level === "error" && shouldCaptureException(error, config)) {
			callSafely(() => sentry.captureException?.(error));
		}
	};

	const withScope = sentry.withScope;
	if (typeof withScope === "function") {
		callSafely(() => withScope((scope) => run(scope)));
		return;
	}

	callSafely(() => {
		addBreadcrumbSafely(sentry, {
			category,
			message,
			level: level === "warn" ? "warning" : level,
			data: attributes,
		});
		if (config.enableLogs) {
			writeSentryLog(sentry, level, message, attributes);
		}
		if (level === "error" && shouldCaptureException(error, config)) {
			sentry.captureException?.(error);
		}
	});
}

function writeSentryLog(
	sentry: SentryClientLike,
	level: "info" | "warn" | "error",
	message: string,
	attributes: Record<string, unknown>,
): void {
	callSafely(() => {
		if (level === "info") {
			sentry.logger?.info(message, attributes);
			return;
		}
		if (level === "warn") {
			sentry.logger?.warn(message, attributes);
			return;
		}
		sentry.logger?.error(message, attributes);
	});
}

function shouldSendSentryLog(log: Log, config: SentryEnv): boolean {
	if (!config.enableLogs) {
		return false;
	}

	if (severity(log.level) >= severity(config.logLevel)) {
		return true;
	}

	return log.level === "info" && isImportantInfoLog(log);
}

function isImportantInfoLog(log: Log): boolean {
	const category = log.attributes?.["billing.category"];
	return category === "worker_run" || category === "webhook" || category === "purchase";
}

function severity(level: string | SentryLogLevel): number {
	if (level === "error") {
		return 3;
	}
	if (level === "warn") {
		return 2;
	}
	if (level === "info") {
		return 1;
	}
	return 0;
}

function shouldCaptureException(error: unknown, config: SentryEnv): boolean {
	if (error === undefined) {
		return false;
	}
	if (config.captureExpectedErrors) {
		return true;
	}
	return !(isBillingError(error) && error.status < 500);
}

function createSentryAttributes(
	message: string,
	context?: Record<string, unknown>,
	error?: unknown,
): Record<string, unknown> {
	return stripUndefined({
		"billing.category": classifyLogCategory(message, context),
		...scrubRecord(context),
		...normalizeErrorAttributes(error),
	});
}

function classifyLogCategory(message: string, context?: Record<string, unknown>): string {
	const worker = context?.worker;
	if (typeof worker === "string") {
		return message.endsWith("run completed") ? "worker_run" : "worker";
	}

	const provider = context?.provider;
	if (isBillingProvider(provider)) {
		return message.toLowerCase().includes("webhook") ? "webhook" : "purchase";
	}

	return "billing";
}

function normalizeErrorAttributes(error: unknown): Record<string, unknown> {
	if (error === undefined) {
		return {};
	}

	if (error instanceof BillingError) {
		return {
			"error.name": error.name,
			"error.message": scrubString(error.message),
			"error.code": error.code,
			"error.status": error.status,
		};
	}

	if (error instanceof Error) {
		const attributes: Record<string, unknown> = {
			"error.name": error.name || "Error",
			"error.message": scrubString(error.message),
		};
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" || typeof code === "number") {
			attributes["error.code"] = code;
		}
		return attributes;
	}

	return {
		"error.name": "Error",
		"error.message": describeThrown(error),
	};
}

function applyScopeContext(
	scope: SentryScopeLike,
	contextName: string,
	context: Record<string, unknown>,
): void {
	const sanitized = scrubRecord(context);
	for (const [key, value] of Object.entries(createTags(sanitized))) {
		callSafely(() => scope.setTag(key, value));
	}
	callSafely(() => scope.setContext(contextName, sanitized));
}

function createTags(context: Record<string, unknown>): Record<string, string> {
	const tags = stripUndefined({
		service: stringTag(context.service),
		method: stringTag(context.method),
		route: stringTag(context.route),
		provider: stringTag(context.provider),
		project_key: stringTag(context.projectKey),
		billing_error_code: stringTag(context.code ?? context["error.code"]),
		worker: stringTag(context.worker),
	});
	return tags as Record<string, string>;
}

function stringTag(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function inferRequestContext(request: Request, service: string): Record<string, unknown> {
	const url = new URL(request.url);
	const path = url.pathname;
	const route = maskPath(path);
	const projectKey = inferProjectKey(path);
	const provider = inferProvider(path);

	return stripUndefined({
		service,
		method: request.method,
		route,
		projectKey,
		provider,
	});
}

function inferProjectKey(path: string): string | undefined {
	const match = path.match(/^\/v1\/projects\/([^/]+)\//);
	return match?.[1];
}

function inferProvider(path: string): string | undefined {
	const match = path.match(/\/(?:webhooks)\/(apple|google|stripe)$/);
	return match?.[1];
}

function breadcrumbCategory(attributes: Record<string, unknown>): string {
	const category = attributes["billing.category"];
	return typeof category === "string" ? `billing.${category}` : "billing";
}

function addBreadcrumbSafely(sentry: SentryClientLike, breadcrumb: SentryBreadcrumb): void {
	callSafely(() => sentry.addBreadcrumb?.(breadcrumb));
}

function callSafely(callback: () => void): void {
	try {
		callback();
	} catch {
		// Observability must not alter billing behavior.
	}
}
