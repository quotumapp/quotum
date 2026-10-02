import { SQL } from "bun";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { sqlstateOf } from "../db/postgres-errors";

export const DATABASE_ERROR_MESSAGE = "Database operation failed";
const CONSTRAINT_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const MAX_CAUSES = 8;

export interface DatabaseDiagnostic {
	type: "DatabaseError";
	message: typeof DATABASE_ERROR_MESSAGE;
	sqlState?: string;
	constraint?: string;
}

/** Drizzle's message embeds the complete statement and parameter values. Never pattern-mask it. */
export function isDatabaseMessage(value: string): boolean {
	return /\bFailed query:/i.test(value);
}

/**
 * Only typed, bounded diagnostics leave a database failure. Driver messages, detail/hint, SQL and
 * stacks may all contain values. Walk causes without modifying the errors used by billing retries.
 * Throw on unreadable or over-budget input so each sink can fail closed.
 */
export function databaseDiagnostic(error: unknown): DatabaseDiagnostic | null {
	let result: DatabaseDiagnostic | null = null;
	for (const current of diagnosticCauses(error)) {
		if (typeof current === "string") {
			if (isDatabaseMessage(current)) result ??= summary();
			continue;
		}
		const link = current as {
			code?: unknown;
			errno?: unknown;
			name?: unknown;
			message?: unknown;
			constraint?: unknown;
			cause?: unknown;
		};
		const code = link.code;
		const sqlState = sqlstateOf({ code, errno: link.errno });
		const driver = current instanceof SQL.PostgresError || code === "ERR_POSTGRES_SERVER_ERROR";
		if (
			current instanceof DrizzleQueryError ||
			driver ||
			sqlState !== null ||
			link.name === "DrizzleQueryError" ||
			link.name === "PostgresError" ||
			(typeof link.message === "string" && isDatabaseMessage(link.message))
		) {
			result ??= summary();
			if (sqlState !== null && result.sqlState === undefined) {
				result.sqlState = sqlState;
				const constraint = link.constraint;
				if (typeof constraint === "string" && CONSTRAINT_NAME.test(constraint)) {
					result.constraint = constraint;
				}
			}
		}
	}
	return result;
}

function summary(): DatabaseDiagnostic {
	return { type: "DatabaseError", message: DATABASE_ERROR_MESSAGE };
}

/** Bounded traversal also lets Sentry verify source frames against the actual error stacks. */
export function* diagnosticCauses(error: unknown): Generator<object | string> {
	const pending: unknown[] = [error];
	const seen = new WeakSet<object>();
	let inspected = 0;
	while (pending.length > 0) {
		const current = pending.pop();
		if (typeof current === "string") {
			yield current;
			continue;
		}
		if (typeof current !== "object" || current === null || seen.has(current)) continue;
		if (inspected++ >= MAX_CAUSES) throw new Error("Diagnostic cause limit exceeded");
		seen.add(current);
		yield current;
		if (current instanceof AggregateError) {
			if (current.errors.length > MAX_CAUSES) throw new Error("Diagnostic cause limit exceeded");
			pending.push(...current.errors);
		}
		pending.push((current as { cause?: unknown }).cause);
	}
}
