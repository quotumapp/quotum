import type { Breadcrumb, ErrorEvent, Log, SpanJSON, TransactionEvent } from "@sentry/core";
import { stringifyUnknown } from "./stringify-unknown";

export const FILTERED = "[Filtered]";

export interface ScrubOptions {
	maxDepth?: number;
	maxKeys?: number;
	maxItems?: number;
	maxString?: number;
}

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_KEYS = 50;
const DEFAULT_MAX_ITEMS = 50;
const DEFAULT_MAX_STRING = 1024;

const BEARER_BASIC_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const PREFIXED_ID_PATTERN =
	/\b(sk|rk|pk|whsec|sqpk|pqpk|cus|sub|cs|pi|in|ch|seti|pm|acct|promo|evt|req|txn|price|prod|si)_((?:live_|test_)?[A-Za-z0-9]{8,})\b/g;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const LONG_DIGITS_PATTERN = /(?<![A-Za-z0-9_])\d{14,}(?![A-Za-z0-9_])/g;
const OPAQUE_TOKEN_PATTERN = /[A-Za-z0-9_\-+=]{32,}/g;
const UUID_PATTERN =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const KEEP_SEGMENT_PATTERN = /^(?:[a-z]+(?:-[a-z]+)*|v\d+)$/;

const COLLECTIONS = new Set([
	"billing-accounts",
	"by-billing-account",
	"customers",
	"contracts",
	"auto-topups",
	"entities",
	"license-assignments",
	"promotion-redemptions",
	"checkout-sessions",
	"subscriptions",
	"events",
	"reservations",
	"store-events",
	"projection-jobs",
	"promotions",
	"codes",
	"provisioning",
	"invitations",
	"members",
	"step-up",
	"projects",
	"connections",
]);

const SENSITIVE_EXACT = new Set([
	"authorization",
	"authorizationheader",
	"signatureheader",
	"stripesignature",
	"signedpayload",
	"purchasetoken",
	"appaccounttoken",
	"obfuscatedaccountid",
	"rawbody",
	"rawpayload",
	"rawstate",
	"body",
	"apikey",
	"billingapikey",
	"billingaccountid",
	"customerid",
	"providercustomerid",
	"externalcustomerid",
	"transactionid",
	"originaltransactionid",
	"externaleventid",
	"eventid",
	"storeeventid",
	"sessionid",
	"paymentintentid",
	"subscriptionid",
	"idempotencykey",
	"cookie",
	"setcookie",
	"xforwardedfor",
	"cfconnectingip",
	"xrealip",
	"forwarded",
	"ip",
	"ipaddress",
	"clientip",
	"remoteaddr",
	"phone",
	"address",
	"firstname",
	"lastname",
	"fullname",
	"displayname",
	"user",
	"userid",
	"username",
	"memberid",
	"principalid",
	"actor",
	"otp",
	"csrf",
	"jwt",
	"dsn",
	"postgresuri",
	"connectionstring",
]);

const SENSITIVE_SUBSTRINGS = [
	"token",
	"password",
	"secret",
	"credential",
	"signature",
	"authorization",
	"cookie",
	"session",
	"serviceaccount",
	"apikey",
	"operatorkey",
	"privatekey",
	"secretkey",
	"signingkey",
	"encryptionkey",
	"idempotencykey",
	"email",
];

const SENSITIVE_PREFIXES = ["xquotum", "xbilling"];

const URL_KEY_EXACT = new Set([
	"url",
	"href",
	"uri",
	"path",
	"pathname",
	"endpoint",
	"route",
	"urlfull",
	"urlpath",
	"httpurl",
	"httptarget",
	"httproute",
]);

const URL_KEY_SUFFIXES = ["url", "uri", "href", "path", "endpoint"];

const SPAN_DATA_DROP_PREFIXES = [
	"http.request.header.",
	"http.response.header.",
	"url.path.parameter.",
	"db.query.parameter.",
];

