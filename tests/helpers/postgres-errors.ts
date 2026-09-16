import { SQL } from "bun";

/**
 * Models the error shape production sees: drizzle rethrows a `DrizzleQueryError` wrapper whose
 * `cause` is Bun's `SQL.PostgresError`, which carries the driver code plus the SQLSTATE on
 * `errno`.
 */
export function driverError(errno: string, message: string): Error {
	return new Error(message, {
		cause: new SQL.PostgresError(message, { code: "ERR_POSTGRES_SERVER_ERROR", errno }),
	});
}
