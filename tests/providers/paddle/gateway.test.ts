import { describe, expect, it } from "bun:test";
import { PaddleClient, type PaddleFetch } from "../../../src/providers/paddle/client";
import {
	paddleRequiredEvents,
	validatePaddleConnection,
} from "../../../src/providers/paddle/connection";
import { assertPaddleCustomer, PaddleGateway } from "../../../src/providers/paddle/gateway";
import { binding, config, correlation, id, price, subscription, transaction } from "./fixtures";

function client(fetcher: PaddleFetch) {
	return new PaddleClient(config, fetcher, Date.now, { get: () => 0, set: () => {} });
}
const recover = { customerId: id("ctm"), correlation, bindings: [binding] };
const page = (data: unknown[], pagination = { has_more: false, next: null as string | null }) =>
	Response.json({ data, meta: { pagination } });

describe("Paddle gateway", () => {
	it("reports a price read that Paddle rate limits or cannot answer as retryable, not as a bad catalog", async () => {
		const fixed = { ...binding, quantity: 1 };
		const limited = new PaddleGateway(
			client(async () =>
				Response.json(
					{ error: { code: "too_many_requests" } },
					{ status: 429, headers: { "retry-after": "3" } },
				),
			),
			config,
		);
		await expect(limited.validatePrices([fixed], true)).rejects.toMatchObject({
			code: "BILLING_PROVIDER_UNAVAILABLE",
			status: 503,
			details: { retryAfterSeconds: 3 },
		});
		const down = new PaddleGateway(
			client(async () =>
				Response.json({ error: { code: "service_unavailable" } }, { status: 503 }),
			),
			config,
		);
		await expect(down.validatePrices([fixed], true)).rejects.toMatchObject({
			code: "BILLING_PROVIDER_UNAVAILABLE",
			status: 503,
		});
		const missing = new PaddleGateway(
			client(async () => Response.json({ error: { code: "not_found" } }, { status: 404 })),
			config,
		);
		await expect(missing.validatePrices([fixed], true)).rejects.toMatchObject({
			status: 404,
			code: "not_found",
		});
	});
	it("requires quantity-locked, trial-free prices in the qualified checkout", async () => {
		const fixed = { ...binding, quantity: 1 };
		for (const remote of [
			price,
			{
				...price,
				quantity: { minimum: 1, maximum: 1 },
				trial_period: { interval: "day", frequency: 7 },
			},
		]) {
			const gateway = new PaddleGateway(
				client(async () => Response.json({ data: remote })),
				config,
			);
			await expect(gateway.validatePrices([fixed], true)).rejects.toBeInstanceOf(Error);
		}
		const gateway = new PaddleGateway(
			client(async () =>
				Response.json({ data: { ...price, quantity: { minimum: 1, maximum: 1 } } }),
			),
			config,
		);
		await expect(gateway.validatePrices([fixed], true)).resolves.toBeUndefined();
	});

	it("does not confuse inherited checkout correlation on a renewal with the original create", async () => {
		const gateway = new PaddleGateway(
			client(async (url) => {
				expect(new URL(String(url)).searchParams.get("origin")).toBe("api");
				return page([
					transaction,
					{ ...transaction, id: id("txn", "b"), origin: "subscription_recurring" },
				]);
			}),
			config,
		);
		expect(await gateway.recoverCheckout(recover)).toMatchObject({
			status: "succeeded",
			transaction: { id: transaction.id },
		});
	});
	it("recovers a lost checkout response by correlation across every page without writing", async () => {
		let calls = 0;
		const gateway = new PaddleGateway(
			client(async (url, init) => {
				expect(init?.method).toBe("GET");
				const parsed = new URL(String(url));
				expect(parsed.searchParams.get("customer_id")).toBe(id("ctm"));
				calls++;
				if (calls === 1)
					return page([{ ...transaction, custom_data: null }], {
						has_more: true,
						next: `https://sandbox-api.paddle.com/transactions?after=${id("txn", "b")}`,
					});
				expect(parsed.searchParams.get("after")).toBe(id("txn", "b"));
				return page([transaction]);
			}),
			config,
		);
		expect(await gateway.recoverCheckout(recover)).toMatchObject({
			status: "succeeded",
			transaction: { id: transaction.id },
		});
		expect(calls).toBe(2);
	});
	it("keeps absent, mismatched and ambiguous writes in review instead of allowing a retry", async () => {
		for (const [data, reason] of [
			[[], "not_found"],
			[[transaction, { ...transaction, id: id("txn", "b") }], "ambiguous"],
			[
				[
					{
						...transaction,
						custom_data: { quotum: { ...correlation, requestHash: "b".repeat(64) } },
					},
				],
				"mismatch",
			],
			[[{ ...transaction, details: { ...transaction.details, line_items: [] } }], "mismatch"],
		] as const) {
			const gateway = new PaddleGateway(
				client(async () => page([...data])),
				config,
			);
			expect(await gateway.recoverCheckout(recover)).toEqual({ status: "requires_review", reason });
		}
	});
	it("rejects incomplete, foreign and looping pagination and foreign customer objects", async () => {
		for (const response of [
			() => Response.json({ data: [] }),
			() =>
				page([], {
					has_more: true,
					next: `https://attacker.example/transactions?after=${id("txn")}`,
				}),
			() =>
				page([], {
					has_more: true,
					next: `https://sandbox-api.paddle.com/transactions?after=${id("txn")}`,
				}),
			() => page([{ ...transaction, customer_id: id("ctm", "b") }]),
		]) {
			const gateway = new PaddleGateway(
				client(async () => response()),
				config,
			);
			await expect(gateway.recoverCheckout(recover)).rejects.toThrow();
		}
	});
	it("bounds reconciliation scans", async () => {
		let calls = 0;
		const gateway = new PaddleGateway(
			client(async () => {
				calls++;
				return page([], {
					has_more: true,
					next: `https://sandbox-api.paddle.com/transactions?after=txn_${String(calls).padStart(26, "0")}`,
				});
			}),
			config,
		);
		expect(await gateway.recoverCheckout(recover)).toEqual({
			status: "requires_review",
			reason: "scan_limit",
		});
		expect(calls).toBe(100);
	});
	it("checks catalog prices and returned resource identities", async () => {
		const gateway = new PaddleGateway(
			client(async (url) =>
				Response.json({
					data: String(url).includes("/prices/")
						? price
						: String(url).includes("/subscriptions/")
							? subscription
							: transaction,
				}),
			),
			config,
		);
		await gateway.validatePrices([binding]);
		expect(await gateway.subscription(subscription.id)).toEqual(subscription);
		expect(await gateway.transaction(transaction.id)).toEqual(transaction);
		await expect(gateway.subscription(id("sub", "b"))).rejects.toThrow("different subscription");
		await expect(gateway.transaction(id("txn", "b"))).rejects.toThrow("different transaction");
		expect(() => assertPaddleCustomer(id("ctm"), id("ctm", "b"))).toThrow("another customer");
	});
	it("returns only the configured merchant checkout page and transaction", () => {
		const gateway = new PaddleGateway(
			client(async () => page([])),
			config,
		);
		expect(gateway.checkoutResult(transaction)).toEqual({
			sessionId: transaction.id,
			url: transaction.checkout?.url as string,
		});
		for (const checkout of [
			null,
			{ url: null },
			{ url: "https://attacker.example" },
			{ url: `${config.paymentPageUrl}?_ptxn=${id("txn", "b")}` },
		]) {
			expect(() => gateway.checkoutResult({ ...transaction, checkout })).toThrow();
		}
	});
	it("creates short-lived portal links without storing them and pins their destination", async () => {
		const url = "https://sandbox-customer-portal.paddle.com/cpl_test?token=test";
		const gateway = new PaddleGateway(
			client(async (path, init) => {
				expect(String(path)).toEndWith(`/customers/${id("ctm")}/portal-sessions`);
				expect(init?.method).toBe("POST");
				return Response.json({
					data: { customer_id: id("ctm"), urls: { general: { overview: url } } },
				});
			}),
			config,
		);
		expect(await gateway.portal(id("ctm"))).toEqual({ url });
		const foreign = new PaddleGateway(
			client(async () =>
				Response.json({
					data: { customer_id: id("ctm", "b"), urls: { general: { overview: url } } },
				}),
			),
			config,
		);
		await expect(foreign.portal(id("ctm"))).rejects.toThrow("invalid portal");
	});
	it("dispatches a prepared command exactly once", async () => {
		let calls = 0;
		const gateway = new PaddleGateway(
			client(async (_url, init) => {
				calls++;
				expect(init?.body).toBe(JSON.stringify({ scheduled_change: null }));
				return Response.json({ data: subscription });
			}),
			config,
		);
		expect(
			await gateway.dispatch({
				method: "PATCH",
				path: `/subscriptions/${subscription.id}`,
				body: { scheduled_change: null },
			}),
		).toEqual(subscription);
		expect(calls).toBe(1);
	});
});

