import { sql } from "drizzle-orm";
import type Stripe from "stripe";
import { z } from "zod";
import { sha256Hex, stableJson } from "../billing/decimal";
import { BillingError } from "../billing/errors";
import { RepositoryModule } from "../db/repository/base";
import { executeOne, executeRows, jsonb } from "../db/repository/query";
import type { QueryExecutor, TransactionalQueryExecutor } from "../db/repository/types";
import type { RuntimeConnectionResolver } from "../projects/connections";
import type { ProjectInstanceContext } from "../projects/context";
import { billingCadenceUnits, maxCadenceCount } from "../shared/cadence";
import { billingProviders } from "../shared/provider-capabilities";

const stripeBindingAdoptionSchema = z
	.object({
		/** Omitted means Stripe, which is what every adoption file did before native stores. */
		provider: z.literal("stripe").optional(),
		productKey: z.string().trim().min(1).max(120),
		name: z.string().trim().min(1).max(120),
		kind: z.enum(["subscription", "topup", "gift"]),
		/** Required except for a gift, whose product grants nothing to the buyer. */
		entitlementKey: z.string().trim().min(1).max(120).optional(),
		/** Required except for a gift, which carries no credits. */
		credits: z.number().int().nonnegative().max(100_000).optional(),
		externalProductId: z.string().regex(/^prod_[A-Za-z0-9]+$/u),
		externalPriceId: z.string().regex(/^price_[A-Za-z0-9]+$/u),
	})
	.strict()
	.superRefine((input, context) => {
		if (input.kind === "gift") {
			if (input.credits !== undefined && input.credits !== 0) {
				context.addIssue({
					code: "custom",
					message: "A gift carries no credits",
					path: ["credits"],
				});
			}
			return;
		}
		if (input.entitlementKey === undefined) {
			context.addIssue({
				code: "custom",
				message: "An entitlement key is required",
				path: ["entitlementKey"],
			});
		}
		if (input.credits === undefined) {
			context.addIssue({ code: "custom", message: "Credits are required", path: ["credits"] });
		} else if (input.kind === "topup" && input.credits === 0) {
			context.addIssue({
				code: "custom",
				message: "Top-ups require positive credits",
				path: ["credits"],
			});
		}
	});

/** What an operator declares about an App Store or Google Play product; Quotum never reads the store. */
const nativeBindingFields = {
	productKey: z.string().trim().min(1).max(120),
	name: z.string().trim().min(1).max(120),
	/** A gift is sold on the web through Stripe only. */
	kind: z.enum(["subscription", "topup"]),
	entitlementKey: z.string().trim().min(1).max(120),
	credits: z.number().int().nonnegative().max(100_000),
	/** The App Store product identifier, or the Google Play subscription or in-app product id. */
	externalProductId: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/u),
	/** How often a subscription renews; a top-up is a one-time purchase and takes neither field. */
	billingPeriod: z.enum(billingCadenceUnits).optional(),
	billingPeriodCount: z.number().int().min(1).max(maxCadenceCount).optional(),
	/** What the store charges, for catalog price bindings; a provider-priced plan needs neither. */
	currency: z.string().trim().length(3).optional(),
	priceAmountMinor: z.number().int().nonnegative().optional(),
};

function refineNativeBinding(
	input: {
		kind: "subscription" | "topup";
		credits: number;
		billingPeriod?: string | undefined;
		billingPeriodCount?: number | undefined;
		currency?: string | undefined;
		priceAmountMinor?: number | undefined;
	},
	context: z.RefinementCtx,
): void {
	if (input.kind === "subscription") {
		if (input.billingPeriod === undefined)
			context.addIssue({
				code: "custom",
				message: "A subscription needs the billing period it renews on",
				path: ["billingPeriod"],
			});
	} else {
		if (input.billingPeriod !== undefined || input.billingPeriodCount !== undefined)
			context.addIssue({
				code: "custom",
				message: "A top-up is a one-time purchase and has no billing period",
				path: ["billingPeriod"],
			});
		if (input.credits === 0)
			context.addIssue({
				code: "custom",
				message: "Top-ups require positive credits",
				path: ["credits"],
			});
	}
	if ((input.currency === undefined) !== (input.priceAmountMinor === undefined))
		context.addIssue({
			code: "custom",
			message: "currency and priceAmountMinor are given together or not at all",
			path: [input.currency === undefined ? "currency" : "priceAmountMinor"],
		});
}

