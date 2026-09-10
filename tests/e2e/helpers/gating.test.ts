import { describe, expect, it } from "bun:test";
import { requireLaneFlag } from "../../helpers/test-lane";
import { describeE2e } from "./gating";

describe("e2e gating", () => {
	it("throws when BILLING_TEST_LANE=e2e is set without the enabling flag", () => {
		expect(() => requireLaneFlag("e2e", { BILLING_TEST_LANE: "e2e" })).toThrow(
			"BILLING_TEST_LANE=e2e requires RUN_BILLING_E2E_TESTS=1",
		);
	});

	it("selects the skip wrapper when the enabling flag is unset", () => {
		const names: string[] = [];
		const run = ((name: string) => {
			names.push(`run:${name}`);
		}) as unknown as typeof describe;
		const skip = ((name: string) => {
			names.push(`skip:${name}`);
		}) as unknown as typeof describe;
		describeE2e(run, skip)("gated", () => undefined);
		if (process.env.RUN_BILLING_E2E_TESTS === "1") {
			expect(names).toEqual(["run:gated"]);
		} else {
			expect(names).toEqual(["skip:gated"]);
		}
	});
});
