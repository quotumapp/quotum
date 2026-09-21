import type { OpenAPIObject } from "openapi3-ts/oas31";
import { merchantBillingOperations } from "../platform/application/billing-port";
import { merchantBillingRoute } from "../platform/billing";
import { CREDENTIAL_ACCESS_EXTENSION } from "../shared/http";

/**
 * Re-expose the /v1 staff operations that the merchant BFF proxies as /api/billing operations.
 * Reads the generated staff document so the copies can never drift from the backend contract.
 */
export function rewriteStaffOperationsForMerchantBilling(
	staffDocument: OpenAPIObject,
): Record<string, unknown> {
	const paths: Record<string, unknown> = {};
	for (const entry of merchantBillingOperations) {
		const [method, suffix] = entry;
		const staffPath = `/v1${suffix}`.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}");
		const item = staffDocument.paths?.[staffPath] as Record<string, unknown> | undefined;
		const operation = item?.[method.toLowerCase()];
		if (!item || !operation) throw new Error(`Missing backend operation: ${method} ${staffPath}`);
		const path = `/api/billing${suffix.startsWith("/billing-accounts/") ? "/admin" : ""}${suffix}`;
		const sample = path.replace(/:[A-Za-z][A-Za-z0-9]*/g, "11111111-1111-4111-8111-111111111111");
		const sandbox = merchantBillingRoute(method, sample, "sandbox");
		const production = merchantBillingRoute(method, sample, "production");
		if (!sandbox || !production)
			throw new Error(`Operation is not exposed to merchant callers: ${method} ${path}`);
		const source = operation as Record<string, unknown>;
		const operationId = `merchant${String(source.operationId)[0]?.toUpperCase()}${String(source.operationId).slice(1)}`;
		const rewritten = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
		rewritten.operationId = operationId;
		rewritten.tags = ["merchant-billing"];
		rewritten.security = [{ serviceToken: [], merchantSession: [] }];
		// Project credentials never reach the merchant surface, so their access level means nothing here.
		delete rewritten[CREDENTIAL_ACCESS_EXTENSION];
		rewritten.description = `Requires ${sandbox.capability} in sandbox and ${production.capability} in production. ${production.sensitive ? "Production requires an action-bound step-up grant." : ""} ${sandbox.sensitive ? "Sandbox requires an action-bound step-up grant." : ""}`;
		const headerParameters = [
			{
				in: "header",
				name: "X-Quotum-Organization",
				required: true,
				schema: { type: "string" },
			},
			{ in: "header", name: "X-Quotum-Project", required: true, schema: { type: "string" } },
			{
				in: "header",
				name: "X-Quotum-Environment",
				required: true,
				schema: { type: "string", enum: ["sandbox", "production"] },
			},
			...(method.toUpperCase() !== "GET"
				? [
						{ in: "header", name: "X-CSRF-Token", required: true, schema: { type: "string" } },
						{
							in: "header",
							name: "Idempotency-Key",
							required: true,
							schema: { type: "string" },
						},
					]
				: []),
			{
				in: "header",
				name: "X-Quotum-Step-Up-Grant",
				required: false,
				schema: { type: "string" },
			},
			...(method.toUpperCase() !== "GET"
				? [{ in: "header", name: "Origin", required: true, schema: { type: "string" } }]
				: []),
		];
		const parameters = Array.isArray(rewritten.parameters)
			? (rewritten.parameters as Record<string, unknown>[])
			: [];
		rewritten.parameters = [
			...parameters.filter((parameter) => parameter.in !== "header"),
			...headerParameters,
		];
		const documentPath = path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, "{$1}");
		paths[documentPath] = {
			// Several methods share one path (e.g. controls GET+PUT); merge instead of overwrite.
			...((paths[documentPath] ?? {}) as Record<string, unknown>),
			[method.toLowerCase()]: rewritten,
		};
	}
	return paths;
}
