export type BillingTestLane = "integration" | "merchant" | "e2e";

const laneFlags: Record<BillingTestLane, { flag: string; script: string }> = {
	integration: { flag: "RUN_POSTGRES_INTEGRATION_TESTS", script: "test:integration" },
	merchant: { flag: "RUN_POSTGRES_INTEGRATION_TESTS", script: "test:merchant:integration" },
	e2e: { flag: "RUN_BILLING_E2E_TESTS", script: "test:e2e" },
};

export function requireLaneFlag(lane: BillingTestLane, env: NodeJS.ProcessEnv = process.env): void {
	if (env.BILLING_TEST_LANE !== lane) {
		return;
	}
	const { flag, script } = laneFlags[lane];
	if (env[flag] === "1") {
		return;
	}
	throw new Error(`BILLING_TEST_LANE=${lane} requires ${flag}=1; run bun run ${script}`);
}
