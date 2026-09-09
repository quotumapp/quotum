import { describe, expect, it } from "bun:test";
import { BillingRepository } from "../../src/db/repository";
import { projectInstanceContext } from "../helpers/project-context";
import { FakeDatabase, purchaseProjectionInput } from "./repository-fixture";

describe("BillingRepository mutations", () => {
	it("guards purchase conflict updates against terminal status regressions", async () => {
		const database = new FakeDatabase([
			[{ id: "customer-id", billing_account_id: "user-1" }],
			[
				{
					id: "store-product-id",
					product_id: "product-id",
					product_key: "lifetime_unlock",
					product_type: "non_consumable",
					credit_amount: 0,
				},
			],
			[{ id: "store-event-id" }],
			[{ id: "purchase-id" }],
			[{ id: "customer-id" }],
			[],
			[{ id: "customer-id" }],
			[{ projection_sequence: 1, billing_account_id: "user-1" }],
			[],
			[{ project_id: "project-id" }],
			[{ id: "projection-job-id" }],
		]);
		const repository = new BillingRepository(database as never);

		await repository.recordPurchaseAndEnqueueProjection(
			projectInstanceContext("wiseley"),
			purchaseProjectionInput(),
		);

		const queries = database.queries.join("\n");
		expect(queries).toContain("purchases.status = 'completed' AND EXCLUDED.status <> 'completed'");
		expect(queries).toMatch(/EXCLUDED\.status = 'completed'\s+AND purchases\.status = 'completed'/);
		expect(queries).toContain("GREATEST(purchases.purchased_at, EXCLUDED.purchased_at)");
		expect(queries).toMatch(/ELSE\s+purchases\.status\s+END/);
		expect(queries).toMatch(/ELSE\s+purchases\.invalidated_at\s+END/);
	});

	it("deduplicates null external store events with a stable fingerprint", async () => {
		const database = new FakeDatabase([[{ id: "store-event-id" }]]);
		const repository = new BillingRepository(database as never);

		await expect(
			repository.recordStripeSkippedEvent(projectInstanceContext("wiseley"), {
				eventType: "checkout.session.completed",
				externalEventId: null,
				transactionId: "pi_null_event",
				purchaseKind: "consumable",
				processingError: "Stripe customer could not be resolved for credit purchase",
				rawPayload: {
					id: "cs_null_event",
					data: { object: { id: "cs_null_event", payment_intent: "pi_null_event" } },
				},
			}),
		).resolves.toEqual({
			processingStatus: "skipped",
			billingAccountId: null,
			entitlements: null,
		});

		const queries = database.queries.join("\n");
		expect(queries).toContain("event_fingerprint");
		expect(queries).toContain(
			"ON CONFLICT (project_id, provider, event_fingerprint) WHERE external_event_id IS NULL AND event_fingerprint IS NOT NULL DO UPDATE",
		);
	});

	it("does not update processing store events through external event conflict handling", async () => {
		const database = new FakeDatabase([[{ id: "store-event-id" }]]);
		const repository = new BillingRepository(database as never);

		await repository.recordStripeSkippedEvent(projectInstanceContext("wiseley"), {
			eventType: "checkout.session.completed",
			externalEventId: "evt_processing_duplicate",
			transactionId: "pi_processing_duplicate",
			purchaseKind: "consumable",
			processingError: "Stripe customer could not be resolved for credit purchase",
			rawPayload: { id: "evt_processing_duplicate" },
		});

		const queries = database.queries.join("\n");
		expect(queries).toContain("store_events.processing_status IN ('pending', 'skipped', 'failed')");
		expect(queries).not.toContain(
			"WHERE store_events.processing_status IN ('pending', 'processing', 'skipped', 'failed')",
		);
	});
});
