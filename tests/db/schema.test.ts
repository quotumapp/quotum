import { describe, expect, it } from "bun:test";
import * as schema from "../../src/db/schema";

describe("billing Drizzle schema", () => {
	it("does not declare product app read-model tables", () => {
		expect(schema).not.toHaveProperty("profiles");
		expect(schema).not.toHaveProperty("echoBalances");
		expect(schema).not.toHaveProperty("echoTransactions");
	});
});
