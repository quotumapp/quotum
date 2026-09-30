import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { PromotionalOfferSignatureCreator } from "@apple/app-store-server-library";
import type { AppleOfferInput, ApplePromotionSigner } from "../../src/billing/apple-promotions";
import type { RecordStoreKitTransactionProjectionInput } from "../../src/db/repository";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const creator = new PromotionalOfferSignatureCreator(
	privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
	"TESTKEY",
	"com.acme.app",
);
const signer: ApplePromotionSigner = {
	bundleId: "com.acme.app",
	keyId: "TESTKEY",
	sign: (value) =>
		creator.createSignature(
			value.productId,
			value.offerIdentifier,
			value.appAccountToken,
			value.nonce,
			value.timestamp,
		),
};
let context: LocalPostgresContext;
let token: string;
let subscriptionId: string;

// Purchases are dated relative to now: fixed dates turn into the past and flip expiry checks.
const DAY = 86_400_000;

function transaction(
	overrides: Partial<RecordStoreKitTransactionProjectionInput> = {},
): RecordStoreKitTransactionProjectionInput {
	return {
		billingAccountId: "apple_customer",
		appAccountToken: token,
		channel: "ios",
		externalProductId: "premium_monthly",
		purchaseKind: "subscription",
		transactionId: "apple_purchase",
		originalTransactionId: "apple_original",
		webOrderLineItemId: "line",
		purchaseStatus: "completed",
		subscriptionStatus: "active",
		purchasedAt: new Date(Date.now() - 2 * DAY),
		expiresAt: new Date("2099-01-01T00:00:00Z"),
		autoRenew: true,
		invalidatedAt: null,
		invalidationReason: null,
		rawPayload: { transaction: { bundleId: signer.bundleId } },
		eventType: "purchase_verified",
		externalEventId: null,
		projectionReason: "purchase_verified",
		projectionIdempotencyKey: "apple_purchase",
		...overrides,
	};
}

async function promotion(kind: AppleOfferInput["objectKind"] = "apple_promotional_offer") {
	const result = await context.repository.promotions.createPromotion(
		project,
		{
			key: "apple_campaign",
			name: "Apple campaign",
			effect: {
				kind: "discount",
				discount: { type: "percent", percentOffBps: 2000, duration: "once", durationMonths: null },
			},
			allowedChannels: ["ios"],
			targets: [{ kind: "plan", key: "premium" }],
			actor: "test-operator",
			codes: kind === "apple_promotional_offer" ? [{ code: "APPLE20", maxRedemptions: 1 }] : [],
			appleOffers: [
				{ objectKind: kind, productExternalId: "premium_monthly", offerIdentifier: "apple20" },
			],
		},
		signer.bundleId,
	);
	const offer = result.promotion.providerObjects[0];
	if (!offer) throw new Error("Missing Apple offer");
	return offer;
}

async function redeem(offerId: string, key = "first") {
	return context.repository.applePromotions.redeem(
		project,
		{
			code: "APPLE20",
			channel: "ios",
			appleOfferId: offerId,
			subscriptionId,
			billingAccountId: "apple_customer",
			idempotencyKey: key,
			actor: null,
		},
		signer,
	);
}

async function observe(overrides: Partial<RecordStoreKitTransactionProjectionInput> = {}) {
	return context.repository.recordStoreKitTransactionAndEnqueueProjection(
		project,
		transaction({
			transactionId: "apple_discount",
			projectionIdempotencyKey: "apple_discount",
			purchasedAt: new Date(),
			appleOffer: { type: 2, identifier: "apple20", bundleId: signer.bundleId },
			...overrides,
		}),
	);
}

