import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { createApp } from "../../src/app";
import type { StoreEventReplayJobRow } from "../../src/db/repository";
import { PaddleClient } from "../../src/providers/paddle/client";
import type { PaddleSubscription } from "../../src/providers/paddle/schemas";
import { PaddleBillingService } from "../../src/providers/paddle/service";
import { testRequest, withOpenApiAssertions } from "../helpers/openapi";
import { config, id, price, subscription, transaction } from "../providers/paddle/fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import {
	integrationProjectCredential,
	integrationProjectReadOnlyCredential,
} from "./helpers/platform-fixture";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let project: ReturnType<typeof integrationProjectContext>;
const accountIdentity = `paddle:sandbox:${config.notificationSettingId}`;
const unique = (prefix: string) =>
	`${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`;

localDescribe("Paddle fixed subscription persistence", () => {
	let context: LocalPostgresContext;
	beforeAll(async () => {
		context = await createLocalPostgresContext();
		project = integrationProjectContext("acme-sandbox");
		await context.sql`INSERT INTO products(project_id,key,entitlement_key,credit_amount,name,type,active)
			VALUES(${project.projectInstanceId},'paddle_test','paddle_access',0,'Paddle test','subscription',true)`;
		await context.sql`INSERT INTO store_products(project_id,product_id,provider,channel,external_product_id,external_price_id,billing_period,currency,price_amount,active)
			SELECT ${project.projectInstanceId},id,'paddle','web',${price.product_id},${price.id},'month','USD',1000,true
			FROM products WHERE project_id=${project.projectInstanceId} AND key='paddle_test'`;
	});
	afterAll(async () => {
		await context.sql.close();
	});

	function harness() {
		const billingAccountId = unique("account");
		const customerId = unique("ctm");
		const configWithIdentity = { ...config, accountIdentity, versionId: crypto.randomUUID() };
		let remote = {
			...transaction,
			id: unique("txn"),
			customer_id: customerId,
			details: {
				...transaction.details,
				line_items: transaction.details.line_items.map((item) => ({ ...item, quantity: 1 })),
			},
		};
		const startsAt = new Date(Date.now() - 60_000).toISOString();
		const endsAt = new Date(Date.now() + 30 * 86400_000).toISOString();
		let current: PaddleSubscription = {
			...subscription,
			started_at: startsAt,
			updated_at: startsAt,
			current_billing_period: { starts_at: startsAt, ends_at: endsAt },
			id: unique("sub"),
			customer_id: customerId,
			items: subscription.items.map((item) => ({ ...item, quantity: 1 })),
		};
		let customer: Record<string, unknown> | null = null;
		let customerWrites = 0;
		let loseCustomer = false;
		let writes = 0;
		let discardResponse = false;
		const client = new PaddleClient(config, async (url, init) => {
			const path = new URL(String(url)).pathname;
			const body = init?.body ? JSON.parse(String(init.body)) : {};
			if (path.startsWith("/prices/"))
				return Response.json({ data: { ...price, quantity: { minimum: 1, maximum: 1 } } });
			if (path === "/customers" && init?.method === "POST") {
				customerWrites++;
				customer = {
					id: customerId,
					email: body.email,
					status: "active",
					custom_data: body.custom_data,
				};
				if (loseCustomer) throw new Error("Customer response lost");
				return Response.json({ data: customer });
			}
			if (path === "/customers")
				return Response.json({
					data: customer ? [customer] : [],
					meta: { pagination: { has_more: false } },
				});
			if (path === "/transactions" && init?.method === "POST") {
				writes++;
				remote = {
					...remote,
					custom_data: body.custom_data,
					subscription_id: current.id,
					checkout: { url: `${config.paymentPageUrl}?_ptxn=${remote.id}` },
				};
				current = { ...current, custom_data: body.custom_data };
				if (discardResponse) throw new Error("Response lost after remote creation");
				return Response.json({ data: remote });
			}
			if (path === "/transactions")
				return Response.json({ data: [remote], meta: { pagination: { has_more: false } } });
			if (path.startsWith("/transactions/")) return Response.json({ data: remote });
			if (path.startsWith("/subscriptions/")) return Response.json({ data: current });
			throw new Error(`Unexpected Paddle request: ${path}`);
		});
		const service = new PaddleBillingService(
			project,
			configWithIdentity,
			context.repository.forProject(project),
			context.repository.providerOperations,
			client,
		);
		const create = () =>
			service.createCheckoutSession({
				billingAccountId,
				productKey: "paddle_test",
				email: `${billingAccountId}@example.com`,
				idempotencyKey: "initial",
			});
		const rawEvent = (type: string, eventId = unique("evt")) => ({
			event_id: eventId,
			event_type: type,
			occurred_at: current.updated_at,
			data: type === "transaction.completed" ? remote : current,
		});
		const deliver = async (event: ReturnType<typeof rawEvent>) => {
			const rawBody = JSON.stringify(event);
			const ts = Math.floor(Date.now() / 1000);
			const signatureHeader = `ts=${ts};h1=${createHmac("sha256", config.webhookSecret).update(`${ts}:${rawBody}`).digest("hex")}`;
			await service.handleWebhook({ rawBody, signatureHeader });
			const [row] = await context.sql<
				StoreEventReplayJobRow[]
			>`SELECT * FROM store_events WHERE project_id=${project.projectInstanceId} AND external_event_id=${event.event_id}`;
			if (!row) throw new Error("Event was not persisted");
			await service.replayStoreEvent(row);
		};
		return {
			service,
			create,
			deliver,
			rawEvent,
			billingAccountId,
			get remote() {
				return remote;
			},
			get current() {
				return current;
			},
			set current(value) {
				current = value;
			},
			get writes() {
				return writes;
			},
			get customerWrites() {
				return customerWrites;
			},
			loseCustomerResponse() {
				loseCustomer = true;
			},
			loseResponse() {
				discardResponse = true;
			},
		};
	}

	// capability: catalog.product.subscription
	// capability: catalog.price.flat
	// capability: checkout.hosted
	// capability: webhook.ingest
	// capability: event.replay
	it("records a paid subscription, deduplicates its transaction, and enqueues entitlements", async () => {
		const h = harness();
		const session = await h.create();
		expect((await h.create()).sessionId).toBe(session.sessionId);
		expect(h.writes).toBe(1);
		const event = h.rawEvent("transaction.completed");
		await h.deliver(event);
		await h.deliver(event);
		const rows =
			await context.sql`SELECT id FROM purchases WHERE project_id=${project.projectInstanceId} AND provider='paddle' AND transaction_id=${session.sessionId}`;
		expect(rows).toHaveLength(1);
		const snapshot = await context.repository.getEntitlementSnapshot(project, h.billingAccountId);
		expect(snapshot.entitlements).toContainEqual(
			expect.objectContaining({ key: "paddle_access", active: true }),
		);
		const jobs =
			await context.sql`SELECT id,payload FROM projection_sync_jobs WHERE project_id=${project.projectInstanceId} AND idempotency_key=${`paddle:${event.event_id}`}`;
		expect(jobs).toHaveLength(1);
		expect(jobs[0]?.payload.purchase).toMatchObject({
			provider: "paddle",
			transactionId: session.sessionId,
			productKey: "paddle_test",
		});
	});

	it("rejects forged signatures before accepting an event", async () => {
		const h = harness();
		await expect(
			h.service.handleWebhook({
				rawBody: JSON.stringify(h.rawEvent("subscription.created")),
				signatureHeader: "ts=1;h1=invalid",
			}),
		).rejects.toMatchObject({ code: "PADDLE_SIGNATURE_INVALID" });
	});

	it("reconciles a lost create response with one dispatch and an immutable receipt", async () => {
		const h = harness();
		h.loseResponse();
		await expect(h.create()).rejects.toMatchObject({ code: "PROVIDER_OPERATION_PENDING" });
		await expect(h.create()).rejects.toMatchObject({ code: "PROVIDER_OPERATION_PENDING" });
		const [row] = await context.sql<
			{ id: string }[]
		>`SELECT id FROM provider_operations WHERE project_id=${project.projectInstanceId} AND billing_account_id=${h.billingAccountId} AND operation='checkout.hosted'`;
		if (!row) throw new Error("Missing operation");
		const store = context.repository.providerOperations;
		const lease = await store.claimReconciliation(project, h.billingAccountId, row.id);
		if (!lease) throw new Error("Missing recovery lease");
		await store.settle(project, lease, await h.service.observeOperation(lease.operation));
		expect((await h.create()).sessionId).toBe(h.remote.id);
		expect(h.writes).toBe(1);
	});

	it("reads current state for delayed events and never restores canceled access", async () => {
		const h = harness();
		await h.create();
		const delayed = h.rawEvent("subscription.created");
		await h.deliver(h.rawEvent("subscription.activated"));
		h.current = {
			...h.current,
			status: "canceled",
			canceled_at: new Date(Date.now() - 1000).toISOString(),
			updated_at: new Date(Date.now() - 1000).toISOString(),
			current_billing_period: null,
		};
		await h.deliver(h.rawEvent("subscription.canceled"));
		await h.deliver(delayed);
		const snapshot = await context.repository.getEntitlementSnapshot(project, h.billingAccountId);
		expect(snapshot.entitlements.every((entitlement) => !entitlement.active)).toBe(true);
	});

	it("refuses a signed event that names a different customer", async () => {
		const h = harness();
		await h.create();
		h.current = { ...h.current, customer_id: id("ctm", "z") };
		await expect(h.deliver(h.rawEvent("subscription.created"))).rejects.toMatchObject({
			code: "PADDLE_FULFILLMENT_MISMATCH",
		});
		expect(
			(await context.repository.getEntitlementSnapshot(project, h.billingAccountId)).entitlements,
		).toHaveLength(0);
	});
	it("recovers customer creation against its correlation before creating one checkout", async () => {
		const h = harness();
		h.loseCustomerResponse();
		await expect(h.create()).rejects.toMatchObject({ code: "PROVIDER_OPERATION_PENDING" });
		const [row] = await context.sql<
			{ id: string }[]
		>`SELECT id FROM provider_operations WHERE project_id=${project.projectInstanceId} AND billing_account_id=${h.billingAccountId} AND operation='customer.create'`;
		if (!row) throw new Error("Missing customer operation");
		const store = context.repository.providerOperations;
		const op = await store.get(project, h.billingAccountId, row.id);
		expect(
			await h.service.observeOperation({ ...op, connectionVersionId: crypto.randomUUID() }),
		).toMatchObject({
			status: "requires_review",
			errorCode: "PROVIDER_OPERATION_ACCOUNT_MISMATCH",
		});
		expect(await h.service.observeOperation({ ...op, requestHash: "0".repeat(64) })).toMatchObject({
			status: "requires_review",
			errorCode: "PADDLE_OPERATION_INTENT_MISMATCH",
		});
		const lease = await store.claimReconciliation(project, h.billingAccountId, row.id);
		if (!lease) throw new Error("Missing lease");
		await store.settle(project, lease, await h.service.observeOperation(lease.operation));
		await h.create();
		await h.create();
		expect(h.customerWrites).toBe(1);
		expect(h.writes).toBe(1);
		expect(
			await h.service.getCheckoutSessionStatus({
				billingAccountId: h.billingAccountId,
				sessionId: h.remote.id,
			}),
		).toMatchObject({ sessionId: h.remote.id });
		await expect(
			h.service.getCheckoutSessionStatus({ billingAccountId: "foreign", sessionId: h.remote.id }),
		).rejects.toMatchObject({ code: "PADDLE_CUSTOMER_NOT_FOUND" });
	});
	it("rejects changed price semantics and additional items before granting access", async () => {
		for (const change of ["amount", "currency", "cadence", "quantity", "items"] as const) {
			const h = harness();
			await h.create();
			const item = h.current.items[0];
			if (!item) throw new Error("Missing item");
			if (change === "items")
				h.current = {
					...h.current,
					items: [item, { ...item, price: { ...item.price, id: id("pri", "b") } }],
				};
			else
				h.current = {
					...h.current,
					items: [
						{
							...item,
							quantity: change === "quantity" ? 2 : 1,
							price: {
								...item.price,
								unit_price:
									change === "amount"
										? { ...item.price.unit_price, amount: "1" }
										: change === "currency"
											? { ...item.price.unit_price, currency_code: "EUR" }
											: item.price.unit_price,
								billing_cycle:
									change === "cadence"
										? { interval: "year", frequency: 1 }
										: item.price.billing_cycle,
							},
						},
					],
				};
			await expect(h.deliver(h.rawEvent("subscription.created"))).rejects.toMatchObject({
				code: "PADDLE_FULFILLMENT_MISMATCH",
			});
			expect(
				(await context.repository.getEntitlementSnapshot(project, h.billingAccountId)).entitlements,
			).toHaveLength(0);
		}
	});
	it("ignores events outside the admitted scope and rejects caller-controlled checkout URLs", async () => {
		const h = harness();
		await h.deliver(h.rawEvent("adjustment.created"));
		await expect(
			h.service.createCheckoutSession({
				billingAccountId: h.billingAccountId,
				productKey: "paddle_test",
				idempotencyKey: "invalid",
				successUrl: "https://foreign.example",
			}),
		).rejects.toMatchObject({ code: "PADDLE_CHECKOUT_INVALID" });
		expect(h.writes).toBe(0);
		await expect(h.service.createPortalSession()).rejects.toMatchObject({
			code: "PADDLE_OPERATION_UNSUPPORTED",
		});
	});
	it("enforces the trusted checkout and signed ingress HTTP contracts", async () => {
		const h = harness();
		const app = withOpenApiAssertions(
			createApp({
				env: context.env,
				projectContextResolver: context.projectContextResolver,
				projectProviderServices: {
					[project.projectInstanceKey]: { paddleBillingService: h.service },
				},
				providerOperationStore: context.repository.providerOperations,
			}),
		);
		const route = `/v1/billing-accounts/${h.billingAccountId}/providers/paddle/checkout-sessions`;
		const headers = {
			authorization: `Bearer ${integrationProjectCredential(project.projectInstanceKey)}`,
			"idempotency-key": "http-contract",
		};
		expect(
			(
				await testRequest(app, route, {
					method: "POST",
					headers,
					body: JSON.stringify({ productKey: "paddle_test" }),
				})
			).status,
		).toBe(400);
		expect(
			(
				await testRequest(app, route, {
					method: "POST",
					headers: {
						...headers,
						authorization: `Bearer ${integrationProjectReadOnlyCredential(project.projectInstanceKey)}`,
					},
					body: JSON.stringify({ productKey: "paddle_test" }),
				})
			).status,
		).toBe(403);
		const response = await testRequest(app, route, {
			method: "POST",
			headers,
			body: JSON.stringify({
				productKey: "paddle_test",
				email: `${h.billingAccountId}@example.com`,
			}),
		});
		expect(response.status).toBe(200);
		expect((await response.json()).data.sessionId).toBe(h.remote.id);
		const raw = JSON.stringify(h.rawEvent("transaction.completed"));
		const ts = Math.floor(Date.now() / 1000);
		const signature = `ts=${ts};h1=${createHmac("sha256", config.webhookSecret).update(`${ts}:${raw}`).digest("hex")}`;
		const webhook = `/v1/projects/${project.projectInstanceKey}/webhooks/paddle`;
		expect(
			(
				await testRequest(app, webhook, {
					method: "POST",
					headers: { "paddle-signature": "invalid" },
					body: raw,
				})
			).status,
		).toBe(400);
		expect(
			(
				await testRequest(app, webhook, {
					method: "POST",
					headers: { "paddle-signature": signature },
					body: raw,
				})
			).status,
		).toBe(200);
		expect(h.writes).toBe(1);
	});
});
