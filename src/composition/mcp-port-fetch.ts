import { billingOperation, type MerchantBillingPort } from "../platform/application/billing-port";
import type { BillingFetch } from "../sdk/client";

/** Called only through the MCP request allowlist; authority comes from the verified grant. */
export function createMcpPortFetch(input: {
	port: MerchantBillingPort;
	projectInstanceId: string;
	principalId: string;
}): BillingFetch {
	return async (resource, init) => {
		const request = new Request(resource, init);
		const url = new URL(request.url);
		const operation = billingOperation(request.method, url.pathname);
		if (!operation) throw new Error("MCP operation has no merchant port mapping");
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
