/** Browser-safe wire types inferred from the authored platform schemas. */
import type { z } from "zod";
import type {
	InvitationViewSchema,
	MerchantAuthMethodSchema,
	MerchantCapabilitySchema,
	MerchantConfigurationViewSchema,
	MerchantEnvironmentSchema,
	MerchantErrorBodySchema,
	MerchantMembershipViewSchema,
	MerchantProjectViewSchema,
	MerchantRoleSchema,
	MerchantScopeSchema,
	MerchantSessionViewSchema,
	OnboardingDraftViewSchema,
	ProvisioningOperationViewSchema,
	StepUpChallengeViewSchema,
	TeamViewSchema,
} from "./schemas";
export type MerchantRole = z.infer<typeof MerchantRoleSchema>;
export type MerchantEnvironment = z.infer<typeof MerchantEnvironmentSchema>;
export type MerchantAuthMethod = z.infer<typeof MerchantAuthMethodSchema>;
export type MerchantCapability = z.infer<typeof MerchantCapabilitySchema>;
export type MerchantMembershipView = z.infer<typeof MerchantMembershipViewSchema>;
export type MerchantScope = z.infer<typeof MerchantScopeSchema>;
export type MerchantProjectView = z.infer<typeof MerchantProjectViewSchema>;
export type MerchantSessionView = z.infer<typeof MerchantSessionViewSchema>;
export type MerchantConfigurationView = z.infer<typeof MerchantConfigurationViewSchema>;
export type OnboardingDraftView = z.infer<typeof OnboardingDraftViewSchema>;
export type ProvisioningOperationView = z.infer<typeof ProvisioningOperationViewSchema>;
export type InvitationView = z.infer<typeof InvitationViewSchema>;
export type TeamView = z.infer<typeof TeamViewSchema>;
export type StepUpChallengeView = z.infer<typeof StepUpChallengeViewSchema>;
export type MerchantErrorBody = z.infer<typeof MerchantErrorBodySchema>;
export type MerchantResponse<T> = { success: true; data: T } | MerchantErrorBody;