const SPAN_DATA_DROP_EXACT = new Set([
	"db.statement",
	"db.query.text",
	"url.query",
	"url.fragment",
	"http.query",
	"http.fragment",
	"user_agent.original",
	"client.address",
	"net.peer.ip",
	"http.request.body.data",
]);

const BREADCRUMB_DATA_DROP = new Set([
	"arguments",
	"http.query",
	"http.fragment",
	"query",
	"fragment",
	"body",
]);

const KEEP_CONTEXTS = new Set(["app", "device", "os", "runtime", "culture", "cloud_resource"]);

export function scrubString(value: string, maxLength?: number): string {
	let output = value.replace(BEARER_BASIC_PATTERN, "$1 [Filtered]");
	output = output.replace(URL_USERINFO_PATTERN, "$1[Filtered]@");
	output = output.replace(JWT_PATTERN, "[jwt]");
	output = output.replace(PREFIXED_ID_PATTERN, (match, prefix: string, suffix: string) => {
		if (/[0-9A-Z]/.test(suffix)) {
			return `${prefix}_[Filtered]`;
		}
		return match;
	});
	output = output.replace(EMAIL_PATTERN, "[email]");
	output = output.replace(IPV4_PATTERN, "[ip]");
	output = output.replace(LONG_DIGITS_PATTERN, "[number]");
	output = output.replace(OPAQUE_TOKEN_PATTERN, (match) => {
		if (UUID_PATTERN.test(match)) {
			return match;
		}
		if (!/[0-9A-Z]/.test(match)) {
			return match;
		}
		return FILTERED;
	});
	if (maxLength !== undefined && output.length > maxLength) {
		return `${output.slice(0, Math.max(0, maxLength - 1))}…`;
	}
	return output;
}

export function maskPath(pathname: string): string {
	const segments = pathname.split("/");
	return segments
		.map((segment, index) => {
			if (segment === "" || segment.startsWith(":") || segment === "*") {
				return segment;
			}
			if (!KEEP_SEGMENT_PATTERN.test(segment)) {
				return ":id";
			}
			if (COLLECTIONS.has(segment)) {
				return segment;
			}
			const previous = segments[index - 1] ?? "";
			if (COLLECTIONS.has(previous)) {
				return ":id";
			}
			if (index >= 2 && segments[index - 2] === "operations") {
				return ":id";
			}
			return segment;
		})
		.join("/");
}

export function scrubUrl(value: string): string {
	try {
		const parsed = new URL(value);
		return `${parsed.origin}${maskPath(parsed.pathname)}`;
	} catch {
		// Not absolute; fall through to relative handling.
	}
	if (value.startsWith("/")) {
		const pathname = value.split(/[?#]/)[0] ?? "/";
		return maskPath(pathname);
	}
	return scrubString(value);
}

export function isSensitiveKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (normalized === "") {
		return false;
	}
	if (SENSITIVE_EXACT.has(normalized)) {
		return true;
	}
	for (const substring of SENSITIVE_SUBSTRINGS) {
		if (normalized.includes(substring)) {
			return true;
		}
	}
	for (const prefix of SENSITIVE_PREFIXES) {
		if (normalized.startsWith(prefix)) {
			return true;
		}
	}
	return false;
}

export function isUrlKey(key: string): boolean {
	const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
	if (normalized === "") {
		return false;
	}
	if (URL_KEY_EXACT.has(normalized)) {
		return true;
	}
	for (const suffix of URL_KEY_SUFFIXES) {
		if (normalized.endsWith(suffix)) {
			return true;
		}
	}
	return false;
}

export function scrubValue(value: unknown, options?: ScrubOptions): unknown {
	return scrubValueInner(value, resolveOptions(options), 0, new WeakSet());
}

export function scrubRecord(
	record: Record<string, unknown> | undefined,
	options?: ScrubOptions,
): Record<string, unknown> {
	if (record === undefined) {
		return {};
	}
	const scrubbed = scrubValueInner(record, resolveOptions(options), 0, new WeakSet());
	if (typeof scrubbed === "object" && scrubbed !== null && !Array.isArray(scrubbed)) {
		return stripUndefined(scrubbed as Record<string, unknown>);
	}
	return {};
}

export function describeThrown(value: unknown, maxLength = DEFAULT_MAX_STRING): string {
	if (value instanceof Error) {
		return scrubString(value.message, maxLength);
	}
	return scrubString(stringifyUnknown(value), maxLength);
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
	if (breadcrumb.category === "console") {
		return null;
	}
	const output: Breadcrumb = { ...breadcrumb };
	if (typeof output.message === "string") {
		output.message = scrubString(output.message);
	}
	if (output.data !== undefined && output.data !== null && typeof output.data === "object") {
		const data: Record<string, unknown> = { ...(output.data as Record<string, unknown>) };
		for (const key of BREADCRUMB_DATA_DROP) {
			delete data[key];
		}
		output.data = scrubRecord(data);
	}
	return output;
}

export function scrubSpanData(data: Record<string, unknown> | undefined): Record<string, unknown> {
	if (data === undefined) {
		return {};
	}
	const filtered: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		if (SPAN_DATA_DROP_EXACT.has(key)) {
			continue;
		}
		if (SPAN_DATA_DROP_PREFIXES.some((prefix) => key.startsWith(prefix))) {
			continue;
		}
		filtered[key] = value;
	}
	return scrubRecord(filtered);
}

