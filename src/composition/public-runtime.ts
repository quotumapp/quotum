import * as Sentry from "@sentry/bun";
import { type BillingEnv, loadEnv } from "../env";
import { loadOptionalMerchantConfig, type MerchantConfig } from "../platform/config";
import { createBillingRuntime } from "../runtime";
import { registerBillingRuntimeShutdown } from "../shutdown";
import type { QuotumRuntime, QuotumRuntimeScheduler } from "./runtime-lifecycle";
import { createBillingReadinessCheck } from "./runtime-readiness";

export type {
	QuotumApp,
	QuotumRequestServer,
	QuotumRuntime,
	QuotumRuntimeScheduler,
	QuotumScheduledJob,
} from "./runtime-lifecycle";

export interface QuotumRuntimeConfig {
	billing: BillingEnv;
	/** `null` when `QUOTUM_MERCHANT_ENABLED=false`: the process serves `/v1` and workers only. */
	merchant: MerchantConfig | null;
}

export function loadQuotumRuntimeConfig(): QuotumRuntimeConfig {
	return { billing: loadEnv(), merchant: loadOptionalMerchantConfig() };
}

export function createQuotumRuntime(
	config: QuotumRuntimeConfig,
	options: { scheduler?: QuotumRuntimeScheduler } = {},
): QuotumRuntime {
	return createBillingRuntime(config.billing, {
		merchant: config.merchant === null ? null : { config: config.merchant },
		sentry: Sentry,
		readinessCheck: createBillingReadinessCheck(),
		scheduler: options.scheduler,
	});
}

/** Explicit opt-in for Bun process entrypoints; importing or constructing a runtime never binds signals. */
export function registerQuotumProcessShutdown(runtime: Pick<QuotumRuntime, "stop">): void {
	registerBillingRuntimeShutdown({ process, runtimes: [runtime] });
}
