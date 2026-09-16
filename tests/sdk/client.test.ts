import { describe, expect, it } from "bun:test";
import { BillingClient } from "../../src/sdk/client";

describe("BillingClient", () => {
	it("looks up recovery with encoded account/operation IDs and no replacement mutation", async () => {
		const calls: Request[] = [];
		const expected = {
			operation: "consume",
			operationId: "job/1?retry#stable",
			status: "processing",
			completedAt: null,
			outcome: null,
		} as const;
		const client = new BillingClient({
			baseUrl: "https://billing.example.com",
			apiKey: "project-secret",
			fetch: async (input, init) => {
				calls.push(new Request(input, init));
				return Response.json({ success: true, data: expected });
			},
		});
		expect(
			await client.usage.getOperation({
				billingAccountId: "account/one",
				operation: "consume",
				operationId: expected.operationId,
			}),
		).toEqual(expected);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url).toBe(
			"https://billing.example.com/v1/billing-accounts/account%2Fone/usage/operations/consume/job%2F1%3Fretry%23stable",
		);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer project-secret");
		expect(calls[0]?.headers.has("idempotency-key")).toBe(false);
	});
	it("keeps credentials in backend requests and returns typed commercial previews", async () => {
		const calls: Request[] = [];
		const client = new BillingClient({
			baseUrl: "https://billing.example.com/",
			apiKey: "project-secret",
			fetch: async (input, init) => {
				const request = new Request(input, init);
				calls.push(request);
				return Response.json({
					success: true,
					data: {
						schemaVersion: 1,
						previewToken: "11111111-1111-4111-8111-111111111111",
					},
				});
			},
		});
		const preview = await client.commercial.preview("account 1", {
			kind: "checkout_product",
			productKey: "credits_100",
		});
		expect(preview.previewToken).toBe("11111111-1111-4111-8111-111111111111");
		expect(calls[0]?.url).toBe(
			"https://billing.example.com/v1/billing-accounts/account%201/commercial-actions/preview",
		);
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer project-secret");
		expect(calls[0]?.headers.get("content-type")).toBe("application/json");
	});

	it("adds operator identity for catalog publication and surfaces typed API errors", async () => {
		const client = new BillingClient({
			baseUrl: "https://billing.example.com",
			apiKey: "project-secret",
			operatorKey: "operator-secret",
			actor: "deploy@example.com",
			fetch: async (_input, init) => {
				const headers = new Headers(init?.headers);
				expect(headers.get("x-billing-operator-key")).toBe("operator-secret");
				expect(headers.get("x-billing-actor")).toBe("deploy@example.com");
				return Response.json(
					{ success: false, error: { code: "CATALOG_REVISION_CONFLICT", message: "stale" } },
					{ status: 409 },
				);
			},
		});
		await expect(client.catalog.status()).rejects.toEqual(
			expect.objectContaining({
				code: "CATALOG_REVISION_CONFLICT",
				status: 409,
			}),
		);
	});

	it("covers reservation lifecycles and native purchase verification with caller-owned keys", async () => {
		const calls: Request[] = [];
		const client = new BillingClient({
			baseUrl: "https://billing.example.com",
			apiKey: "project-secret",
			fetch: async (input, init) => {
				calls.push(new Request(input, init));
				return Response.json({ success: true, data: {} });
			},
		});
		await client.usage.reserve(
			{
				billingAccountId: "account_1",
				featureKey: "model_tokens",
				quantity: "100",
				expiresInSeconds: 300,
			},
			"reserve:job:1",
		);
		await client.usage.confirm(
			{
				billingAccountId: "account_1",
				reservationId: "11111111-1111-4111-8111-111111111111",
				quantity: "80",
			},
			"confirm:job:1",
		);
		await client.usage.release(
			{
				billingAccountId: "account_1",
				reservationId: "22222222-2222-4222-8222-222222222222",
			},
			"release:job:2",
		);
		await client.purchases.verify({
			provider: "google",
			billingAccountId: "account_1",
			purchaseKind: "consumable",
			purchaseToken: "purchase-token",
			productId: "credits_100",
		});

		expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
			"/v1/billing-accounts/account_1/usage/reservations",
			"/v1/billing-accounts/account_1/usage/reservations/11111111-1111-4111-8111-111111111111/confirm",
			"/v1/billing-accounts/account_1/usage/reservations/22222222-2222-4222-8222-222222222222/release",
			"/v1/purchases/verify",
		]);
		expect(calls.slice(0, 3).map((call) => call.headers.get("idempotency-key"))).toEqual([
			"reserve:job:1",
			"confirm:job:1",
			"release:job:2",
		]);
		expect(await calls[0]?.json()).toEqual({
			featureKey: "model_tokens",
			quantity: "100",
			expiresInSeconds: 300,
		});
		expect(await calls[3]?.json()).toMatchObject({
			provider: "google",
			purchaseToken: "purchase-token",
		});
	});

	it("serializes commercial execution and bounded usage insight queries exactly", async () => {
		const calls: Request[] = [];
		const client = new BillingClient({
			baseUrl: "https://billing.example.com",
			apiKey: "project-secret",
			fetch: async (input, init) => {
				const request = new Request(input, init);
				calls.push(request);
				if (new URL(request.url).pathname.endsWith("/usage/events")) {
					return Response.json({
						success: true,
						data: [],
						pagination: { nextCursor: "next-page" },
					});
				}
				return Response.json({ success: true, data: {} });
			},
		});

		await client.commercial.execute(
			"account/one",
			"11111111-1111-4111-8111-111111111111",
			"commercial:change:1",
		);
		const page = await client.usage.events("account/one", {
			featureKey: "model tokens",
			operation: "correction",
			from: "2026-08-01T00:00:00.000Z",
			to: "2026-08-30T00:00:00.000Z",
			limit: 25,
			cursor: "opaque-cursor",
		});
		await client.usage.series("account/one", {
			featureKey: "model tokens",
			interval: "hour",
		});
		await client.usage.summary("account/one");

		expect(calls[0]?.headers.get("idempotency-key")).toBe("commercial:change:1");
		expect(await calls[0]?.json()).toEqual({
			previewToken: "11111111-1111-4111-8111-111111111111",
		});
		expect(new URL(calls[1]?.url ?? "").pathname).toBe(
			"/v1/billing-accounts/account%2Fone/usage/events",
		);
		expect(new URL(calls[1]?.url ?? "").searchParams.toString()).toBe(
			"featureKey=model+tokens&operation=correction&from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-30T00%3A00%3A00.000Z&limit=25&cursor=opaque-cursor",
		);
		expect(new URL(calls[2]?.url ?? "").searchParams.toString()).toBe(
			"featureKey=model+tokens&interval=hour",
		);
		expect(new URL(calls[3]?.url ?? "").pathname).toBe(
			"/v1/billing-accounts/account%2Fone/billing-summary",
		);
		expect(page).toEqual({ data: [], nextCursor: "next-page" });
	});

	it("manages promotions with operator identity and validates codes with project credentials", async () => {
		const calls: Request[] = [];
		const client = new BillingClient({
			baseUrl: "https://billing.example.com",
			apiKey: "project-secret",
			operatorKey: "operator-secret",
			actor: "growth@example.com",
			fetch: async (input, init) => {
				const request = new Request(input, init);
				calls.push(request);
				return new URL(request.url).pathname.endsWith("/codes") && request.method === "GET"
					? Response.json({ success: true, data: [], pagination: { nextCursor: "next" } })
					: Response.json({ success: true, data: {} });
			},
		});

		await client.promotions.create({
			key: "spring/sale",
			name: "Spring sale",
			effect: {
				kind: "discount",
				discount: { type: "percent", percentOffBps: 2000, duration: "once", durationMonths: null },
			},
			codes: [{ code: "SPRING" }],
		});
		const codes = await client.promotions.listCodes("spring/sale", { active: true, limit: 10 });
		await client.promotions.deactivateCode("spring/sale", "22222222-2222-4222-8222-222222222222");
		await client.promotions.archive("spring/sale");
		await client.promotions.validate("account 1", { code: "SPRING", channel: "web" });

		expect(codes).toEqual({ data: [], nextCursor: "next" });
		expect(
			calls.map(
				(call) => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`,
			),
		).toEqual([
			"POST /v1/admin/promotions",
			"GET /v1/admin/promotions/spring%2Fsale/codes?active=true&limit=10",
			"POST /v1/admin/promotions/spring%2Fsale/codes/22222222-2222-4222-8222-222222222222/deactivate",
			"POST /v1/admin/promotions/spring%2Fsale/archive",
			"POST /v1/billing-accounts/account%201/promotion-codes/validate",
		]);
		for (const call of calls.slice(0, 4)) {
			expect(call.headers.get("x-billing-operator-key")).toBe("operator-secret");
			expect(call.headers.get("x-billing-actor")).toBe("growth@example.com");
		}
		expect(calls[4]?.headers.has("x-billing-operator-key")).toBe(false);
		expect(await calls[4]?.json()).toEqual({ code: "SPRING", channel: "web" });
	});

	it("redeems codes, reads the account ledger and revokes redemptions", async () => {
		const calls: Request[] = [];
		const client = new BillingClient({
			baseUrl: "https://billing.example.com",
			apiKey: "project-secret",
			operatorKey: "operator-secret",
			actor: "support@example.com",
			fetch: async (input, init) => {
				const request = new Request(input, init);
				calls.push(request);
				return request.method === "GET"
					? Response.json({ success: true, data: [], pagination: { nextCursor: null } })
					: Response.json({ success: true, data: {} });
			},
		});

		await client.promotions.redeem("account 1", { code: "LAUNCH", channel: "android" }, "redeem-1");
		const page = await client.promotions.accountRedemptions("account 1", { limit: 5 });
		await client.promotions.revokeRedemption(
			"33333333-3333-4333-8333-333333333333",
			"Fraudulent signup",
			"revoke-1",
		);

		expect(page).toEqual({ data: [], nextCursor: null });
		expect(
			calls.map(
				(call) => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`,
			),
		).toEqual([
			"POST /v1/billing-accounts/account%201/promotion-redemptions",
			"GET /v1/billing-accounts/account%201/promotion-redemptions?limit=5",
			"POST /v1/admin/promotion-redemptions/33333333-3333-4333-8333-333333333333/revoke",
		]);
		expect(calls[0]?.headers.get("idempotency-key")).toBe("redeem-1");
		expect(calls[0]?.headers.has("x-billing-operator-key")).toBe(false);
		expect(await calls[0]?.json()).toEqual({ code: "LAUNCH", channel: "android" });
		expect(calls[2]?.headers.get("idempotency-key")).toBe("revoke-1");
		expect(calls[2]?.headers.get("x-billing-operator-key")).toBe("operator-secret");
		expect(await calls[2]?.json()).toEqual({ reason: "Fraudulent signup" });
	});

	it("uses the reviewed catalog body for preview and publication", async () => {
		const calls: Request[] = [];
		const catalog = { features: [], plans: [], topups: [], rateCards: [] };
		const client = new BillingClient({
			baseUrl: "https://billing.example.com",
			apiKey: "project-secret",
			operatorKey: "operator-secret",
			actor: "release@example.com",
			fetch: async (input, init) => {
				const request = new Request(input, init);
				calls.push(request);
				return Response.json({ success: true, data: {} });
			},
		});

		await client.catalog.preview({ expectedRevision: 7, catalog });
		await client.catalog.publish({
			expectedRevision: 7,
			previewToken: "preview-token",
			catalog,
		});

		expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
			"/v1/admin/catalog/preview",
			"/v1/admin/catalog/publish",
		]);
		expect(await calls[0]?.json()).toEqual({ expectedRevision: 7, catalog });
		expect(await calls[1]?.json()).toEqual({
			expectedRevision: 7,
			previewToken: "preview-token",
			catalog,
		});
		for (const call of calls) {
			expect(call.headers.get("x-billing-operator-key")).toBe("operator-secret");
			expect(call.headers.get("x-billing-actor")).toBe("release@example.com");
		}
	});
});
