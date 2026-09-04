import type { Hono } from "hono";
import { z } from "zod";
import type { ControlsEnterpriseRepositoryLike } from "../billing/controls";
import { BillingError, InvalidRequestError } from "../billing/errors";
import type { ProjectInstanceContext } from "../projects/context";
import { requireOperatorApiKey } from "./admin-routes";
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

const controlBody = z
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
const contractBody = z
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

const migrationBody = z
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

	app.post("/v1/billing-accounts/:billingAccountId/entities", async (c) => {
		const params = parse(accountParams, c.req.param(), "Invalid billing-account route parameters");
		const body = parse(entityBody, await parsePrivateJson(c.req.raw), "Invalid entity body");
		const result = await service.createEntity(privateProject(c), {
			billingAccountId: params.billingAccountId,
			...body,
		});
		return c.json({ success: true, data: result }, 201);
	});

	app.get("/v1/billing-accounts/:billingAccountId/entities", async (c) => {
		const params = parse(accountParams, c.req.param(), "Invalid billing-account route parameters");
		return c.json({
			success: true,
			data: await service.listEntities(privateProject(c), params.billingAccountId),
		});
	});

	app.put("/v1/billing-accounts/:billingAccountId/controls", async (c) => {
		const params = parse(accountParams, c.req.param(), "Invalid billing-account route parameters");
		const body = parse(controlBody, await parsePrivateJson(c.req.raw), "Invalid control body");
		const result = await service.upsertControl(privateProject(c), {
			billingAccountId: params.billingAccountId,
			...body,
			featureKey: body.featureKey ?? null,
			currency: body.currency ?? null,
			actor: requireActor(c),
		});
		return c.json({ success: true, data: result });
	});

	app.get("/v1/billing-accounts/:billingAccountId/controls", async (c) => {
		const params = parse(accountParams, c.req.param(), "Invalid billing-account route parameters");
		const query = parse(
			z.object({ entityId: z.string().trim().min(1).max(200).optional() }).strict(),
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
	});

	app.post("/v1/billing-accounts/:billingAccountId/usage-alerts", async (c) => {
		const params = parse(accountParams, c.req.param(), "Invalid billing-account route parameters");
		const body = parse(alertBody, await parsePrivateJson(c.req.raw), "Invalid usage-alert body");
		const result = await service.createUsageAlert(privateProject(c), {
			billingAccountId: params.billingAccountId,
			...body,
			actor: requireActor(c),
		});
		return c.json({ success: true, data: result }, 201);
	});

	app.get("/v1/billing-accounts/:billingAccountId/usage-alerts", async (c) => {
		const params = parse(accountParams, c.req.param(), "Invalid billing-account route parameters");
		return c.json({
			success: true,
			data: await service.listUsageAlerts(privateProject(c), params.billingAccountId),
		});
	});

	app.get("/v1/billing-accounts/:billingAccountId/usage-alert-events", async (c) => {
		const params = parse(accountParams, c.req.param(), "Invalid billing-account route parameters");
		const rawLimit = new URL(c.req.url).searchParams.get("limit");
		const limit = rawLimit === null ? 100 : Number(rawLimit);
		return c.json({
			success: true,
			data: await service.listUsageAlertEvents(privateProject(c), params.billingAccountId, limit),
		});
	});

	app.put("/v1/billing-accounts/:billingAccountId/auto-topup", async (c) => {
		const params = parse(accountParams, c.req.param(), "Invalid billing-account route parameters");
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
	});

	app.get("/v1/billing-accounts/:billingAccountId/auto-topup", async (c) => {
		const params = parse(accountParams, c.req.param(), "Invalid billing-account route parameters");
		const query = parse(
			z
				.object({
					featureKey: z.string().trim().min(1).max(120),
					entityId: z.string().trim().min(1).max(200).optional(),
				})
				.strict(),
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
	});

	app.post("/v1/admin/auto-topups/:billingAccountId/:policyId/reset", async (c) => {
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
	});

	app.post("/v1/admin/contracts/preview", async (c) => {
		const body = parse(contractBody, await parsePrivateJson(c.req.raw), "Invalid contract body");
		return c.json({
			success: true,
			data: await service.previewEnterpriseContract(privateProject(c), contractInput(body, c)),
		});
	});

	app.post("/v1/admin/contracts/publish", async (c) => {
		const body = parse(
			contractBody.extend({ previewToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
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

	app.get("/v1/admin/contracts/:billingAccountId", async (c) => {
		const params = parse(accountParams, c.req.param(), "Invalid contract route parameters");
		return c.json({
			success: true,
			data: await service.listEnterpriseContracts(privateProject(c), params.billingAccountId),
		});
	});

	app.delete("/v1/admin/contracts/:billingAccountId/:contractId", async (c) => {
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
	});

	app.post("/v1/admin/catalog-migrations/preview", async (c) => {
		const body = parse(migrationBody, await parsePrivateJson(c.req.raw), "Invalid migration body");
		return c.json({
			success: true,
			data: await service.previewCatalogMigration(privateProject(c), {
				...body,
				actor: requireActor(c),
			}),
		});
	});

	app.post("/v1/admin/catalog-migrations/publish", async (c) => {
		const body = parse(
			migrationBody.extend({ previewToken: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
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

	app.get("/v1/billing-accounts/:billingAccountId/license-pools", async (c) => {
		const params = parse(accountParams, c.req.param(), "Invalid billing-account route parameters");
		return c.json({
			success: true,
			data: await service.listLicensePools(privateProject(c), params.billingAccountId),
		});
	});

	app.post("/v1/billing-accounts/:billingAccountId/license-assignments", async (c) => {
		const params = parse(accountParams, c.req.param(), "Invalid billing-account route parameters");
		const body = parse(
			z
				.object({
					poolId: z.string().regex(/^\d+$/),
					entityId: z.string().trim().min(1).max(200),
					quantity: z.number().int().positive().safe(),
				})
				.strict(),
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
	});

	app.delete(
		"/v1/billing-accounts/:billingAccountId/license-assignments/:assignmentId",
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

	app.get(
		"/v1/billing-accounts/:billingAccountId/entities/:entityId/licenses/:featureKey",
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
