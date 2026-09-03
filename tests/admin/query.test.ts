import { describe, expect, it } from "bun:test";
import {
	decodeAdminCursor,
	encodeAdminCursor,
	parseAdminPagination,
	parseBillingAccountIdParam,
	parseCatalogProductListQuery,
	parseCatalogStoreProductListQuery,
	parseCustomerIdParam,
	parseCustomerProjectionJobListQuery,
	parseCustomerPurchaseListQuery,
	parseCustomerSearchQuery,
	parseCustomerStoreEventListQuery,
	parseCustomerSubscriptionListQuery,
	parseEventIdParam,
	parseProjectionJobListQuery,
	parsePurchaseListQuery,
	parseStoreEventDetailQuery,
	parseStoreEventListQuery,
	parseSubscriptionListQuery,
} from "../../src/admin/query";
import type {
	AdminCatalogStoreProduct,
	AdminCatalogStoreProductPrice,
	AdminEntitlementSnapshotItem,
	AdminListResponse,
	AdminPurchase,
} from "../../src/admin/types";
import { BillingError } from "../../src/billing/errors";

const customerId = "123e4567-e89b-12d3-a456-426614174000";
const eventId = "223e4567-e89b-12d3-a456-426614174000";

describe("admin query parsing", () => {
	it("provides admin list envelope and DTO contracts", () => {
		const response = {
			success: true,
			data: [] as AdminPurchase[],
			pagination: { nextCursor: "next_cursor" },
		} satisfies AdminListResponse<AdminPurchase>;
		const entitlement = {
			key: "premium_access",
			active: true,
			expiresAt: null,
			metadata: { source: "test" },
		} satisfies AdminEntitlementSnapshotItem;
		const price = {
			externalPriceId: "price_123",
			billingPeriod: "monthly",
			currency: "usd",
			priceAmount: 999,
		} satisfies AdminCatalogStoreProductPrice;
		const storeProduct = {
			id: "store-product-id",
			productId: "product-id",
			productKey: "premium",
			provider: "stripe",
			channel: "web",
			externalProductId: "prod_123",
			active: true,
			metadata: {},
			createdAt: "2026-06-01T00:00:00.000Z",
			updatedAt: "2026-06-01T00:00:00.000Z",
			...price,
		} satisfies AdminCatalogStoreProduct;

		expect(response.pagination.nextCursor).toBe("next_cursor");
		expect(entitlement.key).toBe("premium_access");
		expect(storeProduct.priceAmount).toBe(999);
	});

	it("parses UUID route params", () => {
		expect(parseCustomerIdParam(customerId)).toBe(customerId);
		expect(parseEventIdParam(eventId)).toBe(eventId);
		expectInvalidRequest(() => parseCustomerIdParam("not-a-uuid"), "Invalid customer id");
		expectInvalidRequest(() => parseEventIdParam("not-a-uuid"), "Invalid store event id");
	});

	it("parses billing account route params", () => {
		expect(parseBillingAccountIdParam(" account_1 ")).toBe("account_1");
		expectInvalidRequest(() => parseBillingAccountIdParam("   "), "Invalid billing account id");
	});

	it("parses pagination with defaults and limits", () => {
		expect(parseAdminPagination(new URLSearchParams())).toEqual({ limit: 25, cursor: null });
		expect(parseAdminPagination(new URLSearchParams({ limit: "100" })).limit).toBe(100);
		expectInvalidRequest(
			() => parseAdminPagination(new URLSearchParams({ limit: "101" })),
			"Invalid pagination",
		);
		expectInvalidRequest(
			() => parseAdminPagination(new URLSearchParams({ cursor: "not-base64" })),
			"Invalid cursor",
		);
	});

	it("round-trips opaque cursors", () => {
		const cursor = encodeAdminCursor({
			createdAt: "2026-06-01T10:00:00.000Z",
			id: "123e4567-e89b-12d3-a456-426614174000",
		});

		expect(decodeAdminCursor(cursor)).toEqual({
			createdAt: "2026-06-01T10:00:00.000Z",
			id: "123e4567-e89b-12d3-a456-426614174000",
		});
	});

	it("preserves cursor timestamp precision", () => {
		const cursor = encodeAdminCursor({
			createdAt: "2026-06-01T00:00:00.123456Z",
			id: customerId,
		});

		expect(decodeAdminCursor(cursor)).toEqual({
			createdAt: "2026-06-01T00:00:00.123456Z",
			id: customerId,
		});
	});

	it("rejects malformed cursors", () => {
		expectInvalidRequest(() => decodeAdminCursor("not-base64"), "Invalid cursor");
		const validCursor = encodeAdminCursor({
			createdAt: "2026-06-01T10:00:00.000Z",
			id: customerId,
		});
		expectInvalidRequest(() => decodeAdminCursor(`${validCursor}A`), "Invalid cursor");
		expectInvalidRequest(() => decodeAdminCursor(`${validCursor}IA`), "Invalid cursor");
		expectInvalidRequest(() => decodeAdminCursor(`${validCursor}$`), "Invalid cursor");
		expectInvalidRequest(() => decodeAdminCursor(`${validCursor}====`), "Invalid cursor");
		const cursor = encodeAdminCursor({ createdAt: "not-a-date", id: customerId });
		expectInvalidRequest(() => decodeAdminCursor(cursor), "Invalid cursor");
		const overflowDateCursor = encodeAdminCursor({ createdAt: "2026-02-31", id: customerId });
		expectInvalidRequest(() => decodeAdminCursor(overflowDateCursor), "Invalid cursor");
	});

	it("parses customer search queries", () => {
		expect(parseCustomerSearchQuery(new URLSearchParams({ q: " user_1 ", limit: "10" }))).toEqual({
			query: "user_1",
			limit: 10,
			cursor: null,
		});
		expect(parseCustomerSearchQuery(new URLSearchParams({ q: "a".repeat(128) })).query).toBe(
			"a".repeat(128),
		);
		expectInvalidRequest(
			() => parseCustomerSearchQuery(new URLSearchParams()),
			"Customer search query is required",
		);
		expectInvalidRequest(
			() => parseCustomerSearchQuery(new URLSearchParams({ q: "a".repeat(129) })),
			"Customer search query must be 128 characters or less",
		);
		expectInvalidRequest(
			() => parseCustomerSearchQuery(new URLSearchParams({ q: "user_1", cursor: "not-base64" })),
			"Invalid cursor",
		);
	});

	it("parses purchase list filters", () => {
		const cursor = encodeAdminCursor({
			createdAt: "2026-06-01T10:00:00.000Z",
			id: customerId,
		});

		expect(
			parsePurchaseListQuery(
				new URLSearchParams({
					limit: "10",
					cursor: ` ${cursor} `,
					provider: "apple",
					channel: "ios",
					billingAccountId: " user_1 ",
					customerId,
					productKey: " premium ",
					entitlementKey: " premium_access ",
					from: "2026-06-01T10:00:00.000Z",
					to: "2026-06-02T10:00:00.000Z",
					purchaseKind: "consumable",
					status: "refunded",
					transactionId: " tx_1 ",
					orderId: " order_1 ",
				}),
			),
		).toEqual({
			limit: 10,
			cursor,
			provider: "apple",
			channel: "ios",
			billingAccountId: "user_1",
			customerId,
			productKey: "premium",
			entitlementKey: "premium_access",
			from: "2026-06-01T10:00:00.000Z",
			to: "2026-06-02T10:00:00.000Z",
			purchaseKind: "consumable",
			status: "refunded",
			transactionId: "tx_1",
			orderId: "order_1",
		});
		expectInvalidRequest(
			() => parsePurchaseListQuery(new URLSearchParams({ status: "unsupported" })),
			"Invalid purchase filters",
		);
		expectInvalidRequest(
			() => parsePurchaseListQuery(new URLSearchParams({ cursor: "not-base64" })),
			"Invalid cursor",
		);
	});

	it("normalizes list date filters accepted by Date", () => {
		expect(
			parsePurchaseListQuery(
				new URLSearchParams({
					from: "2026-06-01",
					to: "June 2, 2026 12:34:56 UTC",
				}),
			),
		).toMatchObject({
			from: "2026-06-01T00:00:00.000Z",
			to: "2026-06-02T12:34:56.000Z",
		});
		expectInvalidRequest(
			() => parsePurchaseListQuery(new URLSearchParams({ from: "not-a-date" })),
			"Invalid purchase filters",
		);
	});

	it("parses subscription attention filters", () => {
		expect(
			parseSubscriptionListQuery(
				new URLSearchParams({ status: "revoked", needsAttention: "true" }),
			),
		).toMatchObject({
			status: "revoked",
			needsAttention: true,
		});
		expectInvalidRequest(
			() => parseSubscriptionListQuery(new URLSearchParams({ status: "unsupported" })),
			"Invalid subscription filters",
		);
	});

	it("parses store event list filters", () => {
		expect(
			parseStoreEventListQuery(
				new URLSearchParams({
					processingStatus: "failed",
					eventType: " invoice.paid ",
					externalEventId: " evt_1 ",
					customerId,
				}),
			),
		).toEqual({
			limit: 25,
			cursor: null,
			processingStatus: "failed",
			eventType: "invoice.paid",
			externalEventId: "evt_1",
			customerId,
		});
		expectInvalidRequest(
			() => parseStoreEventListQuery(new URLSearchParams({ processingStatus: "done" })),
			"Invalid store event filters",
		);
	});

	it("parses raw payload detail flags", () => {
		expect(parseStoreEventDetailQuery(new URLSearchParams()).includeRawPayload).toBe(false);
		expect(
			parseStoreEventDetailQuery(new URLSearchParams({ includeRawPayload: "true" }))
				.includeRawPayload,
		).toBe(true);
		expectInvalidRequest(
			() => parseStoreEventDetailQuery(new URLSearchParams({ includeRawPayload: "yes" })),
			"Invalid store event detail query",
		);
	});

	it("parses projection job list filters", () => {
		expect(
			parseProjectionJobListQuery(
				new URLSearchParams({
					status: "failed",
					reason: "provider_webhook",
					billingAccountId: " user_1 ",
				}),
			),
		).toEqual({
			limit: 25,
			cursor: null,
			status: "failed",
			reason: "provider_webhook",
			billingAccountId: "user_1",
		});
		expectInvalidRequest(
			() => parseProjectionJobListQuery(new URLSearchParams({ reason: "manual" })),
			"Invalid projection job filters",
		);
	});

	it("parses catalog product list pagination", () => {
		expect(parseCatalogProductListQuery(new URLSearchParams({ limit: "7" }))).toEqual({
			limit: 7,
			cursor: null,
		});
		expectInvalidRequest(
			() => parseCatalogProductListQuery(new URLSearchParams({ limit: "101" })),
			"Invalid pagination",
		);
	});

	it("parses catalog store product list filters", () => {
		expect(
			parseCatalogStoreProductListQuery(
				new URLSearchParams({
					limit: "5",
					provider: "stripe",
					channel: "web",
					productKey: " credits_100 ",
				}),
			),
		).toEqual({
			limit: 5,
			cursor: null,
			provider: "stripe",
			channel: "web",
			productKey: "credits_100",
		});
		expectInvalidRequest(
			() => parseCatalogStoreProductListQuery(new URLSearchParams({ provider: "amazon" })),
			"Invalid store product filters",
		);
		expectInvalidRequest(
			() => parseCatalogStoreProductListQuery(new URLSearchParams({ cursor: "not-base64" })),
			"Invalid cursor",
		);
	});

	it("parses customer-scoped child list filters", () => {
		expect(
			parseCustomerPurchaseListQuery(customerId, new URLSearchParams({ status: "voided" })),
		).toEqual({
			limit: 25,
			cursor: null,
			customerId,
			status: "voided",
		});
		expect(
			parseCustomerSubscriptionListQuery(
				customerId,
				new URLSearchParams({ needsAttention: "false" }),
				"2026-06-02T00:00:00.000Z",
			),
		).toEqual({
			limit: 25,
			cursor: null,
			customerId,
			needsAttention: false,
			staleBefore: "2026-06-02T00:00:00.000Z",
		});
		expect(
			parseCustomerStoreEventListQuery(
				customerId,
				new URLSearchParams({ processingStatus: "processing" }),
			),
		).toEqual({
			limit: 25,
			cursor: null,
			customerId,
			processingStatus: "processing",
		});
		expect(
			parseCustomerProjectionJobListQuery(customerId, new URLSearchParams({ status: "succeeded" })),
		).toEqual({
			limit: 25,
			cursor: null,
			customerId,
			status: "succeeded",
		});
		expectInvalidRequest(
			() => parseCustomerPurchaseListQuery("not-a-uuid", new URLSearchParams()),
			"Invalid customer id",
		);
		expectInvalidRequest(
			() =>
				parseCustomerProjectionJobListQuery(customerId, new URLSearchParams({ status: "done" })),
			"Invalid projection job filters",
		);
	});

	it("rejects duplicate query parameters with parser-specific errors", () => {
		expectInvalidRequest(
			() => parseAdminPagination(new URLSearchParams("limit=10&limit=20")),
			"Invalid pagination",
		);
		expectInvalidRequest(
			() => parseSubscriptionListQuery(new URLSearchParams("status=active&status=revoked")),
			"Invalid subscription filters",
		);
		expectInvalidRequest(
			() =>
				parseSubscriptionListQuery(new URLSearchParams("needsAttention=true&needsAttention=false")),
			"Invalid subscription filters",
		);
		expectInvalidRequest(
			() =>
				parseStoreEventDetailQuery(
					new URLSearchParams("includeRawPayload=true&includeRawPayload=false"),
				),
			"Invalid store event detail query",
		);
		expectInvalidRequest(
			() =>
				parsePurchaseListQuery(
					new URLSearchParams(`customerId=${customerId}&customerId=${customerId}`),
				),
			"Invalid purchase filters",
		);
	});
});

function expectInvalidRequest(fn: () => unknown, message: string) {
	let thrown: unknown;
	try {
		fn();
	} catch (error) {
		thrown = error;
	}

	expect(thrown).toBeInstanceOf(BillingError);
	if (!(thrown instanceof BillingError)) {
		throw new Error("Expected BillingError");
	}
	expect(thrown.message).toBe(message);
	expect(thrown.code).toBe("INVALID_REQUEST");
	expect(thrown.status).toBe(400);
}
