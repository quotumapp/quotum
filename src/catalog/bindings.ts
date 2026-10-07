import { sql } from "drizzle-orm";
import Stripe from "stripe";
import { z } from "zod";
import { sha256Hex, stableJson } from "../billing/decimal";
import { BillingError } from "../billing/errors";
import { RepositoryModule } from "../db/repository/base";
import { executeOne, executeRows, jsonb } from "../db/repository/query";
import type { TransactionalQueryExecutor } from "../db/repository/types";
import type { RuntimeConnectionResolver } from "../projects/connections";
import type { ProjectInstanceContext } from "../projects/context";

export const bindingAdoptionSchema = z
	.object({
		productKey: z.string().trim().min(1).max(120),
		name: z.string().trim().min(1).max(120),
		kind: z.enum(["subscription", "topup"]),
		entitlementKey: z.string().trim().min(1).max(120),
		credits: z.number().int().nonnegative().max(100_000),
		externalProductId: z.string().regex(/^prod_[A-Za-z0-9]+$/u),
		externalPriceId: z.string().regex(/^price_[A-Za-z0-9]+$/u),
	})
	.strict()
	.refine((input) => input.kind === "subscription" || input.credits > 0, {
		message: "Top-ups require positive credits",
		path: ["credits"],
	});
export type BindingAdoption = z.infer<typeof bindingAdoptionSchema>;
export const bindingResultSchema = z.object({
	productId: z.uuid(),
	storeProductId: z.uuid(),
	productKey: z.string(),
	externalProductId: z.string(),
	externalPriceId: z.string().nullable(),
	active: z.boolean(),
});
export type BindingResult = z.infer<typeof bindingResultSchema>;
export interface CatalogBindingsLike {
	list(project: ProjectInstanceContext): Promise<BindingResult[]>;
	adopt(
		project: ProjectInstanceContext,
		input: BindingAdoption,
		actor: string,
		key: string,
	): Promise<BindingResult>;
}