const appleBindingAdoptionSchema = z
	.object({ provider: z.literal("apple"), ...nativeBindingFields })
	.strict()
	.superRefine(refineNativeBinding);

const googleBindingAdoptionSchema = z
	.object({
		provider: z.literal("google"),
		...nativeBindingFields,
		/** The subscription's base plan id. Omitted, the product matches any base plan. */
		externalPriceId: z
			.string()
			.regex(/^[A-Za-z0-9_-]{1,63}$/u)
			.optional(),
	})
	.strict()
	.superRefine(refineNativeBinding);

export const bindingAdoptionSchema = z.discriminatedUnion("provider", [
	stripeBindingAdoptionSchema,
	appleBindingAdoptionSchema,
	googleBindingAdoptionSchema,
]);
export type BindingAdoption = z.infer<typeof bindingAdoptionSchema>;
export const bindingResultSchema = z.object({
	productId: z.uuid(),
	storeProductId: z.uuid(),
	productKey: z.string(),
	provider: z.enum(billingProviders),
	channel: z.enum(["ios", "android", "web"]),
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
	/** Composition supplies the Stripe client, so this module never constructs provider clients. */
	constructor(
		database: TransactionalQueryExecutor,
		private readonly connections: RuntimeConnectionResolver,
		private readonly clientFactory: (secretKey: string) => Stripe,
	) {
		super(database);
	}
	async list(project: ProjectInstanceContext): Promise<BindingResult[]> {
		return await executeRows<BindingResult>(
			this.database,
			sql`
			SELECT p.id AS "productId", sp.id AS "storeProductId", p.key AS "productKey",
			sp.provider AS "provider", sp.channel AS "channel",
			sp.external_product_id AS "externalProductId", sp.external_price_id AS "externalPriceId", sp.active AND p.active AS active
			FROM products p JOIN store_products sp ON sp.project_id = p.project_id AND sp.product_id = p.id
			WHERE p.project_id = ${project.projectInstanceId}
			ORDER BY p.key, sp.provider, sp.id
		`,
		);
	}
	async adopt(
		project: ProjectInstanceContext,
		input: BindingAdoption,
		actor: string,
		key: string,
	): Promise<BindingResult> {
		if (input.provider === "apple" || input.provider === "google")
			return await this.adoptNative(project, input, actor, key);
		return await this.adoptStripe(project, input, actor, key);
	}

	/** An exact repeat of an adoption answers what it answered then, whatever fields it has grown since. */
	private async recorded(
		executor: QueryExecutor,
		projectId: string,
		key: string,
		hash: string,
		reuse: (reason: string) => never,
	): Promise<BindingResult | null> {
		const previous = await executeOne<{
			request_hash: string;
			result: Omit<BindingResult, "provider" | "channel"> &
				Partial<Pick<BindingResult, "provider" | "channel">>;
		}>(
			executor,
			sql`SELECT request_hash, result FROM catalog_binding_adoptions WHERE project_id = ${projectId} AND request_key = ${key}`,
		);
		if (!previous) return null;
		if (previous.request_hash !== hash) reuse("idempotency_key_reused");
		// Receipts written before native stores carry neither provider nor channel.
		return {
			...previous.result,
			provider: previous.result.provider ?? "stripe",
			channel: previous.result.channel ?? "web",
		};
	}

	private async adoptStripe(
		project: ProjectInstanceContext,
		input: Extract<BindingAdoption, { provider?: "stripe" | undefined }>,
		actor: string,
		key: string,
	): Promise<BindingResult> {
		const projectId = project.projectInstanceId;
		// `provider: "stripe"` and its absence are the same request.
		const { provider: _provider, ...request } = input;
		const hash = sha256Hex(stableJson(request));
		const previous = await this.recorded(this.database, projectId, key, hash, conflict);
		if (previous) return previous;
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
			(input.kind !== "subscription" && price.unit_amount === 0) ||
			(input.kind === "subscription") !== (price.type === "recurring") ||
			(price.recurring && price.recurring.usage_type !== "licensed")
		)
			conflict("unsupported_price_shape");
		return await this.transaction(async (tx) => {
			// Same project lock used by publication: adding a mapping cannot race the active pointer.
			await executeOne(tx, sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
			const replay = await this.recorded(tx, projectId, key, hash, conflict);
			if (replay) return replay;
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
			// Nothing reads a consumable's entitlement key, so a gift needs none from the caller.
			const entitlementKey = input.entitlementKey ?? input.productKey;
			const credits = input.credits ?? 0;
			if (
				existing &&
				(!existing.active ||
					existing.name !== input.name ||
					existing.type !== type ||
					existing.entitlement_key !== entitlementKey ||
					existing.credit_amount !== credits)
			)
				conflict("product_identity_conflict");
			const productRow =
				existing ??
				(await executeOne<{ id: string }>(
					tx,
					sql`INSERT INTO products (project_id, key, name, type, entitlement_key, credit_amount, active) VALUES (${projectId}, ${input.productKey}, ${input.name}, ${type}, ${entitlementKey}, ${credits}, true) RETURNING id`,
				));
			if (!productRow) throw new Error("Product insert returned no row");
			const mapping = await executeOne<{ id: string; product_id: string; active: boolean }>(
				tx,
				// The exact mapping sorts first: a product can also hold a retired mapping, and an exact
				// repeat must not be judged against whichever row the scan returns first.
				sql`SELECT id, product_id, active FROM store_products WHERE project_id = ${projectId} AND provider = 'stripe' AND (external_price_id = ${input.externalPriceId} OR product_id = ${productRow.id}) ORDER BY (product_id = ${productRow.id} AND external_product_id = ${input.externalProductId} AND external_price_id = ${input.externalPriceId} AND active) DESC, id LIMIT 1`,
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
				provider: "stripe",
				channel: "web",
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

	/**
	 * Registers an App Store or Google Play product the operator declares. Neither store's server
	 * API offers a product lookup to a Quotum connection, so nothing is read from the store and no
	 * connection is needed: the first publish and the first real purchase verify it end to end. The
	 * rules match a Stripe adoption: additive, an exact repeat answers the same ids, and an existing
	 * product or mapping is never rewritten, except that a mapping without a price may gain one.
	 */
	private async adoptNative(
		project: ProjectInstanceContext,
		input: Extract<BindingAdoption, { provider: "apple" | "google" }>,
		actor: string,
		key: string,
	): Promise<BindingResult> {
		const projectId = project.projectInstanceId;
		const hash = sha256Hex(stableJson(input));
		const previous = await this.recorded(this.database, projectId, key, hash, storeConflict);
		if (previous) return previous;
		const channel = input.provider === "apple" ? "ios" : "android";
		const externalPriceId = input.provider === "google" ? (input.externalPriceId ?? null) : null;
		const period = input.kind === "subscription" ? (input.billingPeriod ?? "one_time") : "one_time";
		const periodCount = input.kind === "subscription" ? (input.billingPeriodCount ?? 1) : 1;
		const currency = input.currency === undefined ? null : input.currency.toLowerCase();
		const priceAmount = input.priceAmountMinor ?? null;
		return await this.transaction(async (tx) => {
			// Same project lock used by publication: adding a mapping cannot race the active pointer.
			await executeOne(tx, sql`SELECT id FROM projects WHERE id = ${projectId} FOR UPDATE`);
			const replay = await this.recorded(tx, projectId, key, hash, storeConflict);
			if (replay) return replay;
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
				storeConflict("product_identity_conflict");
			const productRow =
				existing ??
				(await executeOne<{ id: string }>(
					tx,
					sql`INSERT INTO products (project_id, key, name, type, entitlement_key, credit_amount, active) VALUES (${projectId}, ${input.productKey}, ${input.name}, ${type}, ${input.entitlementKey}, ${input.credits}, true) RETURNING id`,
				));
			if (!productRow) throw new Error("Product insert returned no row");
			// A product holds one mapping per provider, and a store product id is never mapped twice.
			// The exact mapping sorts first so a repeat is not judged against whichever row scans first.
			const mapping = await executeOne<{ id: string }>(
				tx,
				sql`SELECT id FROM store_products WHERE project_id = ${projectId} AND provider = ${input.provider} AND (product_id = ${productRow.id} OR (external_product_id = ${input.externalProductId} AND external_price_id IS NOT DISTINCT FROM ${externalPriceId})) ORDER BY (product_id = ${productRow.id} AND channel = ${channel} AND external_product_id = ${input.externalProductId} AND external_price_id IS NOT DISTINCT FROM ${externalPriceId} AND billing_period = ${period} AND billing_period_count = ${periodCount} AND currency IS NOT DISTINCT FROM ${currency} AND price_amount IS NOT DISTINCT FROM ${priceAmount} AND active) DESC, id LIMIT 1`,
			);
			if (mapping) {
				const match = await executeOne(
					tx,
					sql`SELECT id FROM store_products WHERE project_id = ${projectId} AND id = ${mapping.id} AND product_id = ${productRow.id} AND channel = ${channel} AND external_product_id = ${input.externalProductId} AND external_price_id IS NOT DISTINCT FROM ${externalPriceId} AND billing_period = ${period} AND billing_period_count = ${periodCount} AND currency IS NOT DISTINCT FROM ${currency} AND price_amount IS NOT DISTINCT FROM ${priceAmount} AND active = true`,
				);
				// A mapping adopted without a price may gain one; everything else it declares stays fixed.
				const priced =
					match ??
					(priceAmount === null
						? null
						: await executeOne(
								tx,
								sql`UPDATE store_products SET currency = ${currency}, price_amount = ${priceAmount}, updated_at = now() WHERE project_id = ${projectId} AND id = ${mapping.id} AND product_id = ${productRow.id} AND channel = ${channel} AND external_product_id = ${input.externalProductId} AND external_price_id IS NOT DISTINCT FROM ${externalPriceId} AND billing_period = ${period} AND billing_period_count = ${periodCount} AND currency IS NULL AND price_amount IS NULL AND active = true RETURNING id`,
							));
				if (!priced) storeConflict("binding_identity_conflict");
			}
			const stored =
				mapping ??
				(await executeOne<{ id: string }>(
					tx,
					sql`INSERT INTO store_products (project_id, product_id, provider, channel, external_product_id, external_price_id, billing_period, billing_period_count, currency, price_amount, active) VALUES (${projectId}, ${productRow.id}, ${input.provider}, ${channel}, ${input.externalProductId}, ${externalPriceId}, ${period}, ${periodCount}, ${currency}, ${priceAmount}, true) RETURNING id`,
				));
			if (!stored) throw new Error("Store product insert returned no row");
			const result: BindingResult = {
				productId: productRow.id,
				storeProductId: stored.id,
				productKey: input.productKey,
				provider: input.provider,
				channel,
				externalProductId: input.externalProductId,
				externalPriceId,
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
function storeConflict(reason: string): never {
	throw new BillingError("Store product binding cannot be adopted", "STORE_BINDING_INVALID", 409, {
		details: { check: "binding", reason },
	});
}
function conflict(reason: string): never {
	throw new BillingError("Stripe binding cannot be adopted", "STRIPE_BINDING_INVALID", 409, {
		details: { check: "binding", reason },
	});
}
