import { z } from "zod";
import {
	type ReferralServiceLike,
	referralRecipients,
	referralTriggers,
} from "../billing/referrals";
import { projectScopedRateLimitGuard, type RateLimiter } from "../http/rate-limit";
import { LENIENT_JSON_PARSE, operationDetail } from "../shared/http";
import { decimalDigitsQuery } from "../shared/input-bounds";
import { operatorKeyPaths } from "../shared/operator-key-paths";
import { operatorApiKeyGuard } from "./admin-routes";
import * as responses from "./contracts/referral-responses";
import { privateProject, rejectCallerProjectSelectorBody, requireActor } from "./request-context";
import type { BillingElysia, PostAuthGuard } from "./types";

export interface ReferralRoutesDependencies {
	app: BillingElysia;
	operatorApiKey: string | null;
	service: ReferralServiceLike;
	validationLimiter: RateLimiter;
	rateLimitKeyOptions: { trustProxyHeaders?: boolean };
	registerPostAuthGuard: (guard: PostAuthGuard) => void;
}

const keySchema = z.string().trim().min(1).max(120);
const billingAccountIdSchema = z.string().trim().min(1).max(200);
const limitQuery = decimalDigitsQuery(z.coerce.number().int().positive().max(100).default(25));

const programParams = z.object({ programKey: keySchema }).strict();
const accountParams = z.object({ billingAccountId: billingAccountIdSchema }).strict();

const createProgramBodySchema = z
	.object({
		key: keySchema,
		name: z.string().trim().min(1).max(200),
		rewardPromotionKey: keySchema,
		trigger: z.enum(referralTriggers),
		recipient: z.enum(referralRecipients),
		maxRewardsPerReferrer: z.number().int().positive().nullable().optional(),
	})
	.strict();

const redeemBodySchema = z
	.object({
		code: z
			.string()
			.trim()
			.regex(/^[A-Za-z0-9]{8}$/),
		channel: z.enum(["web", "ios", "android"]),
	})
	.strict();

const listProgramsQuerySchema = z
	.object({
		limit: limitQuery,
		cursor: z.uuid().optional(),
		status: z.enum(["active", "archived"]).optional(),
	})
	.strict();

const listLedgerQuerySchema = z.object({ limit: limitQuery, cursor: z.uuid().optional() }).strict();

const listAccountQuerySchema = z
	.object({
		limit: limitQuery,
		cursor: z.uuid().optional(),
		role: z.enum(["referrer", "referee"]).optional(),
	})
	.strict();