export function scrubSpan(span: SpanJSON): SpanJSON {
	const output: SpanJSON = { ...span };
	if (typeof output.description === "string") {
		const match = /^([A-Z]+) (https?:\/\/\S+|\/\S*)$/.exec(output.description);
		if (match?.[1] !== undefined && match?.[2] !== undefined) {
			output.description = `${match[1]} ${scrubUrl(match[2])}`;
		} else {
			output.description = scrubString(output.description);
		}
	}
	output.data = scrubSpanData(
		output.data as Record<string, unknown> | undefined,
	) as SpanJSON["data"];
	return output;
}

export function scrubEvent<E extends ErrorEvent | TransactionEvent>(event: E): E {
	if (typeof event.message === "string") {
		event.message = scrubString(event.message);
	}
	if (event.logentry !== undefined && typeof event.logentry.message === "string") {
		event.logentry.message = scrubString(event.logentry.message);
	}
	const values = event.exception?.values;
	if (Array.isArray(values)) {
		for (const value of values) {
			if (typeof value.value === "string") {
				value.value = scrubString(value.value, DEFAULT_MAX_STRING);
			}
			const frames = value.stacktrace?.frames;
			if (Array.isArray(frames)) {
				for (const frame of frames) {
					const record = frame as unknown as Record<string, unknown>;
					delete record.vars;
				}
			}
		}
	}
	if (event.request !== undefined) {
		const method = event.request.method;
		const url = event.request.url;
		const scrubbed: { method?: string; url?: string } = {};
		if (typeof method === "string") {
			scrubbed.method = method;
		}
		if (typeof url === "string") {
			scrubbed.url = scrubUrl(url);
		}
		event.request = stripUndefined(scrubbed) as E["request"];
	}
	delete event.user;
	if (typeof event.transaction === "string") {
		const match = /^([A-Z]+) (.+)$/.exec(event.transaction);
		if (match?.[1] !== undefined && match?.[2] !== undefined) {
			event.transaction = `${match[1]} ${scrubUrl(match[2])}`;
		} else {
			event.transaction = scrubString(event.transaction);
		}
	}
	if (Array.isArray(event.breadcrumbs)) {
		const scrubbed: Breadcrumb[] = [];
		for (const breadcrumb of event.breadcrumbs) {
			const cleaned = scrubBreadcrumb(breadcrumb);
			if (cleaned !== null) {
				scrubbed.push(cleaned);
			}
		}
		event.breadcrumbs = scrubbed;
	}
	if (event.contexts !== undefined) {
		const trace = (event.contexts as Record<string, unknown>).trace as
			| Record<string, unknown>
			| undefined;
		if (trace !== undefined && typeof trace === "object" && trace !== null) {
			const data = trace.data as Record<string, unknown> | undefined;
			if (data !== undefined && typeof data === "object" && data !== null) {
				trace.data = scrubSpanData(data);
			}
		}
		const response = (event.contexts as Record<string, unknown>).response as
			| Record<string, unknown>
			| undefined;
		if (response !== undefined && typeof response === "object" && response !== null) {
			const statusCode = response.status_code;
			(event.contexts as Record<string, unknown>).response =
				typeof statusCode === "number" ? { status_code: statusCode } : {};
		}
		for (const [name, context] of Object.entries(event.contexts)) {
			if (name === "trace" || name === "response") {
				continue;
			}
			if (KEEP_CONTEXTS.has(name)) {
				continue;
			}
			if (context !== undefined && typeof context === "object" && context !== null) {
				(event.contexts as Record<string, unknown>)[name] = scrubRecord(
					context as Record<string, unknown>,
				);
			}
		}
	}
	if (event.extra !== undefined && typeof event.extra === "object" && event.extra !== null) {
		event.extra = scrubRecord(event.extra as Record<string, unknown>);
	}
	if (event.tags !== undefined) {
		for (const [key, value] of Object.entries(event.tags)) {
			if (typeof value === "string") {
				(event.tags as Record<string, unknown>)[key] = scrubString(value);
			}
		}
	}
	if (Array.isArray(event.spans)) {
		event.spans = event.spans.map((span) => scrubSpan(span));
	}
	return event;
}

