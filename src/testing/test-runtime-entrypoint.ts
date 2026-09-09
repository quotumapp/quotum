import { createBillingReadinessCheck } from "../composition/runtime-readiness";
import { initializePostgresHealth } from "../db/client";
import { loadEnv } from "../env";
import { createBillingRuntimeApp } from "../runtime";

if (process.env.BILLING_ENV !== "test" || process.env.BILLING_TEST_LOOPBACK_PROJECTIONS !== "true")
	throw new Error("Loopback projection transport is restricted to explicit tests");
const env = loadEnv();
await initializePostgresHealth();
export default createBillingRuntimeApp(env, {
	projectionFetch: globalThis.fetch,
	readinessCheck: createBillingReadinessCheck(),
});
