import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { configureErasureKeyring } from "../../src/db/erasure-keyring";
import { BillingAccountRepository } from "../../src/db/repository/billing-accounts";
import { ensureCustomer } from "../../src/db/repository/identities";
import {
	type ErasureKey,
	erasureDigest,
	erasureKeyFromBase64,
} from "../../src/shared/erasure-digest";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const keyOld = erasureKeyFromBase64("old", Buffer.alloc(32, 3).toString("base64"));
const keyNew = erasureKeyFromBase64("new", Buffer.alloc(32, 4).toString("base64"));
const erasedId = "erased_user@example.com";
let context: LocalPostgresContext;

localDescribe("customer erasure tombstones", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterEach(() => {
		configureErasureKeyring(null);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	const acme = () => integrationProjectContext("acme");
	const globex = () => integrationProjectContext("globex");

	/**
	 * An erased account as the operation leaves it: a stub whose id was rewritten, its receipt, and a
	 * tombstone under `key`. Written directly, because the operation itself is a later change.
	 */
	async function eraseAccount(billingAccountId: string, key: ErasureKey, expiresInDays = 30) {
		const project = acme();
		const customer = await ensureCustomer(
			context.db as never,
			project.projectInstanceId,
			billingAccountId,
			"someone@example.com",
		);
		const [erasure] = await context.sql`
			INSERT INTO customer_erasures (
				project_id, customer_id, state, basis, actor, idempotency_key, subject_id,
				tombstone_expires_at
			) VALUES (
				${project.projectInstanceId}, ${customer.id}, 'running', 'data_subject_request',
				'support@example.com', ${`erase-${billingAccountId}`}, ${billingAccountId},
				now() + make_interval(days => ${expiresInDays})
			) RETURNING id
		`;
		await context.sql`
			UPDATE customers
			SET billing_account_id = ${`erased:${erasure.id}`}, email = NULL, metadata = '{}'::jsonb,
				erased_at = now()
			WHERE id = ${customer.id}
		`;
		const created = expiresInDays > 0 ? "now()" : "now() - interval '2 days'";
		await context.sql.unsafe(
			`INSERT INTO customer_erasure_tombstones (project_id, key_id, id_digest, erasure_id, created_at, expires_at)
			 VALUES ($1, $2, $3, $4, ${created}, ${expiresInDays > 0 ? `now() + interval '${expiresInDays} days'` : "now() - interval '1 day'"})`,
			[
				project.projectInstanceId,
				key.id,
				erasureDigest(key, project.projectInstanceId, billingAccountId),
				erasure.id,
			],
		);
		return { customerId: customer.id as string, erasureId: erasure.id as string };
	}

	const accountRows = async (projectId: string, id: string) =>
		await context.sql`SELECT id FROM customers WHERE project_id = ${projectId} AND billing_account_id = ${id}`;

	it("keeps an erased id from being created again through ensureCustomer", async () => {
		await eraseAccount(erasedId, keyNew);
		configureErasureKeyring({ current: keyNew, previous: null });
		const project = acme();

		let error: unknown;
		try {
			await ensureCustomer(context.db as never, project.projectInstanceId, erasedId);
		} catch (caught) {
			error = caught;
		}

		expect(error).toMatchObject({ code: "BILLING_ACCOUNT_ERASED", status: 409 });
		expect(await accountRows(project.projectInstanceId, erasedId)).toHaveLength(0);
	});

	it("keeps it from being created through the billing account repository", async () => {
		await eraseAccount(erasedId, keyNew);
		configureErasureKeyring({ current: keyNew, previous: null });

		let error: unknown;
		try {
			await new BillingAccountRepository(context.db as never).create(acme(), erasedId);
		} catch (caught) {
			error = caught;
		}

		expect(error).toMatchObject({ code: "BILLING_ACCOUNT_ERASED" });
		expect(await accountRows(acme().projectInstanceId, erasedId)).toHaveLength(0);
	});

	it("answers 409 BILLING_ACCOUNT_ERASED on the public route", async () => {
		await eraseAccount(erasedId, keyNew);
		configureErasureKeyring({ current: keyNew, previous: null });
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const response = await testRequest(
			app,
			`/v1/billing-accounts/${encodeURIComponent(erasedId)}`,
			{
				method: "PUT",
				headers: { ...authHeaders("acme"), "content-type": "application/json" },
				body: JSON.stringify({}),
			},
		);

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			success: false,
			error: { code: "BILLING_ACCOUNT_ERASED" },
		});
	});

	it("does not block the same id in another project or a different id", async () => {
		await eraseAccount(erasedId, keyNew);
		configureErasureKeyring({ current: keyNew, previous: null });

		const other = await ensureCustomer(context.db as never, globex().projectInstanceId, erasedId);
		const different = await ensureCustomer(
			context.db as never,
			acme().projectInstanceId,
			"another_user",
		);

		expect(other.billing_account_id).toBe(erasedId);
		expect(different.billing_account_id).toBe("another_user");
	});

	it("keeps matching a tombstone written under the previous key", async () => {
		await eraseAccount(erasedId, keyOld);
		configureErasureKeyring({ current: keyNew, previous: keyOld });

		await expect(
			ensureCustomer(context.db as never, acme().projectInstanceId, erasedId),
		).rejects.toMatchObject({ code: "BILLING_ACCOUNT_ERASED" });
	});

	it("lets the id start again once its tombstone expired", async () => {
		await eraseAccount(erasedId, keyNew, 0);
		configureErasureKeyring({ current: keyNew, previous: null });

		const reopened = await ensureCustomer(context.db as never, acme().projectInstanceId, erasedId);

		expect(reopened.billing_account_id).toBe(erasedId);
	});

	it("does not touch the guarded path without a configured key", async () => {
		await eraseAccount(erasedId, keyNew);

		const created = await ensureCustomer(context.db as never, acme().projectInstanceId, erasedId);

		expect(created.billing_account_id).toBe(erasedId);
	});

	it("rejects an erased stub that still carries contact data", async () => {
		const customer = await ensureCustomer(
			context.db as never,
			acme().projectInstanceId,
			"stub_user",
			"keep@example.com",
		);

		let code: string | undefined;
		try {
			await context.sql`UPDATE customers SET erased_at = now() WHERE id = ${customer.id}`;
		} catch (error) {
			code = (error as { errno?: string }).errno;
		}

		expect(code).toBe("23514");
	});

	it("requires a completed erasure to have dropped the subject id", async () => {
		const { erasureId } = await eraseAccount(erasedId, keyNew);

		let code: string | undefined;
		try {
			await context.sql`
				UPDATE customer_erasures SET state = 'completed', completed_at = now() WHERE id = ${erasureId}
			`;
		} catch (error) {
			code = (error as { errno?: string }).errno;
		}
		expect(code).toBe("23514");

		await context.sql`
			UPDATE customer_erasures
			SET state = 'completed', completed_at = now(), subject_id = NULL
			WHERE id = ${erasureId}
		`;
		const [row] =
			await context.sql`SELECT state, subject_id FROM customer_erasures WHERE id = ${erasureId}`;
		expect(row).toEqual({ state: "completed", subject_id: null });
	});

	it("allows one erasure per account and never cascades it away", async () => {
		const { customerId } = await eraseAccount(erasedId, keyNew);
		const project = acme();

		let duplicate: string | undefined;
		try {
			await context.sql`
				INSERT INTO customer_erasures (
					project_id, customer_id, basis, actor, idempotency_key, subject_id, tombstone_expires_at
				) VALUES (
					${project.projectInstanceId}, ${customerId}, 'other', 'support@example.com', 'second',
					${erasedId}, now() + interval '30 days'
				)
			`;
		} catch (error) {
			duplicate = (error as { errno?: string }).errno;
		}
		expect(duplicate).toBe("23505");

		let restricted: string | undefined;
		try {
			await context.sql`DELETE FROM customers WHERE id = ${customerId}`;
		} catch (error) {
			restricted = (error as { errno?: string }).errno;
		}
		expect(restricted).toBe("23001");
	});
});
