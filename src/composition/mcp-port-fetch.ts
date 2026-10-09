import {
	allowedOnInactiveEnvironment,
	billingOperation,
	type MerchantBillingPort,
} from "../platform/application/billing-port";
import type { BillingFetch } from "../sdk/client";
import { hasUnstorableText, urlHasEncodedNul } from "../shared/input-bounds";

/** Called only through the MCP request allowlist; authority comes from the verified grant. */
export function createMcpPortFetch(input: {
	port: MerchantBillingPort;
	projectInstanceId: string;
	principalId: string;
	/** An `inactive` environment (a production not yet activated) serves only the catalog. */
	environmentStatus?: "active" | "inactive";
}): BillingFetch {
	return async (resource, init) => {
		const request = new Request(resource, init);
		const url = new URL(request.url);
		// Tool arguments become path segments and query values; refuse what Postgres cannot store.
		if (urlHasEncodedNul(request.url) || hasUnstorableText([...url.searchParams]))
			return Response.json(
				{
					success: false,
					error: { code: "INVALID_REQUEST", message: "Request text must be storable." },
				},
				{ status: 400 },
			);
		const operation = billingOperation(request.method, url.pathname);
		if (!operation) throw new Error("MCP operation has no merchant port mapping");
		if (
			input.environmentStatus === "inactive" &&
			!allowedOnInactiveEnvironment(operation.operation)
		)
			return Response.json(
				{
					success: false,
					error: {
						code: "ENVIRONMENT_INACTIVE",
						message:
							"This environment is not activated yet. Only the catalog can be read until it is activated in the Quotum console.",
					},
				},
				{ status: 409 },
			);
		const result = await input.port.dispatch({
			...operation,
			projectInstanceId: input.projectInstanceId,
			actor: `merchant:${input.principalId}`,
			query: Object.fromEntries(url.searchParams),
			body: request.method === "GET" ? undefined : await request.json(),
			idempotencyKey: null,
		});
		return Response.json(result.body, { status: result.status });
	};
}
