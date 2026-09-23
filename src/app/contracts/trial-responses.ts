import { z } from "zod";
import { billingProviderValues } from "./provider-enum";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
const trialSchema = z.object({
	id: z.string(),
	billingAccountId: z.string(),
	planKey: z.string(),
	planVersion: z.number(),
	status: z.enum(["active", "expired", "ended", "superseded"]),
	startsAt: z.string(),
	endsAt: z.string(),
	endedAt: z.union([z.null(), z.string()]),
	durationDays: z.number(),
	entitlementKeys: z.array(z.string()),
	supersededBy: z.union([
		z.null(),
		z.object({
			provider: z.enum(billingProviderValues()),
			externalSubscriptionId: z.string(),
		}),
	]),
	endReason: z.union([z.null(), z.string()]),
	actor: z.string(),
	metadata: z.record(z.string(), z.unknown()),
	createdAt: z.string(),
});

const trialMutationSchema = z.object({
	success: z.literal(true),
	data: z.object({ duplicate: z.boolean(), trial: trialSchema }),
});

export const postV1BillingAccountsByBillingAccountIdTrialsResponse201Schema = trialMutationSchema;
export const postV1BillingAccountsByBillingAccountIdTrialsResponse200Schema = trialMutationSchema;

export const getV1BillingAccountsByBillingAccountIdTrialsResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(trialSchema),
	pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
});

export const getV1BillingAccountsByBillingAccountIdTrialsByTrialIdResponse200Schema = z.object({
	success: z.literal(true),
	data: trialSchema,
});

export const postV1BillingAccountsByBillingAccountIdTrialsByTrialIdEndResponse200Schema =
	trialMutationSchema;

export const getV1BillingAccountsByBillingAccountIdTrialEligibilityResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({
		planKey: z.string(),
		eligible: z.boolean(),
		reason: z.union([
			z.null(),
			z.enum([
				"TRIAL_PLAN_NOT_ELIGIBLE",
				"TRIAL_ALREADY_ACTIVE",
				"TRIAL_BASE_PLAN_ACTIVE",
				"TRIAL_ALREADY_USED",
			]),
		]),
		defaultDurationDays: z.union([z.null(), z.number()]),
	}),
});
