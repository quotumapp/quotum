import { SQL } from "bun";
import { DrizzleQueryError } from "drizzle-orm/errors";

export const diagnosticQuery = "INSERT INTO diagnostic_probe VALUES ($1, $2, $3)";
export const diagnosticParameters = [
	"qa-person@example.invalid",
	`sqpk_${"X".repeat(43)}`,
	"private customer note",
];

export function databaseFailure(sqlState = "40P01", constraint = "customers_project_id_id_unique") {
	const driver = new SQL.PostgresError(diagnosticParameters.join(", "), {
		code: "ERR_POSTGRES_SERVER_ERROR",
		errno: sqlState,
		constraint,
		detail: diagnosticParameters[2],
		hint: diagnosticParameters[2],
		internalQuery: diagnosticQuery,
	});
	return new DrizzleQueryError(diagnosticQuery, diagnosticParameters, driver);
}