export function scrubLog(log: Log): Log {
	const output: Log = { ...log, message: scrubString(log.message) as Log["message"] };
	if (output.attributes !== undefined) {
		const attributes: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(output.attributes)) {
			if (key.startsWith("user.")) {
				continue;
			}
			attributes[key] = value;
		}
		output.attributes = scrubRecord(attributes);
	}
	return output;
}

export function stripUndefined<T extends Record<string, unknown>>(record: T): T {
	for (const key of Object.keys(record)) {
		if (record[key] === undefined) {
			delete record[key];
		}
	}
	return record;
}

function resolveOptions(options?: ScrubOptions): Required<ScrubOptions> {
	return {
		maxDepth: options?.maxDepth ?? DEFAULT_MAX_DEPTH,
		maxKeys: options?.maxKeys ?? DEFAULT_MAX_KEYS,
		maxItems: options?.maxItems ?? DEFAULT_MAX_ITEMS,
		maxString: options?.maxString ?? DEFAULT_MAX_STRING,
	};
}

function scrubValueInner(
	value: unknown,
	options: Required<ScrubOptions>,
	depth: number,
	seen: WeakSet<object>,
): unknown {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value === "string") {
		return scrubString(value, options.maxString);
	}
	if (typeof value !== "object" || value === null) {
		return value;
	}
	if (seen.has(value)) {
		return "[Circular]";
	}
	if (depth >= options.maxDepth) {
		return "[Truncated]";
	}
	seen.add(value);
	if (Array.isArray(value)) {
		return value
			.slice(0, options.maxItems)
			.map((entry) => scrubValueInner(entry, options, depth + 1, seen));
	}
	const output: Record<string, unknown> = {};
	let kept = 0;
	for (const [key, entry] of Object.entries(value)) {
		if (kept >= options.maxKeys) {
			break;
		}
		if (isSensitiveKey(key)) {
			continue;
		}
		if (isUrlKey(key) && typeof entry === "string") {
			output[key] = scrubUrl(entry);
		} else {
			output[key] = scrubValueInner(entry, options, depth + 1, seen);
		}
		kept += 1;
	}
	return stripUndefined(output);
}
