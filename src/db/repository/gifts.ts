import { sql as drizzleSql } from "drizzle-orm";
import { generateGiftCode } from "../../billing/gift-codes";
import { insertAudit } from "./promotions";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";

/** The actor recorded on a code a purchase minted. */
export const GIFT_MINT_ACTOR = "system:gift-purchase";

/**
 * A code that already exists under another purchase, or under an operator, makes the insert skip
 * that ordinal, and the next attempt draws it again. A 99-bit draw collides only if the generator
 * is broken, so a handful of attempts is generous.
 */
const MINT_ATTEMPTS = 5;

export type GiftMintOutcome =
	/** Every ordinal of the purchase has a code. A replay lands here too. */
	| { kind: "minted"; codeCount: number }
	/** The store product has no published gift binding, so the purchase is not a gift. */
	| { kind: "not_a_gift" }
	/** A gift product, but the purchase is not `completed`, so nothing is minted for it. */
	| { kind: "purchase_not_completed" }
	/** The purchase was refunded or disputed; a late replay must not mint again. */
	| { kind: "reversed" };

/**
 * Mints the codes a completed gift purchase yields, in the transaction that records the purchase.
 *
 * The terms (promotion, code count, expiry) are snapshotted into `gift_purchases` on first
 * completion, so a replay, or a catalog published since, never changes how many codes the purchase
 * has. Codes are keyed by `(purchase, ordinal)`: `completed` and `async_payment_succeeded` arrive as
 * different events and both reach this function, and only the missing ordinals are inserted.
 *
 * It deliberately skips the operator path (`insertCodes`): that path refuses an archived promotion,
 * which would roll back a paid purchase, locks the promotion row, which would serialize every sale,
 * and treats a matching code text as a replay, which could hand two purchases the same code.
 */
export async function mintGiftCodesForPurchaseInTx(
	tx: QueryExecutor,
	input: {
		projectId: string;
		purchaseId: string;
		storeProductId: string;
		purchasedAt: Date;
		generateCode?: () => string;
	},
): Promise<GiftMintOutcome> {
	const { projectId, purchaseId } = input;
	const generateCode = input.generateCode ?? generateGiftCode;
	await executeOne(
		tx,
		drizzleSql`
			INSERT INTO gift_purchases (project_id, purchase_id, promotion_id, code_count, codes_expire_at)
			SELECT
				purchase.project_id,
				purchase.id,
				options.promotion_id,
				options.code_count,
				${input.purchasedAt.toISOString()}::timestamptz
					+ options.code_valid_days * interval '24 hours'
			FROM purchases purchase
			JOIN provider_gift_bindings bindings
				ON bindings.project_id = purchase.project_id
				AND bindings.store_product_id = ${input.storeProductId}
				AND bindings.status = 'published'
			JOIN gift_options options
				ON options.project_id = bindings.project_id
				AND options.id = bindings.gift_option_id
			WHERE purchase.project_id = ${projectId}
				AND purchase.id = ${purchaseId}
				AND purchase.status = 'completed'
			ON CONFLICT (project_id, purchase_id) DO NOTHING
			RETURNING purchase_id
		`,
	);
	const gift = await executeOne<{ code_count: number; reversed_at: Date | string | null }>(
		tx,
		drizzleSql`
			SELECT code_count, reversed_at
			FROM gift_purchases
			WHERE project_id = ${projectId} AND purchase_id = ${purchaseId}
		`,
	);
	if (gift === null) {
		const binding = await executeOne(
			tx,
			drizzleSql`
				SELECT 1
				FROM provider_gift_bindings
				WHERE project_id = ${projectId}
					AND store_product_id = ${input.storeProductId}
					AND status = 'published'
			`,
		);
		return binding === null ? { kind: "not_a_gift" } : { kind: "purchase_not_completed" };
	}
	if (gift.reversed_at !== null) return { kind: "reversed" };

	for (let attempt = 0; ; attempt += 1) {
		const present = await executeRows<{ gift_ordinal: number }>(
			tx,
			drizzleSql`
				SELECT gift_ordinal
				FROM promotion_codes
				WHERE project_id = ${projectId} AND gift_purchase_id = ${purchaseId}
			`,
		);
		const have = new Set(present.map((row) => Number(row.gift_ordinal)));
		const missing: Array<{ ordinal: number; code: string }> = [];
		for (let ordinal = 1; ordinal <= gift.code_count; ordinal += 1) {
			if (!have.has(ordinal)) missing.push({ ordinal, code: generateCode() });
		}
		if (missing.length === 0) return { kind: "minted", codeCount: gift.code_count };
		if (attempt === MINT_ATTEMPTS) {
			throw new Error("Gift codes could not be minted without a collision");
		}
		await executeRows(
			tx,
			drizzleSql`
				INSERT INTO promotion_codes (
					project_id, promotion_id, code, normalized_code, active, starts_at, expires_at,
					max_redemptions, max_redemptions_per_customer, first_purchase_only,
					billing_account_id, hosted_checkout_enabled, created_by, gift_purchase_id,
					gift_ordinal
				)
				SELECT
					gift.project_id, gift.promotion_id, minted.code, upper(minted.code), true, NULL,
					gift.codes_expire_at, 1, 1, false, NULL, false, ${GIFT_MINT_ACTOR},
					gift.purchase_id, minted.ordinal
				FROM gift_purchases gift
				CROSS JOIN jsonb_to_recordset(${jsonb(missing)}) AS minted(ordinal integer, code text)
				WHERE gift.project_id = ${projectId}
					AND gift.purchase_id = ${purchaseId}
					AND gift.reversed_at IS NULL
				ON CONFLICT DO NOTHING
			`,
		);
	}
}

/**
 * Withdraws what a fully refunded or disputed gift purchase left unredeemed, in the transaction
 * that reverses the purchase. A redeemed code keeps its running grant and still reads `redeemed`;
 * ending that grant is the operator's decision, through the existing revoke route. Returns null
 * when the purchase is not a gift or its reversal was already recorded.
 */
export async function deactivateGiftCodesForPurchaseInTx(
	tx: QueryExecutor,
	input: {
		projectId: string;
		purchaseId: string;
		reason: "refund" | "dispute";
		reversedAt: Date;
		actor: string;
	},
): Promise<{ deactivated: number } | null> {
	const { projectId, purchaseId, actor } = input;
	const reversed = await executeOne<{ promotion_id: string }>(
		tx,
		drizzleSql`
			UPDATE gift_purchases
			SET reversed_at = ${input.reversedAt.toISOString()}::timestamptz,
				reversal_reason = ${input.reason}
			WHERE project_id = ${projectId}
				AND purchase_id = ${purchaseId}
				AND reversed_at IS NULL
			RETURNING promotion_id
		`,
	);
	if (reversed === null) return null;
	const codes = await executeRows<{ id: string }>(
		tx,
		drizzleSql`
			UPDATE promotion_codes
			SET active = false,
				deactivated_at = now(),
				deactivated_by = ${actor},
				updated_at = now()
			WHERE project_id = ${projectId}
				AND gift_purchase_id = ${purchaseId}
				AND active
				AND redeemed_count + reserved_count = 0
			RETURNING id
		`,
	);
	for (const code of codes) {
		await insertAudit(tx, projectId, {
			promotionId: reversed.promotion_id,
			promotionCodeId: code.id,
			action: "code_deactivated",
			actor,
			details: { reason: `gift_purchase_${input.reason}`, purchaseId },
		});
	}
	return { deactivated: codes.length };
}
