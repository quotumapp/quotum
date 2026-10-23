import { z } from "zod";
import { BillingError } from "../billing/errors";
import { requireIdempotencyKey } from "../billing/idempotency-key";
import {
	bindingAdoptionSchema,
	bindingResultSchema,
	type CatalogBindingsLike,
} from "../catalog/bindings";
import { catalogIntentSchema } from "../catalog/intent-schema";
import type { CatalogControlPlaneLike } from "../catalog/types";
import { LENIENT_JSON_PARSE, operationDetail } from "../shared/http";
import { operatorKeyPaths } from "../shared/operator-key-paths";
import { operatorApiKeyGuard } from "./admin-routes";
import * as responses from "./contracts/catalog-responses";
import { privateProject, rejectCallerProjectSelectorBody, requireActor } from "./request-context";
import type { BillingElysia, PostAuthGuard } from "./types";

export interface CatalogRoutesDependencies {
	app: BillingElysia;
	operatorApiKey: string | null;
	catalogControlPlane: CatalogControlPlaneLike;
	catalogBindings?: CatalogBindingsLike;
	registerPostAuthGuard: (guard: PostAuthGuard) => void;
}

export const previewSchema = z
	.object({
		expectedRevision: z.number().int().positive().nullable(),
		catalog: catalogIntentSchema,
	})
	.strict();

export const publishSchema = z
	.object({
		expectedRevision: z.number().int().positive().nullable(),
		previewToken: z.string().regex(/^[a-f0-9]{64}$/),
		catalog: catalogIntentSchema,
	})
	.strict();

export function registerCatalogRoutes({
	app,
	operatorApiKey,
	catalogControlPlane,
	catalogBindings,
	registerPostAuthGuard,
}: CatalogRoutesDependencies): void {
	registerPostAuthGuard(
		// Reading the published catalog needs project authentication only; every other catalog
		// route, reads included, stays behind the operator key.
		operatorApiKeyGuard(operatorApiKey, operatorKeyPaths.catalog),
	);

	app.get(
		"/v1/admin/catalog/bindings",
		async ({ project }) => {
			if (!catalogBindings)
				throw new BillingError("Binding operations unavailable", "NOT_CONFIGURED", 503);
			return { success: true, data: await catalogBindings.list(privateProject(project)) };
		},
		{
			detail: operationDetail({
				operationId: "getV1AdminCatalogBindings",
				tags: ["catalog"],
				path: "/v1/admin/catalog/bindings",
				responses: {
					200: z.object({ success: z.literal(true), data: z.array(bindingResultSchema) }),
				},
			}),
		},
	);
	app.post(
		"/v1/admin/catalog/bindings/adopt",
		async ({ project, body, request }) => {
			if (!catalogBindings)
				throw new BillingError("Binding operations unavailable", "NOT_CONFIGURED", 503);
			return {
				success: true,
				data: await catalogBindings.adopt(
					privateProject(project),
					body,
					requireActor(request.headers),
					requireIdempotencyKey(request.headers.get("idempotency-key")),
				),
			};
		},
		{
			parse: [LENIENT_JSON_PARSE],
			body: bindingAdoptionSchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminCatalogBindingsAdopt",
				tags: ["catalog"],
				path: "/v1/admin/catalog/bindings/adopt",
				responses: { 200: z.object({ success: z.literal(true), data: bindingResultSchema }) },
			}),
		},
	);

	app.get(
		"/v1/admin/catalog",
		async ({ project }) => {
			if (catalogControlPlane.getPublished === undefined) {
				throw new BillingError("Published catalog reads are not configured", "NOT_CONFIGURED", 503);
			}
			const result = await catalogControlPlane.getPublished(privateProject(project));
			return { success: true, data: result };
		},
		{
			detail: operationDetail({
				operationId: "getV1AdminCatalog",
				credentialAccess: "read_only",
				tags: ["catalog"],
				path: "/v1/admin/catalog",
				responses: {
					200: responses.getV1AdminCatalogResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/admin/catalog/preview",
		async ({ body, request, project }) => {
			const result = await catalogControlPlane.preview(privateProject(project), {
				...body,
				actor: requireActor(request.headers),
			});
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			body: previewSchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminCatalogPreview",
				tags: ["catalog"],
				path: "/v1/admin/catalog/preview",
				responses: {
					200: responses.postV1AdminCatalogPreviewResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/admin/catalog/publish",
		async ({ body, request, project }) => {
			const result = await catalogControlPlane.publish(privateProject(project), {
				...body,
				actor: requireActor(request.headers),
			});
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			body: publishSchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminCatalogPublish",
				tags: ["catalog"],
				path: "/v1/admin/catalog/publish",
				responses: {
					200: responses.postV1AdminCatalogPublishResponse200Schema,
				},
			}),
		},
	);
}
