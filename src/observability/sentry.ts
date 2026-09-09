import type { Integration, Log } from "@sentry/core";
import type { Context, MiddlewareHandler } from "hono";
import { BillingError, isBillingError } from "../billing/errors";
import type { SentryEnv } from "../env";
import type { BillingLogger } from "./logger";
import { stringifyUnknown } from "./stringify-unknown";

type SentryLogLevel = "info" | "warn" | "error";
type SentryBreadcrumbLevel = "info" | "warning" | "error";

export interface SentryInitOptions {
	dsn: string;
	enableLogs: boolean;
	tracesSampleRate: number;
	beforeSendLog(log: Log): Log | null;
	integrations?: Integration[];
}

export interface SentryClientLike {
	init(options: SentryInitOptions): void;

	honoIntegration?(): unknown;

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

	const honoIntegration = sentry.honoIntegration;
	const integrations =
		typeof honoIntegration === "function" ? [honoIntegration() as Integration] : undefined;
	sentry.init({
		dsn: config.dsn,
		enableLogs: config.enableLogs,
		tracesSampleRate: config.tracesSampleRate,
		beforeSendLog: (log) => (shouldSendSentryLog(log, config) ? log : null),
		...(integrations === undefined ? {} : { integrations }),
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

export function createSentryRequestMiddleware(
	sentry: SentryClientLike,
	{ service = "billing" }: SentryRequestMiddlewareOptions = {},
): MiddlewareHandler {
	return async (c, next) => {
		const run = async (scope: SentryScopeLike) => {
			const requestContext = inferRequestContext(c, service);
			applyScopeContext(scope, "billing.request", requestContext);
			await next();
			const completedContext = { ...requestContext, status: c.res.status };
			applyScopeContext(scope, "billing.request", completedContext);
		};

		const withIsolationScope = sentry.withIsolationScope;
		if (typeof withIsolationScope === "function") {
			return withIsolationScope(run);
		}

		const withScope = sentry.withScope;
		if (typeof withScope === "function") {
			return withScope(run);
		}

		await next();
	};
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
		...sanitizeRecord(context),
		...normalizeErrorAttributes(error),
	});
}

function classifyLogCategory(message: string, context?: Record<string, unknown>): string {
	const worker = context?.worker;
	if (typeof worker === "string") {
		return message.endsWith("run completed") ? "worker_run" : "worker";
	}

	const provider = context?.provider;
	if (provider === "apple" || provider === "google" || provider === "stripe") {
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
			"error.message": sanitizeString(error.message),
			"error.code": error.code,
			"error.status": error.status,
		};
	}

	if (error instanceof Error) {
		return {
			"error.name": error.name || "Error",
			"error.message": sanitizeString(error.message),
		};
	}

	return {
		"error.name": "Error",
		"error.message": sanitizeString(stringifyUnknown(error)),
	};
}

function applyScopeContext(
	scope: SentryScopeLike,
	contextName: string,
	context: Record<string, unknown>,
): void {
	const sanitized = sanitizeRecord(context);
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

function inferRequestContext(c: Context, service: string): Record<string, unknown> {
	const path = new URL(c.req.url).pathname;
	const route = parameterizeBillingPath(path);
	const projectKey = c.req.param("projectKey") ?? inferProjectKey(path);
	const provider = inferProvider(path);

	return stripUndefined({
		service,
		method: c.req.method,
		route,
		projectKey,
		provider,
	});
}

function parameterizeBillingPath(path: string): string {
	const projectWebhook = path.match(/^\/v1\/projects\/[^/]+\/webhooks\/(apple|google|stripe)$/);
	if (projectWebhook !== null) {
		return `/v1/projects/:projectKey/webhooks/${projectWebhook[1]}`;
	}

	if (/^\/v1\/webhooks\/(apple|google|stripe)$/.test(path)) {
		return path;
	}

	if (path === "/v1/purchases/verify") {
		return path;
	}

	return path
		.replace(/^\/v1\/billing-accounts\/[^/]+/, "/v1/billing-accounts/:billingAccountId")
		.replace(/^\/v1\/admin\/customers\/[^/]+/, "/v1/admin/customers/:customerId");
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

function sanitizeRecord(record?: Record<string, unknown>): Record<string, unknown> {
	if (record === undefined) {
		return {};
	}
	const seen = new WeakSet<object>();
	const sanitized: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(record)) {
		if (isSensitiveKey(key)) {
			continue;
		}

		sanitized[key] = sanitizeValue(value, seen);
	}

	return stripUndefined(sanitized);
}

function sanitizeValue(value: unknown, seen: WeakSet<object>): unknown {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value === "string") {
		return sanitizeString(value);
	}
	if (typeof value !== "object" || value === null) {
		return value;
	}
	if (seen.has(value)) {
		return "[Circular]";
	}
	seen.add(value);

	if (Array.isArray(value)) {
		return value.map((entry) => sanitizeValue(entry, seen));
	}

	const output: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!isSensitiveKey(key)) {
			output[key] = sanitizeValue(entry, seen);
		}
	}
	return stripUndefined(output);
}

function isSensitiveKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	return (
		normalized === "authorization" ||
		normalized === "authorizationheader" ||
		normalized === "signatureheader" ||
		normalized === "stripesignature" ||
		normalized === "signedpayload" ||
		normalized === "purchasetoken" ||
		normalized === "appaccounttoken" ||
		normalized === "obfuscatedaccountid" ||
		normalized === "rawbody" ||
		normalized === "rawpayload" ||
		normalized === "rawstate" ||
		normalized === "body" ||
		normalized === "apikey" ||
		normalized === "billingapikey" ||
		normalized === "billingaccountid" ||
		normalized === "customerid" ||
		normalized === "providercustomerid" ||
		normalized === "externalcustomerid" ||
		normalized === "transactionid" ||
		normalized === "originaltransactionid" ||
		normalized === "externaleventid" ||
		normalized === "eventid" ||
		normalized === "storeeventid" ||
		normalized === "sessionid" ||
		normalized === "paymentintentid" ||
		normalized === "subscriptionid" ||
		normalized === "idempotencykey" ||
		normalized.includes("password") ||
		normalized.includes("secret") ||
		normalized.includes("credential")
	);
}

function sanitizeString(value: string): string {
	return value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [Filtered]");
}

function stripUndefined<T extends Record<string, unknown>>(record: T): T {
	for (const key of Object.keys(record)) {
		if (record[key] === undefined) {
			delete record[key];
		}
	}
	return record;
}

function callSafely(callback: () => void): void {
	try {
		callback();
	} catch {
		// Observability must not alter billing behavior.
	}
}
