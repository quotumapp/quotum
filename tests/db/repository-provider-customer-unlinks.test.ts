import { describe, expect, it } from "bun:test";
import {
	normalizeProviderCustomerUnlinkInput,
	type ProviderCustomerUnlinkInput,
	providerCustomerUnlinkBlockerKinds,
	providerCustomerUnlinkRequestHash,
} from "../../src/billing/provider-customer-unlinks";
import { ProviderCustomerUnlinkRepository } from "../../src/db/repository/provider-customer-unlinks";
import { projectInstanceContext } from "../helpers/project-context";
import { FakeDatabase } from "./repository-fixture";

const project = projectInstanceContext("acme");
const customer = { id: "customer-id", billing_account_id: "acct_1" };
const link = { id: "link-id", external_customer_id: "cus_old" };

const input: ProviderCustomerUnlinkInput = {
	billingAccountId: "acct_1",
	provider: "stripe",
	externalCustomerId: "cus_old",
	reason: "Stripe customer was deleted",
	actor: "support@example.com",
	idempotencyKey: "unlink-1",
};

function unlinkRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "unlink-id",
		billing_account_id: "acct_1",
		provider: "stripe",
		external_customer_id: "cus_old",
		provider_account_id: "acct_stripe",
		linked_at: "2026-09-01T00:00:00.000Z",
		actor: "support@example.com",
		reason: "Stripe customer was deleted",
		created_at: "2026-10-12T00:00:00.000Z",
		cursor_created_at: "2026-10-12T00:00:00.000000Z",
		...overrides,
	};
}

function repository(database: FakeDatabase) {
	return new ProviderCustomerUnlinkRepository(database as never);
}

