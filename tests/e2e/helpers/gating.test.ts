import { describe, expect, it } from "bun:test";
import { requireLaneFlag } from "../../helpers/test-lane";
import { describeE2e } from "./gating";

describe("e2e gating", () => {
	it("throws when BILLING_TEST_LANE=e2e is set without the enabling flag", () => {
		expect(() => requireLaneFlag("e2e", { BILLING_TEST_LANE: "e2e" })).toThrow(
			"BILLING_TEST_LANE=e2e requires RUN_BILLING_E2E_TESTS=1",
		);
	});

	it("keeps describeE2e as a skip wrapper when the flag is unset", () => {
		const names: string[] = [];
		const skip = ((name: string) => {
			names.push(name);
		}) as unknown as typeof describe;
		describeE2e(describe, skip)("gated", () => undefined);
		if (process.env.RUN_BILLING_E2E_TESTS === "1") {
			expect(names).toEqual([]);
		} else {
			expect(names).toEqual(["gated"]);
		}
	});
});
