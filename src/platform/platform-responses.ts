import { z } from "zod";
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
export const getApiPlatformConfigResponse200Schema = z.object({
	success: z.literal(true),
	data: MerchantConfigurationViewSchema,
});

export const getApiPlatformSessionResponse200Schema = z.object({
	success: z.literal(true),
	data: MerchantSessionViewSchema,
});

export const postApiPlatformSignupIntentResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({ status: z.string() }),
});

export const postApiPlatformSessionExchangeResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({ status: z.string() }),
});

export const postApiPlatformLogoutResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({ status: z.string() }),
});

export const postApiPlatformVerifyEmailResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({ status: z.string() }),
});

export const getApiPlatformOnboardingResponse200Schema = z.object({
	success: z.literal(true),
	data: z.union([OnboardingDraftViewSchema, z.null()]),
});

export const postApiPlatformOnboardingOrganizationResponse200Schema = z.object({
	success: z.literal(true),
	data: OnboardingDraftViewSchema,
});

export const postApiPlatformOnboardingProjectResponse200Schema = z.object({
	success: z.literal(true),
	data: OnboardingDraftViewSchema,
});

export const postApiPlatformOnboardingProvisionResponse200Schema = z.object({
	success: z.literal(true),
	data: ProvisioningOperationViewSchema,
});

export const getApiPlatformProvisioningByIdResponse200Schema = z.object({
	success: z.literal(true),
	data: ProvisioningOperationViewSchema,
});

export const postApiPlatformProvisioningByIdRetryResponse200Schema = z.object({
	success: z.literal(true),
	data: ProvisioningOperationViewSchema,
});

export const postApiPlatformProvisioningByIdCredentialResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({
		credential: z.union([z.null(), z.string()]),
		state: z.enum(["delivered", "unavailable"]),
	}),
});

export const postApiPlatformProvisioningByIdRotateResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({
		credential: z.union([z.null(), z.string()]),
		state: z.enum(["delivered", "unavailable"]),
	}),
});

export const postApiPlatformInvitationsPreviewResponse200Schema = z.object({
	success: z.literal(true),
	data: InvitationViewSchema,
});

export const postApiPlatformInvitationsAcceptResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({ organizationSlug: z.string() }),
});

export const postApiPlatformInvitationsRequestResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({ status: z.literal("requested") }),
});

export const getApiPlatformTeamResponse200Schema = z.object({
	success: z.literal(true),
	data: TeamViewSchema,
});

export const postApiPlatformTeamInvitationsResponse200Schema = z.object({
	success: z.literal(true),
	data: InvitationViewSchema,
});

export const postApiPlatformTeamInvitationsByIdResendResponse200Schema = z.object({
	success: z.literal(true),
	data: InvitationViewSchema,
});

export const postApiPlatformTeamInvitationsByIdRevokeResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({ status: z.literal("revoked") }),
});

export const postApiPlatformTeamMembersByIdResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({ status: z.literal("updated") }),
});

export const postApiPlatformStepUpResponse200Schema = z.object({
	success: z.literal(true),
	data: StepUpChallengeViewSchema,
});

export const getApiPlatformStepUpByIdResponse200Schema = z.object({
	success: z.literal(true),
	data: StepUpChallengeViewSchema,
});

export const postApiPlatformStepUpByIdCompleteResponse200Schema = z.object({
	success: z.literal(true),
	data: z.object({ grant: z.string(), expiresAt: z.string() }),
});
