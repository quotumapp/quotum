import type { Elysia } from "elysia";
import { z } from "zod";
import { operationDetail } from "../../shared/http";
import { MerchantScopeSchema } from "../schemas";
import { idempotencyKey, MERCHANT_JSON_PARSE, MerchantError } from "../security";
import type { MerchantStore } from "../store";
import type { MerchantStripeOAuth } from "./oauth";
import type { MerchantConnections } from "./service";

const kind = z.enum(["stripe", "apple", "google", "projection"]);
const scope = MerchantScopeSchema.strict();
const success = (data: z.ZodType) => z.object({ success: z.literal(true), data });
const draftBody = z.strictObject({
	scope,
	expectedRevision: z.number().int().nonnegative(),
	settings: z.record(z.string(), z.unknown()),
	secrets: z.record(z.string(), z.string().max(32768)),
});
const versionBody = z.strictObject({ scope, draftId: z.uuid() });
const scopeBody = z.strictObject({ scope });
const disableBody = z.strictObject({ scope, expectedRevision: z.number().int().nonnegative() });
const activateBody = z.strictObject({ scope, fingerprint: z.string().min(1) });
const connection = z.object({
	id: z.uuid(),
	kind,
	revision: z.number(),
	enabled: z.boolean(),
	active_version_id: z.uuid().nullable(),
	settings: z.record(z.string(), z.unknown()).nullable(),
	validated_at: z.string().nullable(),
	event_verified_at: z.string().nullable(),
});
const credential = z.object({
	active: z.boolean().optional(),
	credentialDisclosed: z.boolean(),
	credential: z.string().optional(),
});
const oauthStartBody = z.strictObject({
	scope,
	settings: z.record(z.string(), z.unknown()),
	expectedRevision: z.number().int().nonnegative(),
});
const oauthCompleteBody = z.strictObject({
	state: z.string().min(32).max(128),
	code: z.string().min(1).max(4096),
});

const route = (
	operationId: string,
	path: string,
	responsesMap: Record<string, z.ZodType>,
	extra: { params?: z.ZodType } = {},
) => ({
	...(extra.params === undefined ? {} : { params: extra.params }),
	detail: operationDetail({ operationId, tags: ["connections"], path, responses: responsesMap }),
});

const jsonBody = (body: z.ZodType) => ({ parse: [MERCHANT_JSON_PARSE], body });

