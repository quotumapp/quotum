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

export interface ProjectInstanceContextResolver {
	resolveCredential(credential: string): Promise<ProjectInstanceLookupResult>;
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
