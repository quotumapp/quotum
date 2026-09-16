import { z } from "zod";
import type { ControlsEnterpriseRepositoryLike } from "../billing/controls";
import { LENIENT_JSON_PARSE, operationDetail } from "../shared/http";
import { operatorApiKeyGuard } from "./admin-routes";
import * as responses from "./contracts/controls-responses";
import { privateProject, rejectCallerProjectSelectorBody, requireActor } from "./request-context";
import type { BillingElysia, PostAuthGuard } from "./types";

export interface ControlsRoutesDependencies {
	app: BillingElysia;
	operatorApiKey: string | null;
	service: ControlsEnterpriseRepositoryLike;
	registerPostAuthGuard: (guard: PostAuthGuard) => void;
}

const accountParams = z.object({ billingAccountId: z.string().trim().min(1).max(200) }).strict();
const entityParams = accountParams.extend({ entityId: z.string().trim().min(1).max(200) }).strict();
const licenseCheckParams = entityParams
	.extend({ featureKey: z.string().trim().min(1).max(120) })
	.strict();
const policyParams = accountParams.extend({ policyId: z.string().regex(/^\d+$/) }).strict();
const assignmentParams = accountParams.extend({ assignmentId: z.string().regex(/^\d+$/) }).strict();
const contractParams = accountParams.extend({ contractId: z.string().regex(/^\d+$/) }).strict();

