import { describe, expect, it } from "bun:test";
import { environmentStatus, environmentUsable } from "../../../src/platform/mcp/authorization";

const instance = (
	lifecycleStatus: string,
	environment = "production",
	internalProject = false,
) => ({ lifecycleStatus, environment, internalProject });

describe("MCP environment access", () => {
	it("accepts active environments independently of setup readiness", () => {
		for (const environment of ["sandbox", "production"])
			expect(environmentUsable(instance("active", environment))).toBe(true);
		expect(environmentStatus()).toBe("active");
	});
	it("refuses unavailable lifecycle states", () => {
		for (const status of ["inactive", "suspended", "deactivating", "deactivated"])
			expect(environmentUsable(instance(status))).toBe(false);
	});
	it("never accepts an internal project or environment", () => {
		expect(environmentUsable(instance("active", "production", true))).toBe(false);
		expect(environmentUsable(instance("active", "internal"))).toBe(false);
	});
});
