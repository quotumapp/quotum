import { describe, expect, it } from "bun:test";
import { billingChangeActions } from "../../../src/composition/billing-change-actions";
import {
	allowedOnInactiveEnvironment,
	INACTIVE_ENVIRONMENT_OPERATIONS,
	mcpBillingOperations,
	merchantBillingOperations,
} from "../../../src/platform/application/billing-port";
import { environmentStatus, environmentUsable } from "../../../src/platform/mcp/authorization";

const instance = (
	lifecycleStatus: string,
	environment = "production",
	internalProject = false,
) => ({
	lifecycleStatus,
	environment,
	internalProject,
});

describe("MCP environment access", () => {
	it("accepts active and inactive environments only", () => {
		expect(environmentUsable(instance("active"))).toBe(true);
		expect(environmentUsable(instance("inactive"))).toBe(true);
		for (const status of ["suspended", "deactivating", "deactivated"])
			expect({ status, usable: environmentUsable(instance(status)) }).toEqual({
				status,
				usable: false,
			});
	});

	it("never accepts an internal project or environment", () => {
		expect(environmentUsable(instance("active", "production", true))).toBe(false);
		expect(environmentUsable(instance("inactive", "production", true))).toBe(false);
		expect(environmentUsable(instance("active", "internal"))).toBe(false);
	});

	it("reports whether the environment is activated", () => {
		expect(environmentStatus(instance("active"))).toBe("active");
		expect(environmentStatus(instance("inactive"))).toBe("inactive");
	});

	it("lets an inactive environment reach the catalog and nothing else", () => {
		expect([...INACTIVE_ENVIRONMENT_OPERATIONS].sort()).toEqual([
			"catalog",
			"catalog.preview",
			"catalog.products",
			"catalog.publish",
			"catalog.store-products",
		]);
		const operations = [...merchantBillingOperations, ...mcpBillingOperations].map(
			([, , operation]) => operation,
		);
		for (const operation of INACTIVE_ENVIRONMENT_OPERATIONS)
			expect(operations).toContain(operation);
		const refused = operations.filter((operation) => !allowedOnInactiveEnvironment(operation));
		expect(refused).toContain("entities");
		expect(refused).toContain("account.summary");
		expect(refused).toContain("contracts.publish");
		expect(refused).toContain("migrations.publish");
		expect(refused).toHaveLength(operations.length - new Set(INACTIVE_ENVIRONMENT_OPERATIONS).size);
	});

	it("leaves catalog publication as the only proposal an inactive environment accepts", () => {
		expect(
			billingChangeActions
				.filter((action) => allowedOnInactiveEnvironment(action.action))
				.map((action) => action.action),
		).toEqual(["catalog.publish"]);
	});
});
