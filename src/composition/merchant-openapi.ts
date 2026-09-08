import { z } from "@hono/zod-openapi";
import { merchantBillingOperations } from "../platform/application/billing-port";
import { merchantBillingRoute } from "../platform/billing";
import { defineContract, type HttpContract } from "../shared/http-contract";

export function merchantBillingContracts(backend: readonly HttpContract[]): HttpContract[] {
	return merchantBillingOperations.flatMap(([method, suffix]) => {
		const original = backend.find(
			(c) => c.method.toUpperCase() === method && c.path === `/v1${suffix}`,
		);
		if (!original) throw new Error(`Missing backend contract: ${method} /v1${suffix}`);
		const path = `/api/billing${suffix.startsWith("/billing-accounts/") ? "/admin" : ""}${suffix}`;
		const sample = path.replace(/:[A-Za-z][A-Za-z0-9]*/g, "11111111-1111-4111-8111-111111111111");
		const sandbox = merchantBillingRoute(method, sample, "sandbox");
		const production = merchantBillingRoute(method, sample, "production");
		if (!sandbox || !production)
			throw new Error(`Operation is not exposed to merchant callers: ${method} ${path}`);
		return [
			defineContract(original.method, path, {
				...original.input,
				operationId: `merchant${original.input.operationId[0]?.toUpperCase()}${original.input.operationId.slice(1)}`,
				tags: ["merchant-billing"],
				security: [{ serviceToken: [], merchantSession: [] }],
				headers: z.object({
					"X-Quotum-Organization": z.string(),
					"X-Quotum-Project": z.string(),
					"X-Quotum-Environment": z.enum(["sandbox", "production"]),
					...(method !== "GET"
						? { "X-CSRF-Token": z.string(), "Idempotency-Key": z.string() }
						: {}),
					"X-Quotum-Step-Up-Grant": z.string().optional(),
				}),
				description: `Requires ${sandbox.capability} in sandbox and ${production.capability} in production. ${production.sensitive ? "Production requires an action-bound step-up grant." : ""} ${sandbox.sensitive ? "Sandbox requires an action-bound step-up grant." : ""}`,
			}),
		];
	});
}