export function registerReferralRoutes({
	app,
	operatorApiKey,
	service,
	validationLimiter,
	rateLimitKeyOptions,
	registerPostAuthGuard,
}: ReferralRoutesDependencies): void {
	registerPostAuthGuard(operatorApiKeyGuard(operatorApiKey, operatorKeyPaths.referrals));
	// Codes are short so they can be shared, so entry is limited like promotion codes.
	registerPostAuthGuard(
		projectScopedRateLimitGuard({
			limiter: validationLimiter,
			matches: (path) => /^\/v1\/billing-accounts\/[^/]+\/referral-redemptions$/.test(path),
			trustProxyHeaders: rateLimitKeyOptions.trustProxyHeaders,
		}),
	);

	app.post(
		"/v1/admin/referral-programs",
		async ({ body, request, project, set }) => {
			const result = await service.createProgram(privateProject(project), {
				...body,
				actor: requireActor(request.headers),
			});
			set.status = result.created ? 201 : 200;
			return { success: true, data: result.program };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			body: createProgramBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminReferralPrograms",
				tags: ["referrals"],
				path: "/v1/admin/referral-programs",
				description:
					"Creates a referral program. Sending the same terms again answers 200; different terms under the key answer REFERRAL_PROGRAM_KEY_CONFLICT.",
				responses: {
					200: responses.postV1AdminReferralProgramsResponse200Schema,
					201: responses.postV1AdminReferralProgramsResponse201Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/admin/referral-programs",
		async ({ query, project }) => {
			const result = await service.listPrograms(privateProject(project), {
				limit: query.limit,
				cursor: query.cursor ?? null,
				status: query.status ?? null,
			});
			return { success: true, data: result.items, pagination: { nextCursor: result.nextCursor } };
		},
		{
			query: listProgramsQuerySchema,
			detail: operationDetail({
				operationId: "getV1AdminReferralPrograms",
				tags: ["referrals"],
				path: "/v1/admin/referral-programs",
				responses: { 200: responses.getV1AdminReferralProgramsResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/referral-programs/:programKey",
		async ({ params, project }) => ({
			success: true,
			data: await service.getProgram(privateProject(project), params.programKey),
		}),
		{
			params: programParams,
			detail: operationDetail({
				operationId: "getV1AdminReferralProgramsByProgramKey",
				tags: ["referrals"],
				path: "/v1/admin/referral-programs/:programKey",
				responses: { 200: responses.getV1AdminReferralProgramsByProgramKeyResponse200Schema },
			}),
		},
	);

	app.post(
		"/v1/admin/referral-programs/:programKey/archive",
		async ({ params, request, project }) => ({
			success: true,
			data: await service.archiveProgram(
				privateProject(project),
				params.programKey,
				requireActor(request.headers),
			),
		}),
		{
			parse: "none",
			params: programParams,
			detail: operationDetail({
				operationId: "postV1AdminReferralProgramsByProgramKeyArchive",
				tags: ["referrals"],
				path: "/v1/admin/referral-programs/:programKey/archive",
				description:
					"Stops new codes and redemptions. Referrals already recorded keep their rewards.",
				responses: {
					200: responses.postV1AdminReferralProgramsByProgramKeyArchiveResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/admin/referral-programs/:programKey/referrals",
		async ({ params, query, project }) => {
			const result = await service.listProgramReferrals(
				privateProject(project),
				params.programKey,
				{ limit: query.limit, cursor: query.cursor ?? null },
			);
			return { success: true, data: result.items, pagination: { nextCursor: result.nextCursor } };
		},
		{
			params: programParams,
			query: listLedgerQuerySchema,
			detail: operationDetail({
				operationId: "getV1AdminReferralProgramsByProgramKeyReferrals",
				tags: ["referrals"],
				path: "/v1/admin/referral-programs/:programKey/referrals",
				description: "Who referred whom in one program, newest first, with both sides' rewards.",
				responses: {
					200: responses.getV1AdminReferralProgramsByProgramKeyReferralsResponse200Schema,
				},
			}),
		},
	);

	app.put(
		"/v1/billing-accounts/:billingAccountId/referral-codes/:programKey",
		async ({ params, project }) => ({
			success: true,
			data: await service.getOrCreateCode(privateProject(project), {
				billingAccountId: params.billingAccountId,
				programKey: params.programKey,
			}),
		}),
		{
			parse: "none",
			params: accountParams.extend({ programKey: keySchema }),
			detail: operationDetail({
				operationId: "putV1BillingAccountsReferralCodes",
				tags: ["referrals"],
				path: "/v1/billing-accounts/:billingAccountId/referral-codes/:programKey",
				description: "Answers the account's code for the program, creating it the first time.",
				responses: { 200: responses.putV1BillingAccountsReferralCodesResponse200Schema },
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/referral-redemptions",
		async ({ body, params, project }) => ({
			success: true,
			data: await service.redeemCode(privateProject(project), {
				billingAccountId: params.billingAccountId,
				code: body.code,
				channel: body.channel,
			}),
		}),
		{
			parse: [LENIENT_JSON_PARSE],
			params: accountParams,
			body: redeemBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsReferralRedemptions",
				tags: ["referrals"],
				path: "/v1/billing-accounts/:billingAccountId/referral-redemptions",
				description:
					"Records who referred this account. Repeating the same code answers the same referral with `duplicate: true`, so the call needs no Idempotency-Key.",
				responses: { 200: responses.postV1BillingAccountsReferralRedemptionsResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/referrals",
		async ({ params, query, project }) => {
			const result = await service.listAccountReferrals(
				privateProject(project),
				params.billingAccountId,
				{ limit: query.limit, cursor: query.cursor ?? null, role: query.role ?? null },
			);
			return { success: true, data: result.items, pagination: { nextCursor: result.nextCursor } };
		},
		{
			params: accountParams,
			query: listAccountQuerySchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsReferrals",
				tags: ["referrals"],
				path: "/v1/billing-accounts/:billingAccountId/referrals",
				description:
					"The referrals this account made or came from, with its own rewards. A held reward carries its code, so this read needs a full credential.",
				responses: { 200: responses.getV1BillingAccountsReferralsResponse200Schema },
			}),
		},
	);
}
