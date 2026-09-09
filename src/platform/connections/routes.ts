import type { Hono } from "hono";
import { z } from "zod";
import { defineContract, registerRoute } from "../../shared/http-contract";
import { MerchantScopeSchema } from "../schemas";
import { idempotencyKey, MerchantError } from "../security";
import type { MerchantStore } from "../store";
import type { MerchantStripeOAuth } from "./oauth";
import type { MerchantConnections } from "./service";

const kind = z.enum(["stripe", "apple", "google", "projection"]);
const scope = MerchantScopeSchema.strict();
const headers = z.object({
	"X-CSRF-Token": z.string(),
	"Idempotency-Key": z.string(),
	"X-Quotum-Step-Up-Grant": z.string().optional(),
});
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
export const connectionContracts = {
	promotion: defineContract("post", "/api/platform/environments/catalog/prepare-promotion", {
		operationId: "prepareCatalogPromotion",
		tags: ["connections"],
		headers,
		body: scopeBody,
		responses: {
			200: success(
				z.object({
					catalog: z.unknown(),
					sourceRevisionId: z.string(),
					targetRevisionId: z.string().nullable(),
				}),
			),
		},
	}),
	oauthStart: defineContract("post", "/api/platform/connections/stripe/oauth/start", {
		operationId: "startStripeOAuth",
		tags: ["connections"],
		headers,
		body: oauthStartBody,
		responses: { 200: success(z.object({ authorizeUrl: z.url() })) },
	}),
	oauthComplete: defineContract("post", "/api/platform/connections/stripe/oauth/complete", {
		operationId: "completeStripeOAuth",
		tags: ["connections"],
		headers,
		body: oauthCompleteBody,
		responses: {
			200: success(
				z.object({
					draftId: z.uuid(),
					accountId: z.string(),
					scope,
					secretDisclosed: z.literal(false),
				}),
			),
		},
	}),
	list: defineContract("post", "/api/platform/connections/list", {
		operationId: "listConnections",
		tags: ["connections"],
		headers,
		body: scopeBody,
		responses: { 200: success(z.object({ connections: z.array(connection) })) },
	}),
	draft: defineContract("post", "/api/platform/connections/:kind/drafts", {
		operationId: "createConnectionDraft",
		tags: ["connections"],
		headers,
		params: z.object({ kind }),
		body: draftBody,
		responses: {
			200: success(
				z.object({
					draftId: z.uuid(),
					secretDisclosed: z.boolean(),
					projectionSecret: z.string().optional(),
				}),
			),
		},
	}),
	validate: defineContract("post", "/api/platform/connections/:kind/validate", {
		operationId: "validateConnection",
		tags: ["connections"],
		headers,
		params: z.object({ kind }),
		body: versionBody,
		responses: {
			200: success(
				z.object({
					draftId: z.uuid(),
					identity: z.string(),
					eventVerified: z.boolean(),
					checks: z.array(z.object({ code: z.string(), passed: z.boolean() })),
				}),
			),
		},
	}),
	commit: defineContract("post", "/api/platform/connections/:kind/commit", {
		operationId: "commitConnection",
		tags: ["connections"],
		headers,
		params: z.object({ kind }),
		body: versionBody,
		responses: {
			200: success(
				z.object({ connectionId: z.uuid(), revision: z.number(), enabled: z.boolean() }),
			),
		},
	}),
	disable: defineContract("post", "/api/platform/connections/:kind/disable", {
		operationId: "disableConnection",
		tags: ["connections"],
		headers,
		params: z.object({ kind }),
		body: disableBody,
		responses: { 200: success(z.object({ enabled: z.boolean(), revision: z.number() })) },
	}),
	readiness: defineContract("post", "/api/platform/environments/readiness", {
		operationId: "environmentReadiness",
		tags: ["connections"],
		headers,
		body: scopeBody,
		responses: {
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
		},
	}),
	activate: defineContract("post", "/api/platform/environments/activate", {
		operationId: "activateEnvironment",
		tags: ["connections"],
		headers,
		body: activateBody,
		responses: { 200: success(credential) },
	}),
	rotate: defineContract("post", "/api/platform/environments/credentials/rotate", {
		operationId: "rotateEnvironmentCredential",
		tags: ["connections"],
		headers,
		body: scopeBody,
		responses: { 200: success(credential) },
	}),
};
/** Mounted after the merchant authentication, BFF, CSRF and request-size boundaries. */
export function registerConnectionRoutes<E extends { Variables: { requestId: string } }>(
	app: Hono<E>,
	store: MerchantStore,
	service: MerchantConnections,
	json: (request: Request) => Promise<unknown>,
	oauth?: MerchantStripeOAuth,
) {
	registerRoute(app, connectionContracts.oauthStart, async (c) => {
		if (!oauth)
			throw new MerchantError(
				"OAUTH_UNAVAILABLE",
				"Use a restricted key while Stripe app authorization is unavailable.",
				503,
			);
		const input = oauthStartBody.parse(await json(c.req.raw));
		return c.json({
			success: true,
			data: await oauth.start(
				await store.authenticate(c.req.raw),
				input.scope,
				input.settings,
				input.expectedRevision,
			),
		});
	});
	registerRoute(app, connectionContracts.oauthComplete, async (c) => {
		if (!oauth)
			throw new MerchantError("OAUTH_UNAVAILABLE", "Stripe app authorization is unavailable.", 503);
		const input = oauthCompleteBody.parse(await json(c.req.raw));
		return c.json({
			success: true,
			data: await oauth.complete(await store.authenticate(c.req.raw), input.state, input.code),
		});
	});
	registerRoute(app, connectionContracts.promotion, async (c) => {
		const input = scopeBody.parse(await json(c.req.raw));
		return c.json({
			success: true,
			data: await service.preparePromotion(await store.authenticate(c.req.raw), input.scope),
		});
	});
	registerRoute(app, connectionContracts.list, async (c) => {
		const input = scopeBody.parse(await json(c.req.raw));
		return c.json({
			success: true,
			data: await service.list(await store.authenticate(c.req.raw), input.scope),
		});
	});
	registerRoute(app, connectionContracts.draft, async (c) => {
		const input = draftBody.parse(await json(c.req.raw));
		return c.json({
			success: true,
			data: await service.draft(
				await store.authenticate(c.req.raw),
				input.scope,
				kind.parse(c.req.param("kind")),
				idempotencyKey(c.req.raw),
				input,
			),
		});
	});
	registerRoute(app, connectionContracts.validate, async (c) => {
		const input = versionBody.parse(await json(c.req.raw));
		return c.json({
			success: true,
			data: await service.validate(
				await store.authenticate(c.req.raw),
				input.scope,
				kind.parse(c.req.param("kind")),
				input.draftId,
			),
		});
	});
	registerRoute(app, connectionContracts.commit, async (c) => {
		const input = versionBody.parse(await json(c.req.raw));
		return c.json({
			success: true,
			data: await service.commit(
				await store.authenticate(c.req.raw),
				input.scope,
				kind.parse(c.req.param("kind")),
				input.draftId,
				idempotencyKey(c.req.raw),
				c.req.header("x-quotum-step-up-grant") ?? null,
			),
		});
	});
	registerRoute(app, connectionContracts.disable, async (c) => {
		const input = disableBody.parse(await json(c.req.raw));
		return c.json({
			success: true,
			data: await service.disable(
				await store.authenticate(c.req.raw),
				input.scope,
				kind.parse(c.req.param("kind")),
				idempotencyKey(c.req.raw),
				input.expectedRevision,
				c.req.header("x-quotum-step-up-grant") ?? null,
			),
		});
	});
	registerRoute(app, connectionContracts.readiness, async (c) => {
		const input = scopeBody.parse(await json(c.req.raw));
		return c.json({
			success: true,
			data: await service.readiness(await store.authenticate(c.req.raw), input.scope),
		});
	});
	registerRoute(app, connectionContracts.activate, async (c) => {
		const input = activateBody.parse(await json(c.req.raw));
		return c.json({
			success: true,
			data: await service.activate(
				await store.authenticate(c.req.raw),
				input.scope,
				idempotencyKey(c.req.raw),
				input.fingerprint,
				c.req.header("x-quotum-step-up-grant") ?? null,
			),
		});
	});
	registerRoute(app, connectionContracts.rotate, async (c) => {
		const input = scopeBody.parse(await json(c.req.raw));
		return c.json({
			success: true,
			data: await service.rotateCredential(
				await store.authenticate(c.req.raw),
				input.scope,
				idempotencyKey(c.req.raw),
				c.req.header("x-quotum-step-up-grant") ?? null,
			),
		});
	});
}