export class CatalogBindings extends RepositoryModule implements CatalogBindingsLike {
	constructor(
		database: TransactionalQueryExecutor,
		private readonly connections: RuntimeConnectionResolver,
		private readonly clientFactory = (key: string) =>
			new Stripe(key, { timeout: 10_000, maxNetworkRetries: 0 }),
	) {
		super(database);
	}
	async list(project: ProjectInstanceContext): Promise<BindingResult[]> {
		return await executeRows<BindingResult>(
			this.database,
			sql`
			SELECT p.id AS "productId", sp.id AS "storeProductId", p.key AS "productKey",
			sp.external_product_id AS "externalProductId", sp.external_price_id AS "externalPriceId", sp.active AND p.active AS active
			FROM products p JOIN store_products sp ON sp.project_id = p.project_id AND sp.product_id = p.id
			WHERE p.project_id = ${project.projectInstanceId} AND sp.provider = 'stripe' AND sp.channel = 'web'
			ORDER BY p.key, sp.id
		`,
		);
	}
	async adopt(
		project: ProjectInstanceContext,
		input: BindingAdoption,
		actor: string,
		key: string,
	): Promise<BindingResult> {
		const projectId = project.projectInstanceId;
		const hash = sha256Hex(stableJson(input));
		const previous = await executeOne<{ request_hash: string; result: BindingResult }>(
			this.database,
			sql`SELECT request_hash, result FROM catalog_binding_adoptions WHERE project_id = ${projectId} AND request_key = ${key}`,
		);
		if (previous) {
			if (previous.request_hash !== hash) conflict("idempotency_key_reused");
			return previous.result;
		}
		const config = await this.connections.resolve(project, "stripe", "new");
		if (!config)
			throw new BillingError(
				"Configure Stripe before adopting bindings",
				"CONNECTION_UNAVAILABLE",
				503,
			);
		let price: Stripe.Price;
		let product: Stripe.Product;
		try {
			const client = this.clientFactory(config.secretKey);
			const fetched = await Promise.all([
				client.prices.retrieve(input.externalPriceId),
				client.products.retrieve(input.externalProductId),
			]);
			price = fetched[0];
			if ("deleted" in fetched[1] && fetched[1].deleted) conflict("deleted_product");
			product = fetched[1] as Stripe.Product;
		} catch (error) {
			if (error instanceof BillingError) throw error;
			throw new BillingError("Stripe product/price lookup failed", "STRIPE_BINDING_INVALID", 422, {
				details: {
					check: "stripe_lookup",
					reason: "provider_lookup_failed",
					httpStatus: (error as { statusCode?: number }).statusCode,
				},
			});
		}
		if (
			!price.active ||
			!product.active ||
			price.livemode !== (project.environment === "production") ||
			product.livemode !== price.livemode ||
			(typeof price.product === "string" ? price.product : price.product.id) !== product.id
		)
			conflict("product_price_or_environment_mismatch");
		if (
			price.billing_scheme !== "per_unit" ||
			price.custom_unit_amount ||
			price.transform_quantity ||
			price.unit_amount === null ||
			price.unit_amount < 0 ||
			(input.kind === "topup" && price.unit_amount === 0) ||
			(input.kind === "subscription") !== (price.type === "recurring") ||
			(price.recurring && price.recurring.usage_type !== "licensed")
		)
			conflict("unsupported_price_shape");
		return await this.transaction(async (tx) => {
			// Same project lock used by publication: adding a mapping cannot race the active pointer.
			await executeOne(tx, sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
			const replay = await executeOne<{ request_hash: string; result: BindingResult }>(
				tx,
				sql`SELECT request_hash, result FROM catalog_binding_adoptions WHERE project_id = ${projectId} AND request_key = ${key}`,
			);
			if (replay) {
				if (replay.request_hash !== hash) conflict("idempotency_key_reused");
				return replay.result;
			}
			const existing = await executeOne<{
				id: string;
				name: string;
				type: string;
				entitlement_key: string;
				credit_amount: number;
				active: boolean;
			}>(
				tx,
				sql`SELECT id, name, type, entitlement_key, credit_amount, active FROM products WHERE project_id = ${projectId} AND key = ${input.productKey}`,
			);
			const type = input.kind === "subscription" ? "subscription" : "consumable";
			if (
				existing &&
				(!existing.active ||
					existing.name !== input.name ||
					existing.type !== type ||
					existing.entitlement_key !== input.entitlementKey ||
					existing.credit_amount !== input.credits)
			)
				conflict("product_identity_conflict");
			const productRow =
				existing ??
				(await executeOne<{ id: string }>(
					tx,
					sql`INSERT INTO products (project_id, key, name, type, entitlement_key, credit_amount, active) VALUES (${projectId}, ${input.productKey}, ${input.name}, ${type}, ${input.entitlementKey}, ${input.credits}, true) RETURNING id`,
				));
			if (!productRow) throw new Error("Product insert returned no row");
			const mapping = await executeOne<{ id: string; product_id: string; active: boolean }>(
				tx,
				sql`SELECT id, product_id, active FROM store_products WHERE project_id = ${projectId} AND provider = 'stripe' AND (external_price_id = ${input.externalPriceId} OR product_id = ${productRow.id})`,
			);
			if (mapping) {
				const match = await executeOne(
					tx,
					sql`SELECT id FROM store_products WHERE project_id = ${projectId} AND id = ${mapping.id} AND product_id = ${productRow.id} AND external_product_id = ${input.externalProductId} AND external_price_id = ${input.externalPriceId} AND active = true`,
				);
				if (!match) conflict("binding_identity_conflict");
			}
			const stored =
				mapping ??
				(await executeOne<{ id: string }>(
					tx,
					sql`INSERT INTO store_products (project_id, product_id, provider, channel, external_product_id, external_price_id, billing_period, billing_period_count, currency, price_amount, active) VALUES (${projectId}, ${productRow.id}, 'stripe', 'web', ${input.externalProductId}, ${input.externalPriceId}, ${price.recurring?.interval ?? "one_time"}, ${price.recurring?.interval_count ?? 1}, ${price.currency}, ${price.unit_amount}, true) RETURNING id`,
				));
			if (!stored) throw new Error("Store product insert returned no row");
			const result: BindingResult = {
				productId: productRow.id,
				storeProductId: stored.id,
				productKey: input.productKey,
				externalProductId: input.externalProductId,
				externalPriceId: input.externalPriceId,
				active: true,
			};
			await executeRows(
				tx,
				sql`INSERT INTO catalog_binding_adoptions (project_id, request_key, request_hash, actor, result) VALUES (${projectId}, ${key}, ${hash}, ${actor}, ${jsonb(result)})`,
			);
			return result;
		});
	}
}
function conflict(reason: string): never {
	throw new BillingError("Stripe binding cannot be adopted", "STRIPE_BINDING_INVALID", 409, {
		details: { check: "binding", reason },
	});
}
