import type { MiddlewareHandler } from "hono";
import {
	isTenantTrafficEligible,
	type ProjectInstanceContext,
	type ProjectInstanceContextResolver,
} from "../projects/context";

export function requireApiKey(
	resolver: ProjectInstanceContextResolver,
): MiddlewareHandler<{ Variables: { project: ProjectInstanceContext } }> {
	return async (c, next) => {
		const token = parseBearerToken(c.req.header("authorization"));
		const resolution =
			token === null ? { kind: "not_found" as const } : await resolver.resolveCredential(token);

		if (resolution.kind === "unavailable") {
			return c.json(
				{
					success: false,
					error: {
						code: "BILLING_PROJECT_CONTEXT_UNAVAILABLE",
						message: "Billing project context is unavailable",
					},
				},
				503,
			);
		}

		if (resolution.kind !== "resolved" || !isTenantTrafficEligible(resolution.context)) {
			return c.json(
				{
					success: false,
					error: {
						code: "UNAUTHORIZED",
						message: "Invalid billing API key",
					},
				},
				401,
			);
		}

		c.set("project", resolution.context);
		await next();
	};
}

function parseBearerToken(authorization: string | undefined): string | null {
	const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
	return match?.[1] ?? null;
}
