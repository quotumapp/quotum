import { z } from "@hono/zod-openapi";

/** Authored merchant wire contracts; OpenAPI and server types derive from these schemas. */

export const MerchantRoleSchema = z
	.enum(["Owner", "Admin", "Developer", "Operator", "Viewer"])
	.openapi("MerchantRole");

export const MerchantEnvironmentSchema = z
	.enum(["sandbox", "production"])
	.openapi("MerchantEnvironment");

export const MerchantAuthMethodSchema = z
	.enum(["password", "google"])
	.openapi("MerchantAuthMethod");

export const MerchantCapabilitySchema = z
	.enum([
		"billing.read",
		"team.manage",
		"project.create",
		"sandbox.configure",
		"sandbox.credentials.rotate",
		"catalog.author",
		"catalog.publish.sandbox",
		"catalog.publish.production",
		"operations.recover",
		"operations.write",
		"production.manage",
	])
	.openapi("MerchantCapability");

export const MerchantMembershipViewSchema = z
	.object({
		id: z.string(),
		organizationId: z.string(),
		organizationName: z.string(),
		organizationSlug: z.string(),
		role: MerchantRoleSchema,
		capabilities: z.array(MerchantCapabilitySchema),
	})
	.openapi("MerchantMembershipView");

export const MerchantScopeSchema = z
	.object({
		kind: z.literal("merchant"),
		organizationSlug: z.string(),
		projectKey: z.string(),
		environment: MerchantEnvironmentSchema,
	})
	.openapi("MerchantScope");

export const MerchantProjectViewSchema = z
	.object({
		id: z.string(),
		key: z.string(),
		name: z.string(),
		organizationSlug: z.string(),
		environments: z.array(
			z.object({ environment: MerchantEnvironmentSchema, active: z.boolean() }),
		),
	})
	.openapi("MerchantProjectView");

export const MerchantConfigurationViewSchema = z
	.object({
		csrfToken: z.string(),
		signupEnabled: z.boolean(),
		googleEnabled: z.boolean(),
		termsVersion: z.string(),
		privacyVersion: z.string(),
		publicUrl: z.string(),
	})
	.openapi("MerchantConfigurationView");

export const OnboardingDraftViewSchema = z
	.object({
		id: z.string(),
		organization: z.union([
			z.null(),
			z.object({ id: z.string(), name: z.string(), slug: z.string() }),
		]),
		project: z.union([z.null(), z.object({ name: z.string(), key: z.string() })]),
		revision: z.number(),
		status: z.enum(["organization", "project", "provisioning", "ready"]),
		operationId: z.union([z.null(), z.string()]),
	})
	.openapi("OnboardingDraftView");

export const MerchantSessionViewSchema = z
	.object({
		pendingInvitation: z.boolean(),
		principal: z.object({ id: z.string(), name: z.string(), email: z.string() }),
		authMethod: MerchantAuthMethodSchema,
		idleExpiresAt: z.string(),
		absoluteExpiresAt: z.string(),
		memberships: z.array(MerchantMembershipViewSchema),
		projects: z.array(MerchantProjectViewSchema),
		context: z.union([z.null(), MerchantScopeSchema]),
		onboarding: z.union([z.null(), OnboardingDraftViewSchema]),
		csrfToken: z.string(),
	})
	.openapi("MerchantSessionView");

export const ProvisioningOperationViewSchema = z
	.object({
		id: z.string(),
		status: z.enum(["provisioning", "pending", "succeeded", "failed", "partially_provisioned"]),
		projectKey: z.string(),
		organizationSlug: z.string(),
		steps: z.array(
			z.object({
				environment: MerchantEnvironmentSchema,
				status: z.enum(["pending", "succeeded", "failed"]),
			}),
		),
		retryable: z.boolean(),
		credentialDelivery: z.enum(["available", "delivered", "unavailable"]),
		error: z.union([z.null(), z.string()]),
	})
	.openapi("ProvisioningOperationView");

export const InvitationViewSchema = z
	.object({
		id: z.string(),
		organizationName: z.string(),
		organizationSlug: z.string(),
		email: z.string(),
		role: z.enum(["Admin", "Developer", "Operator", "Viewer"]),
		expiresAt: z.string(),
		status: z.enum([
			"valid",
			"expired",
			"used",
			"revoked",
			"replaced",
			"wrong_email",
			"already_member",
			"inviter_authority_lost",
			"seat_limit",
		]),
	})
	.openapi("InvitationView");

export const TeamViewSchema = z
	.object({
		roleDefinitions: z.array(
			z.object({ role: MerchantRoleSchema, capabilities: z.array(MerchantCapabilitySchema) }),
		),
		organizationSlug: z.string(),
		members: z.array(
			z.object({
				id: z.string(),
				name: z.string(),
				email: z.string(),
				role: MerchantRoleSchema,
				status: z.enum(["active", "suspended", "removed"]),
			}),
		),
		invitations: z.array(InvitationViewSchema),
		canManage: z.boolean(),
	})
	.openapi("TeamView");

export const StepUpChallengeViewSchema = z
	.object({
		request: z
			.object({
				method: z.enum(["POST", "PUT", "DELETE"]),
				path: z.string(),
				body: z.unknown(),
				idempotencyKey: z.string(),
			})
			.optional(),
		id: z.string(),
		method: MerchantAuthMethodSchema,
		action: z.string(),
		target: z.string(),
		scope: MerchantScopeSchema,
		expiresAt: z.string(),
		returnTo: z.string(),
	})
	.openapi("StepUpChallengeView");

export const MerchantErrorBodySchema = z
	.object({
		success: z.literal(false),
		error: z.object({
			code: z.string(),
			message: z.string(),
			retryAfter: z.number().optional(),
			requestId: z.string().optional(),
		}),
	})
	.openapi("MerchantErrorBody");
