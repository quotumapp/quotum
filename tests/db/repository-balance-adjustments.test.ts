import { describe, expect, it } from "bun:test";
import { BalanceAdjustmentRepository } from "../../src/db/repository/balance-adjustments";
import { projectInstanceContext } from "../helpers/project-context";
import { FakeDatabase } from "./repository-fixture";

const project = projectInstanceContext("acme");
const customer = { id: "customer-id", billing_account_id: "acct_1" };

function grantRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "grant-id",
		billing_account_id: "acct_1",
		feature_key: "ai_credits",
		entity_external_id: null,
		allocation_id: "17",
		quantity: "20.000000000",
		reversed_quantity: "0.000000000",
		consumed_quantity: "4.000000000",
		held_quantity: "1.000000000",
		expires_at: null,
		allocation_reversed: false,
		expired: false,
		actor: "support@example.com",
		reason: "Outage goodwill",
		request_hash: "a".repeat(64),
		revoked_at: null,
		revoked_quantity: null,
		revocation_actor: null,
		revocation_reason: null,
		created_at: "2026-09-29T00:00:00.000Z",
		cursor_created_at: "2026-09-29T00:00:00.000000Z",
		...overrides,
	};
}

const feature = {
	id: "3",
	key: "ai_credits",
	unit: "credit",
	credit_scale: 2,
	kind: "metered",
	meter_kind: "consumable",
	filter_dimensions: [],
};

function repository(database: FakeDatabase) {
	return new BalanceAdjustmentRepository(database as never);
}

function debitTarget(overrides: Record<string, unknown> = {}) {
	return {
		id: "17",
		source_kind: "operator",
		purchase_id: null,
		quantity: "20.000000000",
		reversed_quantity: "0.000000000",
		consumed_quantity: "4.000000000",
		held_quantity: "1.000000000",
		reversed: false,
		expired: false,
		credit_scale: 2,
		...overrides,
	};
}