localDescribe("Apple subscription promotions", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	afterAll(async () => {
		await context.sql.close();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
		token = await context.repository.getOrCreateProviderCustomerToken(
			project,
			"apple_customer",
			"apple",
		);
		await context.repository.recordStoreKitTransactionAndEnqueueProjection(project, transaction());
		const [subscription] = await context.sql<
			Array<{ id: string }>
		>`SELECT id FROM subscriptions WHERE project_id = ${project.projectInstanceId}`;
		if (!subscription) throw new Error("Missing subscription");
		subscriptionId = subscription.id;
	});

	// capability: promotion.code_entry
	// capability: promotion.signed_offer
	it("signs an account-bound offer, replays it, and refreshes without consuming a second use", async () => {
		const offer = await promotion();
		const first = await redeem(offer.id);
		const value = first.appleOffer;
		const payload = [
			signer.bundleId,
			value.keyId,
			value.productId,
			value.offerIdentifier,
			token,
			value.nonce,
			value.timestamp,
		].join("\u2063");
		expect(
			verify("sha256", Buffer.from(payload), publicKey, Buffer.from(value.signature, "base64")),
		).toBe(true);
		expect(Date.parse(value.expiresAt) - value.timestamp).toBe(86_400_000);
		expect(await redeem(offer.id)).toEqual({ ...first, duplicate: true });
		const retry = await context.repository.applePromotions.refresh(
			project,
			"apple_customer",
			first.redemption.id,
			"retry",
			signer,
		);
		expect(retry.appleOffer.nonce).not.toBe(value.nonce);
		expect(retry.redemption.id).toBe(first.redemption.id);
		expect(
			await context.repository.applePromotions.refresh(
				project,
				"apple_customer",
				first.redemption.id,
				"retry",
				signer,
			),
		).toEqual({ ...retry, duplicate: true });
		const codes = await context.repository.promotions.listPromotionCodes(
			project,
			"apple_campaign",
			{ limit: 10 },
		);
		expect(codes.items[0]).toMatchObject({ reservedCount: 1, redeemedCount: 0 });
	});

	it("observes the offer once across repeated verification and renewals", async () => {
		const offer = await promotion();
		const reserved = await redeem(offer.id);
		await observe();
		await observe();
		await observe({
			transactionId: "apple_renewal",
			projectionIdempotencyKey: "apple_renewal",
			purchasedAt: new Date(Date.now() + 31 * DAY),
		});
		const redemptions = await context.repository.promotions.listAccountRedemptions(
			project,
			"apple_customer",
			{ limit: 10 },
		);
		expect(redemptions.items).toHaveLength(1);
		expect(redemptions.items[0]).toMatchObject({
			id: reserved.redemption.id,
			status: "applied",
			source: "apple_offer",
		});
		const codes = await context.repository.promotions.listPromotionCodes(
			project,
			"apple_campaign",
			{ limit: 10 },
		);
		expect(codes.items[0]).toMatchObject({ reservedCount: 0, redeemedCount: 1 });
		await expect(
			context.repository.applePromotions.refresh(
				project,
				"apple_customer",
				reserved.redemption.id,
				"after-purchase",
				signer,
			),
		).rejects.toMatchObject({ code: "APPLE_PROMOTION_NOT_APPLICABLE" });
	});

	// capability: promotion.store_offer_code
	it("records native offer codes without inventing a Quotum code, retaining retired mappings", async () => {
		const offer = await promotion("apple_offer_code");
		await context.repository.applePromotions.retire(
			project,
			"apple_campaign",
			offer.id,
			"test-operator",
		);
		await observe({
			appAccountToken: null,
			appleOffer: { type: 3, identifier: "apple20", bundleId: signer.bundleId },
		});
		const result = await context.repository.promotions.listAccountRedemptions(
			project,
			"apple_customer",
			{ limit: 10 },
		);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]).toMatchObject({
			status: "applied",
			code: null,
			promotionCodeId: null,
			limitViolation: "inactive",
		});
	});

	it("does not infer an owner for a tokenless purchase on another lineage", async () => {
		await promotion("apple_offer_code");
		await expect(
			observe({
				appAccountToken: null,
				originalTransactionId: "unlinked",
				appleOffer: { type: 3, identifier: "apple20", bundleId: signer.bundleId },
			}),
		).rejects.toMatchObject({ code: "STOREKIT_ACCOUNT_TOKEN_MISMATCH" });
		expect(
			(
				await context.repository.promotions.listAccountRedemptions(project, "apple_customer", {
					limit: 10,
				})
			).items,
		).toHaveLength(0);
	});

	it("rejects cross-account signing, connection mismatch, and changed idempotency input", async () => {
		const offer = await promotion();
		await redeem(offer.id);
		await expect(
			context.repository.applePromotions.redeem(
				project,
				{
					code: "APPLE20",
					channel: "ios",
					appleOfferId: offer.id,
					subscriptionId,
					billingAccountId: "other",
					idempotencyKey: "other",
					actor: null,
				},
				signer,
			),
		).rejects.toMatchObject({ code: "APPLE_PROMOTION_NOT_APPLICABLE" });
		await expect(
			context.repository.applePromotions.redeem(
				project,
				{
					code: "DIFFERENT",
					channel: "ios",
					appleOfferId: offer.id,
					subscriptionId,
					billingAccountId: "apple_customer",
					idempotencyKey: "first",
					actor: null,
				},
				signer,
			),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		await expect(
			context.repository.applePromotions.redeem(
				project,
				{
					code: "APPLE20",
					channel: "ios",
					appleOfferId: offer.id,
					subscriptionId,
					billingAccountId: "apple_customer",
					idempotencyKey: "changed-bundle",
					actor: null,
				},
				{ ...signer, bundleId: "another.app" },
			),
		).rejects.toMatchObject({ code: "APPLE_PROMOTION_NOT_APPLICABLE" });
	});

	it("keeps consumed use through refund and restores its status on refund reversal", async () => {
		const offer = await promotion();
		await redeem(offer.id);
		await observe();
		await observe({
			eventType: "REFUND",
			projectionIdempotencyKey: "refund",
			purchaseStatus: "refunded",
			subscriptionStatus: "refunded",
			invalidatedAt: new Date(),
			invalidationReason: "refund",
		});
		expect(
			(
				await context.repository.promotions.listAccountRedemptions(project, "apple_customer", {
					limit: 10,
				})
			).items[0]?.status,
		).toBe("reversed");
		await observe({ eventType: "REFUND_REVERSED", projectionIdempotencyKey: "refund-reversed" });
		expect(
			(
				await context.repository.promotions.listAccountRedemptions(project, "apple_customer", {
					limit: 10,
				})
			).items[0]?.status,
		).toBe("applied");
		expect(
			(
				await context.repository.promotions.listPromotionCodes(project, "apple_campaign", {
					limit: 10,
				})
			).items[0]?.redeemedCount,
		).toBe(1);
	});

	it("releases abandoned signatures and still applies a delayed verified purchase", async () => {
		const offer = await promotion();
		const first = await redeem(offer.id);
		await context.sql`UPDATE promotion_redemptions SET reserved_until = now() - interval '1 second' WHERE id = ${first.redemption.id}`;
		expect(await context.repository.promotions.releaseExpiredPromotionReservations(10)).toBe(1);
		await observe();
		expect(
			(
				await context.repository.promotions.listAccountRedemptions(project, "apple_customer", {
					limit: 10,
				})
			).items[0]?.status,
		).toBe("applied");
	});

	it("serializes concurrent attempts and rejects retired mappings", async () => {
		const offer = await promotion();
		const results = await Promise.allSettled([redeem(offer.id, "one"), redeem(offer.id, "two")]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		const succeeded = results.find((result) => result.status === "fulfilled");
		if (succeeded?.status !== "fulfilled") throw new Error("Missing signature");
		await context.repository.applePromotions.retire(
			project,
			"apple_campaign",
			offer.id,
			"test-operator",
		);
		await expect(
			context.repository.applePromotions.refresh(
				project,
				"apple_customer",
				succeeded.value.redemption.id,
				"retired",
				signer,
			),
		).rejects.toMatchObject({ code: "APPLE_PROMOTION_NOT_APPLICABLE" });
	});
	it("serves signed actions through guarded HTTP routes and the generated response contract", async () => {
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			applePromotionSigner: signer,
		});
		const backend = { ...authHeaders("acme"), "content-type": "application/json" };
		const operator = {
			...backend,
			"x-billing-operator-key": context.env.operatorApiKey ?? "",
			"x-billing-actor": "operator",
		};
		const created = await testRequest(app, "/v1/admin/promotions", {
			method: "POST",
			headers: operator,
			body: JSON.stringify({
				key: "apple_campaign",
				name: "Apple campaign",
				effect: {
					kind: "discount",
					discount: { type: "percent", percentOffBps: 2000, duration: "once" },
				},
				allowedChannels: ["ios"],
				codes: [{ code: "APPLE20" }],
				appleOffers: [
					{
						objectKind: "apple_promotional_offer",
						productExternalId: "premium_monthly",
						offerIdentifier: "apple20",
					},
				],
			}),
		});
		expect(created.status).toBe(201);
		const offer = (await created.json()).data.providerObjects[0];
		const path = "/v1/admin/promotions/apple_campaign/apple-offers";
		const body = JSON.stringify({
			objectKind: "apple_offer_code",
			productExternalId: "premium_monthly",
			offerIdentifier: "native20",
		});
		expect((await testRequest(app, path, { method: "POST", headers: backend, body })).status).toBe(
			401,
		);
		const linked = await testRequest(app, path, { method: "POST", headers: operator, body });
		expect(linked.status).toBe(200);
		expect((await linked.json()).data.providerObjects).toHaveLength(2);
		const validate = await testRequest(
			app,
			"/v1/billing-accounts/apple_customer/promotion-codes/validate",
			{
				method: "POST",
				headers: backend,
				body: JSON.stringify({ code: "APPLE20", channel: "ios" }),
			},
		);
		expect((await validate.json()).data).toMatchObject({
			valid: true,
			appleOffers: [{ id: offer.id }],
		});
		const redeemed = await testRequest(
			app,
			"/v1/billing-accounts/apple_customer/promotion-redemptions",
			{
				method: "POST",
				headers: { ...backend, "idempotency-key": "http" },
				body: JSON.stringify({
					code: "APPLE20",
					channel: "ios",
					appleOfferId: offer.id,
					subscriptionId,
				}),
			},
		);
		expect(redeemed.status).toBe(200);
		const result = (await redeemed.json()).data;
		expect(result).toMatchObject({
			kind: "provider_action_required",
			provider: "apple",
			redemption: { status: "reserved" },
		});
		const refreshPath = `/v1/billing-accounts/apple_customer/promotion-redemptions/${result.redemption.id}/apple-signatures`;
		expect((await testRequest(app, refreshPath, { method: "POST", headers: backend })).status).toBe(
			400,
		);
		const refreshed = await testRequest(app, refreshPath, {
			method: "POST",
			headers: { ...backend, "idempotency-key": "http-refresh" },
		});
		expect(refreshed.status).toBe(200);
		expect((await refreshed.json()).data.appleOffer.nonce).not.toBe(result.appleOffer.nonce);
		const retired = await testRequest(app, `${path}/${offer.id}/retire`, {
			method: "POST",
			headers: operator,
		});
		expect(retired.status).toBe(200);
	});

	it("records disabled code uses instead of rejecting provider truth", async () => {
		const offer = await promotion();
		await redeem(offer.id);
		await context.sql`UPDATE promotion_codes SET active = false, deactivated_at = now(), deactivated_by = 'operator' WHERE project_id = ${project.projectInstanceId}`;
		await observe();
		expect(
			(
				await context.repository.promotions.listAccountRedemptions(project, "apple_customer", {
					limit: 10,
				})
			).items[0],
		).toMatchObject({
			status: "applied",
			limitViolation: "inactive",
			providerObjectId: offer.id,
			providerTransactionId: "apple_discount",
		});
	});

	it("refuses unpublished products and filters unsupported iOS code entry", async () => {
		const offer = await promotion();
		await expect(
			context.repository.applePromotions.link(
				project,
				"apple_campaign",
				{
					objectKind: "apple_promotional_offer",
					productExternalId: "missing_product",
					offerIdentifier: "another",
				},
				signer,
				"operator",
			),
		).rejects.toMatchObject({ code: "APPLE_PROMOTION_NOT_APPLICABLE" });
		await context.repository.applePromotions.retire(
			project,
			"apple_campaign",
			offer.id,
			"operator",
		);
		expect(
			await context.repository.promotions.validatePromotionCode(project, {
				code: "APPLE20",
				channel: "ios",
				billingAccountId: "apple_customer",
			}),
		).toMatchObject({
			valid: false,
			reason: "PROMOTION_CODE_CHANNEL_NOT_SUPPORTED",
			appleOffers: [],
		});
	});
	it("does not mark continuing renewals as new uses after an offer link is retired", async () => {
		const offer = await promotion();
		await redeem(offer.id);
		await observe();
		await context.repository.applePromotions.retire(
			project,
			"apple_campaign",
			offer.id,
			"operator",
		);
		await observe({
			transactionId: "renewal-after-retirement",
			projectionIdempotencyKey: "renewal-after-retirement",
			purchasedAt: new Date(Date.now() + 31 * DAY),
		});
		expect(
			(
				await context.repository.promotions.listAccountRedemptions(project, "apple_customer", {
					limit: 10,
				})
			).items[0],
		).toMatchObject({
			status: "applied",
			limitViolation: null,
			lastObservedTransactionId: "renewal-after-retirement",
		});
	});
	it("refreshes a released reservation without creating a second redemption", async () => {
		const offer = await promotion();
		const first = await redeem(offer.id);
		await context.sql`UPDATE promotion_redemptions SET reserved_until = now() - interval '1 second' WHERE id = ${first.redemption.id}`;
		await context.repository.promotions.releaseExpiredPromotionReservations(10);
		const refreshed = await context.repository.applePromotions.refresh(
			project,
			"apple_customer",
			first.redemption.id,
			"after-release",
			signer,
		);
		expect(refreshed.redemption).toMatchObject({ id: first.redemption.id, status: "reserved" });
		expect(refreshed.appleOffer.nonce).not.toBe(first.appleOffer.nonce);
		expect(
			(
				await context.repository.promotions.listPromotionCodes(project, "apple_campaign", {
					limit: 10,
				})
			).items[0],
		).toMatchObject({ reservedCount: 1, redeemedCount: 0 });
	});

	it("flags a verified purchase after code expiry and refuses new signatures", async () => {
		const offer = await promotion();
		const first = await redeem(offer.id);
		await context.sql`UPDATE promotion_codes SET expires_at = now() - interval '1 minute' WHERE project_id = ${project.projectInstanceId}`;
		await expect(
			context.repository.applePromotions.refresh(
				project,
				"apple_customer",
				first.redemption.id,
				"expired",
				signer,
			),
		).rejects.toMatchObject({ code: "APPLE_PROMOTION_NOT_APPLICABLE" });
		await observe();
		expect(
			(
				await context.repository.promotions.listAccountRedemptions(project, "apple_customer", {
					limit: 10,
				})
			).items[0],
		).toMatchObject({ status: "applied", limitViolation: "expired" });
	});
});
