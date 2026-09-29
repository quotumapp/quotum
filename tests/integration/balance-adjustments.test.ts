import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
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
const actor = "support@example.com";
let context: LocalPostgresContext;

localDescribe("operator grants and administrative debits", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	function fixture() {
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const operator = (idempotencyKey?: string, projectKey = "acme"): HeadersInit => ({
			...authHeaders(projectKey),
			"x-billing-operator-key": context.env.operatorApiKey ?? "",
			"x-billing-actor": actor,
			"content-type": "application/json",
			...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
		});
		const post = (path: string, idempotencyKey: string, body: unknown, projectKey = "acme") =>
			testRequest(app, path, {
				method: "POST",
				headers: operator(idempotencyKey, projectKey),
				body: JSON.stringify(body),
			});
		const get = (path: string, projectKey = "acme") =>
			testRequest(app, path, { headers: operator(undefined, projectKey) });
		const usage = (billingAccountId: string, action: string, key: string, body: unknown) =>
			testRequest(app, `/v1/billing-accounts/${billingAccountId}/usage/${action}`, {
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json", "idempotency-key": key },
				body: JSON.stringify(body),
			});
		const grant = (billingAccountId: string, key: string, quantity: string, extra = {}) =>
			post(`/v1/admin/operator-grants/${billingAccountId}`, key, {
				featureKey: "ai_credits",
				quantity,
				reason: "Outage goodwill",
				...extra,
			});
		return { get, post, usage, grant };
	}

	it("grants an allocation that usage spends and replays or conflicts by key", async () => {
		const { get, usage, grant } = fixture();

		const granted = await grant("support_account", "grant-1", "100");
		const replay = await grant("support_account", "grant-1", "100.000");
		const conflict = await grant("support_account", "grant-1", "90");

		expect(granted.status).toBe(201);
		const created = (await granted.json()).data.grant;
		expect(created).toMatchObject({
			billingAccountId: "support_account",
			featureKey: "ai_credits",
			quantity: "100",
			expiresAt: null,
			status: "active",
			availableQuantity: "100",
			actor,
			reason: "Outage goodwill",
			revocation: null,
		});
		expect(replay.status).toBe(200);
		expect((await replay.json()).data).toEqual({ duplicate: true, grant: created });
		expect(conflict.status).toBe(409);
		expect((await conflict.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
		const [allocation] = await context.sql<
			Array<{ source_kind: string; source_key: string; operator_grant_id: string; id: string }>
		>`SELECT id::text, source_kind, source_key, operator_grant_id FROM balance_allocations`;
		expect(allocation).toEqual({
			id: created.allocationId,
			source_kind: "operator",
			source_key: `operator_grant:${created.id}`,
			operator_grant_id: created.id,
		});
		const [job] = await context.sql<Array<{ idempotency_key: string }>>`
			SELECT idempotency_key FROM projection_sync_jobs
		`;
		expect(job?.idempotency_key).toMatch(/^usage:/);
		expect(await context.sql`SELECT id FROM purchases`).toHaveLength(0);

		const consumed = await usage("support_account", "consume", "spend-1", {
			featureKey: "model_tokens",
			quantity: "2000",
		});
		expect((await consumed.json()).data).toMatchObject({
			allowed: true,
			balance: { available: "90", breakdown: [{ sourceKind: "operator", available: "90" }] },
		});
		const listed = await get("/v1/admin/operator-grants/support_account");
		expect((await listed.json()).data).toMatchObject([
			{ id: created.id, consumedQuantity: "10", availableQuantity: "90" },
		]);
	});

	it("refuses a non-consumable feature, an unknown entity and a past expiry", async () => {
		const { grant } = fixture();
		await context.sql`UPDATE features SET meter_kind = 'non_consumable' WHERE key = 'model_tokens'`;

		const nonConsumable = await grant("support_account", "grant-1", "1", {
			featureKey: "model_tokens",
		});
		const entity = await grant("support_account", "grant-2", "1", { entityId: "seat-1" });
		const past = await grant("support_account", "grant-3", "1", {
			expiresAt: "2020-01-01T00:00:00.000Z",
		});

		expect(nonConsumable.status).toBe(400);
		expect((await nonConsumable.json()).error.code).toBe("OPERATOR_GRANT_FEATURE_INVALID");
		expect(entity.status).toBe(404);
		expect((await entity.json()).error.code).toBe("ENTITY_NOT_FOUND");
		expect(past.status).toBe(400);
		expect(await context.sql`SELECT id FROM operator_grants`).toHaveLength(0);
	});

	it("revokes only free quantity, lets an open reservation confirm and replays", async () => {
		const { get, post, usage, grant } = fixture();
		const created = (await (await grant("revoke_account", "grant-1", "100")).json()).data.grant;
		await usage("revoke_account", "consume", "spend-1", {
			featureKey: "model_tokens",
			quantity: "6000",
		});
		const reserved = await usage("revoke_account", "reservations", "hold-1", {
			featureKey: "model_tokens",
			quantity: "2000",
			expiresInSeconds: 300,
		});
		const reservation = (await reserved.json()).data;
		expect(reservation).toMatchObject({ allowed: true, walletQuantity: "10" });
		const path = `/v1/admin/operator-grants/revoke_account/${created.id}/revoke`;

		const foreign = await post(path.replace("revoke_account", "other_account"), "revoke-1", {
			reason: "Granted in error",
		});
		const revoked = await post(path, "revoke-1", { reason: "Granted in error" });
		const replay = await post(path, "revoke-1", { reason: "Granted in error" });
		const twice = await post(path, "revoke-2", { reason: "Granted in error" });

		expect(foreign.status).toBe(404);
		expect(revoked.status).toBe(200);
		const revokedData = (await revoked.json()).data;
		expect(revokedData.grant).toMatchObject({
			status: "revoked",
			consumedQuantity: "30",
			heldQuantity: "10",
			reversedQuantity: "60",
			availableQuantity: "0",
			revocation: { actor, reason: "Granted in error", revokedQuantity: "60" },
		});
		expect((await replay.json()).data).toEqual({ ...revokedData, duplicate: true });
		expect(twice.status).toBe(409);
		expect((await twice.json()).error.code).toBe("OPERATOR_GRANT_ALREADY_REVOKED");
		expect(
			await context.repository.getMeteringBalance(project, "revoke_account", "ai_credits"),
		).toMatchObject({ available: "0" });

		const confirmed = await usage(
			"revoke_account",
			`reservations/${reservation.reservationId}/confirm`,
			"confirm-1",
			{ quantity: "2000" },
		);
		expect((await confirmed.json()).data).toMatchObject({ status: "confirmed" });
		const read = await get(`/v1/admin/operator-grants/revoke_account/${created.id}`);
		expect((await read.json()).data).toMatchObject({ consumedQuantity: "40", heldQuantity: "0" });
		const crossProject = await get(
			`/v1/admin/operator-grants/revoke_account/${created.id}`,
			"globex",
		);
		expect(crossProject.status).toBe(404);
	});

	it("debits named allocations all or nothing and never as usage", async () => {
		const { get, post, grant } = fixture();
		const operatorGrant = (await (await grant("debit_account", "grant-1", "50")).json()).data.grant;
		await context.repository.grantAllocation(project, {
			billingAccountId: "debit_account",
			featureKey: "ai_credits",
			quantity: "20",
			sourceKind: "credit_grant",
			sourceKey: "fixture:credit",
		});
		await context.repository.grantAllocation(project, {
			billingAccountId: "debit_account",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "topup",
			sourceKey: "fixture:topup",
		});
		await context.repository.grantAllocation(project, {
			billingAccountId: "someone_else",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "credit_grant",
			sourceKey: "fixture:foreign",
		});
		const ids = Object.fromEntries(
			(
				await context.sql<Array<{ source_key: string; id: string }>>`
					SELECT source_key, id::text FROM balance_allocations
				`
			).map((row) => [row.source_key, row.id]),
		);
		const credit = ids["fixture:credit"] ?? "";
		const debit = (key: string, allocations: Array<{ allocationId: string; quantity: string }>) =>
			post("/v1/admin/administrative-debits/debit_account", key, {
				reason: "Duplicate goodwill credit",
				allocations,
			});

		const overdrawn = await debit("debit-1", [
			{ allocationId: credit, quantity: "1" },
			{ allocationId: operatorGrant.allocationId, quantity: "51" },
		]);
		const purchased = await debit("debit-2", [
			{ allocationId: ids["fixture:topup"] ?? "", quantity: "1" },
		]);
		const foreign = await debit("debit-3", [
			{ allocationId: ids["fixture:foreign"] ?? "", quantity: "1" },
		]);
		const debited = await debit("debit-4", [
			{ allocationId: operatorGrant.allocationId, quantity: "10" },
			{ allocationId: credit, quantity: "5" },
		]);
		const replay = await debit("debit-4", [
			{ allocationId: credit, quantity: "5.0" },
			{ allocationId: operatorGrant.allocationId, quantity: "10" },
		]);

		expect(overdrawn.status).toBe(409);
		expect((await overdrawn.json()).error).toMatchObject({
			code: "ADMINISTRATIVE_DEBIT_EXCEEDS_AVAILABLE",
			details: { allocationId: operatorGrant.allocationId, available: "50" },
		});
		expect(purchased.status).toBe(409);
		expect((await purchased.json()).error.details).toMatchObject({ reason: "provider_purchase" });
		expect(foreign.status).toBe(404);
		expect((await foreign.json()).error.code).toBe("ALLOCATION_NOT_FOUND");
		expect(debited.status).toBe(201);
		const debitData = (await debited.json()).data;
		expect(debitData.debit).toMatchObject({ actor, reason: "Duplicate goodwill credit" });
		expect(replay.status).toBe(200);
		expect((await replay.json()).data).toEqual({ ...debitData, duplicate: true });

		const rows = await context.sql<
			Array<{
				source_key: string;
				reversed_quantity: string;
				consumed_quantity: string;
				reversed: boolean;
			}>
		>`
			SELECT source_key, reversed_quantity::text, consumed_quantity::text,
				reversed_at IS NOT NULL AS reversed
			FROM balance_allocations WHERE source_key <> 'fixture:foreign' ORDER BY id
		`;
		expect(rows).toEqual([
			{
				source_key: `operator_grant:${operatorGrant.id}`,
				reversed_quantity: "10.000000000",
				consumed_quantity: "0.000000000",
				reversed: false,
			},
			{
				source_key: "fixture:credit",
				reversed_quantity: "5.000000000",
				consumed_quantity: "0.000000000",
				reversed: false,
			},
			{
				source_key: "fixture:topup",
				reversed_quantity: "0.000000000",
				consumed_quantity: "0.000000000",
				reversed: false,
			},
		]);
		expect(await context.sql`SELECT id FROM usage_events`).toHaveLength(0);
		expect(
			await context.repository.getMeteringBalance(project, "debit_account", "ai_credits"),
		).toMatchObject({ granted: "65", consumed: "0", available: "65" });

		// The revocation takes back only what the debit left.
		const revoked = await post(
			`/v1/admin/operator-grants/debit_account/${operatorGrant.id}/revoke`,
			"revoke-1",
			{ reason: "Granted in error" },
		);
		expect((await revoked.json()).data.grant.revocation).toMatchObject({ revokedQuantity: "40" });
		const listed = await get("/v1/admin/administrative-debits/debit_account");
		expect((await listed.json()).data).toEqual([debitData.debit]);
	});

	it("reports a promotion revocation net of an earlier debit", async () => {
		const { post } = fixture();
		await context.repository.promotions.createPromotion(project, {
			key: "welcome-credits",
			name: "Welcome credits",
			effect: {
				kind: "feature_grant",
				items: [{ featureKey: "ai_credits", quantity: "100", expiresAfterSeconds: null }],
			},
			codes: [{ code: "WELCOME" }],
			actor,
		});
		const redeemed = await context.repository.promotions.redeemPromotionCode(project, {
			billingAccountId: "promo_account",
			code: "WELCOME",
			channel: "web",
			idempotencyKey: "redeem",
			actor: "user:7",
		});
		if (redeemed.kind !== "granted") throw new Error("expected a granted redemption");
		const [reward] = await context.sql<Array<{ id: string }>>`
			SELECT id::text FROM balance_allocations WHERE source_kind = 'reward'
		`;
		const debited = await post("/v1/admin/administrative-debits/promo_account", "debit-1", {
			reason: "Partial clawback",
			allocations: [{ allocationId: reward?.id ?? "", quantity: "25" }],
		});
		expect(debited.status).toBe(201);

		const revoked = await post(
			`/v1/admin/promotion-redemptions/${redeemed.redemption.id}/revoke`,
			"revoke-1",
			{ reason: "Abuse report" },
		);

		expect((await revoked.json()).data.reversedAllocations).toMatchObject([
			{ featureKey: "ai_credits", reversedQuantity: "75", consumedQuantity: "0" },
		]);
		const [row] = await context.sql<Array<{ reversed_quantity: string }>>`
			SELECT reversed_quantity::text FROM balance_allocations WHERE source_kind = 'reward'
		`;
		expect(row?.reversed_quantity).toBe("100.000000000");
	});
});
