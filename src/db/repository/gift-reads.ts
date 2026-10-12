import { sql as drizzleSql } from "drizzle-orm";
import { decodeAdminCursor, encodeAdminCursor } from "../../admin/query";
import type {
	GiftCodeRecord,
	GiftCodeStatus,
	GiftRecord,
	PromotionListResult,
} from "../../billing/promotions";
import { toIso } from "../../shared/date";
import { executeOne, executeRows, jsonb } from "./query";
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

interface GiftRow {
	id: string;
	product_key: string;
	purchased_at: Date | string;
	reversed_at: Date | string | null;
	reversal_reason: "refund" | "dispute" | null;
	cursor_created_at: string;
}

interface GiftCodeRow {
	gift_purchase_id: string;
	code: string;
	status: GiftCodeStatus;
	expires_at: Date | string;
	redeemed_at: Date | string | null;
}

/**
 * The gifts an account bought, newest first, each with its codes, in pages of purchases. The
 * status of a code follows redemption's own precedence: a redemption makes it `redeemed`, which
 * a later refund or an archived promotion does not undo; otherwise a deactivated code or an
 * archived promotion makes it `deactivated`, and an elapsed expiry `expired`. The redeemer is
 * never read: `redeemedAt` is all a buyer learns.
 */
export async function readAccountGifts(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
	input: { limit: number; cursor?: string | null },
): Promise<PromotionListResult<GiftRecord>> {
	const cursor =
		input.cursor === undefined || input.cursor === null ? null : decodeAdminCursor(input.cursor);
	const rows = await executeRows<GiftRow>(
		executor,
		drizzleSql`
			SELECT
				gift.purchase_id AS id,
				product.key AS product_key,
				purchase.purchased_at,
				gift.reversed_at,
				gift.reversal_reason,
				to_char(gift.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
					AS cursor_created_at
			FROM customers customer
			JOIN purchases purchase
				ON purchase.project_id = customer.project_id AND purchase.customer_id = customer.id
			JOIN gift_purchases gift
				ON gift.project_id = purchase.project_id AND gift.purchase_id = purchase.id
			JOIN products product
				ON product.project_id = purchase.project_id AND product.id = purchase.product_id
			WHERE customer.project_id = ${projectId}
				AND customer.billing_account_id = ${billingAccountId}
				AND (
					${cursor === null}
					OR (gift.created_at, gift.purchase_id)
						< (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid)
				)
			ORDER BY gift.created_at DESC, gift.purchase_id DESC
			LIMIT ${input.limit + 1}
		`,
	);
	const page = rows.slice(0, input.limit);
	const last = rows[input.limit - 1];
	const codes =
		page.length === 0
			? []
			: await executeRows<GiftCodeRow>(
					executor,
					drizzleSql`
						SELECT
							code.gift_purchase_id,
							code.code,
							CASE
								WHEN redemption.id IS NOT NULL THEN 'redeemed'
								WHEN NOT code.active OR promotion.status = 'archived' THEN 'deactivated'
								WHEN code.expires_at IS NOT NULL AND code.expires_at <= now() THEN 'expired'
								ELSE 'available'
							END AS status,
							code.expires_at,
							redemption.applied_at AS redeemed_at
						FROM promotion_codes code
						JOIN promotions promotion
							ON promotion.project_id = code.project_id AND promotion.id = code.promotion_id
						LEFT JOIN LATERAL (
							SELECT r.id, r.applied_at
							FROM promotion_redemptions r
							WHERE r.project_id = code.project_id
								AND r.promotion_code_id = code.id
								AND r.status IN ('applied', 'reversed')
							ORDER BY r.applied_at
							LIMIT 1
						) redemption ON true
						WHERE code.project_id = ${projectId}
							AND code.gift_purchase_id IN (
								SELECT jsonb_array_elements_text(${jsonb(page.map((row) => row.id))})::uuid
							)
						ORDER BY code.gift_purchase_id, code.gift_ordinal
					`,
				);
	const byPurchase = new Map<string, GiftCodeRecord[]>();
	for (const row of codes) {
		const list = byPurchase.get(row.gift_purchase_id) ?? [];
		list.push({
			code: row.code,
			status: row.status,
			expiresAt: toIso(row.expires_at),
			redeemedAt: row.redeemed_at === null ? null : toIso(row.redeemed_at),
		});
		byPurchase.set(row.gift_purchase_id, list);
	}
	return {
		items: page.map((row) => ({
			purchaseId: row.id,
			productKey: row.product_key,
			purchasedAt: toIso(row.purchased_at),
			reversedAt: row.reversed_at === null ? null : toIso(row.reversed_at),
			reversalReason: row.reversal_reason,
			codes: byPurchase.get(row.id) ?? [],
		})),
		nextCursor:
			rows.length > input.limit && last !== undefined
				? encodeAdminCursor({ createdAt: last.cursor_created_at, id: last.id })
				: null,
	};
}
