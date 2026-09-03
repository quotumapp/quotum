export function describeE2e<T extends (name: string, fn: () => void) => void>(
	describeFn: T,
	describeSkipFn: T,
): T {
	return (process.env.RUN_BILLING_E2E_TESTS === "1" ? describeFn : describeSkipFn) as T;
}
