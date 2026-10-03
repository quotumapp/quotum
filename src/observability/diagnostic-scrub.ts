import {
	DATABASE_ERROR_MESSAGE,
	databaseDiagnostic,
	isDatabaseMessage,
} from "./database-diagnostics";

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
export const DEFAULT_MAX_STRING = 1024;

const BEARER_BASIC_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
// Project API keys are a prefix plus base64url, so the secret itself can contain `-` and `_`.
const PROJECT_API_KEY_PATTERN = /(?<![A-Za-z0-9])([sp]q[pr]k)_[A-Za-z0-9_-]+/g;
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;
const PREFIXED_ID_PATTERN =
	/\b(sk|rk|pk|whsec|cus|sub|cs|pi|in|ch|seti|pm|acct|promo|evt|req|txn|price|prod|si)_((?:live_|test_)?[A-Za-z0-9]{8,})\b/g;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4_PATTERN = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const LONG_DIGITS_PATTERN = /(?<![A-Za-z0-9_])\d{14,}(?![A-Za-z0-9_])/g;
const OPAQUE_TOKEN_PATTERN = /[A-Za-z0-9_\-+=]{32,}/g;
const UUID_PATTERN =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Error codes, env var names and camelCase identifiers are long but never secrets.
const IDENTIFIER_PATTERN =
	/^(?:[A-Z][A-Z0-9]*(?:_[A-Z][A-Z0-9]*)+|[A-Za-z][a-z]{2,}(?:[A-Z][a-z]{2,})+)$/;
const KEEP_SEGMENT_PATTERN = /^(?:[a-z]+(?:-[a-z]+)*|v\d+)$/;

/** Path segments followed by one identifier, e.g. `billing-accounts/:billingAccountId`. */
const COLLECTIONS = new Set([
	"administrative-debits",
	"balances",
	"billing-accounts",
	"by-billing-account",
	"checkout-sessions",
	"changes",
	"codes",
	"connections",
	"customers",
	"entities",
	"events",
	"invitations",
	"license-assignments",
	"licenses",
	"members",
	"payment-setup-sessions",
	"projection-jobs",
	"projects",
	"apple-offers",
	"promotion-redemptions",
	"promotions",
	"provisioning",
	"reservations",
	"receipts",
	"step-up",
	"store-events",
	"subscriptions",
	"trials",
]);

/** Path segments followed by two identifiers, e.g. `contracts/:billingAccountId/:contractId`. */
const PAIR_COLLECTIONS = new Set(["auto-topups", "contracts", "operator-grants"]);

/** Static route segments, including enum values, that sit where a collection takes an id. */
const STATIC_AFTER_COLLECTION = new Set([
	"accept",
	"apple",
	"google",
	"list",
	"preview",
	"projection",
	"publish",
	"request",
	"revoke",
	"run",
	"search",
	"stripe",
]);

const SENSITIVE_EXACT = new Set([
	"query",
	"sql",
	"statement",
	"params",
	"parameters",
	"detail",
	"hint",
	"internalquery",
	"dbstatement",
	"dbquerytext",
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

export function scrubString(value: string, maxLength?: number): string {
	if (isDatabaseMessage(value)) return DATABASE_ERROR_MESSAGE;
	let output = value.replace(PROJECT_API_KEY_PATTERN, "$1_[Filtered]");
	output = output.replace(BEARER_BASIC_PATTERN, "$1 [Filtered]");
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
		if (UUID_PATTERN.test(match) || IDENTIFIER_PATTERN.test(match)) {
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
	const output: string[] = [];
	for (const [index, segment] of segments.entries()) {
		output.push(
			maskSegment(segment, segments[index - 1] ?? "", segments[index - 2] ?? "", output[index - 1]),
		);
	}
	return output.join("/");
}

function maskSegment(
	segment: string,
	previous: string,
	beforePrevious: string,
	maskedPrevious: string | undefined,
): string {
	if (segment === "" || segment.startsWith(":") || segment === "*" || segment === ".well-known") {
		return segment;
	}
	if (!KEEP_SEGMENT_PATTERN.test(segment)) {
		return ":id";
	}
	if (COLLECTIONS.has(segment) || PAIR_COLLECTIONS.has(segment)) {
		return segment;
	}
	if (COLLECTIONS.has(previous) || PAIR_COLLECTIONS.has(previous)) {
		return STATIC_AFTER_COLLECTION.has(segment) ? segment : ":id";
	}
	if (PAIR_COLLECTIONS.has(beforePrevious) && maskedPrevious?.startsWith(":") === true) {
		return ":id";
	}
	// `usage/operations/:operation/:operationId`: the operation kind is an enum, the next is an id.
	if (beforePrevious === "operations") {
		return ":id";
	}
	return segment;
}

export function scrubUrl(value: string): string {
	const withoutQuery = value.split(/[?#]/)[0] ?? "";
	if (value.startsWith("/")) {
		return maskPath(withoutQuery);
	}
	try {
		const parsed = new URL(value);
		// Non-special schemes such as postgres: have an opaque "null" origin.
		return parsed.origin === "null"
			? scrubString(withoutQuery)
			: `${parsed.origin}${maskPath(parsed.pathname)}`;
	} catch {
		return scrubString(value);
	}
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

export interface ErrorDiagnostic {
	type: string;
	message: string;
	stack?: string;
	sqlState?: string;
	constraint?: string;
}

export function describeError(error: unknown): ErrorDiagnostic {
	try {
		const database = databaseDiagnostic(error);
		if (database !== null) return database;
		if (error instanceof Error) {
			const output: ErrorDiagnostic = {
				type: scrubString(error.name || "Error", DEFAULT_MAX_STRING),
				message: scrubString(error.message, DEFAULT_MAX_STRING),
			};
			if (typeof error.stack === "string" && error.stack.length > 0) {
				output.stack = scrubString(error.stack, DEFAULT_MAX_STRING);
			}
			return output;
		}
		const value = scrubValue(error);
		const message = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
		return { type: "Error", message: scrubString(message, DEFAULT_MAX_STRING) };
	} catch {
		return { type: "Error", message: "[Unserializable]" };
	}
}

export function describeThrown(value: unknown, maxLength = DEFAULT_MAX_STRING): string {
	return scrubString(describeError(value).message, maxLength);
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
	if (typeof value === "function" || typeof value === "symbol") return undefined;
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
	const database = databaseDiagnostic(value);
	if (database !== null) return database;
	if (Array.isArray(value)) {
		return value
			.slice(0, options.maxItems)
			.map((entry) => scrubValueInner(entry, options, depth + 1, seen));
	}
	const output: Record<string, unknown> = Object.create(null);
	let kept = 0;
	for (const key of Object.keys(value)) {
		if (kept >= options.maxKeys) {
			break;
		}
		if (isSensitiveKey(key)) {
			continue;
		}
		const entry = (value as Record<string, unknown>)[key];
		if (isUrlKey(key) && typeof entry === "string") {
			output[key] = scrubString(scrubUrl(entry), options.maxString);
		} else {
			output[key] = scrubValueInner(entry, options, depth + 1, seen);
		}
		kept += 1;
	}
	return stripUndefined(output);
}
