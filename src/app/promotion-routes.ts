import { z } from "zod";
import { InvalidRequestError } from "../billing/errors";
import type {
	CreatePromotionInput,
	PromotionCodeInput,
	PromotionEffect,
	PromotionServiceLike,
} from "../billing/promotions";
import { projectScopedRateLimitGuard, type RateLimiter } from "../http/rate-limit";
import { LENIENT_JSON_PARSE, operationDetail } from "../shared/http";
import { operatorApiKeyGuard } from "./admin-routes";
import * as responses from "./contracts/promotion-responses";
import { privateProject, rejectCallerProjectSelectorBody, requireActor } from "./request-context";
import type { BillingElysia, PostAuthGuard } from "./types";

export interface PromotionRoutesDependencies {
	app: BillingElysia;
	operatorApiKey: string | null;
	service: PromotionServiceLike;
	validationLimiter: RateLimiter;
	rateLimitKeyOptions: { trustProxyHeaders?: boolean };
	registerPostAuthGuard: (guard: PostAuthGuard) => void;
}

const keySchema = z.string().trim().min(1).max(120);
const codeSchema = z
	.string()
	.trim()
	.regex(/^[A-Za-z0-9-]{3,64}$/);
const channelSchema = z.enum(["web", "ios", "android"]);
const durationSchema = z.enum(["once", "repeating", "forever"]);
const durationMonthsSchema = z.number().int().min(1).max(36).nullable().optional();
const timestampSchema = z.string().datetime({ offset: true }).nullable().optional();
const positiveIntegerSchema = z.number().int().positive().safe();

const discountBodySchema = z.discriminatedUnion("type", [
	z
		.object({
			type: z.literal("percent"),
			percentOffBps: z.number().int().min(1).max(10_000),
			duration: durationSchema,
			durationMonths: durationMonthsSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("amount"),
			amounts: z
				.array(
					z
						.object({
							currency: z
								.string()
								.trim()
								.regex(/^[A-Za-z]{3}$/),
							amountOffMinor: positiveIntegerSchema,
						})
						.strict(),
				)
				.min(1)
				.max(20),
			duration: durationSchema,
			durationMonths: durationMonthsSchema,
		})
		.strict(),
]);

const effectBodySchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("discount"), discount: discountBodySchema }).strict(),
	z
		.object({
			kind: z.literal("feature_grant"),
			items: z
				.array(
					z
						.object({
							featureKey: keySchema,
							quantity: z.string().trim().min(1).max(40),
							expiresAfterSeconds: positiveIntegerSchema.nullable().optional(),
						})
						.strict(),
				)
				.min(1)
				.max(20),
		})
		.strict(),
	z
		.object({
			kind: z.literal("plan_grant"),
			planKey: keySchema,
			durationUnit: z.enum(["day", "month"]),
			durationCount: z.number().int().min(1).max(730),
		})
		.strict(),
]);

export const promotionCodeBodySchema = z
	.object({
		code: codeSchema,
		startsAt: timestampSchema,
		expiresAt: timestampSchema,
		maxRedemptions: positiveIntegerSchema.nullable().optional(),
		maxRedemptionsPerCustomer: positiveIntegerSchema.nullable().optional(),
		firstPurchaseOnly: z.boolean().optional(),
		billingAccountId: z.string().trim().min(1).max(200).nullable().optional(),
		hostedCheckoutEnabled: z.boolean().optional(),
	})
	.strict();

export const createPromotionBodySchema = z
	.object({
		key: keySchema,
		name: z.string().trim().min(1).max(200),
		effect: effectBodySchema,
		targets: z
			.array(z.object({ kind: z.enum(["plan", "product"]), key: keySchema }).strict())
			.max(50)
			.optional(),
		allowedChannels: z.array(channelSchema).min(1).max(3).optional(),
		metadata: z.record(z.string(), z.unknown()).optional(),
		codes: z.array(promotionCodeBodySchema).max(100).optional(),
	})
	.strict();

export const addPromotionCodesBodySchema = z
	.object({ codes: z.array(promotionCodeBodySchema).min(1).max(100) })
	.strict();

export const listPromotionsQuerySchema = z
	.object({
		limit: z.coerce.number().int().positive().max(100).default(25),
		cursor: z.string().trim().min(1).optional(),
		status: z.enum(["active", "archived"]).optional(),
	})
	.strict();

export const listPromotionCodesQuerySchema = z
	.object({
		limit: z.coerce.number().int().positive().max(100).default(25),
		cursor: z.string().trim().min(1).optional(),
		active: z.enum(["true", "false"]).optional(),
	})
	.strict();

