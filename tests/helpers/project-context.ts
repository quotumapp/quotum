import type {
	ProjectInstanceContext,
	ProjectInstanceContextResolver,
	ProjectInstanceLookupResult,
} from "../../src/projects/context";

const idsByKey: Record<string, { organization: string; logicalProject: string; instance: string }> =
	{
		voysee: {
			organization: "00000000-0000-4000-8000-000000000001",
			logicalProject: "00000000-0000-4000-8000-000000000002",
			instance: "00000000-0000-4000-8000-000000000003",
		},
		wiseley: {
			organization: "00000000-0000-4000-8000-000000000011",
			logicalProject: "00000000-0000-4000-8000-000000000012",
			instance: "00000000-0000-4000-8000-000000000013",
		},
	};

export function projectInstanceContext(
	projectInstanceKey = "voysee",
	overrides: Partial<ProjectInstanceContext> = {},
): ProjectInstanceContext {
	const ids = idsByKey[projectInstanceKey] ?? {
		organization: "00000000-0000-4000-8000-000000000021",
		logicalProject: "00000000-0000-4000-8000-000000000022",
		instance: "00000000-0000-4000-8000-000000000023",
	};
	return {
		organizationId: ids.organization,
		organizationSlug: `${projectInstanceKey}-organization`,
		logicalProjectId: ids.logicalProject,
		logicalProjectKey: projectInstanceKey,
		projectInstanceId: ids.instance,
		projectInstanceKey,
		environment: "production",
		lifecycleStatus: "active",
		internalProject: false,
		...overrides,
	};
}

export function projectContextResolver({
	contexts = [projectInstanceContext()],
	credentials = { "test-api-key": "voysee" },
	unavailable = false,
}: {
	contexts?: readonly ProjectInstanceContext[];
	credentials?: Readonly<Record<string, string>>;
	unavailable?: boolean;
} = {}): ProjectInstanceContextResolver {
	const byKey = new Map(contexts.map((context) => [context.projectInstanceKey, context]));
	const byId = new Map(contexts.map((context) => [context.projectInstanceId, context]));
	const result = (context: ProjectInstanceContext | undefined): ProjectInstanceLookupResult => {
		if (unavailable) return { kind: "unavailable" };
		return context === undefined ? { kind: "not_found" } : { kind: "resolved", context };
	};
	return {
		async resolveCredential(credential) {
			return result(byKey.get(credentials[credential] ?? ""));
		},
		async resolveInstanceKey(projectInstanceKey) {
			return result(byKey.get(projectInstanceKey));
		},
		async resolveInstanceId(projectInstanceId) {
			return result(byId.get(projectInstanceId));
		},
	};
}
