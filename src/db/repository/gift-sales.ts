import { sql as drizzleSql } from "drizzle-orm";
import { executeOne } from "./query";
import type { QueryExecutor } from "./types";

export type GiftSale =
	| { onSale: true }
	| { onSale: false; reason: "no_definition" | "retired" | "promotion_unavailable" };

/**
 * Whether a credit-free consumable can be sold as a gift now: a published binding whose gift is
 * still in the published catalog and whose promotion still gives a plan. A retired gift keeps its
 * binding so a checkout already started completes, but it is no longer sold.
 */
export async function readGiftSale(
	executor: QueryExecutor,
	projectId: string,
	storeProductId: string,
): Promise<GiftSale> {
	const row = await executeOne<{
		in_published_catalog: boolean;
		promotion_status: string;
		effect_kind: string;
	}>(
		executor,
		drizzleSql`
			SELECT
				options.catalog_revision_id = project.published_catalog_revision_id AS in_published_catalog,
				promotion.status AS promotion_status,
				promotion.effect_kind
			FROM provider_gift_bindings bindings
			JOIN gift_options options
				ON options.project_id = bindings.project_id AND options.id = bindings.gift_option_id
			JOIN promotions promotion
				ON promotion.project_id = options.project_id AND promotion.id = options.promotion_id
			JOIN projects project ON project.id = bindings.project_id
			WHERE bindings.project_id = ${projectId}
				AND bindings.store_product_id = ${storeProductId}
				AND bindings.status = 'published'
		`,
	);
	if (row === null) return { onSale: false, reason: "no_definition" };
	if (!row.in_published_catalog) return { onSale: false, reason: "retired" };
	if (row.promotion_status !== "active" || row.effect_kind !== "plan_grant") {
		return { onSale: false, reason: "promotion_unavailable" };
	}
	return { onSale: true };
}

/**
 * Whether archiving the promotion would strand a gift: a gift of the published catalog still sells
 * its codes, or codes already sold are neither redeemed nor expired. Archived promotions refuse
 * every redemption, so a sold code would stop working.
 */
export async function promotionBacksGifts(
	executor: QueryExecutor,
	projectId: string,
	promotionKey: string,
): Promise<boolean> {
	const row = await executeOne(
		executor,
		drizzleSql`
			SELECT 1
			FROM promotions promotion
			JOIN projects project ON project.id = promotion.project_id
			WHERE promotion.project_id = ${projectId}
				AND promotion.key = ${promotionKey}
				AND promotion.status = 'active'
				AND (
					EXISTS (
						SELECT 1
						FROM gift_options options
						WHERE options.project_id = promotion.project_id
							AND options.promotion_id = promotion.id
							AND options.catalog_revision_id = project.published_catalog_revision_id
					)
					OR EXISTS (
						SELECT 1
						FROM promotion_codes code
						WHERE code.project_id = promotion.project_id
							AND code.promotion_id = promotion.id
							AND code.gift_purchase_id IS NOT NULL
							AND code.active
							AND code.redeemed_count + code.reserved_count = 0
							AND (code.expires_at IS NULL OR code.expires_at > now())
					)
				)
		`,
	);
	return row !== null;
}
