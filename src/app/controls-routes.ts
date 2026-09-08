import type { Hono } from "hono";
import { z } from "zod";
import type { ControlsEnterpriseRepositoryLike } from "../billing/controls";
import { BillingError, InvalidRequestError } from "../billing/errors";
import type { ProjectInstanceContext } from "../projects/context";
import { defineContract, registerRoute } from "../shared/http-contract";
import { requireOperatorApiKey } from "./admin-routes";
import * as responses from "./contracts/controls-responses";
import type { BillingContext, BillingHonoEnv } from "./types";

export interface ControlsRoutesDependencies {
	app: Hono<BillingHonoEnv>;
	operatorApiKey: string | null;
	service: ControlsEnterpriseRepositoryLike;
	parsePrivateJson(request: Request): Promise<unknown>;
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
		maxSpendMinor: z.number().int().positive().safe().nullable().optional(),
		maxConsecutiveFailures: z.number().int().min(1).max(100).optional(),
	})
	.strict();

const contractControl = controlBody.omit({ entityId: true }).strict();
export const contractBody = z
	.object({
		billingAccountId: z.string().trim().min(1).max(200),
		contractKey: z.string().trim().min(1).max(120),
		version: z.number().int().positive().safe(),
		planKey: z.string().trim().min(1).max(120),
		effectiveAt: z.string().datetime({ offset: true }),
		expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
		replacesCommercialDefaults: z.boolean().optional(),
		terms: z.record(z.string(), z.unknown()).optional(),
		controls: z.array(contractControl).max(50).optional(),
	})
	.strict();

export const migrationBody = z
	.object({
		fromPlanKey: z.string().trim().min(1).max(120),
		fromVersion: z.number().int().positive().safe(),
		toPlanKey: z.string().trim().min(1).max(120),
		toVersion: z.number().int().positive().safe(),
		effectiveMode: z.enum(["immediate", "period_end"]),
	})
	.strict();

