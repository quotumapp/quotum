import { z } from "zod";
import { requireIdempotencyKey } from "../billing/idempotency-key";
import {
	type ProviderCustomerUnlinkServiceLike,
	providerCustomerIdMaxLength,
	providerCustomerUnlinkReasonMaxLength,
	stripeCustomerIdPattern,
} from "../billing/provider-customer-unlinks";
import { type BillingLogger, safelyLogInfo } from "../observability/logger";
import { LENIENT_JSON_PARSE, operationDetail } from "../shared/http";
import { decimalDigitsQuery } from "../shared/input-bounds";
import { operatorKeyPaths } from "../shared/operator-key-paths";
import { operatorApiKeyGuard } from "./admin-routes";
import * as responses from "./contracts/provider-customer-unlink-responses";
import { privateProject, rejectCallerProjectSelectorBody, requireActor } from "./request-context";
import type { BillingElysia, PostAuthGuard } from "./types";

export interface ProviderCustomerUnlinkRoutesDependencies {
	app: BillingElysia;
	operatorApiKey: string | null;
	service: ProviderCustomerUnlinkServiceLike;
	billingLogger: BillingLogger;
	registerPostAuthGuard(guard: PostAuthGuard): void;
}

const accountParams = z.object({ billingAccountId: z.string().trim().min(1).max(200) }).strict();

export const providerCustomerUnlinkBodySchema = z
	.object({
		// Only a Stripe link can be removed; the other providers' links are not operator-repairable.
		provider: z.literal("stripe"),
		externalCustomerId: z
			.string()
			.trim()
			.max(providerCustomerIdMaxLength)
			.regex(stripeCustomerIdPattern),
		reason: z.string().trim().min(1).max(providerCustomerUnlinkReasonMaxLength),
	})
	.strict();

const listQuerySchema = z
	.object({
		limit: decimalDigitsQuery(z.coerce.number().int().positive().max(100).default(25)),
		cursor: z.string().trim().min(1).optional(),
	})
	.strict();

export function registerProviderCustomerUnlinkRoutes({
	app,
	operatorApiKey,
	service,
	billingLogger,
	registerPostAuthGuard,
}: ProviderCustomerUnlinkRoutesDependencies): void {
	registerPostAuthGuard(
		operatorApiKeyGuard(operatorApiKey, operatorKeyPaths.providerCustomerUnlinks),
	);

	app.post(
		"/v1/admin/provider-customer-unlinks/:billingAccountId",
		async ({ body, params, request, project, set }) => {
			const scopedProject = privateProject(project);
			const result = await service.unlinkProviderCustomer(scopedProject, {
				billingAccountId: params.billingAccountId,
				provider: body.provider,
				externalCustomerId: body.externalCustomerId,
				reason: body.reason,
				actor: requireActor(request.headers),
				idempotencyKey: requireIdempotencyKey(request.headers.get("idempotency-key")),
			});
			if (!result.duplicate) {
				// Ids only: the actor and the reason may name a person and stay in the receipt.
				safelyLogInfo(billingLogger, "Billing admin provider customer unlinked", {
					projectKey: scopedProject.projectInstanceKey,
					billingAccountId: result.unlink.billingAccountId,
					provider: result.unlink.provider,
					externalCustomerId: result.unlink.externalCustomerId,
					unlinkId: result.unlink.id,
				});
			}
			set.status = result.duplicate ? 200 : 201;
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: accountParams,
			body: providerCustomerUnlinkBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminProviderCustomerUnlinksByBillingAccountId",
				tags: ["provider-customers"],
				path: "/v1/admin/provider-customer-unlinks/:billingAccountId",
				responses: {
					200: responses.postV1AdminProviderCustomerUnlinksByBillingAccountIdResponse200Schema,
					201: responses.postV1AdminProviderCustomerUnlinksByBillingAccountIdResponse201Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/admin/provider-customer-unlinks/:billingAccountId",
		async ({ params, query, project }) => {
			const result = await service.listProviderCustomerUnlinks(
				privateProject(project),
				params.billingAccountId,
				{ limit: query.limit, cursor: query.cursor ?? null },
			);
			return { success: true, data: result.items, pagination: { nextCursor: result.nextCursor } };
		},
		{
			params: accountParams,
			query: listQuerySchema,
			detail: operationDetail({
				operationId: "getV1AdminProviderCustomerUnlinksByBillingAccountId",
				tags: ["provider-customers"],
				path: "/v1/admin/provider-customer-unlinks/:billingAccountId",
				responses: {
					200: responses.getV1AdminProviderCustomerUnlinksByBillingAccountIdResponse200Schema,
				},
			}),
		},
	);
}
