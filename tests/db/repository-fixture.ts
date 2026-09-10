import type {
	RecordPurchaseProjectionInput,
	RecordStripeCreditReversalProjectionInput,
	RecordStripeSubscriptionProjectionInput,
} from "../../src/db/repository";
import { renderDrizzleSql, renderDrizzleSqlParams } from "../helpers/drizzle-sql";

export interface FakeDatabaseOptions {
	strict?: boolean;
}

export class FakeDatabase {
	queries: string[] = [];
	params: unknown[][] = [];
	constructor(
		private readonly responses: Array<Record<string, unknown>[]>,
		private readonly options: FakeDatabaseOptions = {},
	) {}

	async execute(query: { toQuery?: () => { sql: string } } | unknown) {
		this.queries.push(renderDrizzleSql(query));
		this.params.push(renderDrizzleSqlParams(query));
		if (this.options.strict && this.responses.length === 0) {
			throw new Error(`Unscripted query #${this.queries.length}: ${this.queries.at(-1)}`);
		}
		return this.responses.shift() ?? [];
	}

	async transaction<T>(callback: (tx: FakeDatabase) => Promise<T>): Promise<T> {
		return await callback(this);
	}

	assertConsumed(): void {
		if (this.responses.length > 0) {
			throw new Error(`${this.responses.length} scripted responses were not consumed`);
		}
	}

	boundParameter(column: string, queryIndex?: number): unknown {
		const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(String.raw`\b${escaped}\s*=\s*\$(\d+)`);
		const indexes = queryIndex === undefined ? this.queries.map((_, index) => index) : [queryIndex];
		for (const index of indexes) {
			const query = this.queries[index];
			if (query === undefined) {
				continue;
			}
			const match = query.match(pattern);
			if (match === null) {
				continue;
			}
			return this.params[index]?.[Number(match[1]) - 1];
		}
		throw new Error(`bound parameter for ${column} was not found`);
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
