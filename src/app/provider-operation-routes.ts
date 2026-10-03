import { z } from "zod";
import { NotConfiguredError } from "../billing/errors";
import {
	type ProviderOperation,
	type ProviderOperationStore,
	providerOperationReceipt,
	providerOperationStatuses,
} from "../billing/provider-operations";
import type { ProjectInstanceContext } from "../projects/context";
import { operationDetail } from "../shared/http";
import { billingProviders } from "../shared/provider-capabilities";
import { privateProject, requireActor } from "./request-context";
import type { BillingElysia } from "./types";

export const providerOperationParamsSchema = z.object({
	billingAccountId: z.string().trim().min(1).max(200),
	operationId: z.uuid(),
});
export const providerOperationResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		id: z.uuid(),
		provider: z.enum(billingProviders),
		operation: z.string(),
		status: z.enum(providerOperationStatuses),
		providerObjectId: z.string().nullable(),
		errorCode: z.string().nullable(),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime(),
	}),
});

export function registerProviderOperationRoutes(input: {
	app: BillingElysia;
	store: Pick<ProviderOperationStore, "get">;
	reconcile?: (
		project: ProjectInstanceContext,
		billingAccountId: string,
		operationId: string,
		actor: string,
	) => Promise<ProviderOperation>;
}): void {
	input.app.post(
		"/v1/admin/billing-accounts/:billingAccountId/provider-operations/:operationId/reconcile",
		async ({ params, project, request }) => {
			const actor = requireActor(request.headers);
			if (!input.reconcile)
				throw new NotConfiguredError("Provider operation recovery is unavailable");
			return {
				success: true,
				data: providerOperationReceipt(
					await input.reconcile(
						privateProject(project),
						params.billingAccountId,
						params.operationId,
						actor,
					),
				),
			};
		},
		{
			parse: "none",
			params: providerOperationParamsSchema,
			detail: operationDetail({
				operationId:
					"postV1AdminBillingAccountsByBillingAccountIdProviderOperationsByOperationIdReconcile",
				path: "/v1/admin/billing-accounts/:billingAccountId/provider-operations/:operationId/reconcile",
				tags: ["admin"],
				description:
					"Audits X-Billing-Actor and re-observes the effect with the recorded connection version. Never redispatches or forces a successful outcome.",
				responses: { 200: providerOperationResponseSchema },
			}),
		},
	);
	input.app.get(
		"/v1/billing-accounts/:billingAccountId/provider-operations/:operationId",
		async ({ params, project }) => ({
			success: true,
			data: providerOperationReceipt(
				await input.store.get(privateProject(project), params.billingAccountId, params.operationId),
			),
		}),
		{
			params: providerOperationParamsSchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdProviderOperationsByOperationId",
				credentialAccess: "read_only",
				tags: ["customer"],
				path: "/v1/billing-accounts/:billingAccountId/provider-operations/:operationId",
				responses: { 200: providerOperationResponseSchema },
			}),
		},
	);
}
