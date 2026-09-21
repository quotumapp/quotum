import type { CredentialAccess } from "../shared/credential-access";

export const projectEnvironments = ["sandbox", "production", "internal"] as const;
export type ProjectEnvironment = (typeof projectEnvironments)[number];

export const projectLifecycleStatuses = [
	"inactive",
	"active",
	"suspended",
	"deactivating",
	"deactivated",
] as const;
export type ProjectLifecycleStatus = (typeof projectLifecycleStatuses)[number];

export interface ProjectInstanceContext {
	readonly organizationId: string;
	readonly organizationSlug: string;
	readonly logicalProjectId: string;
	readonly logicalProjectKey: string;
	readonly projectInstanceId: string;
	readonly projectInstanceKey: string;
	readonly environment: ProjectEnvironment;
	readonly lifecycleStatus: ProjectLifecycleStatus;
	readonly internalProject: boolean;
	readonly organizationStatus?: "active" | "suspended" | "removed";
}

export type ProjectInstanceLookupResult =
	| { kind: "resolved"; context: ProjectInstanceContext }
	| { kind: "not_found" }
	| { kind: "ineligible" }
	| { kind: "unavailable" };

/**
 * A credential lookup also reports what the credential may do. `access` is required on purpose: a
 * resolver that omits it fails typecheck instead of being read as full access.
 */
export type ProjectCredentialLookupResult =
	| { kind: "resolved"; context: ProjectInstanceContext; access: CredentialAccess }
	| { kind: "not_found" }
	| { kind: "ineligible" }
	| { kind: "unavailable" };

export interface ProjectInstanceContextResolver {
	resolveCredential(credential: string): Promise<ProjectCredentialLookupResult>;
	resolveInstanceKey(projectInstanceKey: string): Promise<ProjectInstanceLookupResult>;
	resolveInstanceId(projectInstanceId: string): Promise<ProjectInstanceLookupResult>;
}

export function isTenantTrafficEligible(context: ProjectInstanceContext): boolean {
	return (
		context.lifecycleStatus === "active" &&
		!context.internalProject &&
		(context.organizationStatus === undefined || context.organizationStatus === "active")
	);
}
