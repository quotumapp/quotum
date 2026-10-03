import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { createApp } from "../../src/app";
import { executeCommercial, previewCommercial } from "../../src/app/commercial-actions";
import type { CommercialActionIntent } from "../../src/billing/commercial";
import { sha256Hex, stableJson } from "../../src/billing/decimal";
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

	function harness(selectedPrice = price) {
		const billingAccountId = unique("account");
		const customerId = unique("ctm");
		const configWithIdentity = { ...config, accountIdentity, versionId: crypto.randomUUID() };
		let remote = {
			...transaction,
			id: unique("txn"),
			customer_id: customerId,
			details: {
				...transaction.details,
				line_items: transaction.details.line_items.map((item) => ({
					...item,
					price_id: selectedPrice.id,
					product: { id: selectedPrice.product_id },
					quantity: 1,
				})),
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
			items: subscription.items.map((item) => ({ ...item, price: selectedPrice, quantity: 1 })),
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
				return Response.json({ data: { ...selectedPrice, quantity: { minimum: 1, maximum: 1 } } });
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
			config: configWithIdentity,
			client,
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

	async function fixedPlan() {
		const planKey = unique("plan");
		const selectedPrice = { ...price, id: unique("pri"), product_id: unique("pro") };
		const sql = context.sql;
		const projectId = project.projectInstanceId;
		const [revision] =
			await sql`INSERT INTO catalog_revisions(project_id, revision, status, intent_hash, created_by, published_at)
			SELECT ${projectId}, COALESCE(max(revision),0)+1, 'published', ${"a".repeat(64)}, 'paddle-test', now() FROM catalog_revisions WHERE project_id=${projectId} RETURNING id`;
		const [plan] =
			await sql`INSERT INTO plans(project_id,key,name) VALUES(${projectId},${planKey},'Fixed Paddle plan') RETURNING id`;
		const [product] =
			await sql`INSERT INTO products(project_id,key,entitlement_key,credit_amount,name,type,active) VALUES(${projectId},${planKey},${planKey},0,'Fixed Paddle plan','subscription',true) RETURNING id`;
		const [store] =
			await sql`INSERT INTO store_products(project_id,product_id,provider,channel,external_product_id,external_price_id,billing_period,currency,price_amount,active) VALUES(${projectId},${product.id},'paddle','web',${selectedPrice.product_id},${selectedPrice.id},'month','USD',1000,true) RETURNING id`;
		const [feature] =
			await sql`INSERT INTO features(project_id,key,name,kind,unit) VALUES(${projectId},${planKey},'Fixed access','boolean','access') RETURNING id`;
		let version = 0;
		const publish = async () => {
			version++;
			const [pv] =
				await sql`INSERT INTO plan_versions(project_id,plan_id,catalog_revision_id,version,status,currency,base_amount_minor,billing_interval) VALUES(${projectId},${plan.id},${revision.id},${version},'published','USD',1000,'month') RETURNING id`;
			await sql`INSERT INTO plan_items(project_id,plan_version_id,feature_id,item_kind) VALUES(${projectId},${pv.id},${feature.id},'access')`;
			const [pc] =
				await sql`INSERT INTO price_components(project_id,plan_version_id,key,component_kind,charge_timing,currency,unit_amount_minor,billing_interval) VALUES(${projectId},${pv.id},'base','base','in_advance','USD',1000,'month') RETURNING id`;
			await sql`INSERT INTO provider_price_bindings(project_id,price_component_id,store_product_id,provider,channel,status) VALUES(${projectId},${pc.id},${store.id},'paddle','web','published')`;
			await sql`INSERT INTO provider_plan_bindings(project_id,plan_version_id,store_product_id,provider,channel,status) VALUES(${projectId},${pv.id},${store.id},'paddle','web','published') ON CONFLICT(project_id,store_product_id) DO UPDATE SET plan_version_id=EXCLUDED.plan_version_id`;
			await sql`UPDATE plans SET active_version_id=${pv.id} WHERE project_id=${projectId} AND id=${plan.id}`;
			return { versionId: String(pv.id), priceId: String(pc.id) };
		};
		const first = await publish();
		return { ...first, planKey, publish, price: selectedPrice };
	}

	function commercial(h: ReturnType<typeof harness>, intent: CommercialActionIntent) {
		const routing = {
			project,
			billingAccountId: h.billingAccountId,
			services: {
				stripeBillingService: async () => null,
				appleStoreKitService: async () => null,
				googlePlayBillingService: async () => null,
				paddleBillingService: async () => h.service,
				paddleBillingServiceVersion: async (_: unknown, versionId: string) =>
					versionId === h.config.versionId ? h.service : null,
			},
		};
		return {
			preview: () => previewCommercial({ ...routing, provider: "paddle", intent }),
			execute: (previewToken: string, idempotencyKey = "purchase") =>
				executeCommercial({ ...routing, reader: context.repository, previewToken, idempotencyKey }),
		};
	}

	// capability: checkout.plan
	it("previews a fixed plan without provider writes and pins paid fulfillment across publication", async () => {
		const plan = await fixedPlan();
		const h = harness(plan.price);
		const flow = commercial(h, {
			kind: "checkout_plan",
			planKey: plan.planKey,
			quantities: { base: 1 },
			email: "payer@example.com",
		});
		const preview = await flow.preview();
		expect(preview).toMatchObject({
			provider: "paddle",
			toPlanVersionId: plan.versionId,
			subtotalMinor: 1000,
			amountStatus: "provider_calculated",
			estimatedTotalMinor: null,
		});
		expect(preview.lineItems).toHaveLength(1);
		expect(preview.lineItems[0]).toMatchObject({ quantity: 1, totalMinor: null });
		expect(preview).not.toHaveProperty("providerContext");
		expect([h.writes, h.customerWrites]).toEqual([0, 0]);
		const receipt = await flow.execute(preview.previewToken);
		expect(receipt).toMatchObject({ kind: "checkout", sessionId: h.remote.id });
		const second = await plan.publish();
		await h.deliver(h.rawEvent("transaction.completed"));
		await h.deliver(h.rawEvent("subscription.updated"));
		const [sub] =
			await context.sql`SELECT plan_version_id::text FROM subscriptions WHERE project_id=${project.projectInstanceId} AND external_subscription_id=${h.current.id}`;
		expect(sub.plan_version_id).toBe(plan.versionId);
		expect(sub.plan_version_id).not.toBe(second.versionId);
		const items =
			await context.sql`SELECT si.price_component_id::text, si.quantity FROM subscription_items si JOIN subscriptions s ON s.id=si.subscription_id AND s.project_id=si.project_id WHERE s.project_id=${project.projectInstanceId} AND s.external_subscription_id=${h.current.id}`;
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ price_component_id: plan.priceId, quantity: 1 });
		expect(await flow.execute(preview.previewToken)).toEqual(receipt);
		expect(h.writes).toBe(1);
		await expect(flow.execute(preview.previewToken, "other")).rejects.toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
		});
		await expect(flow.preview()).rejects.toMatchObject({ code: "BASE_PLAN_ALREADY_ACTIVE" });
	});

	it("accepts equivalent catalog cadences without changing the provider price or quantity", async () => {
		const plan = await fixedPlan();
		await context.sql`UPDATE plan_versions SET billing_interval='quarter' WHERE project_id=${project.projectInstanceId} AND id=${plan.versionId}`;
		await context.sql`UPDATE price_components SET billing_interval='quarter' WHERE project_id=${project.projectInstanceId} AND id=${plan.priceId}`;
		await context.sql`UPDATE store_products SET billing_period_count=3 WHERE project_id=${project.projectInstanceId} AND external_price_id=${plan.price.id}`;
		const h = harness({ ...plan.price, billing_cycle: { interval: "month", frequency: 3 } });
		const flow = commercial(h, {
			kind: "checkout_plan",
			planKey: plan.planKey,
			quantities: {},
			email: "payer@example.com",
		});
		expect((await flow.preview()).lineItems[0]).toMatchObject({
			interval: "month",
			intervalCount: 3,
			quantity: 1,
			subtotalMinor: 1000,
		});
		expect([h.customerWrites, h.writes]).toEqual([0, 0]);
	});

	it("rejects stale, expired and foreign previews before customer or transaction creation", async () => {
		const plan = await fixedPlan();
		const h = harness(plan.price);
		const flow = commercial(h, {
			kind: "checkout_plan",
			planKey: plan.planKey,
			quantities: {},
			email: "payer@example.com",
		});
		const stale = await flow.preview();
		await plan.publish();
		await expect(flow.execute(stale.previewToken)).rejects.toMatchObject({
			code: "COMMERCIAL_PREVIEW_STALE",
		});
		const expired = await flow.preview();
		await context.sql`UPDATE commercial_action_previews SET expires_at=now()-interval '1 second' WHERE project_id=${project.projectInstanceId} AND preview_token=${expired.previewToken}`;
		await expect(flow.execute(expired.previewToken)).rejects.toMatchObject({
			code: "COMMERCIAL_PREVIEW_EXPIRED",
		});
		await expect(
			h.service.executeCommercialAction({
				billingAccountId: "foreign",
				previewToken: expired.previewToken,
				idempotencyKey: "purchase",
			}),
		).rejects.toMatchObject({ code: "COMMERCIAL_PREVIEW_NOT_FOUND" });
		await expect(
			context.repository.getCommercialActionPreview(
				integrationProjectContext("globex"),
				h.billingAccountId,
				expired.previewToken,
			),
		).rejects.toMatchObject({ code: "COMMERCIAL_PREVIEW_NOT_FOUND" });
		expect([h.writes, h.customerWrites]).toEqual([0, 0]);
	});

	it("resumes an uncertain common execution after preview expiry without a second dispatch", async () => {
		const h = harness();
		const flow = commercial(h, {
			kind: "checkout_product",
			productKey: "paddle_test",
			email: "payer@example.com",
		});
		const preview = await flow.preview();
		h.loseResponse();
		await expect(flow.execute(preview.previewToken)).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_PENDING",
		});
		await expect(flow.execute(preview.previewToken, "wrong")).rejects.toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
		});
		await context.sql`UPDATE commercial_action_previews SET expires_at=now()-interval '1 second' WHERE project_id=${project.projectInstanceId} AND preview_token=${preview.previewToken}`;
		await expect(flow.execute(preview.previewToken)).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_PENDING",
		});
		const [row] =
			await context.sql`SELECT id FROM provider_operations WHERE project_id=${project.projectInstanceId} AND billing_account_id=${h.billingAccountId} AND operation='checkout.hosted'`;
		const store = context.repository.providerOperations;
		const lease = await store.claimReconciliation(project, h.billingAccountId, row.id);
		if (!lease) throw new Error("Missing lease");
		await store.settle(project, lease, await h.service.observeOperation(lease.operation));
		expect(await flow.execute(preview.previewToken)).toMatchObject({
			sessionId: h.remote.id,
			kind: "checkout",
		});
		expect([h.writes, h.customerWrites]).toEqual([1, 1]);
	});

	it("dispatches a prepared checkout once and preserves the first completed commercial receipt", async () => {
		const h = harness();
		const repository = context.repository.forProject(project);
		await repository.linkPaddleCustomer({
			billingAccountId: h.billingAccountId,
			customerId: h.current.customer_id,
			providerAccountId: accountIdentity,
		});
		const flow = commercial(h, { kind: "checkout_product", productKey: "paddle_test" });
		const preview = await flow.preview();
		const request = {
			customerId: h.current.customer_id,
			bindings: [await repository.getPaddleBinding("paddle_test")],
			paymentPageUrl: config.paymentPageUrl,
		};
		await context.repository.providerOperations.prepare(project, {
			billingAccountId: h.billingAccountId,
			provider: "paddle",
			providerAccountId: accountIdentity,
			connectionVersionId: h.config.versionId,
			idempotencyKey: `commercial:${preview.previewToken}`,
			resourceKey: `checkout:${sha256Hex(h.billingAccountId)}`,
			operation: "checkout.hosted",
			request,
			requestHash: sha256Hex(stableJson(request)),
		});
		const result = await flow.execute(preview.previewToken);
		expect(result).toMatchObject({ kind: "checkout", sessionId: h.remote.id });
		expect([h.writes, h.customerWrites]).toEqual([1, 0]);
		const replay = await repository.completeCommercialActionExecution({
			billingAccountId: h.billingAccountId,
			previewToken: preview.previewToken,
			idempotencyKey: "purchase",
			result: {
				kind: "checkout",
				sessionId: "wrong",
				url: "https://example.com/other",
				duplicate: true,
			},
		});
		expect(replay).toEqual(result);
	});

	it("refuses unsupported commercial options and plans without dropping components", async () => {
		const plan = await fixedPlan();
		const h = harness(plan.price);
		const intent = {
			kind: "checkout_plan" as const,
			planKey: plan.planKey,
			quantities: {},
			email: "payer@example.com",
		};
		const rejected: Partial<Extract<CommercialActionIntent, { kind: "checkout_plan" }>>[] = [
			{ quantities: { base: 2 } },
			{ quantities: { foreign: 1 } },
			{ allowPromotionCodes: true },
			{ promotionCode: "PROMO" },
			{ successUrl: "https://example.com" },
			{ cancelUrl: "https://example.com" },
			{ expiresAt: 1800000000 },
		];
		for (const change of rejected) {
			await expect(commercial(h, { ...intent, ...change }).preview()).rejects.toMatchObject({
				code: "PADDLE_OPERATION_UNSUPPORTED",
			});
		}
		await expect(
			commercial(h, { kind: "uncancel", externalSubscriptionId: "sub_foreign" }).preview(),
		).rejects.toMatchObject({ code: "PADDLE_OPERATION_UNSUPPORTED" });
		await expect(commercial(h, { ...intent, email: null }).preview()).rejects.toMatchObject({
			code: "PADDLE_CUSTOMER_EMAIL_REQUIRED",
		});
		await context.sql`UPDATE plan_versions SET trial_days=7 WHERE project_id=${project.projectInstanceId} AND id=${plan.versionId}`;
		await expect(commercial(h, intent).preview()).rejects.toMatchObject({
			code: "PADDLE_PLAN_UNSUPPORTED",
		});
		await context.sql`UPDATE plan_versions SET trial_days=NULL, plan_kind='addon' WHERE project_id=${project.projectInstanceId} AND id=${plan.versionId}`;
		await expect(commercial(h, intent).preview()).rejects.toMatchObject({
			code: "PADDLE_PLAN_UNSUPPORTED",
		});
		await context.sql`UPDATE plan_versions SET plan_kind='base' WHERE project_id=${project.projectInstanceId} AND id=${plan.versionId}`;
		await context.sql`DELETE FROM provider_price_bindings WHERE project_id=${project.projectInstanceId} AND price_component_id=${plan.priceId}`;
		await expect(commercial(h, intent).preview()).rejects.toMatchObject({
			code: "PADDLE_PLAN_UNSUPPORTED",
		});
		expect([h.writes, h.customerWrites]).toEqual([0, 0]);
	});

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
	it("rejects hidden paid components and customer-specific plans for another payer", async () => {
		const plan = await fixedPlan();
		const h = harness(plan.price);
		const flow = commercial(h, {
			kind: "checkout_plan",
			planKey: plan.planKey,
			quantities: {},
			email: "payer@example.com",
		});
		const [feature] =
			await context.sql`INSERT INTO features(project_id,key,name,kind,meter_kind,unit) VALUES(${project.projectInstanceId},${unique("seats")},'Seats','metered','non_consumable','seat') RETURNING id`;
		const [item] =
			await context.sql`INSERT INTO plan_items(project_id,plan_version_id,feature_id,item_kind,quantity) VALUES(${project.projectInstanceId},${plan.versionId},${feature.id},'licensed_quantity',1) RETURNING id`;
		await context.sql`INSERT INTO price_components(project_id,plan_version_id,plan_item_id,key,component_kind,charge_timing,currency,unit_amount_minor,billing_interval) VALUES(${project.projectInstanceId},${plan.versionId},${item.id},'seats','licensed','in_advance','USD',100,'month')`;
		await expect(flow.preview()).rejects.toMatchObject({ code: "PADDLE_PLAN_UNSUPPORTED" });
		await context.sql`DELETE FROM price_components WHERE project_id=${project.projectInstanceId} AND plan_item_id=${item.id}`;
		await context.sql`UPDATE plan_items SET item_kind='meter_limit', overage_policy='allowed' WHERE project_id=${project.projectInstanceId} AND id=${item.id}`;
		await expect(flow.preview()).rejects.toMatchObject({ code: "PADDLE_PLAN_UNSUPPORTED" });
		await context.sql`UPDATE plan_items SET item_kind='allocation', overage_policy='blocked', allocation_scope='entity' WHERE project_id=${project.projectInstanceId} AND id=${item.id}`;
		await expect(flow.preview()).rejects.toMatchObject({ code: "PADDLE_PLAN_UNSUPPORTED" });
		await context.sql`DELETE FROM plan_items WHERE project_id=${project.projectInstanceId} AND id=${item.id}`;
		const [owner] =
			await context.sql`INSERT INTO customers(project_id,billing_account_id) VALUES(${project.projectInstanceId},${h.billingAccountId}) RETURNING id`;
		await context.sql`UPDATE plan_versions SET visibility='customer_specific',customer_id=${owner.id} WHERE project_id=${project.projectInstanceId} AND id=${plan.versionId}`;
		expect((await flow.preview()).toPlanVersionId).toBe(plan.versionId);
		await expect(
			commercial(harness(plan.price), {
				kind: "checkout_plan",
				planKey: plan.planKey,
				quantities: {},
				email: "other@example.com",
			}).preview(),
		).rejects.toMatchObject({ code: "BILLING_PLAN_NOT_FOUND" });
		expect([h.writes, h.customerWrites]).toEqual([0, 0]);
	});

	it("exposes Paddle through the common HTTP contract with server-selected execution", async () => {
		const plan = await fixedPlan();
		const h = harness(plan.price);
		const app = withOpenApiAssertions(
			createApp({
				env: context.env,
				projectContextResolver: context.projectContextResolver,
				projectProviderServices: {
					[project.projectInstanceKey]: { paddleBillingService: h.service },
				},
				commercialPreviewReader: context.repository,
			}),
		);
		const route = `/v1/billing-accounts/${h.billingAccountId}/commercial-actions`;
		const headers = {
			authorization: `Bearer ${integrationProjectCredential(project.projectInstanceKey)}`,
			"idempotency-key": "http-common",
		};
		const body = {
			provider: "paddle",
			intent: {
				kind: "checkout_plan",
				planKey: plan.planKey,
				quantities: {},
				email: "payer@example.com",
			},
		};
		const denied = await testRequest(app, `${route}/preview`, {
			method: "POST",
			headers: {
				...headers,
				authorization: `Bearer ${integrationProjectReadOnlyCredential(project.projectInstanceKey)}`,
			},
			body: JSON.stringify(body),
		});
		expect(denied.status).toBe(403);
		const response = await testRequest(app, `${route}/preview`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		expect(response.status).toBe(200);
		const preview = (await response.json()).data;
		expect(preview).toMatchObject({
			provider: "paddle",
			action: "checkout_plan",
			toPlanVersionId: plan.versionId,
		});
		const result = await testRequest(app, route, {
			method: "POST",
			headers,
			body: JSON.stringify({ previewToken: preview.previewToken }),
		});
		expect(result.status).toBe(200);
		expect((await result.json()).data).toMatchObject({ kind: "checkout", sessionId: h.remote.id });
		expect(h.writes).toBe(1);
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
