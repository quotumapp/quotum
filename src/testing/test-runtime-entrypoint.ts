import { registerQuotumProcessShutdown } from "../composition/public-runtime";
import { createBillingReadinessCheck } from "../composition/runtime-readiness";
import { loadEnv } from "../env";
import { merchantPlatformEnabled } from "../platform/config";
import { createBillingRuntime } from "../runtime";
import { MerchantCaptureMailer } from "./merchant-fakes";

if (process.env.BILLING_ENV !== "test" || process.env.BILLING_TEST_LOOPBACK_PROJECTIONS !== "true")
	throw new Error("Loopback projection transport is restricted to explicit tests");
const env = loadEnv();
const runtime = createBillingRuntime(env, {
	projectionFetch: globalThis.fetch,
	readinessCheck: createBillingReadinessCheck(),
	merchant: merchantPlatformEnabled() ? { mailer: new MerchantCaptureMailer() } : null,
});

registerQuotumProcessShutdown(runtime);
await runtime.start();
export default runtime.app;
