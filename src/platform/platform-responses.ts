import { z } from "@hono/zod-openapi";
import {
	InvitationViewSchema,
	MerchantConfigurationViewSchema,
	MerchantSessionViewSchema,
	OnboardingDraftViewSchema,
	ProvisioningOperationViewSchema,
	StepUpChallengeViewSchema,
	TeamViewSchema,
} from "./schemas";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
export const getApiPlatformConfigResponse200Schema = z
	.object({ success: z.literal(true), data: MerchantConfigurationViewSchema })
	.openapi("getApiPlatformConfigResponse200");

export const getApiPlatformSessionResponse200Schema = z
	.object({ success: z.literal(true), data: MerchantSessionViewSchema })
	.openapi("getApiPlatformSessionResponse200");

export const postApiPlatformSignupIntentResponse200Schema = z
	.object({ success: z.literal(true), data: z.object({ status: z.string() }) })
	.openapi("postApiPlatformSignupIntentResponse200");

export const postApiPlatformSessionExchangeResponse200Schema = z
	.object({ success: z.literal(true), data: z.object({ status: z.string() }) })
	.openapi("postApiPlatformSessionExchangeResponse200");

export const postApiPlatformLogoutResponse200Schema = z
	.object({ success: z.literal(true), data: z.object({ status: z.string() }) })
	.openapi("postApiPlatformLogoutResponse200");

export const postApiPlatformVerifyEmailResponse200Schema = z
	.object({ success: z.literal(true), data: z.object({ status: z.string() }) })
	.openapi("postApiPlatformVerifyEmailResponse200");

export const getApiPlatformOnboardingResponse200Schema = z
	.object({ success: z.literal(true), data: z.union([OnboardingDraftViewSchema, z.null()]) })
	.openapi("getApiPlatformOnboardingResponse200");

export const postApiPlatformOnboardingOrganizationResponse200Schema = z
	.object({ success: z.literal(true), data: OnboardingDraftViewSchema })
	.openapi("postApiPlatformOnboardingOrganizationResponse200");

export const postApiPlatformOnboardingProjectResponse200Schema = z
	.object({ success: z.literal(true), data: OnboardingDraftViewSchema })
	.openapi("postApiPlatformOnboardingProjectResponse200");

export const postApiPlatformOnboardingProvisionResponse200Schema = z
	.object({ success: z.literal(true), data: ProvisioningOperationViewSchema })
	.openapi("postApiPlatformOnboardingProvisionResponse200");

export const getApiPlatformProvisioningByIdResponse200Schema = z
	.object({ success: z.literal(true), data: ProvisioningOperationViewSchema })
	.openapi("getApiPlatformProvisioningByIdResponse200");

export const postApiPlatformProvisioningByIdRetryResponse200Schema = z
	.object({ success: z.literal(true), data: ProvisioningOperationViewSchema })
	.openapi("postApiPlatformProvisioningByIdRetryResponse200");

export const postApiPlatformProvisioningByIdCredentialResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			credential: z.union([z.null(), z.string()]),
			state: z.enum(["delivered", "unavailable"]),
		}),
	})
	.openapi("postApiPlatformProvisioningByIdCredentialResponse200");

export const postApiPlatformProvisioningByIdRotateResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			credential: z.union([z.null(), z.string()]),
			state: z.enum(["delivered", "unavailable"]),
		}),
	})
	.openapi("postApiPlatformProvisioningByIdRotateResponse200");

export const postApiPlatformInvitationsPreviewResponse200Schema = z
	.object({ success: z.literal(true), data: InvitationViewSchema })
	.openapi("postApiPlatformInvitationsPreviewResponse200");

export const postApiPlatformInvitationsAcceptResponse200Schema = z
	.object({ success: z.literal(true), data: z.object({ organizationSlug: z.string() }) })
	.openapi("postApiPlatformInvitationsAcceptResponse200");

export const postApiPlatformInvitationsRequestResponse200Schema = z
	.object({ success: z.literal(true), data: z.object({ status: z.literal("requested") }) })
	.openapi("postApiPlatformInvitationsRequestResponse200");

export const getApiPlatformTeamResponse200Schema = z
	.object({ success: z.literal(true), data: TeamViewSchema })
	.openapi("getApiPlatformTeamResponse200");

export const postApiPlatformTeamInvitationsResponse200Schema = z
	.object({ success: z.literal(true), data: InvitationViewSchema })
	.openapi("postApiPlatformTeamInvitationsResponse200");

export const postApiPlatformTeamInvitationsByIdResendResponse200Schema = z
	.object({ success: z.literal(true), data: InvitationViewSchema })
	.openapi("postApiPlatformTeamInvitationsByIdResendResponse200");

export const postApiPlatformTeamInvitationsByIdRevokeResponse200Schema = z
	.object({ success: z.literal(true), data: z.object({ status: z.literal("revoked") }) })
	.openapi("postApiPlatformTeamInvitationsByIdRevokeResponse200");

export const postApiPlatformTeamMembersByIdResponse200Schema = z
	.object({ success: z.literal(true), data: z.object({ status: z.literal("updated") }) })
	.openapi("postApiPlatformTeamMembersByIdResponse200");

export const postApiPlatformStepUpResponse200Schema = z
	.object({ success: z.literal(true), data: StepUpChallengeViewSchema })
	.openapi("postApiPlatformStepUpResponse200");

export const getApiPlatformStepUpByIdResponse200Schema = z
	.object({ success: z.literal(true), data: StepUpChallengeViewSchema })
	.openapi("getApiPlatformStepUpByIdResponse200");

export const postApiPlatformStepUpByIdCompleteResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({ grant: z.string(), expiresAt: z.string() }),
	})
	.openapi("postApiPlatformStepUpByIdCompleteResponse200");
