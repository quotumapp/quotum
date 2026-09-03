import type {
	RecordPurchaseProjectionInput,
	RecordStripeCreditReversalProjectionInput,
	RecordStripeSubscriptionProjectionInput,
} from "../../src/db/repository";
import { renderDrizzleSql, renderDrizzleSqlParams } from "../helpers/drizzle-sql";

export class FakeDatabase {
	queries: string[] = [];
	params: unknown[][] = [];
	constructor(private readonly responses: Array<Record<string, unknown>[]>) {}

	async execute(query: { toQuery?: () => { sql: string } } | unknown) {
		this.queries.push(renderDrizzleSql(query));
		this.params.push(renderDrizzleSqlParams(query));
		return this.responses.shift() ?? [];
	}

	async transaction<T>(callback: (tx: FakeDatabase) => Promise<T>): Promise<T> {
		return await callback(this);
	}
}

export function stripeReversalInput(
	overrides: Partial<RecordStripeCreditReversalProjectionInput> = {},
): RecordStripeCreditReversalProjectionInput {
	return {
		reversalReason: "refund",
		reversalId: "re_unsafe",
		reversalAmount: 499,
		reversalCurrency: "usd",
		paymentIntentId: "pi_unsafe",
		chargeId: "ch_unsafe",
		reversedAt: new Date("2026-01-01T00:00:00.000Z"),
		rawPayload: { id: "re_unsafe", amount: 499 },
		eventType: "refund.created",
		externalEventId: "evt_refund_unsafe",
		projectionIdempotencyKey: "stripe:refund:re_unsafe:reversal",
		...overrides,
	};
}

export function stripeSubscriptionInput(
	overrides: Partial<RecordStripeSubscriptionProjectionInput> = {},
): RecordStripeSubscriptionProjectionInput {
	return {
		billingAccountId: "user-1",
		stripeCustomerId: "cus_123",
		stripeSubscriptionId: "sub_123",
		invoiceId: "in_123",
		externalProductId: "prod_premium",
		externalPriceId: "price_premium_monthly",
		subscriptionStatus: "active",
		purchasedAt: new Date("2026-06-01T00:00:00.000Z"),
		startsAt: new Date("2026-06-01T00:00:00.000Z"),
		expiresAt: new Date("2026-07-01T00:00:00.000Z"),
		autoRenew: true,
		rawPayload: { id: "sub_123" },
		eventType: "invoice.paid",
		externalEventId: "evt_invoice",
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: "stripe:invoice:in_123:invoice.paid:evt_invoice:projection",
		...overrides,
	};
}

export function purchaseProjectionInput(
	overrides: Partial<RecordPurchaseProjectionInput> = {},
): RecordPurchaseProjectionInput {
	return {
		billingAccountId: "user-1",
		provider: "apple",
		channel: "ios",
		storeProductId: "store-product-id",
		purchaseKind: "non_consumable",
		transactionId: "txn_123",
		originalTransactionId: null,
		status: "completed",
		purchasedAt: new Date("2026-06-01T00:00:00.000Z"),
		rawPayload: { id: "txn_123" },
		eventType: "purchase_verified",
		externalEventId: "evt_purchase",
		projectionReason: "purchase_verified",
		projectionIdempotencyKey: "apple:txn_123:purchase_verified",
		...overrides,
	};
}