describe("Paddle connection proof", () => {
	const webhookUrl = "https://billing.example/v1/webhooks/paddle/acme";
	const setting = {
		id: config.notificationSettingId,
		type: "url",
		active: true,
		api_version: 1,
		destination: webhookUrl,
		endpoint_secret_key: config.webhookSecret,
		traffic_source: "platform",
		subscribed_events: paddleRequiredEvents.map((name) => ({ name })),
	};
	it("pins credentials, webhook secret and destination to one seller-owned notification setting", async () => {
		expect(
			await validatePaddleConnection({
				config,
				webhookUrl,
				client: client(async () => Response.json({ data: setting })),
			}),
		).toEqual({ accountAnchor: `paddle:sandbox:${setting.id}`, notificationSettingId: setting.id });
	});
	it("rejects wrong secrets, destinations, IDs, simulation-only delivery and missing events", async () => {
		for (const changed of [
			{ ...setting, endpoint_secret_key: "different_secret" },
			{ ...setting, destination: "https://another.example" },
			{ ...setting, id: id("ntfset", "b") },
			{ ...setting, traffic_source: "simulation" },
			{ ...setting, active: false },
			{ ...setting, subscribed_events: [] },
			{ ...setting, api_version: 2 },
		])
			await expect(
				validatePaddleConnection({
					config,
					webhookUrl,
					client: client(async () => Response.json({ data: changed })),
				}),
			).rejects.toMatchObject({ code: "PADDLE_CONNECTION_INVALID" });
	});
});