describe("operator grants", () => {
	it("writes one operator allocation linked to the grant and enqueues a usage projection", async () => {
		const database = new FakeDatabase(
			[
				[customer],
				[],
				[feature],
				[{ wallet: true, allocated: false, priced: false }],
				[{ future: true }],
				[{ id: "grant-id" }],
				[{ id: 17 }],
				[{ id: 1 }],
				[grantRow()],
			],
			{ strict: true },
		);

		const result = await repository(database).grantOperatorBalance(project, {
			billingAccountId: "acct_1",
			featureKey: "ai_credits",
			quantity: "20.00",
			entityId: null,
			expiresAt: new Date("2026-12-31T00:00:00.000Z"),
			reason: "Outage goodwill",
			actor: "support@example.com",
			idempotencyKey: "grant-1",
		});

		database.assertConsumed();
		const [upsert, replay, , spentByUsage, expiry, insertGrant, insertAllocation, projection] =
			database.queries;
		expect(upsert).toContain("INSERT INTO customers");
		expect(replay).toMatch(/g\.customer_id = \$\d+ AND g\.idempotency_key = \$\d+/);
		expect(spentByUsage).toMatch(/rce\.wallet_feature_id = \$\d+/);
		expect(expiry).toMatch(/::timestamptz > now\(\) AS future/);
		expect(insertGrant).toContain("INSERT INTO operator_grants");
		expect(insertAllocation).toContain("'operator'");
		expect(insertAllocation).toContain("operator_grant_id");
		expect(database.params[6]).toContain("operator_grant:grant-id");
		expect(database.params[6]).toContain("20");
		expect(projection).toContain("INSERT INTO projection_sync_jobs");
		expect(result).toMatchObject({
			duplicate: false,
			grant: { id: "grant-id", quantity: "20", availableQuantity: "15", status: "active" },
		});
	});

	it("replays a grant with the same terms and refuses the key with other terms", async () => {
		const replayed = new FakeDatabase([[customer], [grantRow()]], { strict: true });
		const input = {
			billingAccountId: "acct_1",
			featureKey: "ai_credits",
			quantity: "20",
			entityId: null,
			expiresAt: null,
			reason: "Outage goodwill",
			actor: "support@example.com",
			idempotencyKey: "grant-1",
		};

		await expect(repository(replayed).grantOperatorBalance(project, input)).rejects.toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
		});
		replayed.assertConsumed();
	});

	it("refuses a non-consumable feature and a quantity finer than its scale", async () => {
		const input = {
			billingAccountId: "acct_1",
			featureKey: "ai_credits",
			quantity: "1",
			entityId: null,
			expiresAt: null,
			reason: "Outage goodwill",
			actor: "support@example.com",
			idempotencyKey: "grant-1",
		};
		const nonConsumable = new FakeDatabase(
			[[customer], [], [{ ...feature, meter_kind: "non_consumable" }]],
			{
				strict: true,
			},
		);
		const fine = new FakeDatabase(
			[[customer], [], [feature], [{ wallet: true, allocated: false, priced: false }]],
			{ strict: true },
		);
		const unspent = new FakeDatabase(
			[[customer], [], [feature], [{ wallet: false, allocated: true, priced: true }]],
			{ strict: true },
		);

		await expect(
			repository(nonConsumable).grantOperatorBalance(project, input),
		).rejects.toMatchObject({
			code: "OPERATOR_GRANT_FEATURE_INVALID",
			status: 400,
		});
		await expect(
			repository(fine).grantOperatorBalance(project, { ...input, quantity: "0.001" }),
		).rejects.toThrow("quantity supports at most 2 decimal places");
		// A meter its rate card charges to a wallet: usage never spends an allocation of it.
		await expect(repository(unspent).grantOperatorBalance(project, input)).rejects.toMatchObject({
			code: "OPERATOR_GRANT_FEATURE_INVALID",
			status: 400,
		});
	});

	it("refuses an expiry that is not in the future", async () => {
		const database = new FakeDatabase(
			[
				[customer],
				[],
				[feature],
				[{ wallet: true, allocated: false, priced: false }],
				[{ future: false }],
			],
			{
				strict: true,
			},
		);

		await expect(
			repository(database).grantOperatorBalance(project, {
				billingAccountId: "acct_1",
				featureKey: "ai_credits",
				quantity: "1",
				entityId: null,
				expiresAt: new Date("2020-01-01T00:00:00.000Z"),
				reason: "Outage goodwill",
				actor: "support@example.com",
				idempotencyKey: "grant-1",
			}),
		).rejects.toThrow("expiresAt must be in the future");
		database.assertConsumed();
	});

	it("revokes only what is free, net of an earlier reversal, under customer then grant then allocation locks", async () => {
		const database = new FakeDatabase(
			[
				[customer],
				[
					{
						id: "grant-id",
						revoked_at: null,
						revocation_idempotency_key: null,
						revocation_request_hash: null,
					},
				],
				[],
				[{ id: "17", reversed_quantity: "5.000000000", expired: false }],
				[{ reversed_quantity: "15.000000000" }],
				[{ id: "grant-id" }],
				[{ id: 1 }],
				[
					grantRow({
						reversed_quantity: "15.000000000",
						allocation_reversed: true,
						revoked_at: "2026-09-29T01:00:00.000Z",
						revoked_quantity: "10.000000000",
						revocation_actor: "support@example.com",
						revocation_reason: "Granted in error",
					}),
				],
			],
			{ strict: true },
		);

		const result = await repository(database).revokeOperatorGrant(project, {
			billingAccountId: "acct_1",
			grantId: "grant-id",
			reason: "Granted in error",
			actor: "support@example.com",
			idempotencyKey: "revoke-1",
		});

		database.assertConsumed();
		const [lockCustomer, lockGrant, keyHolder, lockAllocation, reverse, record] = database.queries;
		expect(lockCustomer).toMatch(
			/FROM customers\s+WHERE project_id = \$1 AND billing_account_id = \$2\s+FOR NO KEY UPDATE/,
		);
		expect(lockGrant).toMatch(/FROM operator_grants[\s\S]*FOR UPDATE/);
		// The key is scoped to the account: another grant already revoked with it conflicts.
		expect(keyHolder).toMatch(/revocation_idempotency_key = \$3\s+AND id <> \$4::uuid/);
		expect(lockAllocation).toMatch(
			/WHERE project_id = \$1 AND operator_grant_id = \$2\s+FOR UPDATE/,
		);
		expect(reverse).toMatch(
			/reversed_quantity = GREATEST\(\s*quantity - consumed_quantity - held_quantity, reversed_quantity\s*\)/,
		);
		expect(reverse).toContain("reversed_at = COALESCE(reversed_at, now())");
		expect(record).toContain("UPDATE operator_grants");
		expect(database.boundParameter("revoked_quantity", 5)).toBe("10");
		expect(result.grant).toMatchObject({
			status: "revoked",
			availableQuantity: "0",
			revocation: { revokedQuantity: "10" },
		});
	});

	it("records nothing taken back when the grant had expired", async () => {
		const database = new FakeDatabase(
			[
				[customer],
				[
					{
						id: "grant-id",
						revoked_at: null,
						revocation_idempotency_key: null,
						revocation_request_hash: null,
					},
				],
				[],
				[{ id: "17", reversed_quantity: "0.000000000", expired: true }],
				[{ id: "grant-id" }],
				[{ id: 1 }],
				[grantRow({ expired: true })],
			],
			{ strict: true },
		);

		await repository(database).revokeOperatorGrant(project, {
			billingAccountId: "acct_1",
			grantId: "grant-id",
			reason: "Granted in error",
			actor: "support@example.com",
			idempotencyKey: "revoke-1",
		});

		database.assertConsumed();
		expect(database.queries.some((query) => query.includes("UPDATE balance_allocations"))).toBe(
			false,
		);
		expect(database.boundParameter("revoked_quantity", 4)).toBe("0");
	});

	it("answers a repeated revocation by key: replay, conflict, or already revoked", async () => {
		const revoked = {
			id: "grant-id",
			revoked_at: "2026-09-29T01:00:00.000Z",
			revocation_idempotency_key: "revoke-1",
			revocation_request_hash: "b".repeat(64),
		};
		const input = {
			billingAccountId: "acct_1",
			grantId: "grant-id",
			reason: "Granted in error",
			actor: "support@example.com",
			idempotencyKey: "revoke-1",
		};

		await expect(
			repository(
				new FakeDatabase([[customer], [revoked], []], { strict: true }),
			).revokeOperatorGrant(project, input),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
		await expect(
			repository(
				new FakeDatabase([[customer], [revoked], []], { strict: true }),
			).revokeOperatorGrant(project, { ...input, idempotencyKey: "revoke-2" }),
		).rejects.toMatchObject({ code: "OPERATOR_GRANT_ALREADY_REVOKED", status: 409 });
		await expect(
			repository(new FakeDatabase([[]], { strict: true })).revokeOperatorGrant(project, input),
		).rejects.toMatchObject({ code: "OPERATOR_GRANT_NOT_FOUND", status: 404 });
		const unrevoked = { ...revoked, revoked_at: null, revocation_idempotency_key: null };
		await expect(
			repository(
				new FakeDatabase([[customer], [unrevoked], [{ id: "other-grant" }]], { strict: true }),
			).revokeOperatorGrant(project, input),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
	});
});

