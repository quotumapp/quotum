import { sql } from "drizzle-orm";
import { BillingError, NotFoundBillingError } from "../../billing/errors";
import {
	type PaddleCommercialTarget,
	paddleCommercialTargetSchema,
} from "../../providers/paddle/plan";
import { type BillingCadenceUnit, sameCadence } from "../../shared/cadence";
import { executeOne } from "./query";
import type { QueryExecutor } from "./types";

/** Left joins keep an unbound or unsupported component visible, so it cannot be silently dropped. */
export async function paddlePlanTarget(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
	planKey: string,
): Promise<PaddleCommercialTarget> {
	const row = await executeOne<{
		id: string;
		revision_id: string;
		name: string;
		plan_kind: string;
		trial_days: number | null;
		component_count: number;
		unsupported_items: boolean;
		price_id: string;
		price_key: string;
		component_kind: string;
		pricing_model: string;
		quantity: string;
		minimum_quantity: number;
		maximum_quantity: number | null;
		unit_amount_minor: number;
		currency: string;
		billing_interval: BillingCadenceUnit;
		billing_interval_count: number;
		store_product_id: string;
		product_key: string;
		product_type: string;
		external_price_id: string;
		external_product_id: string;
		price_amount: number;
		store_currency: string;
		billing_period: BillingCadenceUnit;
		billing_period_count: number;
	}>(
		executor,
		sql`
		SELECT pv.id::text, pv.catalog_revision_id::text AS revision_id, p.name, pv.plan_kind, pv.trial_days,
			(SELECT count(*)::integer FROM price_components all_prices WHERE all_prices.project_id = pv.project_id AND all_prices.plan_version_id = pv.id) AS component_count,
			EXISTS (SELECT 1 FROM plan_items overage WHERE overage.project_id = pv.project_id AND overage.plan_version_id = pv.id AND (overage.overage_policy = 'allowed' OR (overage.item_kind = 'allocation' AND overage.allocation_scope = 'entity'))) AS unsupported_items,
			pc.id::text AS price_id, pc.key AS price_key, pc.component_kind, pc.pricing_model,
			COALESCE(pi.quantity, 1)::text AS quantity, pc.minimum_quantity, pc.maximum_quantity,
			pc.unit_amount_minor, pc.currency, pc.billing_interval, pc.billing_interval_count,
			sp.id AS store_product_id, product.key AS product_key, product.type AS product_type,
			sp.external_price_id, sp.external_product_id, sp.price_amount, sp.currency AS store_currency, sp.billing_period, sp.billing_period_count
		FROM plans p JOIN plan_versions pv ON pv.project_id = p.project_id AND pv.id = p.active_version_id
		LEFT JOIN price_components pc ON pc.project_id = pv.project_id AND pc.plan_version_id = pv.id
		LEFT JOIN plan_items pi ON pi.project_id = pc.project_id AND pi.id = pc.plan_item_id
		LEFT JOIN provider_price_bindings ppb ON ppb.project_id = pc.project_id AND ppb.price_component_id = pc.id AND ppb.provider = 'paddle' AND ppb.channel = 'web' AND ppb.status = 'published'
		LEFT JOIN store_products sp ON sp.project_id = ppb.project_id AND sp.id = ppb.store_product_id AND sp.provider = 'paddle' AND sp.active = true
		LEFT JOIN products product ON product.project_id = sp.project_id AND product.id = sp.product_id AND product.active = true
		WHERE p.project_id = ${projectId} AND p.key = ${planKey} AND p.active = true AND pv.status = 'published'
			AND (pv.visibility = 'public' OR EXISTS (SELECT 1 FROM customers c WHERE c.project_id = pv.project_id AND c.id = pv.customer_id AND c.billing_account_id = ${billingAccountId}))
		ORDER BY pc.id LIMIT 1
	`,
	);
	if (!row) throw new NotFoundBillingError("Active plan was not found", "BILLING_PLAN_NOT_FOUND");
	if (
		row.plan_kind !== "base" ||
		row.trial_days !== null ||
		row.component_count !== 1 ||
		row.unsupported_items ||
		row.component_kind !== "base" ||
		row.pricing_model !== "flat" ||
		Number(row.quantity) !== 1 ||
		row.minimum_quantity > 1 ||
		(row.maximum_quantity !== null && row.maximum_quantity < 1) ||
		!row.store_product_id ||
		row.product_type !== "subscription" ||
		Number(row.unit_amount_minor) !== Number(row.price_amount) ||
		row.currency.toUpperCase() !== row.store_currency.toUpperCase() ||
		!sameCadence(
			{ unit: row.billing_interval, count: row.billing_interval_count },
			{ unit: row.billing_period, count: row.billing_period_count },
		)
	)
		throw new BillingError(
			"Paddle requires one fixed base-plan price at quantity one without a trial",
			"PADDLE_PLAN_UNSUPPORTED",
			400,
		);
	return paddleCommercialTargetSchema.parse({
		productKey: row.product_key,
		name: row.name,
		priceKey: row.price_key,
		storeProductId: row.store_product_id,
		plan: {
			planVersionId: row.id,
			catalogRevisionId: row.revision_id,
			priceComponentId: row.price_id,
			storeProductId: row.store_product_id,
		},
		binding: {
			priceId: row.external_price_id,
			productId: row.external_product_id,
			productType: "subscription",
			currency: row.currency.toUpperCase(),
			unitAmountMinor: String(row.unit_amount_minor),
			billingCycle: { interval: row.billing_period, frequency: row.billing_period_count },
			trialPeriod: null,
			quantity: 1,
		},
	});
}
