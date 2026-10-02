import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { parseReceiptId } from "../../src/db/repository/usage-receipts";
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
		const correct = (
			billingAccountId: string,
			key: string,
			original: { receiptId?: string; usageEventId?: string; recordedAt: string },
			quantity: string,
		) =>
			testRequest(
				app,
				`/v1/billing-accounts/${billingAccountId}/usage/events/${original.receiptId ? parseReceiptId(original.receiptId).id : original.usageEventId}/corrections`,
				{
					method: "POST",
					headers: {
						...authHeaders(),
						"content-type": "application/json",
						"idempotency-key": key,
						"x-billing-actor": "product-worker",
					},
					body: JSON.stringify({
						originalRecordedAt: original.recordedAt,
						quantity,
						reason: "generation returned fewer tokens",
					}),
				},
			);
		return { get, post, usage, grant, correct };
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
			featureId: "model_tokens",
			value: "2000",
		});
		expect((await consumed.json()).data).toMatchObject({
			allowed: true,
			balance: { available: "90" },
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

	it("refuses a consumable feature that usage never spends", async () => {
		const { grant } = fixture();
		// `model_tokens` is a meter its rate card charges to the `ai_credits` wallet, and
		// `loose_credits` has neither a rate card nor a plan allocation: usage spends neither.
		await context.sql`
			INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
			SELECT id, 'loose_credits', 'Loose credits', 'metered', 'consumable', 'credit', 0
			FROM projects WHERE key = 'acme'
		`;
		const meter = await grant("spend_account", "grant-meter", "5", { featureKey: "model_tokens" });
		const loose = await grant("spend_account", "grant-loose", "5", { featureKey: "loose_credits" });
		const wallet = await grant("spend_account", "grant-wallet", "5");

		for (const refused of [meter, loose]) {
			expect(refused.status).toBe(400);
			expect((await refused.json()).error.code).toBe("OPERATOR_GRANT_FEATURE_INVALID");
		}
		expect(wallet.status).toBe(201);
		const grants = await context.sql<Array<{ feature: string }>>`
			SELECT feature.key AS feature FROM balance_allocations allocation
			JOIN features feature ON feature.id = allocation.feature_id
			WHERE allocation.source_kind = 'operator'
		`;
		expect(grants.map((row) => row.feature)).toEqual(["ai_credits"]);
	});

	it("spends an entity's own credit before the shared pool at the same expiry", async () => {
		const { usage, grant } = fixture();
		const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();

		expect((await grant("support_account", "grant-shared", "100", { expiresAt })).status).toBe(201);
		await context.repository.controlsEnterprise.createEntity(project, {
			billingAccountId: "support_account",
			externalId: "seat-1",
			kind: "seat",
		});
		const own = await grant("support_account", "grant-seat", "100", {
			entityId: "seat-1",
			expiresAt,
		});
		expect(own.status).toBe(201);

		const entityUsage = await usage("support_account", "consume", "spend-seat", {
			featureId: "model_tokens",
			value: "2000",
			entityId: "seat-1",
		});
		const accountUsage = await usage("support_account", "consume", "spend-account", {
			featureId: "model_tokens",
			value: "400",
		});

		expect(entityUsage.status).toBe(200);
		expect(accountUsage.status).toBe(200);
		expect(
			await context.sql<Array<{ entity: boolean; consumed: number }>>`
				SELECT entity_id IS NOT NULL AS entity, consumed_quantity::float8 AS consumed
				FROM balance_allocations
				ORDER BY id
			`,
		).toEqual([
			{ entity: false, consumed: 2 },
			{ entity: true, consumed: 10 },
		]);
	});

	it("revokes only free quantity, lets an open reservation confirm and replays", async () => {
		const { get, post, usage, grant } = fixture();
		const created = (await (await grant("revoke_account", "grant-1", "100")).json()).data.grant;
		await usage("revoke_account", "consume", "spend-1", {
			featureId: "model_tokens",
			value: "6000",
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

	it("shows a revoked grant's open holds until they settle and revokes what they free", async () => {
		const { get, post, usage, grant, correct } = fixture();
		const created = (await (await grant("hold_account", "grant-1", "100")).json()).data.grant;
		const spent = (
			await (
				await usage("hold_account", "consume", "spend-1", {
					featureId: "model_tokens",
					value: "6000",
				})
			).json()
		).data;
		const reserve = async (key: string) =>
			(
				await (
					await usage("hold_account", "reservations", key, {
						featureKey: "model_tokens",
						quantity: "2000",
						expiresInSeconds: 300,
					})
				).json()
			).data;
		const released = await reserve("hold-1");
		const confirmed = await reserve("hold-2");
		const path = `/v1/admin/operator-grants/hold_account/${created.id}`;

		const revoked = await post(`${path}/revoke`, "revoke-1", { reason: "Granted in error" });
		expect((await revoked.json()).data.grant).toMatchObject({
			heldQuantity: "20",
			reversedQuantity: "50",
			revocation: { revokedQuantity: "50" },
		});
		// The hold stays visible, and nothing of the revoked grant becomes available.
		expect(
			await context.repository.getMeteringBalance(project, "hold_account", "ai_credits"),
		).toMatchObject({
			held: "20",
			available: "0",
			breakdown: [{ allocationId: created.allocationId, held: "20", available: "0" }],
		});
		expect(
			(await context.repository.getCustomerBillingSummary(project, "hold_account")).balances,
		).toMatchObject([{ featureKey: "ai_credits", held: "20", available: "0" }]);

		const release = await usage(
			"hold_account",
			`reservations/${released.reservationId}/release`,
			"release-1",
			{},
		);
		expect(release.status).toBe(200);
		// A confirm still settles from its hold; what it does not use is revoked like a release.
		const confirm = await usage(
			"hold_account",
			`reservations/${confirmed.reservationId}/confirm`,
			"confirm-1",
			{ quantity: "1000" },
		);
		expect((await confirm.json()).data).toMatchObject({ status: "confirmed" });

		expect((await (await get(path)).json()).data).toMatchObject({
			consumedQuantity: "35",
			heldQuantity: "0",
			reversedQuantity: "65",
			availableQuantity: "0",
			revocation: { revokedQuantity: "65" },
		});
		expect(
			await context.repository.getMeteringBalance(project, "hold_account", "ai_credits"),
		).toMatchObject({ held: "0", available: "0", breakdown: [] });

		const correction = await correct("hold_account", "correct-1", spent, "2000");
		expect(correction.status).toBe(409);
		expect((await correction.json()).error.code).toBe("CORRECTION_TARGETS_REVOKED_GRANT");
		const [allocation] = await context.sql<Array<{ consumed_quantity: string }>>`
			SELECT consumed_quantity::text FROM balance_allocations
			WHERE id = ${created.allocationId}::bigint
		`;
		expect(Number(allocation?.consumed_quantity)).toBe(35);
	});

	it("shows an expired grant's open hold until it settles and forfeits its release", async () => {
		const { get, usage, grant } = fixture();
		const created = (
			await (
				await grant("expiry_account", "grant-1", "100", {
					expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
				})
			).json()
		).data.grant;
		const reservation = (
			await (
				await usage("expiry_account", "reservations", "hold-1", {
					featureKey: "model_tokens",
					quantity: "2000",
					expiresInSeconds: 300,
				})
			).json()
		).data;
		await context.sql`
			UPDATE balance_allocations SET expires_at = now() - interval '1 second'
			WHERE id = ${created.allocationId}::bigint
		`;

		expect(
			await context.repository.getMeteringBalance(project, "expiry_account", "ai_credits"),
		).toMatchObject({
			held: "10",
			available: "0",
			breakdown: [{ allocationId: created.allocationId, held: "10", available: "0" }],
		});

		const release = await usage(
			"expiry_account",
			`reservations/${reservation.reservationId}/release`,
			"release-1",
			{},
		);
		expect(release.status).toBe(200);
		expect(
			await context.repository.getMeteringBalance(project, "expiry_account", "ai_credits"),
		).toMatchObject({ held: "0", available: "0", breakdown: [] });
		expect(
			(await (await get(`/v1/admin/operator-grants/expiry_account/${created.id}`)).json()).data,
		).toMatchObject({
			status: "expired",
			heldQuantity: "0",
			reversedQuantity: "0",
			availableQuantity: "0",
		});
	});

	it("refuses a revocation key reused on another grant of the same account", async () => {
		const { post, grant } = fixture();
		const first = (await (await grant("revoke_keys", "grant-a", "10")).json()).data.grant;
		const second = (await (await grant("revoke_keys", "grant-b", "10")).json()).data.grant;
		const revoke = (grantId: string) =>
			post(`/v1/admin/operator-grants/revoke_keys/${grantId}/revoke`, "revoke-key", {
				reason: "Granted in error",
			});

		expect((await revoke(first.id)).status).toBe(200);
		const reused = await revoke(second.id);

		expect(reused.status).toBe(409);
		expect((await reused.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
		const [row] = await context.sql<Array<{ revoked_at: Date | null }>>`
			SELECT revoked_at FROM operator_grants WHERE id = ${second.id}::uuid
		`;
		expect(row?.revoked_at).toBeNull();
		expect((await revoke(first.id)).status).toBe(200);
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
