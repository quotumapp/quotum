import { describe, expect, it } from "bun:test";
import { requireLaneFlag } from "./test-lane";

describe("requireLaneFlag", () => {
	it("does not throw when BILLING_TEST_LANE is unset, even under CI", () => {
		expect(() => requireLaneFlag("integration", { CI: "true" })).not.toThrow();
		expect(() => requireLaneFlag("merchant", { CI: "true" })).not.toThrow();
		expect(() => requireLaneFlag("e2e", { CI: "true" })).not.toThrow();
	});

	it("throws when the lane is set without its enabling flag", () => {
		expect(() => requireLaneFlag("integration", { BILLING_TEST_LANE: "integration" })).toThrow(
			"BILLING_TEST_LANE=integration requires RUN_POSTGRES_INTEGRATION_TESTS=1; run bun run test:integration",
		);
		expect(() => requireLaneFlag("merchant", { BILLING_TEST_LANE: "merchant" })).toThrow(
			"BILLING_TEST_LANE=merchant requires RUN_POSTGRES_INTEGRATION_TESTS=1; run bun run test:merchant:integration",
		);
		expect(() => requireLaneFlag("e2e", { BILLING_TEST_LANE: "e2e" })).toThrow(
			"BILLING_TEST_LANE=e2e requires RUN_BILLING_E2E_TESTS=1; run bun run test:e2e",
		);
	});

	it("does not throw when the enabling flag is set", () => {
		expect(() =>
			requireLaneFlag("integration", {
				BILLING_TEST_LANE: "integration",
				RUN_POSTGRES_INTEGRATION_TESTS: "1",
			}),
		).not.toThrow();
		expect(() =>
			requireLaneFlag("e2e", { BILLING_TEST_LANE: "e2e", RUN_BILLING_E2E_TESTS: "1" }),
		).not.toThrow();
	});
});
