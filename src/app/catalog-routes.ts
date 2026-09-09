import type { Hono } from "hono";
import { z } from "zod";
import { BillingError, InvalidRequestError } from "../billing/errors";
import type { CatalogControlPlaneLike } from "../catalog/types";
import { defineContract, registerRoute } from "../shared/http-contract";
import { requireOperatorApiKey } from "./admin-routes";
import * as responses from "./contracts/catalog-responses";
import { privateProject, requireActor } from "./request-context";
import type { BillingHonoEnv } from "./types";

export interface CatalogRoutesDependencies {
	app: Hono<BillingHonoEnv>;
	operatorApiKey: string | null;
	catalogControlPlane: CatalogControlPlaneLike;
	parsePrivateJson(request: Request): Promise<unknown>;
}

const featureSchema = z
	.object({
		key: z.string().trim().min(1).max(120),
		name: z.string().trim().min(1).max(200),
		kind: z.enum(["boolean", "metered"]),
		meterKind: z.enum(["consumable", "non_consumable"]).nullable(),
		unit: z.string().trim().min(1).max(120),
		creditScale: z.number().int().min(0).max(9),
		filterDimensions: z.array(z.string().trim().min(1).max(120)).max(8),
	})
	.strict();

const providerBindingSchema = z
	.object({
		productKey: z.string().trim().min(1).max(120),
		provider: z.enum(["apple", "google", "stripe"]),
		channel: z.enum(["ios", "android", "web"]),
	})
	.strict();

const priceTierSchema = z
	.object({
		upToQuantity: z.string().trim().min(1).max(80).nullable(),
		unitAmountMinor: z.number().int().nonnegative().safe(),
		flatAmountMinor: z.number().int().nonnegative().safe().optional(),
	})
	.strict();

const priceSchema = z
	.object({
		key: z.string().trim().min(1).max(120),
		currency: z.string().trim().length(3),
		unitAmountMinor: z.number().int().nonnegative().safe(),
		billingUnits: z.string().trim().min(1).max(80),
		billingInterval: z.enum(["month", "year"]),
		minimumQuantity: z.number().int().positive().safe(),
		maximumQuantity: z.number().int().positive().safe().nullable(),
		taxBehavior: z.enum(["inclusive", "exclusive", "unspecified"]),
		pricingModel: z.enum(["flat", "graduated", "volume"]).optional(),
		tiers: z.array(priceTierSchema).min(1).max(100).optional(),
		providerBindings: z.array(providerBindingSchema).min(1).max(20),
	})
	.strict();

const planItemSchema = z
	.object({
		featureKey: z.string().trim().min(1).max(120),
		itemKind: z.enum(["access", "allocation", "meter_limit", "licensed_quantity"]),
		quantity: z.string().trim().min(1).max(80).nullable(),
		resetInterval: z.enum(["month", "year"]).nullable(),
		expiresAfterSeconds: z.number().int().positive().safe().nullable(),
		overagePolicy: z.enum(["blocked", "allowed"]),
		allocationScope: z.enum(["account", "entity", "license_pool"]).optional(),
		rollover: z
			.object({
				maxQuantity: z.string().trim().min(1).max(80).nullable(),
				expiry: z.discriminatedUnion("mode", [
					z.object({ mode: z.literal("forever") }).strict(),
					z
						.object({ mode: z.literal("months"), months: z.number().int().min(1).max(120) })
						.strict(),
				]),
			})
			.strict()
			.nullable()
			.optional(),
		price: priceSchema.nullable().optional(),
	})
	.strict();

const controlSchema = z
	.object({
		controlKind: z.enum(["spend_limit", "usage_limit"]),
		featureKey: z.string().trim().min(1).max(120).nullable(),
		currency: z.string().trim().length(3).nullable(),
		limitValue: z.string().trim().min(1).max(80),
		interval: z.enum(["month", "year", "lifetime"]),
	})
	.strict();

const planSchema = z
	.object({
		key: z.string().trim().min(1).max(120),
		name: z.string().trim().min(1).max(200),
		version: z.number().int().positive().safe(),
		currency: z.string().trim().min(3).max(3).nullable(),
		baseAmountMinor: z.number().int().nonnegative().safe().nullable(),
		billingInterval: z.enum(["month", "year"]).nullable(),
		trialDays: z.number().int().min(0).max(730).nullable(),
		kind: z.enum(["base", "addon"]).optional(),
		tierRank: z.number().int().safe().optional(),
		trialRequiresPaymentMethod: z.boolean().optional(),
		trialEndBehavior: z.enum(["cancel", "pause"]).optional(),
		upgradeProrationBehavior: z.enum(["always_invoice", "create_prorations", "none"]).optional(),
		downgradeProrationBehavior: z.enum(["always_invoice", "create_prorations", "none"]).optional(),
		visibility: z.enum(["public", "customer_specific"]).optional(),
		customerBillingAccountId: z.string().trim().min(1).max(200).nullable().optional(),
		basePrice: priceSchema.nullable().optional(),
		items: z.array(planItemSchema).min(1).max(100),
		controls: z.array(controlSchema).max(50).optional(),
		providerBindings: z.array(providerBindingSchema).max(20),
	})
	.strict();