const entityBody = z
	.object({
		externalId: z.string().trim().min(1).max(200),
		kind: z.string().trim().min(1).max(120),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

export const controlBody = z
	.object({
		entityId: z.string().trim().min(1).max(200).nullable().optional(),
		controlKind: z.enum(["spend_limit", "usage_limit"]),
		featureKey: z.string().trim().min(1).max(120).nullable().optional(),
		currency: z.string().trim().length(3).nullable().optional(),
		limitValue: z.string().trim().min(1).max(80),
		interval: z.enum(["month", "year", "lifetime"]),
	})
	.strict();

const alertBody = z
	.object({
		entityId: z.string().trim().min(1).max(200).nullable().optional(),
		featureKey: z.string().trim().min(1).max(120),
		thresholdType: z.enum(["absolute", "percentage"]),
		thresholdValue: z.string().trim().min(1).max(80),
		interval: z.enum(["month", "year", "lifetime"]),
		metadata: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

const autoTopupBody = z
	.object({
		entityId: z.string().trim().min(1).max(200).nullable().optional(),
		featureKey: z.string().trim().min(1).max(120),
		topupKey: z.string().trim().min(1).max(120),
		provider: z.enum(["apple", "google", "stripe"]),
		thresholdQuantity: z.string().trim().min(1).max(80),
		cooldownSeconds: z.number().int().min(30).max(86_400).optional(),
		limitIntervalSeconds: z.number().int().min(60).max(31_536_000).optional(),
		maxPurchasesPerInterval: z.number().int().min(1).max(1000).optional(),
		maxSpendMinor: z.number().int().positive().nullable().optional(),
		maxConsecutiveFailures: z.number().int().min(1).max(100).optional(),
	})
	.strict();

const contractControl = controlBody.omit({ entityId: true }).strict();
export const contractBody = z
	.object({
		billingAccountId: z.string().trim().min(1).max(200),
		contractKey: z.string().trim().min(1).max(120),
		version: z.number().int().positive(),
		planKey: z.string().trim().min(1).max(120),
		effectiveAt: z.iso.datetime({ offset: true }),
		expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
		replacesCommercialDefaults: z.boolean().optional(),
		terms: z.record(z.string(), z.unknown()).optional(),
		controls: z.array(contractControl).max(50).optional(),
	})
	.strict();

export const migrationBody = z
	.object({
		fromPlanKey: z.string().trim().min(1).max(120),
		fromVersion: z.number().int().positive(),
		toPlanKey: z.string().trim().min(1).max(120),
		toVersion: z.number().int().positive(),
		effectiveMode: z.enum(["immediate", "period_end"]),
	})
	.strict();

const postV1AdminContractsPublishBodySchema = contractBody
	.extend({ previewToken: z.string().regex(/^[a-f0-9]{64}$/) })
	.strict();
const postV1AdminCatalogMigrationsPublishBodySchema = migrationBody
	.extend({ previewToken: z.string().regex(/^[a-f0-9]{64}$/) })
	.strict();
const postV1BillingAccountsByBillingAccountIdLicenseAssignmentsBodySchema = z
	.object({
		poolId: z.string().regex(/^\d+$/),
		entityId: z.string().trim().min(1).max(200),
		quantity: z.number().int().positive(),
	})
	.strict();
const autoTopupQuerySchema = z
	.object({
		featureKey: z.string().trim().min(1).max(120),
		entityId: z.string().trim().min(1).max(200).optional(),
	})
	.strict();
const effectiveControlsQuerySchema = z
	.object({ entityId: z.string().trim().min(1).max(200).optional() })
	.strict();

export function registerControlsRoutes({
	app,
	operatorApiKey,
	service,
	registerPostAuthGuard,
}: ControlsRoutesDependencies): void {
	registerPostAuthGuard(
		operatorApiKeyGuard(operatorApiKey, (p) =>
			/^\/v1\/admin\/(contracts|catalog-migrations|auto-topups)\//.test(p),
		),
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/entities",
		async ({ body, params, project, set }) => {
			const result = await service.createEntity(privateProject(project), {
				billingAccountId: params.billingAccountId,
				...body,
			});
			set.status = 201;
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: accountParams,
			body: entityBody,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdEntities",
				tags: ["controls"],
				path: "/v1/billing-accounts/:billingAccountId/entities",
				responses: {
					201: responses.postV1BillingAccountsByBillingAccountIdEntitiesResponse201Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/entities",
		async ({ params, project }) => {
			return {
				success: true,
				data: await service.listEntities(privateProject(project), params.billingAccountId),
			};
		},
		{
			params: accountParams,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdEntities",
				tags: ["controls"],
				path: "/v1/billing-accounts/:billingAccountId/entities",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdEntitiesResponse200Schema,
				},
			}),
		},
	);

	app.put(
		"/v1/billing-accounts/:billingAccountId/controls",
		async ({ body, request, params, project }) => {
			const result = await service.upsertControl(privateProject(project), {
				billingAccountId: params.billingAccountId,
				...body,
				featureKey: body.featureKey ?? null,
				currency: body.currency ?? null,
				actor: requireActor(request.headers),
			});
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: accountParams,
			body: controlBody,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "putV1BillingAccountsByBillingAccountIdControls",
				tags: ["controls"],
				path: "/v1/billing-accounts/:billingAccountId/controls",
				responses: {
					200: responses.putV1BillingAccountsByBillingAccountIdControlsResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/controls",
		async ({ params, project, query }) => {
			return {
				success: true,
				data: await service.listEffectiveControls(
					privateProject(project),
					params.billingAccountId,
					query.entityId,
				),
			};
		},
		{
			params: accountParams,
			query: effectiveControlsQuerySchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdControls",
				tags: ["controls"],
				path: "/v1/billing-accounts/:billingAccountId/controls",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdControlsResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/usage-alerts",
		async ({ body, request, params, project, set }) => {
			const result = await service.createUsageAlert(privateProject(project), {
				billingAccountId: params.billingAccountId,
				...body,
				actor: requireActor(request.headers),
			});
			set.status = 201;
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: accountParams,
			body: alertBody,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdUsageAlerts",
				tags: ["controls"],
				path: "/v1/billing-accounts/:billingAccountId/usage-alerts",
				responses: {
					201: responses.postV1BillingAccountsByBillingAccountIdUsageAlertsResponse201Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/usage-alerts",
		async ({ params, project }) => {
			return {
				success: true,
				data: await service.listUsageAlerts(privateProject(project), params.billingAccountId),
			};
		},
		{
			params: accountParams,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdUsageAlerts",
				tags: ["controls"],
				path: "/v1/billing-accounts/:billingAccountId/usage-alerts",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdUsageAlertsResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/usage-alert-events",
		async ({ params, project, request }) => {
			const rawLimit = new URL(request.url).searchParams.get("limit");
			const limit = rawLimit === null ? 100 : Number(rawLimit);
			return {
				success: true,
				data: await service.listUsageAlertEvents(
					privateProject(project),
					params.billingAccountId,
					limit,
				),
			};
		},
		{
			params: accountParams,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdUsageAlertEvents",
				tags: ["controls"],
				path: "/v1/billing-accounts/:billingAccountId/usage-alert-events",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdUsageAlertEventsResponse200Schema,
				},
				request: { query: z.object({ limit: z.coerce.number().nullable().optional() }) },
			}),
		},
	);

	app.put(
		"/v1/billing-accounts/:billingAccountId/auto-topup",
		async ({ body, request, params, project }) => {
			const result = await service.upsertAutoTopupPolicy(privateProject(project), {
				billingAccountId: params.billingAccountId,
				...body,
				actor: requireActor(request.headers),
			});
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: accountParams,
			body: autoTopupBody,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "putV1BillingAccountsByBillingAccountIdAutoTopup",
				tags: ["controls"],
				path: "/v1/billing-accounts/:billingAccountId/auto-topup",
				responses: {
					200: responses.putV1BillingAccountsByBillingAccountIdAutoTopupResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/auto-topup",
		async ({ params, project, query }) => {
			return {
				success: true,
				data: await service.getAutoTopupPolicy(
					privateProject(project),
					params.billingAccountId,
					query.featureKey,
					query.entityId,
				),
			};
		},
		{
			params: accountParams,
			query: autoTopupQuerySchema,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdAutoTopup",
				tags: ["controls"],
				path: "/v1/billing-accounts/:billingAccountId/auto-topup",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdAutoTopupResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/admin/auto-topups/:billingAccountId/:policyId/reset",
		async ({ request, params, project }) => {
			return {
				success: true,
				data: await service.resetAutoTopupCircuit(
					privateProject(project),
					params.billingAccountId,
					params.policyId,
					requireActor(request.headers),
				),
			};
		},
		{
			parse: "none",
			params: policyParams,
			detail: operationDetail({
				operationId: "postV1AdminAutoTopupsByBillingAccountIdByPolicyIdReset",
				tags: ["controls"],
				path: "/v1/admin/auto-topups/:billingAccountId/:policyId/reset",
				responses: {
					200: responses.postV1AdminAutoTopupsByBillingAccountIdByPolicyIdResetResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/admin/contracts/preview",
		async ({ body, request, project }) => {
			return {
				success: true,
				data: await service.previewEnterpriseContract(
					privateProject(project),
					contractInput(body, request.headers),
				),
			};
		},
		{
			parse: [LENIENT_JSON_PARSE],
			body: contractBody,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminContractsPreview",
				tags: ["controls"],
				path: "/v1/admin/contracts/preview",
				responses: { 200: responses.postV1AdminContractsPreviewResponse200Schema },
			}),
		},
	);

	app.post(
		"/v1/admin/contracts/publish",
		async ({ body, request, project }) => {
			return {
				success: true,
				data: await service.publishEnterpriseContract(privateProject(project), {
					...contractInput(body, request.headers),
					previewToken: body.previewToken,
				}),
			};
		},
		{
			parse: [LENIENT_JSON_PARSE],
			body: postV1AdminContractsPublishBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminContractsPublish",
				tags: ["controls"],
				path: "/v1/admin/contracts/publish",
				responses: { 200: responses.postV1AdminContractsPublishResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/admin/contracts/:billingAccountId",
		async ({ params, project }) => {
			return {
				success: true,
				data: await service.listEnterpriseContracts(
					privateProject(project),
					params.billingAccountId,
				),
			};
		},
		{
			params: accountParams,
			detail: operationDetail({
				operationId: "getV1AdminContractsByBillingAccountId",
				tags: ["controls"],
				path: "/v1/admin/contracts/:billingAccountId",
				responses: { 200: responses.getV1AdminContractsByBillingAccountIdResponse200Schema },
			}),
		},
	);

	app.delete(
		"/v1/admin/contracts/:billingAccountId/:contractId",
		async ({ request, params, project }) => {
			return {
				success: true,
				data: await service.terminateEnterpriseContract(
					privateProject(project),
					params.billingAccountId,
					params.contractId,
					requireActor(request.headers),
				),
			};
		},
		{
			parse: "none",
			params: contractParams,
			detail: operationDetail({
				operationId: "deleteV1AdminContractsByBillingAccountIdByContractId",
				tags: ["controls"],
				path: "/v1/admin/contracts/:billingAccountId/:contractId",
				responses: {
					200: responses.deleteV1AdminContractsByBillingAccountIdByContractIdResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/admin/catalog-migrations/preview",
		async ({ body, request, project }) => {
			return {
				success: true,
				data: await service.previewCatalogMigration(privateProject(project), {
					...body,
					actor: requireActor(request.headers),
				}),
			};
		},
		{
			parse: [LENIENT_JSON_PARSE],
			body: migrationBody,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminCatalogMigrationsPreview",
				tags: ["controls"],
				path: "/v1/admin/catalog-migrations/preview",
				responses: { 200: responses.postV1AdminCatalogMigrationsPreviewResponse200Schema },
			}),
		},
	);

	app.post(
		"/v1/admin/catalog-migrations/publish",
		async ({ body, request, project }) => {
			return {
				success: true,
				data: await service.publishCatalogMigration(privateProject(project), {
					...body,
					actor: requireActor(request.headers),
				}),
			};
		},
		{
			parse: [LENIENT_JSON_PARSE],
			body: postV1AdminCatalogMigrationsPublishBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1AdminCatalogMigrationsPublish",
				tags: ["controls"],
				path: "/v1/admin/catalog-migrations/publish",
				responses: { 200: responses.postV1AdminCatalogMigrationsPublishResponse200Schema },
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/license-pools",
		async ({ params, project }) => {
			return {
				success: true,
				data: await service.listLicensePools(privateProject(project), params.billingAccountId),
			};
		},
		{
			params: accountParams,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdLicensePools",
				tags: ["controls"],
				path: "/v1/billing-accounts/:billingAccountId/license-pools",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdLicensePoolsResponse200Schema,
				},
			}),
		},
	);

	app.post(
		"/v1/billing-accounts/:billingAccountId/license-assignments",
		async ({ body, request, params, project, set }) => {
			const result = await service.assignLicense(privateProject(project), {
				billingAccountId: params.billingAccountId,
				...body,
				actor: requireActor(request.headers),
			});
			set.status = 201;
			return { success: true, data: result };
		},
		{
			parse: [LENIENT_JSON_PARSE],
			params: accountParams,
			body: postV1BillingAccountsByBillingAccountIdLicenseAssignmentsBodySchema,
			transform: rejectCallerProjectSelectorBody,
			detail: operationDetail({
				operationId: "postV1BillingAccountsByBillingAccountIdLicenseAssignments",
				tags: ["controls"],
				path: "/v1/billing-accounts/:billingAccountId/license-assignments",
				responses: {
					201: responses.postV1BillingAccountsByBillingAccountIdLicenseAssignmentsResponse201Schema,
				},
			}),
		},
	);

	app.delete(
		"/v1/billing-accounts/:billingAccountId/license-assignments/:assignmentId",
		async ({ request, params, project }) => {
			return {
				success: true,
				data: await service.revokeLicense(privateProject(project), {
					billingAccountId: params.billingAccountId,
					assignmentId: params.assignmentId,
					actor: requireActor(request.headers),
				}),
			};
		},
		{
			parse: "none",
			params: assignmentParams,
			detail: operationDetail({
				operationId: "deleteV1BillingAccountsByBillingAccountIdLicenseAssignmentsByAssignmentId",
				tags: ["controls"],
				path: "/v1/billing-accounts/:billingAccountId/license-assignments/:assignmentId",
				responses: {
					200: responses.deleteV1BillingAccountsByBillingAccountIdLicenseAssignmentsByAssignmentIdResponse200Schema,
				},
			}),
		},
	);

	app.get(
		"/v1/billing-accounts/:billingAccountId/entities/:entityId/licenses/:featureKey",
		async ({ params, project, request }) => {
			const rawQuantity = new URL(request.url).searchParams.get("quantity");
			const requiredQuantity = rawQuantity === null ? 1 : Number(rawQuantity);
			return {
				success: true,
				data: await service.checkEntityLicense(privateProject(project), {
					billingAccountId: params.billingAccountId,
					entityId: params.entityId,
					featureKey: params.featureKey,
					requiredQuantity,
				}),
			};
		},
		{
			params: licenseCheckParams,
			detail: operationDetail({
				operationId: "getV1BillingAccountsByBillingAccountIdEntitiesByEntityIdLicensesByFeatureKey",
				tags: ["controls"],
				path: "/v1/billing-accounts/:billingAccountId/entities/:entityId/licenses/:featureKey",
				responses: {
					200: responses.getV1BillingAccountsByBillingAccountIdEntitiesByEntityIdLicensesByFeatureKeyResponse200Schema,
				},
				request: { query: z.object({ quantity: z.coerce.number().nullable().optional() }) },
			}),
		},
	);
}

function contractInput(body: z.infer<typeof contractBody>, headers: Headers) {
	return {
		...body,
		effectiveAt: new Date(body.effectiveAt),
		expiresAt: body.expiresAt == null ? null : new Date(body.expiresAt),
		controls: body.controls?.map((control) => ({
			...control,
			featureKey: control.featureKey ?? null,
			currency: control.currency ?? null,
		})),
		actor: requireActor(headers),
	};
}
