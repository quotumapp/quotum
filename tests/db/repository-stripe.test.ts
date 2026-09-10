import { describe, expect, it } from "bun:test";
import { BillingRepository } from "../../src/db/repository";
import { projectInstanceContext } from "../helpers/project-context";
import { FakeDatabase, stripeReversalInput, stripeSubscriptionInput } from "./repository-fixture";

describe("BillingRepository Stripe", () => {
	it("looks up Stripe web catalog products inside the supplied project", async () => {
		const database = new FakeDatabase([
			[
				{
					value: {
						storeProductId: "store-product-id",
						productId: "product-id",
						productKey: "credits_100",
						productType: "consumable",
						creditAmount: 100,
						externalProductId: "prod_123",
						externalPriceId: "price_123",
						billingPeriod: "one_time",
						currency: "usd",
						priceAmount: 499,
					},
					product_type: "consumable",
					price_amount: 499,
					currency: "usd",
				},
			],
		]);
		const repository = new BillingRepository(database as never);

		const product = await repository.getStripeWebStoreProductByKey(
			projectInstanceContext("wiseley"),
			"credits_100",
		);

		expect(product.storeProductId).toBe("store-product-id");
		const queries = database.queries.join("\n");
		expect(queries).not.toContain("FROM projects");
		expect(queries).toContain("sp.project_id = $1");
		expect(database.boundParameter("sp.project_id")).toBe(
			projectInstanceContext("wiseley").projectInstanceId,
		);
	});

	it("skips Stripe reversals when BIGINT amount comparison would be unsafe", async () => {
		const unsafeAmount = "9007199254740993";
		const database = new FakeDatabase([
			[{ purchase_id: "purchase-id", customer_id: "customer-id" }],
			[{ id: "customer-id" }],
			[
				{
					purchase_id: "purchase-id",
					customer_id: "customer-id",
					billing_account_id: "user-1",
					store_product_id: "store-product-id",
					product_key: "echo_credits_10",
					purchase_kind: "consumable",
					credit_amount: 10,
					price_amount: unsafeAmount,
					currency: "usd",
				},
			],
			[{ id: "store-event-id" }],
		]);
		const repository = new BillingRepository(database as never);

		await expect(
			repository.recordStripeCreditReversalAndEnqueueProjection(
				projectInstanceContext("wiseley"),
				stripeReversalInput({
					reversalAmount: Number(unsafeAmount),
					rawPayload: { id: "re_unsafe", amount: Number(unsafeAmount) },
				}),
			),
		).resolves.toEqual({
			processingStatus: "skipped",
			billingAccountId: null,
			entitlements: null,
		});

		const queries = database.queries.join("\n");
		expect(queries).toContain("INSERT INTO store_events");
		expect(queries).toContain("Stripe credit reversal amount is invalid for credit reversal");
		expect(queries).not.toContain("UPDATE purchases");
		expect(queries).not.toContain("INSERT INTO projection_sync_jobs");
	});

	it("records skipped Stripe reversal events for invalid original catalog amounts", async () => {
		const database = new FakeDatabase([
			[{ purchase_id: "purchase-id", customer_id: "customer-id" }],
			[{ id: "customer-id" }],
			[
				{
					purchase_id: "purchase-id",
					customer_id: "customer-id",
					billing_account_id: "user-1",
					store_product_id: "store-product-id",
					product_key: "echo_credits_10",
					purchase_kind: "consumable",
					credit_amount: 10,
					price_amount: "not-a-billing-amount",
					currency: "usd",
				},
			],
			[{ id: "store-event-id" }],
		]);
		const repository = new BillingRepository(database as never);

		await expect(
			repository.recordStripeCreditReversalAndEnqueueProjection(
				projectInstanceContext("wiseley"),
				stripeReversalInput(),
			),
		).resolves.toEqual({
			processingStatus: "skipped",
			billingAccountId: null,
			entitlements: null,
		});

		const queries = database.queries.join("\n");
		expect(queries).toContain("INSERT INTO store_events");
		expect(queries).toContain("Stripe original purchase amount is invalid for credit reversal");
		expect(queries).not.toContain("UPDATE purchases");
		expect(queries).not.toContain("INSERT INTO projection_sync_jobs");
	});

	it("processes partial Stripe refunds with tracked reversed money and credit amounts", async () => {
		const database = new FakeDatabase(
			[
				[{ purchase_id: "purchase-id", customer_id: "customer-id" }],
				[{ id: "customer-id" }],
				[
					{
						purchase_id: "purchase-id",
						customer_id: "customer-id",
						billing_account_id: "user-1",
						store_product_id: "store-product-id",
						product_key: "echo_credits_10",
						purchase_kind: "consumable",
						credit_amount: 10,
						price_amount: 499,
						currency: "usd",
						reversed_amount: 0,
						reversed_credit_amount: 0,
					},
				],
				[],
				[{ id: "store-event-id" }],
				[],
				[{ id: "customer-id" }],
				[],
				[{ id: "customer-id" }],
				[{ projection_sequence: 1, billing_account_id: "user-1" }],
				[],
				[{ project_id: "project-id" }],
			],
			{ strict: true },
		);
		const repository = new BillingRepository(database as never);

		await expect(
			repository.recordStripeCreditReversalAndEnqueueProjection(
				projectInstanceContext("wiseley"),
				stripeReversalInput({
					reversalAmount: 250,
					rawPayload: { id: "re_partial", amount: 250 },
				}),
			),
		).resolves.toEqual({
			processingStatus: "processed",
			billingAccountId: "user-1",
			entitlements: {
				billingAccountId: "user-1",
				generatedAt: expect.any(String),
				entitlements: [],
			},
		});

		const queries = database.queries.join("\n");
		expect(queries).toContain("reversed_amount");
		expect(queries).toContain("reversed_credit_amount");
		expect(queries).toContain('\\"creditAmount\\":5');
		expect(queries).toContain('\\"totalCreditAmount\\":10');
		expect(queries).not.toContain("Stripe credit reversal amount or currency does not match");
		const customerLockIndex = database.queries.findIndex(
			(query) => query.includes("SELECT c.id") && query.includes("FOR UPDATE"),
		);
		const purchaseLockIndex = database.queries.findIndex(
			(query) => query.includes("FROM purchases pu") && query.includes("FOR UPDATE OF pu"),
		);
		expect(customerLockIndex).toBeGreaterThan(-1);
		expect(purchaseLockIndex).toBeGreaterThan(customerLockIndex);
		database.assertConsumed();
		expect(database.queries).toHaveLength(12);
	});

	it("records Stripe subscription events without synthetic purchase rows", async () => {
		const database = new FakeDatabase(
			[
				[{ id: "customer-id", billing_account_id: "user-1" }],
				[{ id: "provider-customer-id" }],
				[
					{
						id: "store-product-id",
						product_id: "product-id",
						product_key: "premium_monthly",
						product_type: "subscription",
						credit_amount: 0,
					},
				],
				[],
				[{ id: "store-event-id" }],
				[{ id: "subscription-id" }],
				[],
				[],
				[{ id: "customer-id" }],
				[],
				[{ id: "customer-id" }],
				[
					{
						key: "premium",
						active: true,
						expires_at: new Date("2026-07-01T00:00:00.000Z"),
						metadata: { source: "subscription" },
					},
				],
				[{ project_id: "project-id" }],
				[{ projection_sequence: 1, billing_account_id: "user-1" }],
				[],
				[{ id: "projection-job-id" }],
			],
			{ strict: true },
		);
		const repository = new BillingRepository(database as never);

		await expect(
			repository.recordStripeSubscriptionAndEnqueueProjection(
				projectInstanceContext("wiseley"),
				stripeSubscriptionInput(),
			),
		).resolves.toMatchObject({
			processingStatus: "processed",
			billingAccountId: "user-1",
		});

		database.assertConsumed();
		expect(database.queries).toHaveLength(16);
		const queries = database.queries.join("\n");
		expect(queries).toContain("INSERT INTO subscriptions");
		expect(queries).not.toContain("INSERT INTO purchases");
	});

	it("guards subscription conflict updates with provider ordering and monotonic expiry", async () => {
		const database = new FakeDatabase([
			[{ id: "customer-id", billing_account_id: "user-1" }],
			[{ id: "provider-customer-id" }],
			[
				{
					id: "store-product-id",
					product_id: "product-id",
					product_key: "premium_monthly",
					product_type: "subscription",
					credit_amount: 0,
				},
			],
			[],
			[{ id: "store-event-id" }],
			[{ id: "subscription-id" }],
			[],
			[],
			[{ id: "customer-id" }],
			[],
			[{ id: "customer-id" }],
			[],
			[{ project_id: "project-id" }],
			[{ projection_sequence: 1, billing_account_id: "user-1" }],
			[],
			[{ id: "projection-job-id" }],
		]);
		const repository = new BillingRepository(database as never);

		await repository.recordStripeSubscriptionAndEnqueueProjection(
			projectInstanceContext("wiseley"),
			stripeSubscriptionInput(),
		);

		const queries = database.queries.join("\n");
		expect(queries).toContain(">= subscriptions.last_provider_event_created");
		expect(queries).toContain("GREATEST(subscriptions.expires_at, EXCLUDED.expires_at)");
		expect(queries).toMatch(/ELSE\s+subscriptions\.status\s+END/);
		expect(queries).toMatch(/ELSE\s+subscriptions\.latest_transaction_id\s+END/);
	});
});
