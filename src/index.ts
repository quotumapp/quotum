import * as Sentry from "@sentry/bun";
import { createBillingReadinessCheck } from "./composition/runtime-readiness";
import { initializePostgresHealth } from "./db/client";
import { loadEnv } from "./env";
import { initializeSentry } from "./observability/sentry";
import { createBillingRuntimeApp } from "./runtime";

const env = loadEnv();
initializeSentry(Sentry, env.sentry);
await initializePostgresHealth();

const app = createBillingRuntimeApp(env, {
	sentry: Sentry,
	readinessCheck: createBillingReadinessCheck(),
});

export default app;
