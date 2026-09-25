import { z } from "zod";
import { InvalidRequestError } from "../billing/errors";
import { type TrialServiceLike, trialDurationMaxDays } from "../billing/plan-grants";
import { LENIENT_JSON_PARSE, operationDetail } from "../shared/http";
import * as responses from "./contracts/trial-responses";
import { requirePromotionIdempotencyKey } from "./promotion-routes";
import { privateProject, rejectCallerProjectSelectorBody } from "./request-context";
import type { BillingElysia } from "./types";

export interface TrialRoutesDependencies {
	app: BillingElysia;
	service: TrialServiceLike;
}

const accountParams = z.object({ billingAccountId: z.string().trim().min(1).max(200) }).strict();
const trialParams = accountParams.extend({ trialId: z.uuid() }).strict();

const startTrialBodySchema = z
	.object({
		planKey: z.string().trim().min(1).max(120),
		durationDays: z.number().int().min(1).max(trialDurationMaxDays).optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

const endTrialBodySchema = z
	.object({ reason: z.string().trim().min(1).max(500).optional() })
	.strict()
	.optional();

const listTrialsQuerySchema = z
	.object({
		limit: z.coerce.number().int().positive().max(100).default(25),
		cursor: z.string().trim().min(1).optional(),
	})
	.strict();

const eligibilityQuerySchema = z.object({ planKey: z.string().trim().min(1).max(120) }).strict();

function optionalActor(headers: Headers): string | null {
	const actor = headers.get("x-billing-actor")?.trim();
	if (actor === undefined || actor === "") return null;
	if (actor.length > 200) {
		throw new InvalidRequestError(
			"X-Billing-Actor header must contain between 1 and 200 characters",
		);
	}
	return actor;
}

export function registerTrialRoutes({ app, service }: TrialRoutesDependencies): void {
	app.post(
		"/v1/billing-accounts/:billingAccountId/trials",
		async ({ body, params, request, project, set }) => {
			const result = await service.startTrial(privateProject(project), {
				billingAccountId: params.billingAccountId,
				planKey: body.planKey,
				durationDays: body.durationDays ?? null,
				metadata: body.metadata ?? {},
				idempotencyKey: requirePromotionIdempotencyKey(request.headers.get("idempotency-key")),
				actor: optionalActor(request.headers),
			});
			set.status = result.duplicate ? 200 : 201;
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: accountParams,
			body: startTrialBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdTrials",
				tags: ["trials"],
				path: "/v1/billing-accounts/:billingAccountId/trials",
				responses: {
					200: responses.postV1BillingAccountsByBillingAccountIdTrialsResponse200Schema,
					201: responses.postV1BillingAccountsByBillingAccountIdTrialsResponse201Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/trials",
		async ({ params, query, project }) => {
			const result = await service.listTrials(privateProject(project), params.billingAccountId, {
				limit: query.limit,
				cursor: query.cursor ?? null,
			});
			return { success: true, data: result.items, pagination: { nextCursor: result.nextCursor } };
		},
		{
			params: accountParams,
			query: listTrialsQuerySchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdTrials",
				tags: ["trials"],
				path: "/v1/billing-accounts/:billingAccountId/trials",
				credentialAccess: "read_only",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdTrialsResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/trials/:trialId",
		async ({ params, project }) => ({
			success: true,
			data: await service.getTrial(
				privateProject(project),
				params.billingAccountId,
				params.trialId,
			),
		}),
		{
			params: trialParams,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdTrialsByTrialId",
				tags: ["trials"],
				path: "/v1/billing-accounts/:billingAccountId/trials/:trialId",
				credentialAccess: "read_only",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdTrialsByTrialIdResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/trials/:trialId/end",
		async ({ body, params, request, project }) => ({
			success: true,
			data: await service.endTrial(privateProject(project), {
				billingAccountId: params.billingAccountId,
				trialId: params.trialId,
				reason: body?.reason ?? null,
				idempotencyKey: requirePromotionIdempotencyKey(request.headers.get("idempotency-key")),
				actor: optionalActor(request.headers),
			}),
		}),
		{
			parse: [LENIENT_JSON_PARSE],
			params: trialParams,
			body: endTrialBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdTrialsByTrialIdEnd",
				tags: ["trials"],
				path: "/v1/billing-accounts/:billingAccountId/trials/:trialId/end",
				responses: {
					200: responses.postV1BillingAccountsByBillingAccountIdTrialsByTrialIdEndResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/trial-eligibility",
		async ({ params, query, project }) => ({
			success: true,
			data: await service.trialEligibility(
				privateProject(project),
				params.billingAccountId,
				query.planKey,
			),
		}),
		{
			params: accountParams,
			query: eligibilityQuerySchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdTrialEligibility",
				tags: ["trials"],
				path: "/v1/billing-accounts/:billingAccountId/trial-eligibility",
				credentialAccess: "read_only",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdTrialEligibilityResponse200Schema,
				},
			}),
		},
	);
}
