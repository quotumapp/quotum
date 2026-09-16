const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
const DIGIT_PATTERN = /[0-9]/;

/**
 * Reads the PostgreSQL SQLSTATE off a thrown error. Drizzle wraps driver errors in
 * `DrizzleQueryError` with the original error on `cause`, and Bun's SQL driver reports the
 * SQLSTATE on `errno` while its own `code` is a driver name like `ERR_POSTGRES_SERVER_ERROR`,
 * so the cause chain has to be walked and both fields checked. Every PostgreSQL SQLSTATE
 * contains a digit, which rules out five-letter system and framework codes such as `EPIPE`.
 */
export function sqlstateOf(error: unknown): string | null {
	let current: unknown = error;
	for (let depth = 0; depth < 8; depth += 1) {
		if (typeof current !== "object" || current === null) {
			return null;
		}
		const link = current as { errno?: unknown; code?: unknown; cause?: unknown };
		if (isSqlstate(link.errno)) {
			return link.errno;
		}
		if (isSqlstate(link.code)) {
			return link.code;
		}
		current = link.cause;
	}
	return null;
}

function isSqlstate(value: unknown): value is string {
	return typeof value === "string" && SQLSTATE_PATTERN.test(value) && DIGIT_PATTERN.test(value);
}