export function registerControlsRoutes({
	app,
	operatorApiKey,
	service,
	parsePrivateJson,
}: ControlsRoutesDependencies): void {
	app.use("/v1/admin/contracts/*", requireOperatorApiKey(operatorApiKey));
	app.use("/v1/admin/catalog-migrations/*", requireOperatorApiKey(operatorApiKey));
	app.use("/v1/admin/auto-topups/*", requireOperatorApiKey(operatorApiKey));

	registerRoute(
		app,
		controlsContracts.postV1BillingAccountsByBillingAccountIdEntities,
		async (c) => {
			const params = parse(
				accountParams,
				c.req.param(),
				"Invalid billing-account route parameters",
			);
			const body = parse(entityBody, await parsePrivateJson(c.req.raw), "Invalid entity body");
			const result = await service.createEntity(privateProject(c), {
				billingAccountId: params.billingAccountId,
				...body,
			});
			return c.json({ success: true, data: result }, 201);
		},
	);

	registerRoute(
		app,
		controlsContracts.getV1BillingAccountsByBillingAccountIdEntities,
		async (c) => {
			const params = parse(
				accountParams,
				c.req.param(),
				"Invalid billing-account route parameters",
			);
			return c.json({
				success: true,
				data: await service.listEntities(privateProject(c), params.billingAccountId),
			});
		},
	);

	registerRoute(
		app,
		controlsContracts.putV1BillingAccountsByBillingAccountIdControls,
		async (c) => {
			const params = parse(
				accountParams,
				c.req.param(),
				"Invalid billing-account route parameters",
			);
			const body = parse(controlBody, await parsePrivateJson(c.req.raw), "Invalid control body");
			const result = await service.upsertControl(privateProject(c), {
				billingAccountId: params.billingAccountId,
				...body,
				featureKey: body.featureKey ?? null,
				currency: body.currency ?? null,
				actor: requireActor(c),
			});
			return c.json({ success: true, data: result });
		},
	);

	registerRoute(
		app,
		controlsContracts.getV1BillingAccountsByBillingAccountIdControls,
		async (c) => {
			const params = parse(
				accountParams,
				c.req.param(),
				"Invalid billing-account route parameters",
			);
			const query = parse(
				effectiveControlsQuerySchema,
				Object.fromEntries(new URL(c.req.url).searchParams),
				"Invalid control query",
			);
			return c.json({
				success: true,
				data: await service.listEffectiveControls(
					privateProject(c),
					params.billingAccountId,
					query.entityId,
				),
			});
		},
	);

	registerRoute(
		app,
		controlsContracts.postV1BillingAccountsByBillingAccountIdUsageAlerts,
		async (c) => {
			const params = parse(
				accountParams,
				c.req.param(),
				"Invalid billing-account route parameters",
			);
			const body = parse(alertBody, await parsePrivateJson(c.req.raw), "Invalid usage-alert body");
			const result = await service.createUsageAlert(privateProject(c), {
				billingAccountId: params.billingAccountId,
				...body,
				actor: requireActor(c),
			});
			return c.json({ success: true, data: result }, 201);
		},
	);

	registerRoute(
		app,
		controlsContracts.getV1BillingAccountsByBillingAccountIdUsageAlerts,
		async (c) => {
			const params = parse(
				accountParams,
				c.req.param(),
				"Invalid billing-account route parameters",
			);
			return c.json({
				success: true,
				data: await service.listUsageAlerts(privateProject(c), params.billingAccountId),
			});
		},
	);

	registerRoute(
		app,
		controlsContracts.getV1BillingAccountsByBillingAccountIdUsageAlertEvents,
		async (c) => {
			const params = parse(
				accountParams,
				c.req.param(),
				"Invalid billing-account route parameters",
			);
			const rawLimit = new URL(c.req.url).searchParams.get("limit");
			const limit = rawLimit === null ? 100 : Number(rawLimit);
			return c.json({
				success: true,
				data: await service.listUsageAlertEvents(privateProject(c), params.billingAccountId, limit),
			});
		},
	);

	registerRoute(
		app,
		controlsContracts.putV1BillingAccountsByBillingAccountIdAutoTopup,
		async (c) => {
			const params = parse(
				accountParams,
				c.req.param(),
				"Invalid billing-account route parameters",
			);
			const body = parse(
				autoTopupBody,
				await parsePrivateJson(c.req.raw),
				"Invalid auto-top-up body",
			);
			const result = await service.upsertAutoTopupPolicy(privateProject(c), {
				billingAccountId: params.billingAccountId,
				...body,
				actor: requireActor(c),
			});
			return c.json({ success: true, data: result });
		},
	);

	registerRoute(
		app,
		controlsContracts.getV1BillingAccountsByBillingAccountIdAutoTopup,
		async (c) => {
			const params = parse(
				accountParams,
				c.req.param(),
				"Invalid billing-account route parameters",
			);
			const query = parse(
				autoTopupQuerySchema,
				Object.fromEntries(new URL(c.req.url).searchParams),
				"Invalid auto-top-up query",
			);
			return c.json({
				success: true,
				data: await service.getAutoTopupPolicy(
					privateProject(c),
					params.billingAccountId,
					query.featureKey,
					query.entityId,
				),
			});
		},
	);

	registerRoute(
		app,
		controlsContracts.postV1AdminAutoTopupsByBillingAccountIdByPolicyIdReset,
		async (c) => {
			const params = parse(policyParams, c.req.param(), "Invalid auto-top-up route parameters");
			return c.json({
				success: true,
				data: await service.resetAutoTopupCircuit(
					privateProject(c),
					params.billingAccountId,
					params.policyId,
					requireActor(c),
				),
			});
		},
	);

	registerRoute(app, controlsContracts.postV1AdminContractsPreview, async (c) => {
		const body = parse(contractBody, await parsePrivateJson(c.req.raw), "Invalid contract body");
		return c.json({
			success: true,
			data: await service.previewEnterpriseContract(privateProject(c), contractInput(body, c)),
		});
	});

	registerRoute(app, controlsContracts.postV1AdminContractsPublish, async (c) => {
		const body = parse(
			postV1AdminContractsPublishBodySchema,
			await parsePrivateJson(c.req.raw),
			"Invalid contract publish body",
		);
		return c.json({
			success: true,
			data: await service.publishEnterpriseContract(privateProject(c), {
				...contractInput(body, c),
				previewToken: body.previewToken,
			}),
		});
	});

	registerRoute(app, controlsContracts.getV1AdminContractsByBillingAccountId, async (c) => {
		const params = parse(accountParams, c.req.param(), "Invalid contract route parameters");
		return c.json({
			success: true,
			data: await service.listEnterpriseContracts(privateProject(c), params.billingAccountId),
		});
	});

	registerRoute(
		app,
		controlsContracts.deleteV1AdminContractsByBillingAccountIdByContractId,
		async (c) => {
			const params = parse(contractParams, c.req.param(), "Invalid contract route parameters");
			return c.json({
				success: true,
				data: await service.terminateEnterpriseContract(
					privateProject(c),
					params.billingAccountId,
					params.contractId,
					requireActor(c),
				),
			});
		},
	);

	registerRoute(app, controlsContracts.postV1AdminCatalogMigrationsPreview, async (c) => {
		const body = parse(migrationBody, await parsePrivateJson(c.req.raw), "Invalid migration body");
		return c.json({
			success: true,
			data: await service.previewCatalogMigration(privateProject(c), {
				...body,
				actor: requireActor(c),
			}),
		});
	});

	registerRoute(app, controlsContracts.postV1AdminCatalogMigrationsPublish, async (c) => {
		const body = parse(
			postV1AdminCatalogMigrationsPublishBodySchema,
			await parsePrivateJson(c.req.raw),
			"Invalid migration publish body",
		);
		return c.json({
			success: true,
			data: await service.publishCatalogMigration(privateProject(c), {
				...body,
				actor: requireActor(c),
			}),
		});
	});

	registerRoute(
		app,
		controlsContracts.getV1BillingAccountsByBillingAccountIdLicensePools,
		async (c) => {
			const params = parse(
				accountParams,
				c.req.param(),
				"Invalid billing-account route parameters",
			);
			return c.json({
				success: true,
				data: await service.listLicensePools(privateProject(c), params.billingAccountId),
			});
		},
	);

	registerRoute(
		app,
		controlsContracts.postV1BillingAccountsByBillingAccountIdLicenseAssignments,
		async (c) => {
			const params = parse(
				accountParams,
				c.req.param(),
				"Invalid billing-account route parameters",
			);
			const body = parse(
				postV1BillingAccountsByBillingAccountIdLicenseAssignmentsBodySchema,
				await parsePrivateJson(c.req.raw),
				"Invalid license assignment body",
			);
			return c.json(
				{
					success: true,
					data: await service.assignLicense(privateProject(c), {
						billingAccountId: params.billingAccountId,
						...body,
						actor: requireActor(c),
					}),
				},
				201,
			);
		},
	);

	registerRoute(
		app,
		controlsContracts.deleteV1BillingAccountsByBillingAccountIdLicenseAssignmentsByAssignmentId,
		async (c) => {
			const params = parse(
				assignmentParams,
				c.req.param(),
				"Invalid license assignment route parameters",
			);
			return c.json({
				success: true,
				data: await service.revokeLicense(privateProject(c), {
					billingAccountId: params.billingAccountId,
					assignmentId: params.assignmentId,
					actor: requireActor(c),
				}),
			});
		},
	);

	registerRoute(
		app,
		controlsContracts.getV1BillingAccountsByBillingAccountIdEntitiesByEntityIdLicensesByFeatureKey,
		async (c) => {
			const params = parse(
				licenseCheckParams,
				c.req.param(),
				"Invalid entity-license route parameters",
			);
			const rawQuantity = new URL(c.req.url).searchParams.get("quantity");
			const requiredQuantity = rawQuantity === null ? 1 : Number(rawQuantity);
			return c.json({
				success: true,
				data: await service.checkEntityLicense(privateProject(c), {
					billingAccountId: params.billingAccountId,
					entityId: params.entityId,
					featureKey: params.featureKey,
					requiredQuantity,
				}),
			});
		},
	);
}

