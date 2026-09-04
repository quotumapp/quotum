import type { ProjectInstanceContext, ProjectInstanceContextResolver } from "../projects/context";

export async function resolveClaimedProjectInstance(
	resolver: ProjectInstanceContextResolver,
	identity: { projectInstanceId?: string; projectInstanceKey: string },
): Promise<ProjectInstanceContext> {
	const result =
		identity.projectInstanceId === undefined
			? await resolver.resolveInstanceKey(identity.projectInstanceKey)
			: await resolver.resolveInstanceId(identity.projectInstanceId);

	if (result.kind !== "resolved") {
		throw new Error(
			`Billing project instance could not be resolved for claimed work: ${result.kind}`,
		);
	}

	if (
		result.context.projectInstanceKey !== identity.projectInstanceKey ||
		(identity.projectInstanceId !== undefined &&
			result.context.projectInstanceId !== identity.projectInstanceId)
	) {
		throw new Error("Claimed work project identity does not match the platform project instance");
	}

	return result.context;
}
