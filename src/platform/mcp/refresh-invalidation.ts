import type { GenericEndpointContext } from "better-auth";
import { APIError } from "better-auth/api";

type Adapter = GenericEndpointContext["context"]["adapter"];
type FamilyQuery = Pick<Parameters<Adapter["findMany"]>[0], "model" | "where">;

/** The provider's fallback family invalidation selects by user/client, across every grant. */
function isFamilyQuery({ model, where }: FamilyQuery): boolean {
	return (
		model === "oauthRefreshToken" &&
		where?.length === 2 &&
		where.every(
			(part) => (part.operator === undefined || part.operator === "eq") && part.connector !== "OR",
		) &&
		where.some((part) => part.field === "clientId") &&
		where.some((part) => part.field === "userId")
	);
}

/**
 * Better Auth 1.7.5 shallow-copies context for every endpoint dispatch. Replace that
 * request's adapter property, never its shared adapter methods. If grace expires after
 * the precheck, intercept the provider's family read before any broad deletion starts.
 */
export function containMcpRefreshInvalidation(
	ctx: Pick<GenericEndpointContext, "context">,
	grant: { client_id: string; userId: string },
	revokeGrant: () => Promise<unknown>,
): void {
	const adapter = ctx.context.adapter;
	const invalidate = async (query: FamilyQuery): Promise<never> => {
		if (
			query.where?.some((part) => part.field === "clientId" && part.value === grant.client_id) &&
			query.where.some((part) => part.field === "userId" && part.value === grant.userId)
		)
			await revokeGrant();
		throw new APIError("BAD_REQUEST", {
			error: "invalid_grant",
			error_description: "Reconnect Quotum to authorize access.",
		});
	};
	ctx.context.adapter = {
		...adapter,
		async findMany<T>(query: Parameters<Adapter["findMany"]>[0]): Promise<T[]> {
			if (isFamilyQuery(query)) return invalidate(query);
			return adapter.findMany<T>(query);
		},
		async deleteMany(query) {
			if (isFamilyQuery(query)) return invalidate(query);
			return adapter.deleteMany(query);
		},
	};
}
