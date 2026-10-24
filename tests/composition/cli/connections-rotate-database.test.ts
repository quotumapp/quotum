import { describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import { openRotationDatabase } from "../../../src/composition/cli/connections-rotate-secrets";

describe("secret rotation database connection", () => {
	it.each([
		[undefined, true],
		["true", true],
		["false", false],
	] as const)(
		"forwards prepared-statements setting %s while keeping a single connection",
		(setting, expected) => {
			const connection = {} as SQL;
			let supplied: unknown;
			expect(
				openRotationDatabase(
					{
						POSTGRES_URI: "postgres://localhost/rotation",
						BILLING_POSTGRES_PREPARED_STATEMENTS: setting,
					},
					(uri, options) => {
						supplied = { uri, options };
						return connection;
					},
				),
			).toBe(connection);
			expect(supplied).toEqual({
				uri: "postgres://localhost/rotation",
				options: { max: 1, prepare: expected },
			});
		},
	);
	it("rejects invalid configuration before opening a connection", () => {
		let opened = false;
		expect(() =>
			openRotationDatabase(
				{
					POSTGRES_URI: "postgres://localhost/rotation",
					BILLING_POSTGRES_PREPARED_STATEMENTS: "invalid",
				},
				() => {
					opened = true;
					return {} as SQL;
				},
			),
		).toThrow("BILLING_POSTGRES_PREPARED_STATEMENTS");
		expect(opened).toBe(false);
		expect(() => openRotationDatabase({})).toThrow("POSTGRES_URI is required");
	});
});
