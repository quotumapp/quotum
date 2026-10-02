import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type {
	AppleOfferInput,
	ApplePromotionAction,
	ApplePromotionSigner,
} from "../../billing/apple-promotions";
import { sha256Hex, stableJson } from "../../billing/decimal";
import { BillingError, InvalidRequestError, PersistenceConflictError } from "../../billing/errors";
import {
	normalizePromotionCode,
	type PromotionRedeemInput,
	promotionError,
} from "../../billing/promotions";
import type { ProjectInstanceContext } from "../../projects/context";
import { toIso } from "../../shared/date";
import { RepositoryModule } from "./base";
import { lockCustomerRow } from "./invalidations";
import {
	applyPromotionRedemptionInTx,
	insertAudit,
	requirePromotion,
	requireRedemption,
	reservePromotionRedemptionInTx,
	resolvePromotionCodeInTx,
} from "./promotions";
import { executeOne, jsonb } from "./query";
import type { QueryExecutor, RecordStoreKitTransactionProjectionInput } from "./types";

function unavailable(message: string): never {
	throw new BillingError(message, "APPLE_PROMOTION_NOT_APPLICABLE", 409);
}

export async function linkAppleOfferInTx(
	tx: QueryExecutor,
	projectId: string,
	promotionId: string,
	input: AppleOfferInput,
	bundleId: string | undefined,
	actor: string,
): Promise<void> {
	if (!bundleId) unavailable("An active Apple connection is required");
	if (
		!["apple_promotional_offer", "apple_offer_code"].includes(input.objectKind) ||
		!input.productExternalId.trim() ||
		!input.offerIdentifier.trim() ||
		input.productExternalId.length > 255 ||
		input.offerIdentifier.length > 255
	) {
		throw new InvalidRequestError("Apple offer kind, product and offer identifier are required");
	}
	const promotion = await executeOne<{ id: string }>(
		tx,
		sql`
		SELECT id FROM promotions WHERE project_id = ${projectId} AND id = ${promotionId}
		AND status = 'active' AND effect_kind = 'discount' AND 'ios' = ANY(allowed_channels) FOR UPDATE
	`,
	);
	if (!promotion) unavailable("Apple offers require an active iOS discount promotion");
	const product = await executeOne<{ id: string }>(
		tx,
		sql`
		SELECT sp.id FROM store_products sp
		JOIN products p ON p.project_id = sp.project_id AND p.id = sp.product_id
		JOIN provider_plan_bindings b ON b.project_id = sp.project_id AND b.store_product_id = sp.id
		JOIN plan_versions v ON v.project_id = b.project_id AND v.id = b.plan_version_id
		JOIN plans plan ON plan.project_id = v.project_id AND plan.id = v.plan_id
		JOIN projects project ON project.id = sp.project_id
		WHERE sp.project_id = ${projectId} AND sp.provider = 'apple' AND sp.channel = 'ios'
		AND sp.active AND p.active AND p.type = 'subscription' AND sp.external_product_id = ${input.productExternalId.trim()}
		AND v.catalog_revision_id = project.published_catalog_revision_id
		AND (NOT EXISTS (SELECT 1 FROM promotion_targets t WHERE t.project_id = ${projectId} AND t.promotion_id = ${promotionId})
			OR EXISTS (SELECT 1 FROM promotion_targets t WHERE t.project_id = ${projectId} AND t.promotion_id = ${promotionId}
			AND (t.product_id = p.id OR t.plan_id = plan.id)))
	`,
	);
	if (!product) unavailable("The offer must target a published Apple subscription product");
	const inserted = await executeOne<{ id: string }>(
		tx,
		sql`
		INSERT INTO promotion_provider_objects (project_id, promotion_id, provider, provider_account_id, object_kind, external_id, product_external_id, status, ready_at)
		VALUES (${projectId}, ${promotionId}, 'apple', ${bundleId}, ${input.objectKind}, ${input.offerIdentifier.trim()}, ${input.productExternalId.trim()}, 'ready', now())
		ON CONFLICT DO NOTHING RETURNING id
	`,
	);
	if (!inserted) {
		const existing = await executeOne<{ promotion_id: string; status: string }>(
			tx,
			sql`
			SELECT promotion_id, status FROM promotion_provider_objects WHERE project_id = ${projectId}
			AND provider = 'apple' AND provider_account_id = ${bundleId} AND object_kind = ${input.objectKind}
			AND external_id = ${input.offerIdentifier.trim()} AND product_external_id = ${input.productExternalId.trim()}
		`,
		);
		if (existing?.promotion_id !== promotionId || existing.status === "retired")
			unavailable("This Apple offer is already linked or retired; use a new offer identifier");
		return;
	}
	await insertAudit(tx, projectId, {
		promotionId,
		action: "provider_mapping_added",
		actor,
		details: { ...input, bundleId, providerObjectId: inserted.id },
	});
}

