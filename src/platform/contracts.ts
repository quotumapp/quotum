/** Browser-safe merchant contracts. Never add credentials or provider tokens to these views. */
export type MerchantRole = "Owner" | "Admin" | "Developer" | "Operator" | "Viewer";
export type MerchantEnvironment = "sandbox" | "production";
export type MerchantAuthMethod = "password" | "google";
export type MerchantCapability =
	| "billing.read"
	| "team.manage"
	| "project.create"
	| "sandbox.configure"
	| "sandbox.credentials.rotate"
	| "catalog.author"
	| "catalog.publish.sandbox"
	| "catalog.publish.production"
	| "operations.recover"
	| "operations.write"
	| "production.manage";

export interface MerchantMembershipView {
	id: string;
	organizationId: string;
	organizationName: string;
	organizationSlug: string;
	role: MerchantRole;
	capabilities: MerchantCapability[];
}
export interface MerchantScope {
	kind: "merchant";
	organizationSlug: string;
	projectKey: string;
	environment: MerchantEnvironment;
}
export interface MerchantProjectView {
	id: string;
	key: string;
	name: string;
	organizationSlug: string;
	environments: { environment: MerchantEnvironment; active: boolean }[];
}
export interface MerchantSessionView {
	pendingInvitation: boolean;
	principal: { id: string; name: string; email: string };
	authMethod: MerchantAuthMethod;
	idleExpiresAt: string;
	absoluteExpiresAt: string;
	memberships: MerchantMembershipView[];
	projects: MerchantProjectView[];
	context: MerchantScope | null;
	onboarding: OnboardingDraftView | null;
	csrfToken: string;
}
export interface MerchantConfigurationView {
	csrfToken: string;
	signupEnabled: boolean;
	googleEnabled: boolean;
	termsVersion: string;
	privacyVersion: string;
	publicUrl: string;
}
export interface OnboardingDraftView {
	id: string;
	organization: { id: string; name: string; slug: string } | null;
	project: { name: string; key: string } | null;
	revision: number;
	status: "organization" | "project" | "provisioning" | "ready";
	operationId: string | null;
}
export interface ProvisioningOperationView {
	id: string;
	status: "pending" | "provisioning" | "succeeded" | "failed" | "partially_provisioned";
	projectKey: string;
	organizationSlug: string;
	steps: { environment: MerchantEnvironment; status: "pending" | "succeeded" | "failed" }[];
	retryable: boolean;
	credentialDelivery: "available" | "delivered" | "unavailable";
	error: string | null;
}
export interface InvitationView {
	id: string;
	organizationName: string;
	organizationSlug: string;
	email: string;
	role: Exclude<MerchantRole, "Owner">;
	expiresAt: string;
	status:
		| "valid"
		| "expired"
		| "used"
		| "revoked"
		| "replaced"
		| "wrong_email"
		| "already_member"
		| "inviter_authority_lost"
		| "seat_limit";
}
export interface TeamView {
	organizationSlug: string;
	members: {
		id: string;
		name: string;
		email: string;
		role: MerchantRole;
		status: "active" | "suspended" | "removed";
	}[];
	invitations: InvitationView[];
	canManage: boolean;
}
export interface StepUpChallengeView {
	request?: {
		method: "POST" | "PUT" | "DELETE";
		path: string;
		body: unknown;
		idempotencyKey: string;
	};
	id: string;
	method: MerchantAuthMethod;
	action: string;
	target: string;
	scope: MerchantScope;
	expiresAt: string;
	returnTo: string;
}
export interface MerchantErrorBody {
	success: false;
	error: { code: string; message: string; retryAfter?: number; requestId?: string };
}
export type MerchantResponse<T> = { success: true; data: T } | MerchantErrorBody;
