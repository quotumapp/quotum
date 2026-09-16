import { z } from "zod";

export const billingLogLevelSchema = z
	.enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
	.default("info");

export type BillingLogLevel = z.infer<typeof billingLogLevelSchema>;

/** CLI tools must not need database or merchant configuration to initialize logging. */
export function loadBillingLogLevel(
	source: Record<string, string | undefined> = process.env,
): BillingLogLevel {
	return z.object({ BILLING_LOG_LEVEL: billingLogLevelSchema }).parse(source).BILLING_LOG_LEVEL;
}