interface SigningContext {
	id: string;
	promotion_id: string;
	product_external_id: string;
	external_id: string;
	external_subscription_id: string;
	customer_id: string;
	app_account_token: string;
}

export class ApplePromotionRepository extends RepositoryModule {
	async link(
		project: ProjectInstanceContext,
		key: string,
		offer: AppleOfferInput,
		signer: ApplePromotionSigner,
		actor: string,
	) {
		return this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const promotion = await requirePromotion(tx, projectId, sql`p.key = ${key}`);
			await linkAppleOfferInTx(tx, projectId, promotion.id, offer, signer.bundleId, actor);
			return requirePromotion(tx, projectId, sql`p.id = ${promotion.id}`);
		});
	}

	async retire(project: ProjectInstanceContext, key: string, offerId: string, actor: string) {
		return this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const promotion = await requirePromotion(tx, projectId, sql`p.key = ${key}`);
			const owned = await executeOne<{ id: string; status: string }>(
				tx,
				sql`
				SELECT id, status FROM promotion_provider_objects WHERE project_id = ${projectId}
				AND promotion_id = ${promotion.id} AND id = ${offerId} AND provider = 'apple' FOR UPDATE
			`,
			);
			if (!owned) unavailable("Apple offer was not found on this promotion");
			if (owned.status !== "retired") {
				await executeOne(
					tx,
					sql`UPDATE promotion_provider_objects SET status = 'retired', desired_active = false, retired_at = now(), updated_at = now() WHERE project_id = ${projectId} AND id = ${offerId} RETURNING id`,
				);
				await insertAudit(tx, projectId, {
					promotionId: promotion.id,
					action: "provider_mapping_retired",
					actor,
					details: { providerObjectId: offerId },
				});
			}
			return requirePromotion(tx, projectId, sql`p.id = ${promotion.id}`);
		});
	}

	async redeem(
		project: ProjectInstanceContext,
		input: PromotionRedeemInput,
		signer: ApplePromotionSigner,
	): Promise<ApplePromotionAction> {
		if (input.channel !== "ios" || !input.appleOfferId || !input.subscriptionId)
			throw new InvalidRequestError("iOS redemption requires appleOfferId and subscriptionId");
		const offerId = input.appleOfferId;
		const subscriptionId = input.subscriptionId;
		const code = normalizePromotionCode(input.code);
		const hash = sha256Hex(stableJson({ code, channel: input.channel, offerId, subscriptionId }));
		return this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await this.lockAccount(tx, projectId, input.billingAccountId);
			const replay = await this.replay(
				tx,
				projectId,
				customer,
				`redeem:${input.idempotencyKey}`,
				hash,
			);
			if (replay) return replay;
			const resolved = await resolvePromotionCodeInTx(tx, projectId, code);
			if (
				!resolved ||
				(resolved.code.billingAccountId !== null &&
					resolved.code.billingAccountId !== input.billingAccountId)
			)
				throw promotionError("PROMOTION_CODE_NOT_FOUND");
			const context = await this.context(
				tx,
				projectId,
				customer,
				offerId,
				subscriptionId,
				signer.bundleId,
			);
			if (context.promotion_id !== resolved.promotion.id)
				unavailable("The offer does not belong to this promotion");
			const previous = await executeOne<{ id: string }>(
				tx,
				sql`
				SELECT id FROM promotion_redemptions WHERE project_id = ${projectId} AND provider = 'apple'
				AND provider_object_id = ${offerId} AND external_subscription_id = ${context.external_subscription_id}
			`,
			);
			if (previous)
				unavailable(
					"This offer already has a redemption; refresh its signature to retry a pending purchase",
				);
			const now = await this.clock(tx);
			const { redemption } = await reservePromotionRedemptionInTx(tx, projectId, {
				customerId: customer,
				billingAccountId: input.billingAccountId,
				promotionCodeId: resolved.code.id,
				channel: "ios",
				provider: "apple",
				source: "apple_offer",
				providerObjectId: offerId,
				externalSubscriptionId: context.external_subscription_id,
				idempotencyKey: `apple_redeem:${input.idempotencyKey}`,
				requestHash: hash,
				reservedUntil: new Date(now + 86_400_000),
				effectSnapshot: { ...resolved.promotion.effect },
				actor: input.actor ?? input.billingAccountId,
			});
			return this.sign(
				tx,
				projectId,
				customer,
				redemption.id,
				context,
				signer,
				now,
				`redeem:${input.idempotencyKey}`,
				hash,
			);
		});
	}

	async refresh(
		project: ProjectInstanceContext,
		billingAccountId: string,
		redemptionId: string,
		key: string,
		signer: ApplePromotionSigner,
	): Promise<ApplePromotionAction> {
		return this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await this.lockAccount(tx, projectId, billingAccountId);
			const hash = sha256Hex(stableJson({ redemptionId }));
			const replay = await this.replay(tx, projectId, customer, `refresh:${key}`, hash);
			if (replay) return replay;
			const row = await executeOne<{
				provider_object_id: string;
				subscription_id: string;
				promotion_code_id: string;
			}>(
				tx,
				sql`
				SELECT r.provider_object_id, s.id AS subscription_id, r.promotion_code_id FROM promotion_redemptions r
				JOIN subscriptions s ON s.project_id = r.project_id AND s.provider = 'apple' AND s.external_subscription_id = r.external_subscription_id AND s.customer_id = r.customer_id
				WHERE r.project_id = ${projectId} AND r.id = ${redemptionId} AND r.customer_id = ${customer}
				AND r.provider = 'apple' AND r.status IN ('reserved', 'released') AND r.promotion_code_id IS NOT NULL
			`,
			);
			if (!row)
				unavailable("Only an unused Apple promotional-offer redemption can be signed again");
			const context = await this.context(
				tx,
				projectId,
				customer,
				row.provider_object_id,
				row.subscription_id,
				signer.bundleId,
			);
			const original = await executeOne<{
				idempotency_key: string;
				request_hash: string;
				effect_snapshot: Record<string, unknown>;
				actor: string;
			}>(
				tx,
				sql`SELECT idempotency_key, request_hash, effect_snapshot, actor FROM promotion_redemptions WHERE project_id = ${projectId} AND id = ${redemptionId} FOR UPDATE`,
			);
			if (!original) unavailable("Redemption was not found");
			const usable = await executeOne<{ id: string }>(
				tx,
				sql`
				SELECT id FROM promotion_codes WHERE project_id = ${projectId} AND id = ${row.promotion_code_id}
				AND active AND (starts_at IS NULL OR starts_at <= now()) AND (expires_at IS NULL OR expires_at > now()) FOR UPDATE
			`,
			);
			if (!usable) unavailable("This promotion code is no longer active");
			const now = await this.clock(tx);
			await reservePromotionRedemptionInTx(tx, projectId, {
				customerId: customer,
				billingAccountId,
				promotionCodeId: row.promotion_code_id,
				channel: "ios",
				provider: "apple",
				source: "apple_offer",
				idempotencyKey: original.idempotency_key,
				requestHash: original.request_hash,
				effectSnapshot: original.effect_snapshot,
				actor: original.actor,
				reservedUntil: new Date(now + 86_400_000),
			});
			return this.sign(
				tx,
				projectId,
				customer,
				redemptionId,
				context,
				signer,
				now,
				`refresh:${key}`,
				hash,
			);
		});
	}

	private async lockAccount(
		tx: QueryExecutor,
		projectId: string,
		account: string,
	): Promise<string> {
		const customer = await executeOne<{ id: string }>(
			tx,
			sql`SELECT id FROM customers WHERE project_id = ${projectId} AND billing_account_id = ${account}`,
		);
		if (!customer) unavailable("An existing linked Apple subscription is required");
		await lockCustomerRow(tx, projectId, customer.id);
		return customer.id;
	}

	private async context(
		tx: QueryExecutor,
		projectId: string,
		customer: string,
		offerId: string,
		subscriptionId: string,
		bundleId: string,
	): Promise<SigningContext> {
		const row = await executeOne<SigningContext>(
			tx,
			sql`
			SELECT o.id, o.promotion_id, o.product_external_id, o.external_id, s.external_subscription_id,
				s.customer_id, pc.external_customer_id AS app_account_token
			FROM promotion_provider_objects o
			JOIN promotions p ON p.project_id = o.project_id AND p.id = o.promotion_id
			JOIN subscriptions s ON s.project_id = o.project_id AND s.id = ${subscriptionId} AND s.customer_id = ${customer}
			JOIN store_products sp ON sp.project_id = s.project_id AND sp.id = s.store_product_id AND sp.active
			JOIN provider_customers pc ON pc.project_id = s.project_id AND pc.customer_id = s.customer_id AND pc.provider = 'apple'
			WHERE o.project_id = ${projectId} AND o.id = ${offerId} AND o.provider = 'apple'
			AND o.provider_account_id = ${bundleId} AND o.object_kind = 'apple_promotional_offer'
			AND o.status = 'ready' AND o.desired_active AND p.status = 'active' AND p.effect_kind = 'discount'
			AND 'ios' = ANY(p.allowed_channels) AND s.provider = 'apple' AND s.external_product_id = o.product_external_id
			AND s.status NOT IN ('refunded', 'revoked')
			AND s.raw_state #>> '{transaction,bundleId}' = ${bundleId}
			FOR SHARE OF o, p
		`,
		);
		if (!row)
			unavailable(
				"The Apple offer must match this account's linked subscription and current connection",
			);
		return row;
	}

	private async clock(tx: QueryExecutor): Promise<number> {
		const row = await executeOne<{ now: Date | string }>(tx, sql`SELECT clock_timestamp() AS now`);
		if (!row) throw new Error("Database clock unavailable");
		return new Date(toIso(row.now)).getTime();
	}

	private async replay(
		tx: QueryExecutor,
		projectId: string,
		customer: string,
		key: string,
		hash: string,
	): Promise<ApplePromotionAction | null> {
		const row = await executeOne<{ request_hash: string; result: ApplePromotionAction }>(
			tx,
			sql`SELECT request_hash, result FROM promotion_apple_signature_attempts WHERE project_id = ${projectId} AND customer_id = ${customer} AND idempotency_key = ${key}`,
		);
		if (!row) return null;
		if (row.request_hash !== hash)
			throw new PersistenceConflictError(
				"Apple signature key was reused with different input",
				"IDEMPOTENCY_CONFLICT",
			);
		return { ...row.result, duplicate: true };
	}

	private async sign(
		tx: QueryExecutor,
		projectId: string,
		customer: string,
		redemptionId: string,
		context: SigningContext,
		signer: ApplePromotionSigner,
		timestamp: number,
		key: string,
		hash: string,
	): Promise<ApplePromotionAction> {
		const nonce = randomUUID().toLowerCase();
		const appAccountToken = context.app_account_token.toLowerCase();
		const expiresAt = new Date(timestamp + 86_400_000).toISOString();
		const signature = signer.sign({
			productId: context.product_external_id,
			offerIdentifier: context.external_id,
			appAccountToken,
			nonce,
			timestamp,
		});
		await executeOne(
			tx,
			sql`UPDATE promotion_redemptions SET reserved_until = ${expiresAt}::timestamptz, updated_at = now() WHERE project_id = ${projectId} AND id = ${redemptionId} AND status = 'reserved' RETURNING id`,
		);
		const {
			promotionId: _promotionId,
			customerId: _customerId,
			requestHash: _requestHash,
			result: _result,
			...redemption
		} = await requireRedemption(tx, projectId, redemptionId);
		const result: ApplePromotionAction = {
			kind: "provider_action_required",
			provider: "apple",
			duplicate: false,
			redemption,
			appleOffer: {
				productId: context.product_external_id,
				offerIdentifier: context.external_id,
				appAccountToken,
				keyId: signer.keyId,
				nonce,
				timestamp,
				signature,
				expiresAt,
			},
		};
		await executeOne(
			tx,
			sql`INSERT INTO promotion_apple_signature_attempts (project_id, customer_id, redemption_id, idempotency_key, request_hash, result) VALUES (${projectId}, ${customer}, ${redemptionId}, ${key}, ${hash}, ${jsonb(result)}) RETURNING id`,
		);
		return result;
	}
}

