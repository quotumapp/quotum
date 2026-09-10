import { requireLaneFlag } from "../../helpers/test-lane";

export function describeE2e<T extends (name: string, fn: () => void) => void>(
	describeFn: T,
	describeSkipFn: T,
): T {
	if (process.env.RUN_BILLING_E2E_TESTS === "1") {
		return describeFn;
	}
	requireLaneFlag("e2e");
	return describeSkipFn;
}