/** Mounted after the merchant authentication, BFF, CSRF and request-size boundaries. */
export function registerConnectionRoutes(
	app: Elysia,
	store: MerchantStore,
	service: MerchantConnections,
	oauth?: MerchantStripeOAuth,
) {
	app.post(
		"/api/platform/connections/stripe/oauth/start",
		async ({ body, request }) => {
			if (!oauth)
				throw new MerchantError(
					"OAUTH_UNAVAILABLE",
					"Use a restricted key while Stripe app authorization is unavailable.",
					503,
				);
			const input = oauthStartBody.parse(body);
			return {
				success: true as const,
				data: await oauth.start(
					await store.authenticate(request),
					input.scope,
					input.settings,
					input.expectedRevision,
				),
			};
		},
		{
			...jsonBody(oauthStartBody),
			...route("startStripeOAuth", "/api/platform/connections/stripe/oauth/start", {
				200: success(z.object({ authorizeUrl: z.url() })),
			}),
		},
	);

	app.post(
		"/api/platform/connections/stripe/oauth/complete",
		async ({ body, request }) => {
			if (!oauth)
				throw new MerchantError(
					"OAUTH_UNAVAILABLE",
					"Stripe app authorization is unavailable.",
					503,
				);
			const input = oauthCompleteBody.parse(body);
			return {
				success: true as const,
				data: await oauth.complete(await store.authenticate(request), input.state, input.code),
			};
		},
		{
			...jsonBody(oauthCompleteBody),
			...route("completeStripeOAuth", "/api/platform/connections/stripe/oauth/complete", {
				200: success(
					z.object({
						draftId: z.uuid(),
						accountId: z.string(),
						scope,
						secretDisclosed: z.literal(false),
					}),
				),
			}),
		},
	);

	app.post(
		"/api/platform/environments/catalog/prepare-promotion",
		async ({ body, request }) => {
			const input = scopeBody.parse(body);
			return {
				success: true as const,
				data: await service.preparePromotion(await store.authenticate(request), input.scope),
			};
		},
		{
			...jsonBody(scopeBody),
			...route("prepareCatalogPromotion", "/api/platform/environments/catalog/prepare-promotion", {
				200: success(
					z.object({
						catalog: z.unknown(),
						sourceRevisionId: z.string(),
						targetRevisionId: z.string().nullable(),
					}),
				),
			}),
		},
	);

	app.post(
		"/api/platform/connections/list",
		async ({ body, request }) => {
			const input = scopeBody.parse(body);
			return {
				success: true as const,
				data: await service.list(await store.authenticate(request), input.scope),
			};
		},
		{
			...jsonBody(scopeBody),
			...route("listConnections", "/api/platform/connections/list", {
				200: success(z.object({ connections: z.array(connection) })),
			}),
		},
	);

	app.post(
		"/api/platform/connections/:kind/drafts",
		async ({ body, params, request }) => {
			const input = draftBody.parse(body);
			return {
				success: true as const,
				data: await service.draft(
					await store.authenticate(request),
					input.scope,
					kind.parse(params.kind),
					idempotencyKey(request),
					input,
				),
			};
		},
		{
			...jsonBody(draftBody),
			...route(
				"createConnectionDraft",
				"/api/platform/connections/:kind/drafts",
				{
					200: success(
						z.object({
							draftId: z.uuid(),
							secretDisclosed: z.boolean(),
							projectionSecret: z.string().optional(),
						}),
					),
				},
				{ params: z.object({ kind }) },
			),
		},
	);

	app.post(
		"/api/platform/connections/:kind/validate",
		async ({ body, params, request }) => {
			const input = versionBody.parse(body);
			return {
				success: true as const,
				data: await service.validate(
					await store.authenticate(request),
					input.scope,
					kind.parse(params.kind),
					input.draftId,
				),
			};
		},
		{
			...jsonBody(versionBody),
			...route(
				"validateConnection",
				"/api/platform/connections/:kind/validate",
				{
					200: success(
						z.object({
							draftId: z.uuid(),
							identity: z.string(),
							eventVerified: z.boolean(),
							checks: z.array(z.object({ code: z.string(), passed: z.boolean() })),
						}),
					),
				},
				{ params: z.object({ kind }) },
			),
		},
	);

	app.post(
		"/api/platform/connections/:kind/commit",
		async ({ body, params, request }) => {
			const input = versionBody.parse(body);
			return {
				success: true as const,
				data: await service.commit(
					await store.authenticate(request),
					input.scope,
					kind.parse(params.kind),
					input.draftId,
					idempotencyKey(request),
					request.headers.get("x-quotum-step-up-grant") ?? null,
				),
			};
		},
		{
			...jsonBody(versionBody),
			...route(
				"commitConnection",
				"/api/platform/connections/:kind/commit",
				{
					200: success(
						z.object({ connectionId: z.uuid(), revision: z.number(), enabled: z.boolean() }),
					),
				},
				{ params: z.object({ kind }) },
			),
		},
	);

	app.post(
		"/api/platform/connections/:kind/disable",
		async ({ body, params, request }) => {
			const input = disableBody.parse(body);
			return {
				success: true as const,
				data: await service.disable(
					await store.authenticate(request),
					input.scope,
					kind.parse(params.kind),
					idempotencyKey(request),
					input.expectedRevision,
					request.headers.get("x-quotum-step-up-grant") ?? null,
				),
			};
		},
		{
			...jsonBody(disableBody),
			...route(
				"disableConnection",
				"/api/platform/connections/:kind/disable",
				{ 200: success(z.object({ enabled: z.boolean(), revision: z.number() })) },
				{ params: z.object({ kind }) },
			),
		},
	);

	app.post(
		"/api/platform/environments/readiness",
		async ({ body, request }) => {
			const input = scopeBody.parse(body);
			return {
				success: true as const,
				data: await service.readiness(await store.authenticate(request), input.scope),
			};
		},
		{
			...jsonBody(scopeBody),
			...route("environmentReadiness", "/api/platform/environments/readiness", {
				200: success(
					z.object({
						instanceId: z.uuid(),
						instanceKey: z.string(),
						lifecycleStatus: z.string(),
						ready: z.boolean(),
						blockers: z.array(z.string()),
						catalogRevisionId: z.string().nullable(),
						connections: z.array(connection),
						fingerprint: z.string(),
					}),
				),
			}),
		},
	);

	app.post(
		"/api/platform/environments/activate",
		async ({ body, request }) => {
			const input = activateBody.parse(body);
			return {
				success: true as const,
				data: await service.activate(
					await store.authenticate(request),
					input.scope,
					idempotencyKey(request),
					input.fingerprint,
					request.headers.get("x-quotum-step-up-grant") ?? null,
				),
			};
		},
		{
			...jsonBody(activateBody),
			...route("activateEnvironment", "/api/platform/environments/activate", {
				200: success(credential),
			}),
		},
	);

	app.post(
		"/api/platform/environments/credentials/rotate",
		async ({ body, request }) => {
			const input = scopeBody.parse(body);
			return {
				success: true as const,
				data: await service.rotateCredential(
					await store.authenticate(request),
					input.scope,
					idempotencyKey(request),
					request.headers.get("x-quotum-step-up-grant") ?? null,
				),
			};
		},
		{
			...jsonBody(scopeBody),
			...route("rotateEnvironmentCredential", "/api/platform/environments/credentials/rotate", {
				200: success(credential),
			}),
		},
	);
}