const rateCardSchema = z
	.object({
		meterFeatureKey: z.string().trim().min(1).max(120),
		walletFeatureKey: z.string().trim().min(1).max(120),
		ratePerUnit: z.string().trim().min(1).max(80),
		pricingModel: z.enum(["flat", "graduated"]).optional(),
		tiers: z
			.array(
				z
					.object({
						upToQuantity: z.string().trim().min(1).max(80).nullable(),
						ratePerUnit: z.string().trim().min(1).max(80),
					})
					.strict(),
			)
			.min(1)
			.max(100)
			.optional(),
	})
	.strict();

const topupSchema = z
	.object({
		key: z.string().trim().min(1).max(120),
		featureKey: z.string().trim().min(1).max(120),
		quantity: z.string().trim().min(1).max(80),
		expiresAfterSeconds: z.number().int().positive().safe().nullable(),
		providerBindings: z.array(providerBindingSchema).min(1).max(20),
	})
	.strict();

const catalogSchema = z
	.object({
		features: z.array(featureSchema).min(1).max(100),
		plans: z.array(planSchema).max(100),
		topups: z.array(topupSchema).max(100),
		rateCards: z.array(rateCardSchema).max(100),
		retiredFeatureKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
		retiredPlanKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
		retiredTopupKeys: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
	})
	.strict();

export const previewSchema = z
	.object({
		expectedRevision: z.number().int().positive().safe().nullable(),
		catalog: catalogSchema,
	})
	.strict();

export const publishSchema = z
	.object({
		expectedRevision: z.number().int().positive().safe().nullable(),
		previewToken: z.string().regex(/^[a-f0-9]{64}$/),
		catalog: catalogSchema,
	})
	.strict();

export function registerCatalogRoutes({
	app,
	operatorApiKey,
	catalogControlPlane,
	parsePrivateJson,
}: CatalogRoutesDependencies): void {
	app.use("/v1/admin/catalog/*", requireOperatorApiKey(operatorApiKey));
	app.use("/v1/admin/catalog", requireOperatorApiKey(operatorApiKey));

	registerRoute(app, catalogContracts.getV1AdminCatalog, async (c) => {
		if (catalogControlPlane.getPublished === undefined) {
			throw new BillingError("Published catalog reads are not configured", "NOT_CONFIGURED", 503);
		}
		const result = await catalogControlPlane.getPublished(privateProject(c));
		return c.json({ success: true, data: result });
	});

	registerRoute(app, catalogContracts.postV1AdminCatalogPreview, async (c) => {
		const body = parseSchema(
			previewSchema,
			await parsePrivateJson(c.req.raw),
			"Invalid catalog preview body",
		);
		const result = await catalogControlPlane.preview(privateProject(c), {
			...body,
			actor: requireActor(c),
		});
		return c.json({ success: true, data: result });
	});

	registerRoute(app, catalogContracts.postV1AdminCatalogPublish, async (c) => {
		const body = parseSchema(
			publishSchema,
			await parsePrivateJson(c.req.raw),
			"Invalid catalog publish body",
		);
		const result = await catalogControlPlane.publish(privateProject(c), {
			...body,
			actor: requireActor(c),
		});
		return c.json({ success: true, data: result });
	});
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
	const parsed = schema.safeParse(value);
	if (!parsed.success) throw new InvalidRequestError(message);
	return parsed.data;
}

export const catalogContracts = {
	getV1AdminCatalog: defineContract("get", "/v1/admin/catalog", {
		operationId: "getV1AdminCatalog",
		tags: ["catalog"],
		responses: { "200": responses.getV1AdminCatalogResponse200Schema },
	}),
	postV1AdminCatalogPreview: defineContract("post", "/v1/admin/catalog/preview", {
		operationId: "postV1AdminCatalogPreview",
		tags: ["catalog"],
		body: previewSchema,
		responses: { "200": responses.postV1AdminCatalogPreviewResponse200Schema },
	}),
	postV1AdminCatalogPublish: defineContract("post", "/v1/admin/catalog/publish", {
		operationId: "postV1AdminCatalogPublish",
		tags: ["catalog"],
		body: publishSchema,
		responses: { "200": responses.postV1AdminCatalogPublishResponse200Schema },
	}),
} as const;
