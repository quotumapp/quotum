import { z } from "zod";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
const roleSchema = z.enum(["referrer", "referee"]);
const referralStatusSchema = z.enum(["pending", "qualified"]);
const nullableString = z.union([z.null(), z.string()]);

const programSchema = z.object({
	key: z.string(),
	name: z.string(),
	status: z.enum(["active", "archived"]),
	rewardPromotionKey: z.string(),
	trigger: z.enum(["redemption", "first_payment"]),
	recipient: z.enum(["referrer", "both"]),
	maxRewardsPerReferrer: z.union([z.null(), z.number()]),
	targets: z.array(z.object({ kind: z.enum(["plan", "product"]), key: z.string() })),
	excludeTrial: z.boolean(),
	createdBy: z.string(),
	createdAt: z.string(),
	archivedBy: nullableString,
	archivedAt: nullableString,
});

const rewardSchema = z.object({
	id: z.string(),
	recipient: roleSchema,
	status: z.enum(["pending", "issued", "held", "used", "skipped", "failed"]),
	reason: nullableString,
	promotionKey: z.string(),
	effectKind: z.enum(["discount", "feature_grant", "plan_grant"]),
	code: nullableString,
	issuedAt: nullableString,
});

const accountReferralSchema = z.object({
	id: z.string(),
	programKey: z.string(),
	role: roleSchema,
	counterpartBillingAccountId: nullableString,
	status: referralStatusSchema,
	qualifiedAt: nullableString,
	createdAt: z.string(),
	rewards: z.array(rewardSchema),
});

const ledgerReferralSchema = z.object({
	id: z.string(),
	referrerBillingAccountId: nullableString,
	refereeBillingAccountId: nullableString,
	status: referralStatusSchema,
	qualifiedAt: nullableString,
	createdAt: z.string(),
	rewards: z.array(rewardSchema),
});

const paginationSchema = z.object({ nextCursor: nullableString });

const programResponseSchema = z.object({ success: z.literal(true), data: programSchema });
export const postV1AdminReferralProgramsResponse200Schema = programResponseSchema;
export const postV1AdminReferralProgramsResponse201Schema = programResponseSchema;
export const getV1AdminReferralProgramsByProgramKeyResponse200Schema = programResponseSchema;
export const postV1AdminReferralProgramsByProgramKeyArchiveResponse200Schema =
	programResponseSchema;

export const getV1AdminReferralProgramsResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(programSchema),
	pagination: paginationSchema,
});

export const getV1AdminReferralProgramsByProgramKeyReferralsResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(ledgerReferralSchema),
	pagination: paginationSchema,
});

export const putV1BillingAccountsReferralCodesResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({
		programKey: z.string(),
		billingAccountId: z.string(),
		code: z.string(),
		createdAt: z.string(),
	}),
});

export const postV1BillingAccountsReferralRedemptionsResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({ duplicate: z.boolean(), referral: accountReferralSchema }),
});

export const getV1BillingAccountsReferralsResponse200Schema = z.object({
	success: z.literal(true),
	data: z.array(accountReferralSchema),
	pagination: paginationSchema,
});