export const listPromotionRedemptionsQuerySchema = z
	.object({
		limit: z.coerce.number().int().positive().max(100).default(25),
		cursor: z.string().trim().min(1).optional(),
		status: z.enum(["reserved", "applied", "released", "reversed"]).optional(),
		billingAccountId: z.string().trim().min(1).max(200).optional(),
	})
	.strict();

export const validatePromotionCodeBodySchema = z
	.object({
		code: codeSchema,
		channel: channelSchema.optional(),
		target: z
			.object({ kind: z.enum(["plan", "product"]), key: keySchema })
			.strict()
			.optional(),
	})
	.strict();

export const redeemPromotionCodeBodySchema = z
	.object({ code: codeSchema, channel: channelSchema })
	.strict();

export const revokePromotionRedemptionBodySchema = z
	.object({ reason: z.string().trim().min(1).max(500) })
	.strict();

export const listAccountRedemptionsQuerySchema = z
	.object({
		limit: z.coerce.number().int().positive().max(100).default(25),
		cursor: z.string().trim().min(1).optional(),
	})
	.strict();

const redemptionParams = z.object({ redemptionId: z.string().uuid() }).strict();
const accountRedemptionParams = z
	.object({ billingAccountId: z.string().trim().min(1).max(200), redemptionId: z.string().uuid() })
	.strict();

export function requirePromotionIdempotencyKey(value: string | null): string {
	const key = value?.trim();
	if (key === undefined || key === "" || key.length > 200) {
		throw new InvalidRequestError(
			"Idempotency-Key header must contain between 1 and 200 characters",
		);
	}
	return key;
}

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

const promotionParams = z.object({ promotionKey: keySchema }).strict();
const codeParams = promotionParams.extend({ codeId: z.string().uuid() }).strict();
const accountParams = z.object({ billingAccountId: z.string().trim().min(1).max(200) }).strict();

type EffectBody = z.infer<typeof effectBodySchema>;
type CodeBody = z.infer<typeof promotionCodeBodySchema>;

export function promotionEffectInput(effect: EffectBody): PromotionEffect {
	switch (effect.kind) {
		case "discount":
			return {
				kind: "discount",
				discount:
					effect.discount.type === "percent"
						? { ...effect.discount, durationMonths: effect.discount.durationMonths ?? null }
						: { ...effect.discount, durationMonths: effect.discount.durationMonths ?? null },
			};
		case "feature_grant":
			return {
				kind: "feature_grant",
				items: effect.items.map((item) => ({
					...item,
					expiresAfterSeconds: item.expiresAfterSeconds ?? null,
				})),
			};
		case "plan_grant":
			return effect;
	}
}

export function promotionCodeInputs(codes: readonly CodeBody[]): PromotionCodeInput[] {
	return codes.map((code) => ({ ...code }));
}

export function createPromotionInput(
	body: z.infer<typeof createPromotionBodySchema>,
	actor: string,
): CreatePromotionInput {
	return {
		...body,
		effect: promotionEffectInput(body.effect),
		codes: body.codes === undefined ? undefined : promotionCodeInputs(body.codes),
		actor,
	};
}