function contractInput(body: z.infer<typeof contractBody>, c: BillingContext) {
	return {
		...body,
		effectiveAt: new Date(body.effectiveAt),
		expiresAt: body.expiresAt == null ? null : new Date(body.expiresAt),
		controls: body.controls?.map((control) => ({
			...control,
			featureKey: control.featureKey ?? null,
			currency: control.currency ?? null,
		})),
		actor: requireActor(c),
	};
}

function requireActor(c: BillingContext): string {
	const actor = c.req.header("x-billing-actor")?.trim();
	if (actor === undefined || actor === "" || actor.length > 200) {
		throw new InvalidRequestError(
			"X-Billing-Actor header must contain between 1 and 200 characters",
		);
	}
	return actor;
}

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new InvalidRequestError(message);
	return parsed.data;
}

function privateProject(c: BillingContext): ProjectInstanceContext {
	const project = c.get("project");
	if (project === undefined) {
		throw new BillingError("Billing project context is required", "BILLING_PROJECT_REQUIRED", 401);
	}
	return project;
}

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
		quantity: z.number().int().positive().safe(),
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
export const controlsContracts = {
	postV1BillingAccountsByBillingAccountIdEntities: defineContract(
		"post",
		"/v1/billing-accounts/:billingAccountId/entities",
		{
			operationId: "postV1BillingAccountsByBillingAccountIdEntities",
			tags: ["controls"],
			params: accountParams,
			body: entityBody,
			responses: {
				"201": responses.postV1BillingAccountsByBillingAccountIdEntitiesResponse201Schema,
			},
		},
	),
	getV1BillingAccountsByBillingAccountIdEntities: defineContract(
		"get",
		"/v1/billing-accounts/:billingAccountId/entities",
		{
			operationId: "getV1BillingAccountsByBillingAccountIdEntities",
			tags: ["controls"],
			params: accountParams,
			responses: {
				"200": responses.getV1BillingAccountsByBillingAccountIdEntitiesResponse200Schema,
			},
		},
	),
	putV1BillingAccountsByBillingAccountIdControls: defineContract(
		"put",
		"/v1/billing-accounts/:billingAccountId/controls",
		{
			operationId: "putV1BillingAccountsByBillingAccountIdControls",
			tags: ["controls"],
			params: accountParams,
			body: controlBody,
			responses: {
				"200": responses.putV1BillingAccountsByBillingAccountIdControlsResponse200Schema,
			},
		},
	),
	getV1BillingAccountsByBillingAccountIdControls: defineContract(
		"get",
		"/v1/billing-accounts/:billingAccountId/controls",
		{
			operationId: "getV1BillingAccountsByBillingAccountIdControls",
			query: effectiveControlsQuerySchema,
			tags: ["controls"],
			params: accountParams,
			responses: {
				"200": responses.getV1BillingAccountsByBillingAccountIdControlsResponse200Schema,
			},
		},
	),
	postV1BillingAccountsByBillingAccountIdUsageAlerts: defineContract(
		"post",
		"/v1/billing-accounts/:billingAccountId/usage-alerts",
		{
			operationId: "postV1BillingAccountsByBillingAccountIdUsageAlerts",
			tags: ["controls"],
			params: accountParams,
			body: alertBody,
			responses: {
				"201": responses.postV1BillingAccountsByBillingAccountIdUsageAlertsResponse201Schema,
			},
		},
	),
	getV1BillingAccountsByBillingAccountIdUsageAlerts: defineContract(
		"get",
		"/v1/billing-accounts/:billingAccountId/usage-alerts",
		{
			operationId: "getV1BillingAccountsByBillingAccountIdUsageAlerts",
			tags: ["controls"],
			params: accountParams,
			responses: {
				"200": responses.getV1BillingAccountsByBillingAccountIdUsageAlertsResponse200Schema,
			},
		},
	),
	getV1BillingAccountsByBillingAccountIdUsageAlertEvents: defineContract(
		"get",
		"/v1/billing-accounts/:billingAccountId/usage-alert-events",
		{
			operationId: "getV1BillingAccountsByBillingAccountIdUsageAlertEvents",
			query: z.object({ limit: z.coerce.number().optional() }),
			tags: ["controls"],
			params: accountParams,
			responses: {
				"200": responses.getV1BillingAccountsByBillingAccountIdUsageAlertEventsResponse200Schema,
			},
		},
	),
	putV1BillingAccountsByBillingAccountIdAutoTopup: defineContract(
		"put",
		"/v1/billing-accounts/:billingAccountId/auto-topup",
		{
			operationId: "putV1BillingAccountsByBillingAccountIdAutoTopup",
			tags: ["controls"],
			params: accountParams,
			body: autoTopupBody,
			responses: {
				"200": responses.putV1BillingAccountsByBillingAccountIdAutoTopupResponse200Schema,
			},
		},
	),
	getV1BillingAccountsByBillingAccountIdAutoTopup: defineContract(
		"get",
		"/v1/billing-accounts/:billingAccountId/auto-topup",
		{
			operationId: "getV1BillingAccountsByBillingAccountIdAutoTopup",
			query: autoTopupQuerySchema,
			tags: ["controls"],
			params: accountParams,
			responses: {
				"200": responses.getV1BillingAccountsByBillingAccountIdAutoTopupResponse200Schema,
			},
		},
	),
	postV1AdminAutoTopupsByBillingAccountIdByPolicyIdReset: defineContract(
		"post",
		"/v1/admin/auto-topups/:billingAccountId/:policyId/reset",
		{
			operationId: "postV1AdminAutoTopupsByBillingAccountIdByPolicyIdReset",
			tags: ["controls"],
			params: policyParams,
			responses: {
				"200": responses.postV1AdminAutoTopupsByBillingAccountIdByPolicyIdResetResponse200Schema,
			},
		},
	),
	postV1AdminContractsPreview: defineContract("post", "/v1/admin/contracts/preview", {
		operationId: "postV1AdminContractsPreview",
		tags: ["controls"],
		body: contractBody,
		responses: { "200": responses.postV1AdminContractsPreviewResponse200Schema },
	}),
	postV1AdminContractsPublish: defineContract("post", "/v1/admin/contracts/publish", {
		operationId: "postV1AdminContractsPublish",
		tags: ["controls"],
		body: postV1AdminContractsPublishBodySchema,
		responses: { "200": responses.postV1AdminContractsPublishResponse200Schema },
	}),
	getV1AdminContractsByBillingAccountId: defineContract(
		"get",
		"/v1/admin/contracts/:billingAccountId",
		{
			operationId: "getV1AdminContractsByBillingAccountId",
			tags: ["controls"],
			params: accountParams,
			responses: { "200": responses.getV1AdminContractsByBillingAccountIdResponse200Schema },
		},
	),
	deleteV1AdminContractsByBillingAccountIdByContractId: defineContract(
		"delete",
		"/v1/admin/contracts/:billingAccountId/:contractId",
		{
			operationId: "deleteV1AdminContractsByBillingAccountIdByContractId",
			tags: ["controls"],
			params: contractParams,
			responses: {
				"200": responses.deleteV1AdminContractsByBillingAccountIdByContractIdResponse200Schema,
			},
		},
	),
	postV1AdminCatalogMigrationsPreview: defineContract(
		"post",
		"/v1/admin/catalog-migrations/preview",
		{
			operationId: "postV1AdminCatalogMigrationsPreview",
			tags: ["controls"],
			body: migrationBody,
			responses: { "200": responses.postV1AdminCatalogMigrationsPreviewResponse200Schema },
		},
	),
	postV1AdminCatalogMigrationsPublish: defineContract(
		"post",
		"/v1/admin/catalog-migrations/publish",
		{
			operationId: "postV1AdminCatalogMigrationsPublish",
			tags: ["controls"],
			body: postV1AdminCatalogMigrationsPublishBodySchema,
			responses: { "200": responses.postV1AdminCatalogMigrationsPublishResponse200Schema },
		},
	),
	getV1BillingAccountsByBillingAccountIdLicensePools: defineContract(
		"get",
		"/v1/billing-accounts/:billingAccountId/license-pools",
		{
			operationId: "getV1BillingAccountsByBillingAccountIdLicensePools",
			tags: ["controls"],
			params: accountParams,
			responses: {
				"200": responses.getV1BillingAccountsByBillingAccountIdLicensePoolsResponse200Schema,
			},
		},
	),
	postV1BillingAccountsByBillingAccountIdLicenseAssignments: defineContract(
		"post",
		"/v1/billing-accounts/:billingAccountId/license-assignments",
		{
			operationId: "postV1BillingAccountsByBillingAccountIdLicenseAssignments",
			tags: ["controls"],
			params: accountParams,
			body: postV1BillingAccountsByBillingAccountIdLicenseAssignmentsBodySchema,
			responses: {
				"201": responses.postV1BillingAccountsByBillingAccountIdLicenseAssignmentsResponse201Schema,
			},
		},
	),
	deleteV1BillingAccountsByBillingAccountIdLicenseAssignmentsByAssignmentId: defineContract(
		"delete",
		"/v1/billing-accounts/:billingAccountId/license-assignments/:assignmentId",
		{
			operationId: "deleteV1BillingAccountsByBillingAccountIdLicenseAssignmentsByAssignmentId",
			tags: ["controls"],
			params: assignmentParams,
			responses: {
				"200":
					responses.deleteV1BillingAccountsByBillingAccountIdLicenseAssignmentsByAssignmentIdResponse200Schema,
			},
		},
	),
	getV1BillingAccountsByBillingAccountIdEntitiesByEntityIdLicensesByFeatureKey: defineContract(
		"get",
		"/v1/billing-accounts/:billingAccountId/entities/:entityId/licenses/:featureKey",
		{
			operationId: "getV1BillingAccountsByBillingAccountIdEntitiesByEntityIdLicensesByFeatureKey",
			query: z.object({ quantity: z.coerce.number().optional() }),
			tags: ["controls"],
			params: licenseCheckParams,
			responses: {
				"200":
					responses.getV1BillingAccountsByBillingAccountIdEntitiesByEntityIdLicensesByFeatureKeyResponse200Schema,
			},
		},
	),
} as const;
