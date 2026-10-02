import { defaultStackParser } from "@sentry/bun";
import type {
	Breadcrumb,
	ErrorEvent,
	EventHint,
	Log,
	SpanJSON,
	StackFrame,
	TransactionEvent,
} from "@sentry/core";
import {
	DATABASE_ERROR_MESSAGE,
	databaseDiagnostic,
	diagnosticCauses,
	isDatabaseMessage,
} from "./database-diagnostics";
import {
	DEFAULT_MAX_STRING,
	scrubRecord,
	scrubString,
	scrubUrl,
	stripUndefined,
} from "./diagnostic-scrub";

export type { ScrubOptions } from "./diagnostic-scrub";
export {
	DEFAULT_MAX_STRING,
	describeError,
	describeThrown,
	FILTERED,
	isSensitiveKey,
	isUrlKey,
	maskPath,
	scrubRecord,
	scrubString,
	scrubUrl,
	scrubValue,
	stripUndefined,
} from "./diagnostic-scrub";

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
	"url.query",
	"url.fragment",
	"query",
	"fragment",
	"body",
]);

const KEEP_CONTEXTS = new Set(["app", "device", "os", "runtime", "culture", "cloud_resource"]);

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

export function scrubEvent<E extends ErrorEvent | TransactionEvent>(event: E, hint?: EventHint): E {
	const values = event.exception?.values;
	const database = databaseDiagnostic(hint?.originalException);
	const databaseFailure =
		database !== null ||
		values?.some(
			(value) =>
				value.type === "PostgresError" ||
				value.type === "DrizzleQueryError" ||
				(typeof value.value === "string" && isDatabaseMessage(value.value)),
		);
	const sourceFrames = databaseFailure ? databaseSourceFrames(hint?.originalException) : null;
	if (typeof event.message === "string") {
		event.message = databaseFailure ? DATABASE_ERROR_MESSAGE : scrubString(event.message);
	}
	if (event.logentry !== undefined) {
		if (databaseFailure) event.logentry = { message: DATABASE_ERROR_MESSAGE };
		else if (typeof event.logentry.message === "string") {
			event.logentry.message = scrubString(event.logentry.message);
		}
	}
	if (Array.isArray(values)) {
		for (const value of values) {
			if (typeof value.type === "string") value.type = scrubString(value.type, DEFAULT_MAX_STRING);
			if (typeof value.value === "string") {
				value.value = databaseFailure
					? DATABASE_ERROR_MESSAGE
					: scrubString(value.value, DEFAULT_MAX_STRING);
			}
			const frames = value.stacktrace?.frames;
			if (Array.isArray(frames)) {
				if (sourceFrames !== null && value.stacktrace !== undefined) {
					value.stacktrace.frames = frames.filter((frame) =>
						sourceFrames.has(frameIdentity(frame)),
					);
				}
				for (const frame of frames) {
					const record = frame as unknown as Record<string, unknown>;
					delete record.vars;
					// Keep file/function/line correlation, not snippets that can contain SQL or literals.
					if (databaseFailure) {
						delete record.pre_context;
						delete record.post_context;
						delete record.context_line;
					}
				}
			}
		}
	}
	if (database !== null) {
		event.contexts = {
			...event.contexts,
			database: stripUndefined({ sqlState: database.sqlState, constraint: database.constraint }),
		};
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

/**
 * The SDK parses every line after the first as a potential frame. A SQL parameter can itself
 * contain a fake "at ..." line. Parse only the tail after the COMPLETE original error message,
 * then keep SDK frames whose locations are present there. Unverifiable stacks contribute nothing.
 */
function databaseSourceFrames(error: unknown): Set<string> {
	const frames = new Set<string>();
	for (const cause of diagnosticCauses(error)) {
		if (!(cause instanceof Error) || typeof cause.stack !== "string") continue;
		const header = `${cause.name}: ${cause.message}`;
		if (!cause.stack.startsWith(`${header}\n`)) continue;
		const tail = cause.stack.slice(header.length);
		for (const frame of defaultStackParser(`Error: ${DATABASE_ERROR_MESSAGE}${tail}`, 1)) {
			frames.add(frameIdentity(frame));
		}
	}
	return frames;
}

function frameIdentity(frame: StackFrame): string {
	return JSON.stringify([frame.filename, frame.function, frame.lineno, frame.colno]);
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
