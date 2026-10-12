import { z } from "zod";
import {
	type CustomerErasureServiceLike,
	customerErasureAcknowledgements,
	customerErasureBases,
	customerErasureReferenceMaxLength,
} from "../billing/customer-erasures";
import { requireIdempotencyKey } from "../billing/idempotency-key";
import { type BillingLogger, safelyLogInfo } from "../observability/logger";
import { LENIENT_JSON_PARSE, operationDetail } from "../shared/http";
import { operatorKeyPaths } from "../shared/operator-key-paths";
import { operatorApiKeyGuard } from "./admin-routes";
import * as responses from "./contracts/customer-erasure-responses";
import { privateProject, rejectCallerProjectSelectorBody, requireActor } from "./request-context";
import type { BillingElysia, PostAuthGuard } from "./types";

export interface CustomerErasureRoutesDependencies {
	app: BillingElysia;
	operatorApiKey: string | null;
	service: CustomerErasureServiceLike;
	billingLogger: BillingLogger;
	registerPostAuthGuard(guard: PostAuthGuard): void;
}

// The id travels in the body, not the path: paths reach access logs and error reports, and the
// id is what an erasure exists to forget.
const billingAccountId = z.string().min(1).max(200);

const previewBodySchema = z.object({ billingAccountId }).strict();

export const customerErasureBodySchema = z
	.object({
		billingAccountId,
		basis: z.enum(customerErasureBases),
		// A ticket or case number, never a name or an address: it is kept in the receipt.
		reference: z.string().trim().min(1).max(customerErasureReferenceMaxLength).optional(),
		acknowledge: z.array(z.enum(customerErasureAcknowledgements)).max(2).default([]),
	})
	.strict();

const erasureParams = z.object({ erasureId: z.string().trim().min(1).max(64) }).strict();

export function registerCustomerErasureRoutes({
	app,
	operatorApiKey,
	service,
	billingLogger,
	registerPostAuthGuard,
}: CustomerErasureRoutesDependencies): void {
	registerPostAuthGuard(operatorApiKeyGuard(operatorApiKey, operatorKeyPaths.customerErasures));

	app.post(
		"/v1/admin/customer-erasures/preview",
		async ({ body, request, project }) => {
			requireActor(request.headers);
			const preview = await service.previewCustomerErasure(
				privateProject(project),
				body.billingAccountId,
			);
			return { success: true, data: preview };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			body: previewBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminCustomerErasuresPreview",
				tags: ["customer-erasures"],
				path: "/v1/admin/customer-erasures/preview",
				responses: { 200: responses.postV1AdminCustomerErasuresPreviewResponse200Schema },
			}),
		},
	);

	app.post(
		"/v1/admin/customer-erasures",
		async ({ body, request, project, set }) => {
			const scopedProject = privateProject(project);
			const result = await service.requestCustomerErasure(scopedProject, {
				billingAccountId: body.billingAccountId,
				basis: body.basis,
				reference: body.reference ?? null,
				acknowledge: body.acknowledge,
				actor: requireActor(request.headers),
				idempotencyKey: requireIdempotencyKey(request.headers.get("idempotency-key")),
			});
			if (!result.duplicate) {
				// The operation id only: neither the account id nor the actor belongs in a log line.
				safelyLogInfo(billingLogger, "Billing admin customer erasure requested", {
					projectKey: scopedProject.projectInstanceKey,
					erasureId: result.erasure.id,
					basis: result.erasure.basis,
				});
			}
			set.status = result.duplicate ? 200 : 201;
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			body: customerErasureBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminCustomerErasures",
				tags: ["customer-erasures"],
				path: "/v1/admin/customer-erasures",
				responses: {
					200: responses.postV1AdminCustomerErasuresResponse200Schema,
					201: responses.postV1AdminCustomerErasuresResponse201Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/admin/customer-erasures/:erasureId",
		async ({ params, project }) => {
			const erasure = await service.getCustomerErasure(privateProject(project), params.erasureId);
			return { success: true, data: erasure };
		},
		{
			params: erasureParams,
			detail: operationDetail({
				operationId: "getV1AdminCustomerErasuresByErasureId",
				tags: ["customer-erasures"],
				path: "/v1/admin/customer-erasures/:erasureId",
				responses: { 200: responses.getV1AdminCustomerErasuresByErasureIdResponse200Schema },
			}),
		},
	);
}