describe("provider customer unlinks", () => {
	it("locks the customer, then the link, and writes the receipt before deleting the link", async () => {
		const database = new FakeDatabase(
			[[customer], [], [link], [], [{ id: "unlink-id" }], [{ id: "link-id" }], [unlinkRow()]],
			{ strict: true },
		);

		const result = await repository(database).unlinkProviderCustomer(project, input);

		database.assertConsumed();
		const [lock, replay, linkRead, blockers, receipt, removal] = database.queries;
		expect(lock).toMatch(
			/FROM customers\s+WHERE project_id = \$1 AND billing_account_id = \$2\s+FOR NO KEY UPDATE/,
		);
		expect(replay).toContain("FROM provider_customer_unlinks");
		expect(replay).toContain("idempotency_key = ");
		expect(linkRead).toMatch(/FROM provider_customers[\s\S]+AND provider = \$3\s+FOR UPDATE/);
		expect(database.params[2]).toEqual([project.projectInstanceId, "customer-id", "stripe"]);
		for (const table of [
			"subscriptions",
			"provider_operations",
			"payment_setup_sessions",
			"auto_topup_jobs",
			"usage_invoice_periods",
			"usage_invoice_adjustments",
		]) {
			expect(blockers).toContain(`FROM ${table} `);
		}
		for (const kind of providerCustomerUnlinkBlockerKinds) {
			expect(blockers).toContain(`'${kind}'`);
		}
		// A subscription Stripe has ended and a usage invoice that ended failed do not hold the link.
		expect(blockers).toContain("s.status IN ('active', 'grace_period', 'billing_retry')");
		expect(blockers).not.toContain("'cancelled'");
		// Nor does a top-up policy, which an operator has no way to switch off first.
		expect(blockers).not.toContain("auto_topup_policies");
		expect(blockers).not.toContain("'failed'");
		expect(receipt).toMatch(
			/INSERT INTO provider_customer_unlinks[\s\S]+SELECT link\.project_id, link\.customer_id, link\.provider, link\.provider_account_id,\s+link\.external_customer_id, link\.created_at,/,
		);
		expect(receipt).toMatch(
			/FROM provider_customers link\s+WHERE link\.project_id = \$\d+ AND link\.id = \$\d+/,
		);
		expect(removal).toMatch(/DELETE FROM provider_customers\s+WHERE project_id = \$1 AND id = \$2/);
		expect(database.params[5]).toEqual([project.projectInstanceId, "link-id"]);
		expect(database.queries.some((query) => query.includes("projection_sync_jobs"))).toBe(false);
		expect(result).toEqual({
			duplicate: false,
			unlink: {
				id: "unlink-id",
				billingAccountId: "acct_1",
				provider: "stripe",
				externalCustomerId: "cus_old",
				providerAccountId: "acct_stripe",
				linkedAt: "2026-09-01T00:00:00.000Z",
				actor: "support@example.com",
				reason: "Stripe customer was deleted",
				createdAt: "2026-10-12T00:00:00.000Z",
			},
		});
	});

	it("replays an unlink with the same terms and refuses the key with other terms", async () => {
		const requestHash = providerCustomerUnlinkRequestHash(
			normalizeProviderCustomerUnlinkInput(input),
		);
		const replayed = new FakeDatabase(
			[[customer], [{ id: "unlink-id", request_hash: requestHash }], [unlinkRow()]],
			{ strict: true },
		);
		const conflicting = new FakeDatabase(
			[[customer], [{ id: "unlink-id", request_hash: requestHash }]],
			{ strict: true },
		);

		const result = await repository(replayed).unlinkProviderCustomer(project, {
			...input,
			reason: "  Stripe customer was deleted ",
		});
		const conflict = await repository(conflicting)
			.unlinkProviderCustomer(project, { ...input, reason: "Another reason" })
			.catch((error: unknown) => error);

		replayed.assertConsumed();
		expect(result.duplicate).toBe(true);
		expect(result.unlink.id).toBe("unlink-id");
		expect(replayed.queries.some((query) => query.includes("DELETE FROM"))).toBe(false);
		expect(conflict).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
		expect(conflicting.queries).toHaveLength(2);
	});

	it("refuses an unknown account, a missing link and another linked customer before any write", async () => {
		const unknownAccount = new FakeDatabase([[]], { strict: true });
		const noLink = new FakeDatabase([[customer], [], []], { strict: true });
		const otherCustomer = new FakeDatabase(
			[[customer], [], [{ id: "link-id", external_customer_id: "cus_current" }]],
			{ strict: true },
		);
		const refused = (database: FakeDatabase) =>
			repository(database)
				.unlinkProviderCustomer(project, input)
				.catch((error: unknown) => error);

		expect(await refused(unknownAccount)).toMatchObject({
			code: "BILLING_ACCOUNT_NOT_FOUND",
			status: 404,
		});
		expect(await refused(noLink)).toMatchObject({
			code: "PROVIDER_CUSTOMER_LINK_NOT_FOUND",
			status: 404,
		});
		expect(await refused(otherCustomer)).toMatchObject({
			code: "PROVIDER_CUSTOMER_LINK_MISMATCH",
			status: 409,
			details: { externalCustomerId: "cus_current" },
		});
		// The account is looked up, never created.
		expect(unknownAccount.queries.some((query) => query.includes("INSERT INTO"))).toBe(false);
		for (const database of [unknownAccount, noLink, otherCustomer]) {
			expect(database.queries.some((query) => /INSERT INTO|DELETE FROM|UPDATE /.test(query))).toBe(
				false,
			);
		}
	});

	it("refuses a link that work still depends on and names each kind of work", async () => {
		const database = new FakeDatabase(
			[
				[customer],
				[],
				[link],
				[
					{ kind: "subscription", count: 1 },
					{ kind: "usage_invoice", count: "2" },
				],
			],
			{ strict: true },
		);

		const refused = await repository(database)
			.unlinkProviderCustomer(project, input)
			.catch((error: unknown) => error);

		database.assertConsumed();
		expect(refused).toMatchObject({
			code: "PROVIDER_CUSTOMER_LINK_IN_USE",
			status: 409,
			details: {
				blockers: [
					{ kind: "subscription", count: 1 },
					{ kind: "usage_invoice", count: 2 },
				],
			},
		});
		expect(database.queries).toHaveLength(4);
	});

	it("refuses an id that is not a Stripe customer and a reason out of bounds", () => {
		const invalid = (overrides: Partial<ProviderCustomerUnlinkInput>) => {
			try {
				normalizeProviderCustomerUnlinkInput({ ...input, ...overrides });
				return null;
			} catch (error) {
				return error;
			}
		};

		for (const externalCustomerId of ["sub_123", "cus_", "cus_a b", `cus_${"a".repeat(252)}`]) {
			expect(invalid({ externalCustomerId })).toMatchObject({ code: "INVALID_REQUEST" });
		}
		expect(invalid({ reason: "   " })).toMatchObject({ code: "INVALID_REQUEST" });
		expect(invalid({ reason: "x".repeat(501) })).toMatchObject({ code: "INVALID_REQUEST" });
		expect(invalid({ reason: "x".repeat(500), externalCustomerId: " cus_old " })).toBeNull();
	});

	it("lists an account's receipts newest first with a keyset cursor", async () => {
		// The cursor carries the row id, which is a UUID.
		const newest = "66666666-6666-4666-8666-666666666666";
		const older = "55555555-5555-4555-8555-555555555555";
		const database = new FakeDatabase(
			[
				[
					unlinkRow({ id: newest }),
					unlinkRow({ id: older, cursor_created_at: "2026-10-01T00:00:00.000000Z" }),
				],
				[],
			],
			{ strict: true },
		);

		const first = await repository(database).listProviderCustomerUnlinks(project, "acct_1", {
			limit: 1,
			cursor: null,
		});
		await repository(database).listProviderCustomerUnlinks(project, "acct_1", {
			limit: 1,
			cursor: first.nextCursor,
		});

		const [firstPage, secondPage] = database.queries;
		expect(first.items.map((item) => item.id)).toEqual([newest]);
		expect(first.nextCursor).not.toBeNull();
		expect(firstPage).toMatch(/WHERE u\.project_id = \$1 AND c\.billing_account_id = \$2/);
		expect(firstPage).toContain("ORDER BY u.created_at DESC, u.id DESC");
		expect(secondPage).toContain("(u.created_at, u.id) < (");
	});
});
