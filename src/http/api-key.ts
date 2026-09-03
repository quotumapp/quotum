import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { ProjectApiKeyResolver } from "../projects/config";
import type { ProjectContext } from "../projects/context";

export function requireApiKey(
	expectedApiKeyOrResolver: string | ProjectApiKeyResolver,
): MiddlewareHandler<{ Variables: { project: ProjectContext } }> {
	return async (c, next) => {
		const authorization = c.req.header("authorization");
		const project = resolveProjectContext(expectedApiKeyOrResolver, authorization);

		if (project === null) {
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

		c.set("project", project);
		await next();
	};
}

function resolveProjectContext(
	expectedApiKeyOrResolver: string | ProjectApiKeyResolver,
	authorization: string | undefined,
): ProjectContext | null {
	if (typeof expectedApiKeyOrResolver === "string") {
		const expected = `Bearer ${expectedApiKeyOrResolver}`;
		return constantTimeEquals(authorization ?? "", expected) ? { projectKey: "voysee" } : null;
	}

	const token = parseBearerToken(authorization);
	return token === null ? null : expectedApiKeyOrResolver(token);
}

function parseBearerToken(authorization: string | undefined): string | null {
	const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
	return match?.[1] ?? null;
}

export function constantTimeEquals(actual: string, expected: string): boolean {
	const actualBuffer = Buffer.from(actual, "utf8");
	const expectedBuffer = Buffer.from(expected, "utf8");

	if (actualBuffer.byteLength !== expectedBuffer.byteLength) {
		return false;
	}

	return timingSafeEqual(actualBuffer, expectedBuffer);
}
