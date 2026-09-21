import { z } from "zod";
import type { ProviderCapabilityReads } from "../providers/capability-read-types";
import { operationDetail } from "../shared/http";
import * as adminResponses from "./contracts/admin-responses";
import * as customerResponses from "./contracts/customer-responses";
import { privateProject } from "./request-context";
import type { BillingElysia } from "./types";

const accountParamsSchema = z.object({ billingAccountId: z.string().trim().min(1) });

/**
 * Provider capability reads. Both answer from persisted connection state and billing rows, so they
 * need the project key only and never reach a provider.
 */
export function registerCapabilityRoutes(input: {
	app: BillingElysia;
	reads: ProviderCapabilityReads;
}): void {
	const { app, reads } = input;

	app.get(
		"/v1/admin/providers/capabilities",
		async ({ project }) => {
			const capabilities = await reads.environment(privateProject(project));
			return { success: true, data: capabilities };
		},
		{
			detail: operationDetail({
				operationId: "getV1AdminProvidersCapabilities",
				credentialAccess: "read_only",
				tags: ["admin"],
				path: "/v1/admin/providers/capabilities",
				responses: { 200: adminResponses.getV1AdminProvidersCapabilitiesResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/available-actions",
		async ({ params, project }) => {
			const actions = await reads.availableActions(
				privateProject(project),
				params.billingAccountId,
			);
			return { success: true, data: actions };
		},
		{
			params: accountParamsSchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdAvailableActions",
				credentialAccess: "read_only",
				tags: ["customer"],
				path: "/v1/billing-accounts/:billingAccountId/available-actions",
				responses: {
					200: customerResponses.getV1BillingAccountsByBillingAccountIdAvailableActionsResponse200Schema,
				},
			}),
		},
	);
}
