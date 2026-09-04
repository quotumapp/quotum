import { describe, expect, it } from "bun:test";
import { BillingRepository } from "../../src/db/repository";
import { projectInstanceContext } from "../helpers/project-context";
import { FakeDatabase } from "./repository-fixture";

describe("BillingRepository Google", () => {
	it("matches Google voided purchase targets by purchase token only", async () => {
		const database = new FakeDatabase([[], [], [{ id: "store-event-id" }]]);
		const repository = new BillingRepository(database as never);

		await repository.recordGoogleVoidedPurchaseAndEnqueueProjection(
			projectInstanceContext("wiseley"),
			{
				purchaseToken: "purchase-token-mismatch",
				orderId: "GPA.1111-2222-3333-44444",
				refundType: 1,
				quantity: 1,
				refundableQuantity: 0,
				eventTime: new Date("2026-05-31T00:00:00.000Z"),
				rawPayload: {
					voidedPurchaseNotification: {
						purchaseToken: "purchase-token-mismatch",
						orderId: "GPA.1111-2222-3333-44444",
					},
				},
				eventType: "VOIDED_PURCHASE",
				externalEventId:
					"google:voided:purchase-token-mismatch:1780185600000:1:1:GPA.1111-2222-3333-44444",
				projectionReason: "provider_webhook",
				projectionIdempotencyKey:
					"google:voided:purchase-token-mismatch:1780185600000:1:1:GPA.1111-2222-3333-44444:projection",
			},
		);

		const queries = database.queries.join("\n");
		expect(queries).toMatch(/pu\.transaction_id = \$\d+/);
		expect(queries).toMatch(/s\.external_subscription_id = \$\d+/);
		expect(queries).not.toContain("raw_payload->>'orderId'");
		expect(queries).not.toContain("raw_payload->>'latestOrderId'");
		expect(queries).not.toContain("s.latest_transaction_id =");
	});
});
