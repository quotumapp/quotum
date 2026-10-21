import { z } from "zod";

/** Organization authority comes from OAuth; callers choose only a project and environment. */
export const mcpTargetSchema = z.object({
	projectKey: z
		.string()
		.min(1)
		.max(80)
		.regex(/^[a-z0-9][a-z0-9_-]*$/u),
	environment: z.enum(["sandbox", "production"]),
});

export type McpTarget = z.infer<typeof mcpTargetSchema>;
