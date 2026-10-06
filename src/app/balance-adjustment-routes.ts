import { z } from "zod";
import {
	adjustmentReasonMaxLength,
	administrativeDebitMaxAllocations,
	type BalanceAdjustmentServiceLike,
} from "../billing/balance-adjustments";
import { requireIdempotencyKey } from "../billing/idempotency-key";
import { LENIENT_JSON_PARSE, operationDetail } from "../shared/http";
import { decimalDigitsQuery, isBigintId, storableDateTimeSchema } from "../shared/input-bounds";
import { operatorApiKeyGuard } from "./admin-routes";
import * as responses from "./contracts/balance-adjustment-responses";
import { privateProject, rejectCallerProjectSelectorBody, requireActor } from "./request-context";
import type { BillingElysia, PostAuthGuard } from "./types";

export interface BalanceAdjustmentRoutesDependencies {
	app: BillingElysia;
	operatorApiKey: string | null;
	service: BalanceAdjustmentServiceLike;
	registerPostAuthGuard(guard: PostAuthGuard): void;
}

/** Operator grants and administrative debits change balances, so both need the operator key. */
export function isBalanceAdjustmentPath(path: string): boolean {
	return (
		path.startsWith("/v1/admin/operator-grants/") ||
		path.startsWith("/v1/admin/administrative-debits/")
	);
}

const accountParams = z.object({ billingAccountId: z.string().trim().min(1).max(200) }).strict();
const grantParams = accountParams.extend({ grantId: z.uuid() }).strict();
const reason = z.string().trim().min(1).max(adjustmentReasonMaxLength);
const quantity = z.string().trim().min(1).max(40);

export const operatorGrantBodySchema = z
	.object({
		featureKey: z.string().trim().min(1).max(120),
		quantity,
		entityId: z.string().trim().min(1).max(200).nullable().optional(),
		expiresAt: storableDateTimeSchema().nullable().optional(),
		reason,
	})
	.strict();

export const operatorGrantRevokeBodySchema = z.object({ reason }).strict();

export const administrativeDebitBodySchema = z
	.object({
		reason,
		allocations: z
			.array(
				z
					.object({
						allocationId: z
							.string()
							.regex(/^[1-9]\d{0,18}$/)
							.refine(isBigintId),
						quantity,
					})
					.strict(),
			)
			.min(1)
			.max(administrativeDebitMaxAllocations),
	})
	.strict();

const listQuerySchema = z
	.object({
		limit: decimalDigitsQuery(z.coerce.number().int().positive().max(100).default(25)),
		cursor: z.string().trim().min(1).optional(),
	})
	.strict();

export function registerBalanceAdjustmentRoutes({
	app,
	operatorApiKey,
	service,
	registerPostAuthGuard,
}: BalanceAdjustmentRoutesDependencies): void {
	registerPostAuthGuard(operatorApiKeyGuard(operatorApiKey, isBalanceAdjustmentPath));

	app.post(
		"/v1/admin/operator-grants/:billingAccountId",
		async ({ body, params, request, project, set }) => {
			const result = await service.grantOperatorBalance(privateProject(project), {
				billingAccountId: params.billingAccountId,
				featureKey: body.featureKey,
				quantity: body.quantity,
				entityId: body.entityId ?? null,
				expiresAt:
					body.expiresAt === undefined || body.expiresAt === null ? null : new Date(body.expiresAt),
				reason: body.reason,
				actor: requireActor(request.headers),
				idempotencyKey: requireIdempotencyKey(request.headers.get("idempotency-key")),
			});
			set.status = result.duplicate ? 200 : 201;
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: accountParams,
			body: operatorGrantBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminOperatorGrantsByBillingAccountId",
				tags: ["balance-adjustments"],
				path: "/v1/admin/operator-grants/:billingAccountId",
				responses: {
					200: responses.postV1AdminOperatorGrantsByBillingAccountIdResponse200Schema,
					201: responses.postV1AdminOperatorGrantsByBillingAccountIdResponse201Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/admin/operator-grants/:billingAccountId",
		async ({ params, query, project }) => {
			const result = await service.listOperatorGrants(
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
				operationId: "getV1AdminOperatorGrantsByBillingAccountId",
				tags: ["balance-adjustments"],
				path: "/v1/admin/operator-grants/:billingAccountId",
				responses: {
					200: responses.getV1AdminOperatorGrantsByBillingAccountIdResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/admin/operator-grants/:billingAccountId/:grantId",
		async ({ params, project }) => ({
			success: true,
			data: await service.getOperatorGrant(
				privateProject(project),
				params.billingAccountId,
				params.grantId,
			),
		}),
		{
			params: grantParams,
			detail: operationDetail({
				operationId: "getV1AdminOperatorGrantsByBillingAccountIdByGrantId",
				tags: ["balance-adjustments"],
				path: "/v1/admin/operator-grants/:billingAccountId/:grantId",
				responses: {
					200: responses.getV1AdminOperatorGrantsByBillingAccountIdByGrantIdResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/admin/operator-grants/:billingAccountId/:grantId/revoke",
		async ({ body, params, request, project }) => ({
			success: true,
			data: await service.revokeOperatorGrant(privateProject(project), {
				billingAccountId: params.billingAccountId,
				grantId: params.grantId,
				reason: body.reason,
				actor: requireActor(request.headers),
				idempotencyKey: requireIdempotencyKey(request.headers.get("idempotency-key")),
			}),
		}),
		{
			parse: [LENIENT_JSON_PARSE],
			params: grantParams,
			body: operatorGrantRevokeBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminOperatorGrantsByBillingAccountIdByGrantIdRevoke",
				tags: ["balance-adjustments"],
				path: "/v1/admin/operator-grants/:billingAccountId/:grantId/revoke",
				responses: {
					200: responses.postV1AdminOperatorGrantsByBillingAccountIdByGrantIdRevokeResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/admin/administrative-debits/:billingAccountId",
		async ({ body, params, request, project, set }) => {
			const result = await service.debitAllocations(privateProject(project), {
				billingAccountId: params.billingAccountId,
				allocations: body.allocations,
				reason: body.reason,
				actor: requireActor(request.headers),
				idempotencyKey: requireIdempotencyKey(request.headers.get("idempotency-key")),
			});
			set.status = result.duplicate ? 200 : 201;
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: accountParams,
			body: administrativeDebitBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminAdministrativeDebitsByBillingAccountId",
				tags: ["balance-adjustments"],
				path: "/v1/admin/administrative-debits/:billingAccountId",
				responses: {
					200: responses.postV1AdminAdministrativeDebitsByBillingAccountIdResponse200Schema,
					201: responses.postV1AdminAdministrativeDebitsByBillingAccountIdResponse201Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/admin/administrative-debits/:billingAccountId",
		async ({ params, query, project }) => {
			const result = await service.listAdministrativeDebits(
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
				operationId: "getV1AdminAdministrativeDebitsByBillingAccountId",
				tags: ["balance-adjustments"],
				path: "/v1/admin/administrative-debits/:billingAccountId",
				responses: {
					200: responses.getV1AdminAdministrativeDebitsByBillingAccountIdResponse200Schema,
				},
			}),
		},
	);
}
