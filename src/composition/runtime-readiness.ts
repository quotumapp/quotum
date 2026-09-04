import { checkPostgresHealth } from "../db/client";
import type { ProjectRuntimeConfig } from "../projects/config";
import { checkProjectRuntimeConfiguration } from "./project-instance-persistence";

export function createBillingReadinessCheck(
	projectRuntime: readonly ProjectRuntimeConfig[],
): () => Promise<boolean> {
	return async () =>
		(await checkPostgresHealth()) && (await checkProjectRuntimeConfiguration(projectRuntime));
}
