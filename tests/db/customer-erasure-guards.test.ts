import { afterEach, describe, expect, it } from "bun:test";
import {
	assertErasureKeyringCoversTombstones,
	configureErasureKeyring,
	tombstoneDigests,
} from "../../src/db/erasure-keyring";
import { BillingAccountRepository } from "../../src/db/repository/billing-accounts";
import { ensureCustomer } from "../../src/db/repository/identities";
import {
	type ErasureKeyring,
	erasureDigest,
	erasureKeyFromBase64,
} from "../../src/shared/erasure-digest";
import { projectInstanceContext } from "../helpers/project-context";
import { FakeDatabase } from "./repository-fixture";

const keyA = erasureKeyFromBase64("a1", Buffer.alloc(32, 1).toString("base64"));
const keyB = erasureKeyFromBase64("b1", Buffer.alloc(32, 2).toString("base64"));
const keyring: ErasureKeyring = { current: keyA, previous: keyB };
const project = projectInstanceContext("acme");
const projectId = project.projectInstanceId;

afterEach(() => {
	configureErasureKeyring(null);
});

describe("ensureCustomer erasure guard", () => {
	it("keeps the original statement when no erasure key is configured", async () => {
		const database = new FakeDatabase(
			[[{ id: "c1", billing_account_id: "acct", created: false }]],
			{
				strict: true,
			},
		);

		await ensureCustomer(database as never, projectId, "acct");

		expect(database.queries[0]).not.toContain("customer_erasure_tombstones");
		expect(database.queries[0]).toContain("VALUES (");
		expect(tombstoneDigests(projectId, "acct")).toEqual([]);
	});

	it("inserts through a tombstone check keyed by the current and previous key", async () => {
		configureErasureKeyring(keyring);
		const database = new FakeDatabase(
			[[{ id: "c1", billing_account_id: "acct", created: false }]],
			{
				strict: true,
			},
		);

		await ensureCustomer(database as never, projectId, "acct");

		const [query] = database.queries;
		expect(query).toContain("WHERE NOT EXISTS");
		expect(query).toContain("FROM customer_erasure_tombstones");
		expect(query).toContain("expires_at > now()");
		expect(query).toMatch(/\(key_id, id_digest\) IN \(\(\$\d+, \$\d+\), \(\$\d+, \$\d+\)\)/);
		const params = database.params[0] ?? [];
		expect(params).toContain(erasureDigest(keyA, projectId, "acct"));
		expect(params).toContain(erasureDigest(keyB, projectId, "acct"));
		expect(params).toContain("a1");
		expect(params).toContain("b1");
	});

	it("answers BILLING_ACCOUNT_ERASED when the guarded insert returns no row", async () => {
		configureErasureKeyring(keyring);
		const database = new FakeDatabase([[]], { strict: true });

		await expect(ensureCustomer(database as never, projectId, "acct")).rejects.toMatchObject({
			code: "BILLING_ACCOUNT_ERASED",
			status: 409,
		});
	});

	it("keeps the generic failure when no key is configured and no row returns", async () => {
		const database = new FakeDatabase([[]], { strict: true });

		await expect(ensureCustomer(database as never, projectId, "acct")).rejects.toThrow(
			"could not be created",
		);
	});
});

describe("BillingAccountRepository.create erasure guard", () => {
	it("refuses an erased id before inserting", async () => {
		configureErasureKeyring(keyring);
		const database = new FakeDatabase([[{ allowed: false }]], { strict: true });

		await expect(
			new BillingAccountRepository(database as never).create(project, "acct"),
		).rejects.toMatchObject({ code: "BILLING_ACCOUNT_ERASED" });
		expect(database.queries).toHaveLength(1);
		expect(database.queries[0]).toContain("FROM customer_erasure_tombstones");
	});

	it("does not query tombstones without a key", async () => {
		const database = new FakeDatabase(
			[
				[{ id: "c1", billing_account_id: "acct" }],
				[],
				[{ id: "c1", billing_account_id: "acct", created_at: "2026-10-12T00:00:00.000Z" }],
			],
			{},
		);

		await new BillingAccountRepository(database as never).create(project, "acct");

		expect(database.queries.some((query) => query.includes("customer_erasure_tombstones"))).toBe(
			false,
		);
	});
});

describe("assertErasureKeyringCoversTombstones", () => {
	function client(result: { key_id: string }[] | Error) {
		return ((_strings: TemplateStringsArray) => {
			if (result instanceof Error) return Promise.reject(result);
			return Promise.resolve(result);
		}) as never;
	}

	it("passes when every live tombstone key is configured", async () => {
		await expect(
			assertErasureKeyringCoversTombstones(client([{ key_id: "a1" }, { key_id: "b1" }]), keyring),
		).resolves.toBeUndefined();
		await expect(assertErasureKeyringCoversTombstones(client([]), null)).resolves.toBeUndefined();
	});

	it("fails when a live tombstone was written under an unconfigured key", async () => {
		await expect(
			assertErasureKeyringCoversTombstones(client([{ key_id: "old" }]), {
				current: keyA,
				previous: null,
			}),
		).rejects.toThrow("written under key old");
		await expect(
			assertErasureKeyringCoversTombstones(client([{ key_id: "a1" }]), null),
		).rejects.toThrow("written under key a1");
	});

	it("starts degraded when the database cannot be reached", async () => {
		await expect(
			assertErasureKeyringCoversTombstones(client(new Error("connection refused")), keyring),
		).resolves.toBeUndefined();
	});
});
