import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { createApp } from "../../src/app";
import { executeCommercial, previewCommercial } from "../../src/app/commercial-actions";
import type { CommercialActionIntent } from "../../src/billing/commercial";
import { sha256Hex, stableJson } from "../../src/billing/decimal";
import type {
	ProviderSubscriptionReconciliationRow,
	StoreEventReplayJobRow,
} from "../../src/db/repository";
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
		let rejectNext = false;
		let customerRejection: { status: number; code: string } | null = null;
		let priceMode: "active" | "archived" | "down" = "active";
		let priceReads = 0;
		let cooldownUntil = 0;
		let onPriceRead: ((read: number) => void) | undefined;
		let onCreated: (() => Promise<void>) | undefined;
		// A private cooldown keeps one test's rate limit from reaching the others in this process.
		const cooldown = {
			get: () => cooldownUntil,
			set: (value: number) => {
				cooldownUntil = Math.max(cooldownUntil, value);
			},
		};
		const client = new PaddleClient(
			config,
			async (url, init) => {
				const path = new URL(String(url)).pathname;
				const body = init?.body ? JSON.parse(String(init.body)) : {};
				if (path.startsWith("/prices/")) {
					priceReads++;
					onPriceRead?.(priceReads);
					if (priceMode === "down")
						return Response.json({ error: { code: "service_unavailable" } }, { status: 503 });
					return Response.json({
						data: {
							...selectedPrice,
							...(priceMode === "archived" ? { status: "archived" } : {}),
							quantity: { minimum: 1, maximum: 1 },
						},
					});
				}
				if (path === "/customers" && init?.method === "POST") {
					customerWrites++;
					if (customerRejection)
						return Response.json(
							{ error: { code: customerRejection.code } },
							{
								status: customerRejection.status,
								...(customerRejection.status === 429
									? { headers: { "retry-after": "0.001" } }
									: {}),
							},
						);
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
					if (rejectNext) {
						rejectNext = false;
						return Response.json({ error: { code: "transaction_invalid" } }, { status: 400 });
					}
					const transactionId = unique("txn");
					remote = {
						...remote,
						id: transactionId,
						custom_data: body.custom_data,
						subscription_id: current.id,
						checkout: { url: `${config.paymentPageUrl}?_ptxn=${transactionId}` },
					};
					current = { ...current, custom_data: body.custom_data };
					await onCreated?.();
					if (discardResponse) throw new Error("Response lost after remote creation");
					return Response.json({ data: remote });
				}
				if (path === "/transactions")
					return Response.json({ data: [remote], meta: { pagination: { has_more: false } } });
				if (path.startsWith("/transactions/")) return Response.json({ data: remote });
				if (path.startsWith("/subscriptions/")) return Response.json({ data: current });
				throw new Error(`Unexpected Paddle request: ${path}`);
			},
			Date.now,
			cooldown,
		);
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
			data: type.startsWith("transaction.") ? remote : current,
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
			return service.replayStoreEvent(row);
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
			set remote(value) {
				remote = value;
			},
			rejectCustomer(status = 400, code = "customer_invalid") {
				customerRejection = { status, code };
			},
			acceptCustomer() {
				customerRejection = null;
			},
			rejectTransaction() {
				rejectNext = true;
			},
			archivePrice() {
				priceMode = "archived";
			},
			makePriceUnavailable() {
				priceMode = "down";
			},
			get priceReads() {
				return priceReads;
			},
			/** Starts, or with 0 ends, the shared rate-limit cooldown another tenant's 429 would set. */
			coolDown(ms: number) {
				cooldownUntil = ms === 0 ? 0 : Date.now() + ms;
			},
			onPriceRead(callback: (read: number) => void) {
				onPriceRead = callback;
			},
			onTransactionCreated(callback: () => Promise<void>) {
				onCreated = callback;
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
		const competing = await flow.preview();
		await expect(flow.execute(competing.previewToken, "competitor")).rejects.toMatchObject({
			code: "PADDLE_CHECKOUT_PENDING",
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
	// QA-01: the recorded checkout intent pins price and product identity, so retiring the store mapping
	// or the product ends sales without stranding a paid subscription or its cancellation.
	async function retireCatalog(reason: "mapping" | "product", active: boolean) {
		if (reason === "mapping")
			await context.sql`UPDATE store_products SET active=${active} WHERE project_id=${project.projectInstanceId} AND provider='paddle' AND external_price_id=${price.id}`;
		else
			await context.sql`UPDATE products SET active=${active} WHERE project_id=${project.projectInstanceId} AND key='paddle_test'`;
	}
	const activeAccess = async (billingAccountId: string) =>
		(await context.repository.getEntitlementSnapshot(project, billingAccountId)).entitlements.some(
			(entitlement) => entitlement.key === "paddle_access" && entitlement.active,
		);

	for (const reason of ["mapping", "product"] as const)
		it(`revokes access on cancellation after the ${reason} was retired`, async () => {
			const h = harness();
			await h.create();
			await h.deliver(h.rawEvent("subscription.activated"));
			expect(await activeAccess(h.billingAccountId)).toBe(true);
			try {
				await retireCatalog(reason, false);
				h.current = {
					...h.current,
					status: "canceled",
					canceled_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					current_billing_period: null,
				};
				expect(await h.deliver(h.rawEvent("subscription.canceled"))).toEqual({
					status: "processed",
				});
				expect(await activeAccess(h.billingAccountId)).toBe(false);
			} finally {
				await retireCatalog(reason, true);
			}
		});

	it("grants access to a checkout paid after its mapping was retired and reconciles it later", async () => {
		const h = harness();
		await h.create();
		try {
			await retireCatalog("mapping", false);
			await h.deliver(h.rawEvent("transaction.completed"));
			expect(await activeAccess(h.billingAccountId)).toBe(true);
			h.current = {
				...h.current,
				status: "canceled",
				canceled_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				current_billing_period: null,
			};
			const [row] = await context.sql<
				ProviderSubscriptionReconciliationRow[]
			>`SELECT * FROM subscriptions WHERE project_id=${project.projectInstanceId} AND provider='paddle' AND external_subscription_id=${h.current.id}`;
			expect(
				await h.service.reconcileSubscription(row as ProviderSubscriptionReconciliationRow),
			).toEqual({
				status: "processed",
			});
			expect(await activeAccess(h.billingAccountId)).toBe(false);
		} finally {
			await retireCatalog("mapping", true);
		}
	});

	const accessExpiry = async (billingAccountId: string) =>
		(await context.repository.getEntitlementSnapshot(project, billingAccountId)).entitlements.find(
			(entitlement) => entitlement.key === "paddle_access" && entitlement.active,
		)?.expiresAt;
	const renewal = (current: PaddleSubscription) => {
		const startsAt = current.current_billing_period?.ends_at ?? "";
		const endsAt = new Date(Date.parse(startsAt) + 30 * 86400_000).toISOString();
		return {
			endsAt,
			subscription: {
				...current,
				updated_at: new Date().toISOString(),
				current_billing_period: { starts_at: startsAt, ends_at: endsAt },
				next_billed_at: endsAt,
			},
		};
	};

	for (const reason of ["mapping", "product"] as const)
		it(`extends a paid period on renewal after the ${reason} was retired`, async () => {
			const h = harness();
			await h.create();
			await h.deliver(h.rawEvent("subscription.activated"));
			const before = await accessExpiry(h.billingAccountId);
			try {
				await retireCatalog(reason, false);
				const renewed = renewal(h.current);
				h.current = renewed.subscription;
				expect(await h.deliver(h.rawEvent("subscription.updated"))).toEqual({
					status: "processed",
				});
				expect(await accessExpiry(h.billingAccountId)).toBe(renewed.endsAt);
				expect(renewed.endsAt).not.toBe(before);
			} finally {
				await retireCatalog(reason, true);
			}
		});

	it("extends a paid period through reconciliation after the mapping was retired", async () => {
		const h = harness();
		await h.create();
		await h.deliver(h.rawEvent("subscription.activated"));
		try {
			await retireCatalog("mapping", false);
			const renewed = renewal(h.current);
			h.current = renewed.subscription;
			const [row] = await context.sql<
				ProviderSubscriptionReconciliationRow[]
			>`SELECT * FROM subscriptions WHERE project_id=${project.projectInstanceId} AND provider='paddle' AND external_subscription_id=${h.current.id}`;
			expect(
				await h.service.reconcileSubscription(row as ProviderSubscriptionReconciliationRow),
			).toEqual({
				status: "processed",
			});
			expect(await accessExpiry(h.billingAccountId)).toBe(renewed.endsAt);
		} finally {
			await retireCatalog("mapping", true);
		}
	});

	it("still refuses an event whose price is not the recorded checkout price", async () => {
		const h = harness();
		await h.create();
		await context.sql`UPDATE store_products SET active=false WHERE project_id=${project.projectInstanceId} AND provider='paddle' AND external_price_id=${price.id}`;
		try {
			h.current = {
				...h.current,
				items: h.current.items.map((item) => ({
					...item,
					price: { ...item.price, id: id("pri", "q") },
				})),
			};
			await expect(h.deliver(h.rawEvent("subscription.activated"))).rejects.toMatchObject({
				code: "PADDLE_FULFILLMENT_MISMATCH",
			});
			expect(await activeAccess(h.billingAccountId)).toBe(false);
		} finally {
			await retireCatalog("mapping", true);
		}
	});

	// QA-03: a succeeded receipt replays from the durable operation, without a provider read, an extra
	// dispatch, or a dependence on the product still being on sale.
	it("replays a succeeded direct checkout after the provider price is archived or unavailable", async () => {
		const h = harness();
		const original = await h.create();
		expect(original.duplicate).toBe(false);
		const readsBeforeReplay = h.priceReads;
		expect(readsBeforeReplay).toBeGreaterThan(0);
		h.archivePrice();
		expect(await h.create()).toEqual({ ...original, duplicate: true });
		h.makePriceUnavailable();
		expect(await h.create()).toEqual({ ...original, duplicate: true });
		expect(h.priceReads).toBe(readsBeforeReplay);
		expect([h.writes, h.customerWrites]).toEqual([1, 1]);
	});

	it("replays a succeeded direct checkout after its mapping was retired, but not a new key", async () => {
		const h = harness();
		const original = await h.create();
		try {
			await retireCatalog("mapping", false);
			expect(await h.create()).toEqual({ ...original, duplicate: true });
			await expect(
				h.service.createCheckoutSession({
					billingAccountId: h.billingAccountId,
					productKey: "paddle_test",
					email: `${h.billingAccountId}@example.com`,
					idempotencyKey: "another",
				}),
			).rejects.toMatchObject({ code: "PADDLE_FULFILLMENT_MISMATCH" });
		} finally {
			await retireCatalog("mapping", true);
		}
		expect(h.writes).toBe(1);
	});

	it("reports the replay flag over the trusted HTTP route", async () => {
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
		const send = async () => {
			const response = await testRequest(
				app,
				`/v1/billing-accounts/${h.billingAccountId}/providers/paddle/checkout-sessions`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${integrationProjectCredential(project.projectInstanceKey)}`,
						"idempotency-key": "http-replay",
					},
					body: JSON.stringify({
						productKey: "paddle_test",
						email: `${h.billingAccountId}@example.com`,
					}),
				},
			);
			expect(response.status).toBe(200);
			return (await response.json()).data;
		};
		const first = await send();
		expect(first).toMatchObject({ sessionId: h.remote.id, duplicate: false });
		h.makePriceUnavailable();
		expect(await send()).toEqual({ ...first, duplicate: true });
		expect(h.writes).toBe(1);
	});

	it("replays a succeeded common execution without provider reads after the price changed", async () => {
		const h = harness();
		const flow = commercial(h, {
			kind: "checkout_product",
			productKey: "paddle_test",
			email: `${h.billingAccountId}@example.com`,
		});
		const preview = await flow.preview();
		const first = await flow.execute(preview.previewToken);
		const readsBeforeReplay = h.priceReads;
		h.archivePrice();
		expect(await flow.execute(preview.previewToken)).toEqual(first);
		h.makePriceUnavailable();
		expect(await flow.execute(preview.previewToken)).toEqual(first);
		expect(h.priceReads).toBe(readsBeforeReplay);
		expect(h.writes).toBe(1);
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
		expect((await denied.json()).error.code).toBe("READ_ONLY_CREDENTIAL");
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

	it("reserves one checkout across competing previews and direct calls without claiming the loser", async () => {
		const plan = await fixedPlan();
		const h = harness(plan.price);
		const repo = context.repository.forProject(project);
		await repo.linkPaddleCustomer({
			billingAccountId: h.billingAccountId,
			customerId: h.current.customer_id,
			providerAccountId: accountIdentity,
		});
		const flow = commercial(h, { kind: "checkout_plan", planKey: plan.planKey, quantities: {} });
		const previews = await Promise.all([flow.preview(), flow.preview()]);
		const results = await Promise.allSettled(
			previews.map((p, i) => flow.execute(p.previewToken, `purchase-${i}`)),
		);
		expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		const loser = results.findIndex((r) => r.status === "rejected");
		const winner = 1 - loser;
		const losingPreview = previews[loser];
		const winningPreview = previews[winner];
		if (!losingPreview || !winningPreview)
			throw new Error("Expected one winning and one losing preview");
		expect(results[loser]).toMatchObject({
			status: "rejected",
			reason: { code: "PADDLE_CHECKOUT_PENDING", status: 409 },
		});
		expect(
			await repo.getCommercialActionPreview(h.billingAccountId, losingPreview.previewToken),
		).toMatchObject({ status: "previewed", executionIdempotencyKey: null });
		await expect(
			flow.execute(losingPreview.previewToken, `purchase-${loser}`),
		).rejects.toMatchObject({ code: "PADDLE_CHECKOUT_PENDING" });
		await expect(
			h.service.createCheckoutSession({
				billingAccountId: h.billingAccountId,
				productKey: plan.planKey,
				idempotencyKey: "direct-bypass",
			}),
		).rejects.toMatchObject({ code: "PADDLE_CHECKOUT_PENDING" });
		await context.sql`UPDATE commercial_action_previews SET expires_at=now()-interval '1 second' WHERE project_id=${project.projectInstanceId} AND preview_token=${losingPreview.previewToken}`;
		await expect(flow.execute(losingPreview.previewToken)).rejects.toMatchObject({
			code: "COMMERCIAL_PREVIEW_EXPIRED",
		});
		expect(await flow.execute(winningPreview.previewToken, `purchase-${winner}`)).toMatchObject({
			kind: "checkout",
		});
		expect([h.writes, h.customerWrites]).toEqual([1, 0]);
		const other = harness(plan.price);
		expect(
			await commercial(other, {
				kind: "checkout_plan",
				planKey: plan.planKey,
				quantities: {},
				email: "other@example.com",
			}).preview(),
		).toMatchObject({ provider: "paddle" });
		expect(
			await other.service.createCheckoutSession({
				billingAccountId: other.billingAccountId,
				productKey: plan.planKey,
				email: "other@example.com",
				idempotencyKey: "other",
			}),
		).toHaveProperty("sessionId");
		await h.deliver(h.rawEvent("transaction.completed"));
		const [reservation] =
			await context.sql`SELECT closure_reason FROM paddle_checkout_reservations WHERE project_id=${project.projectInstanceId} AND billing_account_id=${h.billingAccountId}`;
		expect(reservation.closure_reason).toBe("fulfilled");
		await expect(
			h.service.createCheckoutSession({
				billingAccountId: h.billingAccountId,
				productKey: plan.planKey,
				idempotencyKey: "after-payment",
			}),
		).rejects.toMatchObject({ code: "BASE_PLAN_ALREADY_ACTIVE" });
	});

	it("keeps a direct checkout reserved until verified cancellation and ignores duplicate older cancellation", async () => {
		const h = harness();
		const receipt = await h.create();
		const flow = commercial(h, { kind: "checkout_product", productKey: "paddle_test" });
		const preview = await flow.preview();
		await expect(flow.execute(preview.previewToken)).rejects.toMatchObject({
			code: "PADDLE_CHECKOUT_PENDING",
		});
		// The signed event alone does not prove cancellation: GET still returns current completed state.
		await h.deliver(h.rawEvent("transaction.canceled"));
		await expect(flow.execute(preview.previewToken)).rejects.toMatchObject({
			code: "PADDLE_CHECKOUT_PENDING",
		});
		h.remote = { ...h.remote, status: "canceled" };
		const canceled = h.remote;
		const event = h.rawEvent("transaction.canceled");
		await h.deliver(event);
		const created = await flow.execute(preview.previewToken);
		expect(created).toMatchObject({ kind: "checkout" });
		expect(h.remote.id).not.toBe(canceled.id);
		h.remote = canceled;
		await h.deliver(event);
		await h.deliver(h.rawEvent("transaction.canceled"));
		await expect(
			h.service.createCheckoutSession({
				billingAccountId: h.billingAccountId,
				productKey: "paddle_test",
				idempotencyKey: "third",
			}),
		).rejects.toMatchObject({ code: "PADDLE_CHECKOUT_PENDING" });
		expect(await h.create()).toEqual({ ...receipt, duplicate: true });
		expect(h.writes).toBe(2);
	});

	it("releases a canceled checkout even when its event precedes create receipt settlement", async () => {
		const h = harness();
		h.onTransactionCreated(async () => {
			h.remote = { ...h.remote, status: "canceled" };
			await h.deliver(h.rawEvent("transaction.canceled"));
		});
		expect(await h.create()).toHaveProperty("sessionId");
		const [hold] =
			await context.sql`SELECT closure_reason FROM paddle_checkout_reservations WHERE project_id=${project.projectInstanceId} AND billing_account_id=${h.billingAccountId}`;
		expect(hold.closure_reason).toBe("canceled");
		expect(h.writes).toBe(1);
	});

	it("does not release another account's checkout for mismatched cancellation evidence", async () => {
		const h = harness();
		await h.create();
		h.remote = { ...h.remote, status: "canceled", customer_id: unique("ctm") };
		await expect(h.deliver(h.rawEvent("transaction.canceled"))).rejects.toMatchObject({
			code: "PADDLE_FULFILLMENT_MISMATCH",
		});
		const [hold] =
			await context.sql`SELECT closed_at FROM paddle_checkout_reservations WHERE project_id=${project.projectInstanceId} AND billing_account_id=${h.billingAccountId}`;
		expect(hold.closed_at).toBeNull();
		expect(h.writes).toBe(1);
	});

	it("ignores canceled renewals and transactions without valid checkout correlation", async () => {
		const h = harness();
		await h.create();
		const created = h.remote;
		for (const change of [
			{ origin: "subscription_recurring" as const },
			{ custom_data: null },
			{ custom_data: { quotum: { operationId: "invalid", requestHash: "invalid" } } },
		]) {
			h.remote = { ...created, status: "canceled", ...change };
			expect(await h.deliver(h.rawEvent("transaction.canceled"))).toMatchObject({
				status: "ignored",
			});
			const [hold] =
				await context.sql`SELECT closed_at FROM paddle_checkout_reservations WHERE project_id=${project.projectInstanceId} AND billing_account_id=${h.billingAccountId}`;
			expect(hold.closed_at).toBeNull();
		}
		expect(h.writes).toBe(1);
	});

	it("blocks fresh checkout keys when a populated restore omitted legacy reservations", async () => {
		const h = harness();
		const receipt = await h.create();
		await context.sql`DELETE FROM paddle_checkout_reservations WHERE project_id=${project.projectInstanceId} AND billing_account_id=${h.billingAccountId}`;
		const flow = commercial(h, { kind: "checkout_product", productKey: "paddle_test" });
		const preview = await flow.preview();
		await expect(flow.execute(preview.previewToken)).rejects.toMatchObject({
			code: "PADDLE_CHECKOUT_PENDING",
		});
		await expect(
			h.service.createCheckoutSession({
				billingAccountId: h.billingAccountId,
				productKey: "paddle_test",
				idempotencyKey: "fresh",
			}),
		).rejects.toMatchObject({ code: "PADDLE_CHECKOUT_PENDING" });
		expect(await h.create()).toEqual({ ...receipt, duplicate: true });
		expect(h.writes).toBe(1);
		const [stored] =
			await context.sql`SELECT status FROM commercial_action_previews WHERE project_id=${project.projectInstanceId} AND preview_token=${preview.previewToken}`;
		expect(stored.status).toBe("previewed");
	});

	it("retains failed-key semantics and closes a rejected reservation after an interrupted local cleanup", async () => {
		const h = harness();
		h.rejectTransaction();
		await expect(h.create()).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_FAILED",
			details: { status: "failed" },
		});
		await expect(h.create()).rejects.toMatchObject({ code: "PROVIDER_OPERATION_FAILED" });
		await context.sql`UPDATE paddle_checkout_reservations SET closed_at=NULL, closure_reason=NULL WHERE project_id=${project.projectInstanceId} AND billing_account_id=${h.billingAccountId}`;
		expect(
			await h.service.createCheckoutSession({
				billingAccountId: h.billingAccountId,
				productKey: "paddle_test",
				idempotencyKey: "corrected",
			}),
		).toHaveProperty("sessionId");
		expect(h.writes).toBe(2);
	});

	it("returns 400 for invalid email and 409 for corrupt contexts without claiming or calling Paddle", async () => {
		const h = harness();
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
			"idempotency-key": "validation",
		};
		const bad = await testRequest(app, `${route}/preview`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				provider: "paddle",
				intent: { kind: "checkout_product", productKey: "paddle_test", email: "invalid" },
			}),
		});
		expect(bad.status).toBe(400);
		expect((await bad.json()).error.code).toBe("INVALID_REQUEST");
		await expect(
			h.service.createCheckoutSession({
				billingAccountId: h.billingAccountId,
				productKey: "paddle_test",
				idempotencyKey: "invalid",
				email: "invalid",
			}),
		).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
		const preview = await commercial(h, {
			kind: "checkout_product",
			productKey: "paddle_test",
			email: "payer@example.com",
		}).preview();
		await context.sql`UPDATE commercial_action_previews SET provider_context='{}'::jsonb WHERE project_id=${project.projectInstanceId} AND preview_token=${preview.previewToken}`;
		for (let attempt = 0; attempt < 2; attempt++) {
			const result = await testRequest(app, route, {
				method: "POST",
				headers,
				body: JSON.stringify({ previewToken: preview.previewToken }),
			});
			expect(result.status).toBe(409);
			expect((await result.json()).error.code).toBe("COMMERCIAL_PREVIEW_STALE");
		}
		expect(
			(
				await context.repository.getCommercialActionPreview(
					project,
					h.billingAccountId,
					preview.previewToken,
				)
			).status,
		).toBe("previewed");
		await context.sql`UPDATE commercial_action_previews SET status='executing', execution_idempotency_key='validation' WHERE project_id=${project.projectInstanceId} AND preview_token=${preview.previewToken}`;
		const retry = await testRequest(app, route, {
			method: "POST",
			headers,
			body: JSON.stringify({ previewToken: preview.previewToken }),
		});
		expect(retry.status).toBe(409);
		expect((await retry.json()).error.code).toBe("COMMERCIAL_PREVIEW_STALE");
		expect(
			await context.sql`SELECT id FROM paddle_checkout_reservations WHERE project_id=${project.projectInstanceId} AND billing_account_id=${h.billingAccountId}`,
		).toHaveLength(0);
		expect([h.writes, h.customerWrites]).toEqual([0, 0]);
	});

	const openReservations = (billingAccountId: string) =>
		context.sql`SELECT id FROM paddle_checkout_reservations WHERE project_id=${project.projectInstanceId} AND billing_account_id=${billingAccountId} AND closed_at IS NULL`;
	const customerOperations = (billingAccountId: string) =>
		context.sql<
			{
				idempotency_key: string;
				status: string;
				request: { email: string };
				error_code: string | null;
			}[]
		>`SELECT idempotency_key, status, request, error_code FROM provider_operations WHERE project_id=${project.projectInstanceId} AND billing_account_id=${billingAccountId} AND operation='customer.create' ORDER BY created_at`;
	const checkout = (h: ReturnType<typeof harness>, idempotencyKey: string, email?: string) =>
		h.service.createCheckoutSession({
			billingAccountId: h.billingAccountId,
			productKey: "paddle_test",
			email: email ?? `${h.billingAccountId}@example.com`,
			idempotencyKey,
		});

	// QA-02: a definite rejection created no Paddle customer, so it is terminal only for its own key.
	it("keeps a customer rejection terminal for its own key and lets a new key create the customer", async () => {
		const h = harness();
		h.rejectCustomer(400, "invalid_email");
		await expect(h.create()).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_FAILED",
			details: { status: "failed" },
		});
		await expect(h.create()).rejects.toMatchObject({ code: "PROVIDER_OPERATION_FAILED" });
		expect(await openReservations(h.billingAccountId)).toHaveLength(0);
		expect([h.writes, h.customerWrites]).toEqual([0, 1]);
		// A changed email under the same key is still a different request.
		await expect(checkout(h, "initial", "payer@example.com")).rejects.toMatchObject({
			code: "IDEMPOTENCY_CONFLICT",
		});
		// A corrected request with a new key creates the customer once; the first receipt stays failed.
		h.acceptCustomer();
		const recovered = await checkout(h, "corrected", "payer@example.com");
		expect(recovered).toMatchObject({ sessionId: h.remote.id, duplicate: false });
		expect([h.writes, h.customerWrites]).toEqual([1, 2]);
		const operations = await customerOperations(h.billingAccountId);
		expect(operations.map((operation) => [operation.status, operation.request.email])).toEqual([
			["failed", `${h.billingAccountId}@example.com`],
			["succeeded", "payer@example.com"],
		]);
		expect(operations[0]?.error_code).toBe("invalid_email");
		expect(await checkout(h, "corrected", "payer@example.com")).toEqual({
			...recovered,
			duplicate: true,
		});
		// The rejected key never dispatches a checkout later, even though the account now has a customer.
		await expect(h.create()).rejects.toMatchObject({ status: 409 });
		expect(h.writes).toBe(1);
	});

	it("lets a new key retry the same email after Paddle rate limits the customer write", async () => {
		const h = harness();
		h.rejectCustomer(429, "too_many_requests");
		// Paddle answered 429, so the write was refused and is a terminal receipt for this key; the
		// receipt names the rate limit so the caller knows a new key is the way forward.
		const refused = await h.create().catch((error: unknown) => error);
		expect(refused).toMatchObject({
			code: "PROVIDER_OPERATION_FAILED",
			status: 409,
			details: { status: "failed", errorCode: "PADDLE_RATE_LIMITED" },
		});
		expect((refused as Error).message).toContain("retry with a new Idempotency-Key");
		h.acceptCustomer();
		await Bun.sleep(10);
		await expect(h.create()).rejects.toMatchObject({ code: "PROVIDER_OPERATION_FAILED" });
		const recovered = await checkout(h, "fresh-attempt");
		expect(recovered).toMatchObject({ sessionId: h.remote.id, duplicate: false });
		expect(h.customerWrites).toBe(2);
		const operations = await customerOperations(h.billingAccountId);
		expect(operations.map((operation) => operation.status)).toEqual(["failed", "succeeded"]);
		expect(operations[0]?.error_code).toBe("PADDLE_RATE_LIMITED");
	});

	// QA-02: a cooldown that another tenant's 429 started refuses this write locally. Nothing was
	// sent, so it must not leave a terminal receipt (or a reservation) behind for the key.
	it("refuses a customer write during the shared cooldown without a receipt, and the same key then succeeds", async () => {
		const h = harness();
		h.onPriceRead((read) => {
			if (read === 1) h.coolDown(60_000);
		});
		const refused = await h.create().catch((error: unknown) => error);
		expect(refused).toMatchObject({
			code: "BILLING_PROVIDER_UNAVAILABLE",
			status: 503,
			details: { retryAfterSeconds: 60 },
		});
		expect(h.customerWrites).toBe(0);
		expect(await customerOperations(h.billingAccountId)).toHaveLength(0);
		expect(await openReservations(h.billingAccountId)).toHaveLength(0);
		h.coolDown(0);
		expect(await h.create()).toMatchObject({ sessionId: h.remote.id, duplicate: false });
		expect([h.writes, h.customerWrites]).toEqual([1, 1]);
	});

	it("refuses the checkout write during the shared cooldown without a receipt and resumes the same key", async () => {
		const h = harness();
		h.onPriceRead((read) => {
			// The second read belongs to the checkout step, after the customer already exists.
			if (read === 2) h.coolDown(60_000);
		});
		await expect(h.create()).rejects.toMatchObject({
			code: "BILLING_PROVIDER_UNAVAILABLE",
			status: 503,
		});
		expect([h.writes, h.customerWrites]).toEqual([0, 1]);
		const checkoutOperations =
			await context.sql`SELECT id FROM provider_operations WHERE project_id=${project.projectInstanceId} AND billing_account_id=${h.billingAccountId} AND operation='checkout.hosted'`;
		expect(checkoutOperations).toHaveLength(0);
		h.coolDown(0);
		expect(await h.create()).toMatchObject({ sessionId: h.remote.id, duplicate: false });
		expect([h.writes, h.customerWrites]).toEqual([1, 1]);
		expect(
			(await customerOperations(h.billingAccountId)).map((operation) => operation.status),
		).toEqual(["succeeded"]);
	});

	it("maps a rate limit or an outage on the price read to a retryable provider error", async () => {
		const limited = harness();
		limited.coolDown(30_000);
		await expect(limited.create()).rejects.toMatchObject({
			code: "BILLING_PROVIDER_UNAVAILABLE",
			status: 503,
			details: { retryAfterSeconds: 30 },
		});
		const down = harness();
		down.makePriceUnavailable();
		await expect(down.create()).rejects.toMatchObject({
			code: "BILLING_PROVIDER_UNAVAILABLE",
			status: 503,
		});
		for (const h of [limited, down]) {
			expect([h.writes, h.customerWrites]).toEqual([0, 0]);
			expect(await customerOperations(h.billingAccountId)).toHaveLength(0);
			expect(await openReservations(h.billingAccountId)).toHaveLength(0);
		}
		limited.coolDown(0);
		expect(await limited.create()).toMatchObject({ duplicate: false });
	});

	it("reports a provider outage and the shared cooldown as 503 over the trusted HTTP route", async () => {
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
		const send = async () =>
			await testRequest(
				app,
				`/v1/billing-accounts/${h.billingAccountId}/providers/paddle/checkout-sessions`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${integrationProjectCredential(project.projectInstanceKey)}`,
						"idempotency-key": "http-unavailable",
					},
					body: JSON.stringify({
						productKey: "paddle_test",
						email: `${h.billingAccountId}@example.com`,
					}),
				},
			);
		h.coolDown(45_000);
		const limited = await send();
		expect(limited.status).toBe(503);
		expect((await limited.json()).error).toMatchObject({
			code: "BILLING_PROVIDER_UNAVAILABLE",
			details: { retryAfterSeconds: 45 },
		});
		h.coolDown(0);
		h.makePriceUnavailable();
		const down = await send();
		expect(down.status).toBe(503);
		expect((await down.json()).error.code).toBe("BILLING_PROVIDER_UNAVAILABLE");
	});

	it("tells the caller why Paddle refused a customer for an email it already knows", async () => {
		const h = harness();
		h.rejectCustomer(409, "customer_already_exists");
		await expect(h.create()).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_FAILED",
			details: { status: "failed", errorCode: "customer_already_exists" },
		});
		// No customer was created or linked, so another key asks Paddle again instead of being
		// blocked by this key's receipt, and succeeds as soon as Paddle accepts the email.
		await expect(checkout(h, "second")).rejects.toMatchObject({
			details: { errorCode: "customer_already_exists" },
		});
		h.acceptCustomer();
		expect(await checkout(h, "third")).toMatchObject({ duplicate: false });
		expect(h.customerWrites).toBe(3);
	});

	it("does not block previews or other executions on a terminal customer rejection", async () => {
		const h = harness();
		const corrected = commercial(h, {
			kind: "checkout_product",
			productKey: "paddle_test",
			email: "corrected@example.com",
		});
		const original = commercial(h, {
			kind: "checkout_product",
			productKey: "paddle_test",
			email: `${h.billingAccountId}@example.com`,
		});
		const preview = await corrected.preview();
		const sameEmailPreview = await original.preview();
		h.rejectCustomer();
		await expect(h.create()).rejects.toMatchObject({ code: "PROVIDER_OPERATION_FAILED" });
		// New previews and the earlier previews' own keys are unaffected by the direct key's receipt.
		await expect(corrected.preview()).resolves.toHaveProperty("previewToken");
		await expect(original.preview()).resolves.toHaveProperty("previewToken");
		h.acceptCustomer();
		await expect(corrected.execute(preview.previewToken)).resolves.toMatchObject({
			kind: "checkout",
		});
		expect([h.writes, h.customerWrites]).toEqual([1, 2]);
		// The customer now exists, so the earlier preview is stale; a fresh one still meets the single
		// open reservation per account instead of checking out twice.
		await expect(original.execute(sameEmailPreview.previewToken)).rejects.toThrow(
			"changed after preview",
		);
		const next = await original.preview();
		await expect(original.execute(next.previewToken)).rejects.toMatchObject({
			code: "PADDLE_CHECKOUT_PENDING",
		});
		expect(await openReservations(h.billingAccountId)).toHaveLength(1);
	});

	it("blocks a new key while an earlier customer write is unresolved, before reserving or dispatching", async () => {
		const h = harness();
		h.loseCustomerResponse();
		await expect(h.create()).rejects.toMatchObject({ code: "PROVIDER_OPERATION_PENDING" });
		const corrected = commercial(h, {
			kind: "checkout_product",
			productKey: "paddle_test",
			email: "corrected@example.com",
		});
		await expect(checkout(h, "second", "corrected@example.com")).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_PENDING",
			details: { status: "reconciling" },
		});
		await expect(corrected.preview()).rejects.toMatchObject({ code: "PROVIDER_OPERATION_PENDING" });
		expect(h.customerWrites).toBe(1);
		expect(await openReservations(h.billingAccountId)).toHaveLength(1);
		// The first key resumes once recovery resolves the write against Paddle.
		const [row] = await context.sql<
			{ id: string }[]
		>`SELECT id FROM provider_operations WHERE project_id=${project.projectInstanceId} AND billing_account_id=${h.billingAccountId} AND operation='customer.create'`;
		if (!row) throw new Error("Missing customer operation");
		const store = context.repository.providerOperations;
		const lease = await store.claimReconciliation(project, h.billingAccountId, row.id);
		if (!lease) throw new Error("Missing lease");
		await store.settle(project, lease, await h.service.observeOperation(lease.operation));
		expect(await h.create()).toMatchObject({ sessionId: h.remote.id });
		expect([h.writes, h.customerWrites]).toEqual([1, 1]);
	});

	it("treats operations keyed by the account alone as before: failed ones no longer block, unresolved ones resume", async () => {
		const legacyKey = (account: string) => `customer:${sha256Hex(account)}`;
		// A failed account-keyed operation, as an earlier build stranded the account with.
		const stranded = harness();
		stranded.rejectCustomer();
		await expect(stranded.create()).rejects.toMatchObject({ code: "PROVIDER_OPERATION_FAILED" });
		await context.sql`UPDATE provider_operations SET idempotency_key=${legacyKey(stranded.billingAccountId)} WHERE project_id=${project.projectInstanceId} AND billing_account_id=${stranded.billingAccountId} AND operation='customer.create'`;
		stranded.acceptCustomer();
		expect(await checkout(stranded, "retry")).toMatchObject({ sessionId: stranded.remote.id });
		expect(stranded.customerWrites).toBe(2);
		// An account-keyed operation that was prepared and never dispatched is resumed, not duplicated.
		const waiting = harness();
		const email = `${waiting.billingAccountId}@example.com`;
		const request = { email };
		await context.repository.providerOperations.prepare(project, {
			billingAccountId: waiting.billingAccountId,
			provider: "paddle",
			providerAccountId: accountIdentity,
			connectionVersionId: waiting.config.versionId,
			idempotencyKey: legacyKey(waiting.billingAccountId),
			resourceKey: legacyKey(waiting.billingAccountId),
			operation: "customer.create",
			requestHash: sha256Hex(stableJson(request)),
			request,
		});
		await expect(checkout(waiting, "other-key", "different@example.com")).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_PENDING",
		});
		expect(await checkout(waiting, "resume")).toMatchObject({ sessionId: waiting.remote.id });
		expect(waiting.customerWrites).toBe(1);
		expect(await customerOperations(waiting.billingAccountId)).toHaveLength(1);
	});

	it("closes unbound reservations after preparation fails for common and direct checkout", async () => {
		for (const common of [true, false]) {
			const h = harness();
			const flow = commercial(h, {
				kind: "checkout_product",
				productKey: "paddle_test",
				email: "payer@example.com",
			});
			const preview = await flow.preview();
			const prepare = spyOn(context.repository.providerOperations, "prepare").mockRejectedValueOnce(
				new Error("Preparation failed before dispatch"),
			);
			try {
				await expect(common ? flow.execute(preview.previewToken) : h.create()).rejects.toThrow(
					"Preparation failed before dispatch",
				);
			} finally {
				prepare.mockRestore();
			}
			const [hold] =
				await context.sql`SELECT operation_id, closure_reason FROM paddle_checkout_reservations WHERE project_id=${project.projectInstanceId} AND billing_account_id=${h.billingAccountId}`;
			expect(hold).toMatchObject({ operation_id: null, closure_reason: "rejected" });
			expect([h.writes, h.customerWrites]).toEqual([0, 0]);
			const replacement = await flow.preview();
			expect(await flow.execute(replacement.previewToken)).toHaveProperty("sessionId");
			expect([h.writes, h.customerWrites]).toEqual([1, 1]);
		}
	});

	it("closes an already-claimed unbound preview when customer preflight fails", async () => {
		const h = harness();
		const flow = commercial(h, {
			kind: "checkout_product",
			productKey: "paddle_test",
			email: "corrected@example.com",
		});
		const preview = await flow.preview();
		// An unresolved customer write from another path (prepared, never dispatched) blocks this
		// attempt before it reserves or dispatches anything.
		const request = { email: `${h.billingAccountId}@example.com` };
		await context.repository.providerOperations.prepare(project, {
			billingAccountId: h.billingAccountId,
			provider: "paddle",
			providerAccountId: accountIdentity,
			connectionVersionId: h.config.versionId,
			idempotencyKey: `customer:${sha256Hex(h.billingAccountId)}:${sha256Hex("other-key")}`,
			resourceKey: `customer:${sha256Hex(h.billingAccountId)}`,
			operation: "customer.create",
			requestHash: sha256Hex(stableJson(request)),
			request,
		});
		// Reproduce an executing preview retained by an older runtime after customer preparation failed.
		await context.repository.beginCommercialActionExecution(project, {
			billingAccountId: h.billingAccountId,
			previewToken: preview.previewToken,
			intentHash: preview.intentHash,
			stateFingerprint: preview.stateFingerprint,
			idempotencyKey: "execute",
		});
		await expect(flow.execute(preview.previewToken, "execute")).rejects.toMatchObject({
			code: "PROVIDER_OPERATION_PENDING",
		});
		const [hold] =
			await context.sql`SELECT operation_id, closure_reason FROM paddle_checkout_reservations WHERE project_id=${project.projectInstanceId} AND preview_token=${preview.previewToken}`;
		expect(hold).toMatchObject({ operation_id: null, closure_reason: "rejected" });
		expect([h.writes, h.customerWrites]).toEqual([0, 0]);
	});
});
