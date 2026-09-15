import { describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { sqlstateOf } from "../../../src/db/repository/base";

function driverError(errno: string, message: string): Error {
	return new Error(message, {
		cause: new SQL.PostgresError(message, { code: "ERR_POSTGRES_SERVER_ERROR", errno }),
	});
}

describe("sqlstateOf", () => {
	it("reads the SQLSTATE from Bun's wrapped driver error", () => {
		expect(sqlstateOf(driverError("40P01", "deadlock detected"))).toBe("40P01");
	});

	it("reads a five-character code from the top-level error", () => {
		expect(sqlstateOf(Object.assign(new Error("unique violation"), { code: "23505" }))).toBe(
			"23505",
		);
	});

	it("ignores a driver code with no SQLSTATE and keeps walking", () => {
		const error = new Error("wrapped", {
			cause: new SQL.PostgresError("server error", { code: "ERR_POSTGRES_SERVER_ERROR" }),
		});

		expect(sqlstateOf(error)).toBeNull();
	});

	it("resolves through a double wrap", () => {
		const error = new Error("wrapped", {
			cause: driverError("40001", "serialization failure"),
		});

		expect(sqlstateOf(error)).toBe("40001");
	});

	it("terminates on a cyclic cause chain", () => {
		const error = new Error("cyclic");
		error.cause = error;

		expect(sqlstateOf(error)).toBeNull();
	});

	it("ignores numeric errno values from system errors", () => {
		const error = Object.assign(new Error("no such file"), { errno: -2, code: "ENOENT" });

		expect(sqlstateOf(error)).toBeNull();
	});

	it("returns null for null, strings and undefined", () => {
		expect(sqlstateOf(null)).toBeNull();
		expect(sqlstateOf("40P01")).toBeNull();
		expect(sqlstateOf(undefined)).toBeNull();
	});
});
