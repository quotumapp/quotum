import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { CatalogPreviewInput } from "../../src/catalog/types";
import { price as fixturePrice } from "../providers/paddle/fixtures";

const price = {
	...fixturePrice,
	id: `pri_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`,
	product_id: `pro_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`,
};

import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
localDescribe("Paddle published fixed catalog", () => {
	let context: LocalPostgresContext;
	beforeAll(async () => {
		context = await createLocalPostgresContext();
		await resetAndSeedIntegrationData(context.sql);
	});
	afterAll(async () => {
		await context.sql.close();
	});
	it("resolves the price and version produced by normal catalog preview and publication", async () => {
		const project = integrationProjectContext("acme-sandbox");
		await context.sql`INSERT INTO products(project_id,key,entitlement_key,credit_amount,name,type,active) VALUES(${project.projectInstanceId},'paddle_published','access',0,'Paddle published','subscription',true)`;
		await context.sql`INSERT INTO store_products(project_id,product_id,provider,channel,external_product_id,external_price_id,billing_period,currency,price_amount,active) SELECT ${project.projectInstanceId},id,'paddle','web',${price.product_id},${price.id},'month','USD',1000,true FROM products WHERE project_id=${project.projectInstanceId} AND key='paddle_published'`;
		const input: CatalogPreviewInput = {
			expectedRevision: null,
			actor: "paddle-test",
			catalog: {
				features: [
					{
						key: "access",
						name: "Access",
						kind: "boolean",
						meterKind: null,
						unit: "access",
						creditScale: 0,
						filterDimensions: [],
					},
				],
				plans: [
					{
						key: "fixed",
						name: "Fixed",
						version: 1,
						kind: "base",
						basePrice: {
							key: "base",
							currency: "USD",
							unitAmountMinor: 1000,
							billingUnits: "1",
							billingInterval: "month",
							minimumQuantity: 1,
							maximumQuantity: 1,
							taxBehavior: "exclusive",
							providerBindings: [
								{ provider: "paddle", channel: "web", productKey: "paddle_published" },
							],
						},
						items: [{ featureKey: "access", itemKind: "access" }],
					},
				],
				topups: [],
				rateCards: [],
			},
		};
		const preview = await context.repository.previewCatalog(project, input);
		await context.repository.publishCatalog(project, {
			...input,
			previewToken: preview.previewToken,
		});
		const target = await context.repository.forProject(project).getPaddlePlan("payer", "fixed");
		expect(target).toMatchObject({
			productKey: "paddle_published",
			priceKey: "base",
			binding: { priceId: price.id, quantity: 1, unitAmountMinor: "1000" },
			plan: { storeProductId: target.storeProductId },
		});
		expect(target.plan?.planVersionId).toMatch(/^[1-9][0-9]*$/);
	});
});