/** Called inside the verified purchase transaction, never from caller-supplied offer data. */
export async function recordApplePromotionInTx(
	tx: QueryExecutor,
	projectId: string,
	customerId: string,
	purchaseId: string,
	input: RecordStoreKitTransactionProjectionInput,
): Promise<void> {
	const offer = input.appleOffer;
	if (!offer || !input.originalTransactionId || input.purchaseKind !== "subscription") return;
	const mapping = await executeOne<{ id: string; promotion_id: string; inactive: boolean }>(
		tx,
		sql`
		SELECT o.id, o.promotion_id, (o.status = 'retired' OR p.status = 'archived') AS inactive
		FROM promotion_provider_objects o JOIN promotions p ON p.project_id = o.project_id AND p.id = o.promotion_id
		WHERE o.project_id = ${projectId} AND o.provider = 'apple' AND o.provider_account_id = ${offer.bundleId}
		AND o.product_external_id = ${input.externalProductId} AND o.external_id = ${offer.identifier}
		AND o.object_kind = ${offer.type === 2 ? "apple_promotional_offer" : "apple_offer_code"}
	`,
	);
	if (!mapping) return;
	await lockCustomerRow(tx, projectId, customerId);
	let row = await executeOne<{ id: string; status: string; purchase_id: string | null }>(
		tx,
		sql`
		SELECT id, status, purchase_id FROM promotion_redemptions WHERE project_id = ${projectId} AND provider = 'apple'
		AND provider_object_id = ${mapping.id} AND external_subscription_id = ${input.originalTransactionId} FOR UPDATE
	`,
	);
	const firstObservation = !row || row.status === "reserved" || row.status === "released";
	if (!row) {
		const identity = `apple_offer:${mapping.id}:${input.originalTransactionId}`;
		row = await executeOne<{ id: string; status: string; purchase_id: string | null }>(
			tx,
			sql`
			INSERT INTO promotion_redemptions (project_id, promotion_id, customer_id, channel, status, provider, source, provider_object_id, external_subscription_id, purchase_id, effect_snapshot, actor, idempotency_key, request_hash, applied_at, limit_violation)
			VALUES (${projectId}, ${mapping.promotion_id}, ${customerId}, 'ios', 'applied', 'apple', 'apple_offer', ${mapping.id}, ${input.originalTransactionId}, ${purchaseId}, ${jsonb({ kind: "discount", appleOffer: offer })}, 'provider:apple', ${identity}, ${sha256Hex(identity)}, now(), ${mapping.inactive ? "inactive" : null})
			RETURNING id, status, purchase_id
		`,
		);
	}
	if (!row) throw new Error("Apple offer observation could not be recorded");
	if (row.status === "reserved" || row.status === "released") {
		await applyPromotionRedemptionInTx(tx, projectId, {
			redemptionId: row.id,
			purchaseId,
			externalSubscriptionId: input.originalTransactionId,
		});
	}
	await executeOne(
		tx,
		sql`
		UPDATE promotion_redemptions SET provider_offer_type = ${String(offer.type)},
		provider_transaction_id = COALESCE(provider_transaction_id, ${input.transactionId}),
		last_observed_transaction_id = CASE WHEN last_observed_at IS NULL OR last_observed_at <= ${input.purchasedAt.toISOString()}::timestamptz THEN ${input.transactionId} ELSE last_observed_transaction_id END,
		last_observed_at = GREATEST(last_observed_at, ${input.purchasedAt.toISOString()}::timestamptz),
		limit_violation = COALESCE(limit_violation, ${firstObservation && mapping.inactive ? "inactive" : null}), updated_at = now()
		WHERE project_id = ${projectId} AND id = ${row.id} RETURNING id
	`,
	);
	// Codes can expire or be disabled after a signature was issued. Provider truth still wins.
	await executeOne(
		tx,
		sql`
		UPDATE promotion_redemptions r SET limit_violation = COALESCE(r.limit_violation,
			CASE WHEN NOT c.active THEN 'inactive'
			WHEN c.expires_at <= ${input.purchasedAt.toISOString()}::timestamptz THEN 'expired' END)
		FROM promotion_codes c WHERE r.project_id = ${projectId} AND r.id = ${row.id}
		AND c.project_id = r.project_id AND c.id = r.promotion_code_id AND r.purchase_id = ${purchaseId}
		RETURNING r.id
	`,
	);
	// Only the purchase attributed to this use changes its reversal state, not later renewals.
	await executeOne(
		tx,
		sql`
		UPDATE promotion_redemptions r SET status = CASE WHEN p.status IN ('refunded', 'revoked') THEN 'reversed' ELSE 'applied' END,
		reversed_at = CASE WHEN p.status IN ('refunded', 'revoked') THEN COALESCE(r.reversed_at, now()) ELSE NULL END, updated_at = now()
		FROM purchases p WHERE r.project_id = ${projectId} AND r.id = ${row.id}
		AND p.project_id = r.project_id AND p.id = r.purchase_id AND p.id = ${purchaseId}
		AND r.status IN ('applied', 'reversed') RETURNING r.id
	`,
	);
}
