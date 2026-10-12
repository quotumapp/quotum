import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { stripeCheckoutSessionObject, stripeEvent } from "./helpers/fake-provider-clients";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { runStoreEventReplayWorkerOnce } from "./helpers/worker-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const actor = "support@example.com";
let context: LocalPostgresContext;

localDescribe("provider customer unlinks", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	function fixture(event?: ReturnType<typeof stripeEvent>) {
		const created = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			...(event === undefined ? {} : { stripeEvent: event }),
		});
		const { app, authHeaders } = created;
		const operator = (idempotencyKey?: string): HeadersInit => ({
			...authHeaders("acme"),
			"x-billing-operator-key": context.env.operatorApiKey ?? "",
			"x-billing-actor": actor,
			"content-type": "application/json",
			...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
		});
		const unlink = (
			billingAccountId: string,
			idempotencyKey: string,
			externalCustomerId: string,
			reason = "Link does not belong to this account",
		) =>
			testRequest(app, `/v1/admin/provider-customer-unlinks/${billingAccountId}`, {
				method: "POST",
				headers: operator(idempotencyKey),
				body: JSON.stringify({ provider: "stripe", externalCustomerId, reason }),
			});
		const receipts = (billingAccountId: string, query = "") =>
			testRequest(app, `/v1/admin/provider-customer-unlinks/${billingAccountId}${query}`, {
				headers: operator(),
			});
		const webhook = (eventId: string) =>
			testRequest(app, "/v1/projects/acme/webhooks/stripe", {
				method: "POST",
				headers: { "content-type": "application/json", "stripe-signature": "sig_test" },
				body: JSON.stringify({
					id: eventId,
					type: "checkout.session.completed",
					data: { object: {} },
				}),
			});
		const checkout = (billingAccountId: string) =>
			testRequest(
				app,
				`/v1/billing-accounts/${billingAccountId}/providers/stripe/checkout-sessions`,
				{
					method: "POST",
					headers: { ...authHeaders("acme"), "content-type": "application/json" },
					body: JSON.stringify({ productKey: "echo_credits_10" }),
				},
			);
		const replay = () =>
			runStoreEventReplayWorkerOnce({
				env: context.env,
				repository: context.repository,
				providers: {
					apple: null,
					google: null,
					stripe: created.projectProviderServices.acme?.stripeBillingService ?? null,
				},
			});
		return { ...created, unlink, receipts, webhook, checkout, replay };
	}

	/** The seeded owner pays first, which links `cus_integration` to `integration_user`. */
	async function linkedOwner() {
		const created = fixture(
			stripeEvent("checkout.session.completed", stripeCheckoutSessionObject(), "evt_owner"),
		);
		expect((await created.webhook("evt_owner")).status).toBe(200);
		return created;
	}

	/** A paid one-time purchase by another billing account under the owner's Stripe customer. */
	function otherAccountPayment() {
		return stripeEvent(
			"checkout.session.completed",
			stripeCheckoutSessionObject({
				id: "cs_other",
				client_reference_id: "other_user",
				metadata: {
					billingAccountId: "other_user",
					externalPriceId: "price_credits_10",
					externalProductId: "prod_stripe_credits_10",
					productKey: "echo_credits_10",
					purchaseKind: "consumable",
				},
				payment_intent: {
					id: "pi_other",
					latest_charge: "ch_other",
					metadata: { billingAccountId: "other_user" },
					object: "payment_intent",
				},
			}),
			"evt_other",
		);
	}

	/** A paid one-time purchase by the owner under a second Stripe customer. */
	function secondCustomerPayment() {
		return stripeEvent(
			"checkout.session.completed",
			stripeCheckoutSessionObject({
				id: "cs_second_customer",
				customer: "cus_second",
				payment_intent: {
					id: "pi_second",
					latest_charge: "ch_second",
					metadata: { billingAccountId: "integration_user" },
					object: "payment_intent",
				},
			}),
			"evt_second",
		);
	}

	async function links() {
		const rows = await context.sql<
			Array<{ billing_account_id: string; external_customer_id: string }>
		>`
			SELECT c.billing_account_id, pc.external_customer_id
			FROM provider_customers pc JOIN customers c ON c.id = pc.customer_id
			WHERE pc.provider = 'stripe'
			ORDER BY c.billing_account_id, pc.external_customer_id
		`;
		return rows.map((row) => ({ ...row }));
	}

	async function eventStatus(eventId: string) {
		const rows = await context.sql<Array<{ processing_status: string }>>`
			SELECT processing_status FROM store_events
			WHERE provider = 'stripe' AND external_event_id = ${eventId}
		`;
		expect(rows).toHaveLength(1);
		return rows[0]?.processing_status;
	}

	async function ownerCustomerId() {
		const [row] = await context.sql<Array<{ id: string; project_id: string }>>`
			SELECT id, project_id FROM customers WHERE billing_account_id = 'integration_user'
		`;
		if (row === undefined) throw new Error("integration_user was not created");
		return row;
	}

	it("frees a Stripe customer another account holds, so the skipped payment applies", async () => {
		const app = await linkedOwner();
		app.stripe.setWebhookEvent(otherAccountPayment());
		expect((await (await app.webhook("evt_other")).json()).data.status).toBe("skipped");

		const unlinked = await app.unlink("integration_user", "unlink-1", "cus_integration");
		const run = await app.replay();

		expect(unlinked.status).toBe(201);
		expect((await unlinked.json()).data).toMatchObject({
			duplicate: false,
			unlink: {
				billingAccountId: "integration_user",
				provider: "stripe",
				externalCustomerId: "cus_integration",
				actor,
				reason: "Link does not belong to this account",
			},
		});
		expect(run).toMatchObject({ claimed: 1, processed: 1, failed: 0 });
		expect(await eventStatus("evt_other")).toBe("processed");
		expect(await links()).toEqual([
			{ billing_account_id: "other_user", external_customer_id: "cus_integration" },
		]);
		// The owner's own purchase and balance stay; only the link moved on.
		const purchases = await context.sql<Array<{ transaction_id: string; account: string }>>`
			SELECT p.transaction_id, c.billing_account_id AS account
			FROM purchases p JOIN customers c ON c.id = p.customer_id
			ORDER BY p.transaction_id
		`;
		expect(purchases.map((row) => ({ ...row }))).toEqual([
			{ transaction_id: "pi_integration", account: "integration_user" },
			{ transaction_id: "pi_other", account: "other_user" },
		]);
	});

	it("drops an account's Stripe customer, so a payment under its second one applies", async () => {
		const app = await linkedOwner();
		app.stripe.setWebhookEvent(secondCustomerPayment());
		expect((await (await app.webhook("evt_second")).json()).data.status).toBe("skipped");

		const unlinked = await app.unlink("integration_user", "unlink-1", "cus_integration");
		const run = await app.replay();

		expect(unlinked.status).toBe(201);
		expect(run).toMatchObject({ claimed: 1, processed: 1, failed: 0 });
		expect(await eventStatus("evt_second")).toBe("processed");
		expect(await links()).toEqual([
			{ billing_account_id: "integration_user", external_customer_id: "cus_second" },
		]);
	});

	it("refuses an unknown account, an unlinked account and another customer than the linked one", async () => {
		const app = await linkedOwner();
		await context.sql`
			INSERT INTO customers (project_id, billing_account_id)
			SELECT project_id, 'unlinked_user' FROM customers WHERE billing_account_id = 'integration_user'
		`;
		const customersBefore = await context.sql`SELECT id FROM customers`;

		const unknown = await app.unlink("nobody", "unlink-1", "cus_integration");
		const noLink = await app.unlink("unlinked_user", "unlink-1", "cus_integration");
		const mismatch = await app.unlink("integration_user", "unlink-1", "cus_someone_else");

		expect(unknown.status).toBe(404);
		expect((await unknown.json()).error.code).toBe("BILLING_ACCOUNT_NOT_FOUND");
		expect(noLink.status).toBe(404);
		expect((await noLink.json()).error.code).toBe("PROVIDER_CUSTOMER_LINK_NOT_FOUND");
		expect(mismatch.status).toBe(409);
		expect((await mismatch.json()).error).toMatchObject({
			code: "PROVIDER_CUSTOMER_LINK_MISMATCH",
			details: { externalCustomerId: "cus_integration" },
		});
		// An unknown account is looked up, never created, and no link or receipt changed.
		expect(await context.sql`SELECT id FROM customers`).toHaveLength(customersBefore.length);
		expect(await links()).toEqual([
			{ billing_account_id: "integration_user", external_customer_id: "cus_integration" },
		]);
		expect(await context.sql`SELECT id FROM provider_customer_unlinks`).toHaveLength(0);
	});

	it("refuses while work still depends on the link and names each kind", async () => {
		const app = await linkedOwner();
		const owner = await ownerCustomerId();
		const blockedBy = async () => {
			const response = await app.unlink("integration_user", "unlink-blocked", "cus_integration");
			const body = await response.json();
			return {
				status: response.status,
				code: body.error?.code,
				blockers: body.error?.details?.blockers,
			};
		};

		// A live Stripe subscription: Stripe still bills and reports it under the linked customer.
		await context.sql`
			INSERT INTO subscriptions (
				project_id, customer_id, product_id, store_product_id, provider, channel,
				external_subscription_id, external_product_id, status
			)
			SELECT sp.project_id, ${owner.id}, sp.product_id, sp.id, 'stripe', 'web', 'sub_live',
				sp.external_product_id, 'active'
			FROM store_products sp
			JOIN products p ON p.id = sp.product_id
			WHERE sp.project_id = ${owner.project_id} AND sp.provider = 'stripe'
				AND p.key = 'premium_monthly'
			LIMIT 1
		`;
		expect(await blockedBy()).toEqual({
			status: 409,
			code: "PROVIDER_CUSTOMER_LINK_IN_USE",
			blockers: [{ kind: "subscription", count: 1 }],
		});

		// Once Stripe has ended it, it no longer holds the link, even with paid time left.
		await context.sql`
			UPDATE subscriptions SET status = 'cancelled', expires_at = now() + interval '20 days'
			WHERE external_subscription_id = 'sub_live'
		`;
		// An in-flight provider operation for the account.
		await context.sql`
			INSERT INTO provider_operations (
				project_id, billing_account_id, provider, provider_account_id, connection_version_id,
				idempotency_key, resource_key, operation, request_hash, request, status
			)
			VALUES (
				${owner.project_id}, 'integration_user', 'stripe', 'acct_test', uuidv7(),
				'op-1', 'subscription:sub_live', 'subscription.cancel', ${"a".repeat(64)},
				'{}'::jsonb, 'prepared'
			)
		`;
		expect(await blockedBy()).toEqual({
			status: 409,
			code: "PROVIDER_CUSTOMER_LINK_IN_USE",
			blockers: [{ kind: "provider_operation", count: 1 }],
		});
		expect(await links()).toEqual([
			{ billing_account_id: "integration_user", external_customer_id: "cus_integration" },
		]);
		expect(await context.sql`SELECT id FROM provider_customer_unlinks`).toHaveLength(0);

		await context.sql`DELETE FROM provider_operations WHERE idempotency_key = 'op-1'`;
		expect((await app.unlink("integration_user", "unlink-free", "cus_integration")).status).toBe(
			201,
		);
	});

	it("replays by key, conflicts on other terms, and lists receipts newest first", async () => {
		const app = await linkedOwner();

		const first = await app.unlink("integration_user", "unlink-1", "cus_integration");
		const replayed = await app.unlink("integration_user", "unlink-1", "cus_integration");
		const conflict = await app.unlink("integration_user", "unlink-1", "cus_integration", "Other");
		const again = await app.unlink("integration_user", "unlink-2", "cus_integration");

		expect(first.status).toBe(201);
		const receipt = (await first.json()).data.unlink;
		expect(replayed.status).toBe(200);
		expect((await replayed.json()).data).toEqual({ duplicate: true, unlink: receipt });
		expect(conflict.status).toBe(409);
		expect((await conflict.json()).error.code).toBe("IDEMPOTENCY_CONFLICT");
		// A new key is a new request, and the link is already gone.
		expect(again.status).toBe(404);
		expect((await again.json()).error.code).toBe("PROVIDER_CUSTOMER_LINK_NOT_FOUND");

		// The account is linked and unlinked once more, so there are two receipts to page through.
		app.stripe.setWebhookEvent(secondCustomerPayment());
		expect((await (await app.webhook("evt_second")).json()).data.status).toBe("processed");
		expect((await app.unlink("integration_user", "unlink-3", "cus_second")).status).toBe(201);

		const page = await (await app.receipts("integration_user", "?limit=1")).json();
		const rest = await (
			await app.receipts("integration_user", `?limit=1&cursor=${page.pagination.nextCursor}`)
		).json();
		expect(page.data.map((row: { externalCustomerId: string }) => row.externalCustomerId)).toEqual([
			"cus_second",
		]);
		expect(rest.data).toEqual([receipt]);
		expect(rest.pagination.nextCursor).toBeNull();
		// The receipt keeps when the removed link was written.
		expect(Date.parse(receipt.linkedAt)).toBeLessThanOrEqual(Date.parse(receipt.createdAt));
		expect(await links()).toEqual([]);
	});

	it("writes one receipt when two unlinks race", async () => {
		const app = await linkedOwner();

		const responses = await Promise.all([
			app.unlink("integration_user", "unlink-a", "cus_integration"),
			app.unlink("integration_user", "unlink-b", "cus_integration"),
		]);

		expect(responses.map((response) => response.status).sort()).toEqual([201, 404]);
		expect(await context.sql`SELECT id FROM provider_customer_unlinks`).toHaveLength(1);
		expect(await links()).toEqual([]);
	});

	it("lets an account whose Stripe customer was deleted check out again after an unlink", async () => {
		const app = fixture();
		expect((await app.checkout("deleted_user")).status).toBe(200);
		const [linked] = await links();
		if (linked === undefined) throw new Error("checkout did not link a Stripe customer");
		app.stripe.deleteCustomer(linked.external_customer_id);

		// The link never changes on its own, so every later checkout names the deleted customer.
		const failed = await app.checkout("deleted_user");
		const failedAgain = await app.checkout("deleted_user");
		expect([failed.status, failedAgain.status]).toEqual([500, 500]);
		expect((await failed.json()).error.code).toBe("INTERNAL_ERROR");
		expect(await links()).toEqual([linked]);

		const unlinked = await app.unlink(
			"deleted_user",
			"unlink-deleted",
			linked.external_customer_id,
			"Stripe customer was deleted",
		);
		const recovered = await app.checkout("deleted_user");

		expect(unlinked.status).toBe(201);
		expect(recovered.status).toBe(200);
		const [relinked] = await links();
		expect(relinked?.billing_account_id).toBe("deleted_user");
		// Stripe replays a customer creation for a day, so the account must not get the same one back.
		expect(relinked?.external_customer_id).not.toBe(linked.external_customer_id);
	});
});