describe("administrative debits", () => {
	const input = {
		billingAccountId: "acct_1",
		allocations: [
			{ allocationId: "17", quantity: "5" },
			{ allocationId: "9", quantity: "2.5" },
		],
		reason: "Duplicate goodwill credit",
		actor: "support@example.com",
		idempotencyKey: "debit-1",
	};

	it("locks the named allocations in spend order and raises their reversal with a guard", async () => {
		const debitRow = {
			id: "debit-id",
			billing_account_id: "acct_1",
			actor: "support@example.com",
			reason: "Duplicate goodwill credit",
			request_hash: "c".repeat(64),
			created_at: "2026-09-29T00:00:00.000Z",
			cursor_created_at: "2026-09-29T00:00:00.000000Z",
			allocations: [
				{
					allocation_id: 9,
					feature_key: "ai_credits",
					entity_external_id: null,
					source_kind: "subscription",
					quantity: "2.500000000",
				},
				{
					allocation_id: 17,
					feature_key: "ai_credits",
					entity_external_id: null,
					source_kind: "operator",
					quantity: "5.000000000",
				},
			],
		};
		const database = new FakeDatabase(
			[
				[customer],
				[],
				[debitTarget({ id: "9", source_kind: "subscription" }), debitTarget()],
				[{ id: "debit-id" }],
				[{ allocation_id: 9 }],
				[{ id: 9 }],
				[{ id: 17 }],
				[{ id: 1 }],
				[debitRow],
			],
			{ strict: true },
		);

		const result = await repository(database).debitAllocations(project, input);

		database.assertConsumed();
		const [, , targets, , lines, firstUpdate, secondUpdate] = database.queries;
		expect(targets).toMatch(
			/ORDER BY a\.feature_id, a\.expires_at ASC NULLS LAST, a\.created_at, a\.id\s+FOR UPDATE OF a/,
		);
		expect(lines).toContain("jsonb_to_recordset");
		for (const update of [firstUpdate, secondUpdate]) {
			expect(update).toContain("SET reversed_quantity = reversed_quantity + ");
			expect(update).toContain("AND reversed_at IS NULL");
			expect(update).toContain("quantity - reversed_quantity - consumed_quantity - held_quantity");
			expect(update).not.toContain("consumed_quantity =");
		}
		expect(database.queries.some((query) => query.includes("usage_events"))).toBe(false);
		expect(result.debit.allocations).toEqual([
			{
				allocationId: "9",
				featureKey: "ai_credits",
				entityId: null,
				sourceKind: "subscription",
				quantity: "2.5",
			},
			{
				allocationId: "17",
				featureKey: "ai_credits",
				entityId: null,
				sourceKind: "operator",
				quantity: "5",
			},
		]);
	});

	it("refuses a missing, closed, provider-purchased or over-drawn allocation before any write", async () => {
		const attempt = async (targets: Array<Record<string, unknown>>) => {
			const database = new FakeDatabase([[customer], [], targets], { strict: true });
			const outcome = repository(database).debitAllocations(project, input);
			await outcome.catch(() => undefined);
			database.assertConsumed();
			return outcome;
		};

		await expect(attempt([debitTarget()])).rejects.toMatchObject({
			code: "ALLOCATION_NOT_FOUND",
			details: { allocationId: "9" },
		});
		await expect(
			attempt([debitTarget({ id: "9", source_kind: "topup" }), debitTarget()]),
		).rejects.toMatchObject({
			code: "ALLOCATION_NOT_DEBITABLE",
			details: { allocationId: "9", reason: "provider_purchase" },
		});
		await expect(
			attempt([debitTarget({ id: "9", expired: true }), debitTarget()]),
		).rejects.toMatchObject({ details: { reason: "expired" } });
		await expect(
			attempt([debitTarget({ id: "9", reversed: true }), debitTarget()]),
		).rejects.toMatchObject({ details: { reason: "reversed" } });
		await expect(
			attempt([debitTarget({ id: "9" }), debitTarget({ reversed_quantity: "12.000000000" })]),
		).rejects.toMatchObject({
			code: "ADMINISTRATIVE_DEBIT_EXCEEDS_AVAILABLE",
			details: { allocationId: "17", available: "3" },
		});
	});

	it("needs an existing billing account", async () => {
		await expect(
			repository(new FakeDatabase([[]], { strict: true })).debitAllocations(project, input),
		).rejects.toMatchObject({ code: "BILLING_ACCOUNT_NOT_FOUND", status: 404 });
	});
});