export function registerPromotionRoutes({
	app,
	operatorApiKey,
	service,
	validationLimiter,
	rateLimitKeyOptions,
	registerPostAuthGuard,
}: PromotionRoutesDependencies): void {
	registerPostAuthGuard(
		operatorApiKeyGuard(operatorApiKey, (path) => path.startsWith("/v1/admin/promotion")),
	);
	// Code entry is limited like purchase verification so codes cannot be guessed; ledger reads are not.
	const codeEntryLimit = projectScopedRateLimitGuard({
		limiter: validationLimiter,
		matches: (path) =>
			/^\/v1\/billing-accounts\/[^/]+\/promotion-(?:codes\/validate|redemptions)$/.test(path),
		trustProxyHeaders: rateLimitKeyOptions.trustProxyHeaders,
	});
	registerPostAuthGuard({
		matches: codeEntryLimit.matches,
		guard: (input) => {
			if (input.request.method === "POST") codeEntryLimit.guard(input);
		},
	});

	app.post(
		"/v1/admin/promotions",
		async ({ body, request, project, set }) => {
			const result = await service.createPromotion(
				privateProject(project),
				createPromotionInput(body, requireActor(request.headers)),
			);
			set.status = result.created ? 201 : 200;
			return { success: true, data: result.promotion };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			body: createPromotionBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminPromotions",
				tags: ["promotions"],
				path: "/v1/admin/promotions",
				responses: {
					200: responses.postV1AdminPromotionsResponse200Schema,
					201: responses.postV1AdminPromotionsResponse201Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/admin/promotions",
		async ({ query, project }) => {
			const result = await service.listPromotions(privateProject(project), {
				limit: query.limit,
				cursor: query.cursor ?? null,
				status: query.status ?? null,
			});
			return { success: true, data: result.items, pagination: { nextCursor: result.nextCursor } };
		},
		{
			query: listPromotionsQuerySchema,
			detail: operationDetail({
				operationId: "getV1AdminPromotions",
				tags: ["promotions"],
				path: "/v1/admin/promotions",
				responses: { 200: responses.getV1AdminPromotionsResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/promotions/:promotionKey",
		async ({ params, project }) => ({
			success: true,
			data: await service.getPromotion(privateProject(project), params.promotionKey),
		}),
		{
			params: promotionParams,
			detail: operationDetail({
				operationId: "getV1AdminPromotionsByPromotionKey",
				tags: ["promotions"],
				path: "/v1/admin/promotions/:promotionKey",
				responses: { 200: responses.getV1AdminPromotionsByPromotionKeyResponse200Schema },
			}),
		},
	);

	app.post(
		"/v1/admin/promotions/:promotionKey/archive",
		async ({ params, request, project }) => ({
			success: true,
			data: await service.archivePromotion(
				privateProject(project),
				params.promotionKey,
				requireActor(request.headers),
			),
		}),
		{
			parse: "none",
			params: promotionParams,
			detail: operationDetail({
				operationId: "postV1AdminPromotionsByPromotionKeyArchive",
				tags: ["promotions"],
				path: "/v1/admin/promotions/:promotionKey/archive",
				responses: {
					200: responses.postV1AdminPromotionsByPromotionKeyArchiveResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/admin/promotions/:promotionKey/provider-sync",
		async ({ params, request, project }) => ({
			success: true,
			data: await service.requestPromotionProviderSync(
				privateProject(project),
				params.promotionKey,
				requireActor(request.headers),
			),
		}),
		{
			parse: "none",
			params: promotionParams,
			detail: operationDetail({
				operationId: "postV1AdminPromotionsByPromotionKeyProviderSync",
				tags: ["promotions"],
				path: "/v1/admin/promotions/:promotionKey/provider-sync",
				responses: {
					200: responses.postV1AdminPromotionsByPromotionKeyProviderSyncResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/admin/promotions/:promotionKey/codes",
		async ({ body, params, request, project }) => ({
			success: true,
			data: await service.addPromotionCodes(
				privateProject(project),
				params.promotionKey,
				promotionCodeInputs(body.codes),
				requireActor(request.headers),
			),
		}),
		{
			parse: [LENIENT_JSON_PARSE],
			params: promotionParams,
			body: addPromotionCodesBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminPromotionsByPromotionKeyCodes",
				tags: ["promotions"],
				path: "/v1/admin/promotions/:promotionKey/codes",
				responses: { 200: responses.postV1AdminPromotionsByPromotionKeyCodesResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/promotions/:promotionKey/codes",
		async ({ params, query, project }) => {
			const result = await service.listPromotionCodes(
				privateProject(project),
				params.promotionKey,
				{
					limit: query.limit,
					cursor: query.cursor ?? null,
					active: query.active === undefined ? null : query.active === "true",
				},
			);
			return { success: true, data: result.items, pagination: { nextCursor: result.nextCursor } };
		},
		{
			params: promotionParams,
			query: listPromotionCodesQuerySchema,
			detail: operationDetail({
				operationId: "getV1AdminPromotionsByPromotionKeyCodes",
				tags: ["promotions"],
				path: "/v1/admin/promotions/:promotionKey/codes",
				responses: { 200: responses.getV1AdminPromotionsByPromotionKeyCodesResponse200Schema },
			}),
		},
	);

	app.post(
		"/v1/admin/promotions/:promotionKey/codes/:codeId/deactivate",
		async ({ params, request, project }) => ({
			success: true,
			data: await service.deactivatePromotionCode(
				privateProject(project),
				params.promotionKey,
				params.codeId,
				requireActor(request.headers),
			),
		}),
		{
			parse: "none",
			params: codeParams,
			detail: operationDetail({
				operationId: "postV1AdminPromotionsByPromotionKeyCodesByCodeIdDeactivate",
				tags: ["promotions"],
				path: "/v1/admin/promotions/:promotionKey/codes/:codeId/deactivate",
				responses: {
					200: responses.postV1AdminPromotionsByPromotionKeyCodesByCodeIdDeactivateResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/admin/promotions/:promotionKey/redemptions",
		async ({ params, query, project }) => {
			const result = await service.listPromotionRedemptions(
				privateProject(project),
				params.promotionKey,
				{
					limit: query.limit,
					cursor: query.cursor ?? null,
					status: query.status ?? null,
					billingAccountId: query.billingAccountId ?? null,
				},
			);
			return { success: true, data: result.items, pagination: { nextCursor: result.nextCursor } };
		},
		{
			params: promotionParams,
			query: listPromotionRedemptionsQuerySchema,
			detail: operationDetail({
				operationId: "getV1AdminPromotionsByPromotionKeyRedemptions",
				tags: ["promotions"],
				path: "/v1/admin/promotions/:promotionKey/redemptions",
				responses: {
					200: responses.getV1AdminPromotionsByPromotionKeyRedemptionsResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/promotion-codes/validate",
		async ({ body, params, project }) => ({
			success: true,
			data: await service.validatePromotionCode(privateProject(project), {
				billingAccountId: params.billingAccountId,
				code: body.code,
				channel: body.channel ?? "web",
				target: body.target ?? null,
			}),
		}),
		{
			parse: [LENIENT_JSON_PARSE],
			params: accountParams,
			body: validatePromotionCodeBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdPromotionCodesValidate",
				tags: ["promotions"],
				path: "/v1/billing-accounts/:billingAccountId/promotion-codes/validate",
				responses: {
					200: responses.postV1BillingAccountsByBillingAccountIdPromotionCodesValidateResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/promotion-redemptions",
		async ({ body, params, request, project }) => ({
			success: true,
			data: await service.redeemPromotionCode(privateProject(project), {
				billingAccountId: params.billingAccountId,
				code: body.code,
				channel: body.channel,
				idempotencyKey: requirePromotionIdempotencyKey(request.headers.get("idempotency-key")),
				actor: optionalActor(request.headers),
			}),
		}),
		{
			parse: [LENIENT_JSON_PARSE],
			params: accountParams,
			body: redeemPromotionCodeBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdPromotionRedemptions",
				tags: ["promotions"],
				path: "/v1/billing-accounts/:billingAccountId/promotion-redemptions",
				responses: {
					200: responses.postV1BillingAccountsByBillingAccountIdPromotionRedemptionsResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/promotion-redemptions",
		async ({ params, query, project }) => {
			const result = await service.listAccountRedemptions(
				privateProject(project),
				params.billingAccountId,
				{ limit: query.limit, cursor: query.cursor ?? null },
			);
			return { success: true, data: result.items, pagination: { nextCursor: result.nextCursor } };
		},
		{
			params: accountParams,
			query: listAccountRedemptionsQuerySchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdPromotionRedemptions",
				tags: ["promotions"],
				path: "/v1/billing-accounts/:billingAccountId/promotion-redemptions",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdPromotionRedemptionsResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/promotion-redemptions/:redemptionId",
		async ({ params, project }) => ({
			success: true,
			data: await service.getAccountRedemption(
				privateProject(project),
				params.billingAccountId,
				params.redemptionId,
			),
		}),
		{
			params: accountRedemptionParams,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdPromotionRedemptionsByRedemptionId",
				tags: ["promotions"],
				path: "/v1/billing-accounts/:billingAccountId/promotion-redemptions/:redemptionId",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdPromotionRedemptionsByRedemptionIdResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/admin/promotion-redemptions/:redemptionId/revoke",
		async ({ body, params, request, project }) => ({
			success: true,
			data: await service.revokePromotionRedemption(privateProject(project), {
				redemptionId: params.redemptionId,
				reason: body.reason,
				actor: requireActor(request.headers),
				idempotencyKey: requirePromotionIdempotencyKey(request.headers.get("idempotency-key")),
			}),
		}),
		{
			parse: [LENIENT_JSON_PARSE],
			params: redemptionParams,
			body: revokePromotionRedemptionBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminPromotionRedemptionsByRedemptionIdRevoke",
				tags: ["promotions"],
				path: "/v1/admin/promotion-redemptions/:redemptionId/revoke",
				responses: {
					200: responses.postV1AdminPromotionRedemptionsByRedemptionIdRevokeResponse200Schema,
				},
			}),
		},
	);
}
