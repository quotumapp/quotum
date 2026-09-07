import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SQL } from "bun";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

localDescribe("authoritative metering flows", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedMeteringCatalog(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("enforces the raw reservation ceiling even when the wallet has spare credits", async () => {
		const project = integrationProjectContext();
		const billingAccountId = "ceiling";
		await context.repository.grantAllocation(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "ceiling",
		});
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const reserved = await context.repository.reserveUsage(project, {
			billingAccountId,
			featureKey: "model_tokens",
			quantity: "100",
			idempotencyKey: "reserve",
		});
		const path = `/v1/billing-accounts/${billingAccountId}/usage/reservations/${reserved.reservationId}/confirm`;
		const rejected = await app.request(path, {
			method: "POST",
			headers: jsonHeaders(authHeaders(), "confirm-over"),
			body: JSON.stringify({ quantity: "200" }),
		});
		expect(rejected.status).toBe(409);
		expect((await rejected.json()).error.code).toBe("RESERVATION_QUANTITY_EXCEEDED");
		expect(
			await context.repository.getMeteringBalance(project, billingAccountId, "ai_credits"),
		).toMatchObject({ held: "0.5", consumed: "0", available: "9.5" });
		expect(await countRows(context.sql, "usage_events")).toBe(0);
		expect((await context.sql`SELECT status FROM reservations`)[0].status).toBe("active");
		const confirmed = await context.repository.confirmUsageReservation(project, {
			billingAccountId,
			reservationId: reserved.reservationId ?? "",
			quantity: "100",
			idempotencyKey: "confirm-exact",
		});
		expect(confirmed).toMatchObject({
			status: "confirmed",
			balance: { held: "0", consumed: "0.5" },
		});
		expect(
			await context.repository.releaseUsageReservation(project, {
				billingAccountId,
				reservationId: reserved.reservationId ?? "",
				idempotencyKey: "release-after-confirm",
			}),
		).toMatchObject({ status: "confirmed", usageEventId: confirmed.usageEventId });
		expect(await countRows(context.sql, "usage_events")).toBe(1);
	});

	it("enforces the same ceiling for capped meters", async () => {
		await seedMeterLimitSubscription(context.sql, "cap-ceiling", "workspace_1");
		const project = integrationProjectContext();
		const reserved = await context.repository.reserveUsage(project, {
			billingAccountId: "cap-ceiling",
			featureKey: "api_requests",
			entityId: "workspace_1",
			quantity: "25",
			idempotencyKey: "reserve",
		});
		expect(reserved.allowed).toBe(true);
		await expect(
			context.repository.confirmUsageReservation(project, {
				billingAccountId: "cap-ceiling",
				reservationId: reserved.reservationId ?? "",
				quantity: "26",
				idempotencyKey: "confirm",
			}),
		).rejects.toMatchObject({ code: "RESERVATION_QUANTITY_EXCEEDED" });
		expect(await countRows(context.sql, "usage_events")).toBe(0);
		expect((await context.sql`SELECT status FROM reservations`)[0].status).toBe("active");
	});

	it("reuses logically expired capacity before maintenance and returns stable expiry outcomes", async () => {
		const project = integrationProjectContext();
		const billingAccountId = "logical-expiry";
		const subject = { billingAccountId, featureKey: "model_tokens", quantity: "200" };
		await context.repository.grantAllocation(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity: "1",
			sourceKind: "operator",
			sourceKey: "expiry",
		});
		await context.repository.controlsEnterprise.upsertControl(project, {
			billingAccountId,
			controlKind: "usage_limit",
			featureKey: "model_tokens",
			currency: null,
			limitValue: "200",
			interval: "month",
			actor: "test",
		});
		const reserved = await context.repository.reserveUsage(project, {
			...subject,
			idempotencyKey: "reserve",
		});
		expect(reserved).toMatchObject({ allowed: true, balance: { held: "1", available: "0" } });
		await context.sql`UPDATE reservations SET effective_at=clock_timestamp()-interval '10 minutes',created_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 second' WHERE id=${reserved.reservationId}`;
		const check = await context.repository.checkUsage(project, subject);
		expect(check).toMatchObject({ allowed: true, balance: { held: "0", available: "1" } });
		expect((await context.sql`SELECT status FROM reservations`)[0].status).toBe("active");
		const consumed = await context.repository.consumeUsage(project, {
			...subject,
			idempotencyKey: "reuse",
		});
		expect(consumed).toMatchObject({
			allowed: true,
			balance: { consumed: "1", held: "0", available: "0" },
		});
		for (const key of ["expired-once", "expired-again"]) {
			expect(
				await context.repository.confirmUsageReservation(project, {
					billingAccountId,
					reservationId: reserved.reservationId ?? "",
					quantity: "200",
					idempotencyKey: key,
				}),
			).toMatchObject({
				allowed: false,
				reason: "reservation_expired",
				status: "expired",
				usageEventId: null,
			});
		}
		expect(await countRows(context.sql, "usage_events")).toBe(1);
		expect(
			(await context.sql`SELECT finalized_at=expires_at AS logical FROM reservations`)[0].logical,
		).toBe(true);
	});

	it("normalizes the default reservation TTL for retry identity", async () => {
		const project = integrationProjectContext();
		const billingAccountId = "default-ttl";
		await context.repository.grantAllocation(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity: "1",
			sourceKind: "operator",
			sourceKey: "ttl",
		});
		const input = {
			billingAccountId,
			featureKey: "model_tokens",
			quantity: "100",
			idempotencyKey: "same-generation",
		};
		const start = Date.now();
		const reserved = await context.repository.reserveUsage(project, input);
		expect(new Date(reserved.expiresAt ?? "").getTime() - start).toBeGreaterThanOrEqual(300_000);
		expect(
			await context.repository.reserveUsage(project, { ...input, expiresInSeconds: 300 }),
		).toEqual(reserved);
		await expect(
			context.repository.reserveUsage(project, { ...input, expiresInSeconds: 301 }),
		).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
	});

	it("requires explicit rate activation when a published meter was absent from purchased terms", async () => {
		const project = integrationProjectContext();
		await seedMeterLimitSubscription(context.sql, "new-meter", "workspace_1");
		await context.sql`
          WITH revision AS (
            INSERT INTO catalog_revisions(project_id,revision,status,intent_hash,created_by,published_at)
            VALUES(${project.projectInstanceId},2,'published',repeat('b',64),'test',now()) RETURNING id,project_id
          ), meter AS (
            INSERT INTO features(project_id,key,name,kind,meter_kind,unit,credit_scale)
            VALUES(${project.projectInstanceId},'new_meter','New meter','metered','consumable','unit',0) RETURNING id
          ), rate AS (
            INSERT INTO rate_card_entries(project_id,catalog_revision_id,meter_feature_id,wallet_feature_id,rate_per_unit)
            SELECT revision.project_id,revision.id,meter.id,wallet.id,1 FROM revision,meter,features wallet WHERE wallet.project_id=revision.project_id AND wallet.key='ai_credits'
          ) UPDATE projects SET published_catalog_revision_id=revision.id FROM revision WHERE projects.id=revision.project_id
        `;
		const subject = {
			billingAccountId: "new-meter",
			featureKey: "new_meter",
			quantity: "1",
			idempotencyKey: "new-meter",
		};
		await expect(context.repository.checkUsage(project, subject)).rejects.toMatchObject({
			code: "METER_RATE_NOT_ACTIVATED",
		});
		await expect(context.repository.consumeUsage(project, subject)).rejects.toMatchObject({
			code: "METER_RATE_NOT_ACTIVATED",
		});
		await expect(context.repository.reserveUsage(project, subject)).rejects.toMatchObject({
			code: "METER_RATE_NOT_ACTIVATED",
		});
		expect(await countRows(context.sql, "usage_events")).toBe(0);
		expect(await countRows(context.sql, "reservations")).toBe(0);
		expect(await countRows(context.sql, "client_idempotency_claims")).toBe(0);
	});
	it("converts raw usage exactly, records an inline deduction receipt, and replays duplicate keys", async () => {
		await context.repository.grantAllocation(integrationProjectContext(), {
			billingAccountId: "account_1",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "fixture:account_1",
		});
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		expect(
			await context.repository.checkUsage(integrationProjectContext(), {
				billingAccountId: "account_1",
				featureKey: "model_tokens",
				quantity: "125",
			}),
		).toMatchObject({ allowed: true, walletQuantity: "0.625" });

		const check = await usageRequest(app, authHeaders(), "account_1", "check", {
			featureKey: "model_tokens",
			quantity: "125",
		});
		const consumed = await usageRequest(
			app,
			authHeaders(),
			"account_1",
			"consume",
			{ featureKey: "model_tokens", quantity: "125" },
			"generation:1",
		);
		const duplicate = await usageRequest(
			app,
			authHeaders(),
			"account_1",
			"consume",
			{ featureKey: "model_tokens", quantity: "125" },
			"generation:1",
		);

		expect(check.status).toBe(200);
		expect((await check.json()).data).toMatchObject({
			allowed: true,
			walletQuantity: "0.625",
			rateCard: { path: "additive", revision: 1, ratePerUnit: "0.005" },
			balance: { available: "10" },
		});
		expect(consumed.status).toBe(200);
		const consumedData = (await consumed.json()).data;
		expect(consumedData).toMatchObject({
			allowed: true,
			walletQuantity: "0.625",
			balance: { consumed: "0.625", available: "9.375" },
		});
		expect(consumedData.usageEventId).toEqual(expect.any(String));
		expect(consumedData.deductions).toEqual([
			expect.objectContaining({ quantity: "0.625", sourceKey: "fixture:account_1" }),
		]);
		expect(duplicate.status).toBe(200);
		expect((await duplicate.json()).data).toEqual(consumedData);

		const events = await context.sql<
			Array<{
				quantity: string;
				wallet_quantity: string;
				rate_card_path: string;
				deductions: Array<{ quantity: string }>;
			}>
		>`
			SELECT quantity::text, wallet_quantity::text, rate_card_path, deductions
			FROM usage_events
			WHERE id = ${consumedData.usageEventId}
		`;
		expect(events).toEqual([
			{
				quantity: "125.000000000",
				wallet_quantity: "0.625000000",
				rate_card_path: "additive",
				deductions: [expect.objectContaining({ quantity: "0.625" })],
			},
		]);
	});

	it("explores signed usage with cursors, series, and a provider-neutral billing summary", async () => {
		await context.repository.grantAllocation(integrationProjectContext(), {
			billingAccountId: "insights_account",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "fixture:insights_account",
		});
		const original = await context.repository.consumeUsage(integrationProjectContext(), {
			billingAccountId: "insights_account",
			featureKey: "model_tokens",
			quantity: "400",
			idempotencyKey: "insights:consume",
		});
		await context.repository.correctUsage(integrationProjectContext(), {
			billingAccountId: "insights_account",
			originalUsageEventId: original.usageEventId ?? "",
			originalRecordedAt: new Date(original.recordedAt ?? ""),
			quantity: "100",
			idempotencyKey: "insights:correction",
			actor: "integration-test",
			reason: "remove duplicated tokens",
		});
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});

		const firstPage = await app.request(
			"/v1/billing-accounts/insights_account/usage/events?limit=1",
			{ headers: authHeaders() },
		);
		expect(firstPage.status).toBe(200);
		const firstBody = await firstPage.json();
		expect(firstBody.data).toEqual([
			expect.objectContaining({
				operation: "correction",
				featureKey: "model_tokens",
				quantity: "-100",
				walletQuantity: "-0.5",
			}),
		]);
		expect(firstBody.pagination.nextCursor).toEqual(expect.any(String));

		const secondPage = await app.request(
			`/v1/billing-accounts/insights_account/usage/events?limit=1&cursor=${encodeURIComponent(firstBody.pagination.nextCursor)}`,
			{ headers: authHeaders() },
		);
		expect(secondPage.status).toBe(200);
		expect((await secondPage.json()).data).toEqual([
			expect.objectContaining({
				operation: "consume",
				quantity: "400",
				walletQuantity: "2",
			}),
		]);

		const series = await app.request(
			"/v1/billing-accounts/insights_account/usage/series?interval=day",
			{ headers: authHeaders() },
		);
		expect(series.status).toBe(200);
		expect((await series.json()).data).toEqual([
			expect.objectContaining({
				featureKey: "model_tokens",
				quantity: "300",
				walletQuantity: "1.5",
				eventCount: 2,
			}),
		]);

		const summary = await app.request("/v1/billing-accounts/insights_account/billing-summary", {
			headers: authHeaders(),
		});
		expect(summary.status).toBe(200);
		expect((await summary.json()).data).toMatchObject({
			schemaVersion: 1,
			billingAccountId: "insights_account",
			customerExists: true,
			balances: [
				expect.objectContaining({ featureKey: "ai_credits", available: "8.5", held: "0" }),
			],
			usage: [],
			recentInvoices: [],
		});
	});

	it("serializes concurrent reservations and confirms or releases held capacity", async () => {
		await context.repository.grantAllocation(integrationProjectContext(), {
			billingAccountId: "account_2",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "fixture:account_2",
		});
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const [first, second] = await Promise.all([
			reserveRequest(app, authHeaders(), "account_2", "reserve:1", "1400"),
			reserveRequest(app, authHeaders(), "account_2", "reserve:2", "1400"),
		]);
		const results = [await first.json(), await second.json()];
		const accepted = results.find((result) => result.data.allowed === true)?.data;
		const denied = results.find((result) => result.data.allowed === false)?.data;

		expect(accepted).toMatchObject({ walletQuantity: "7", status: "active" });
		expect(denied).toMatchObject({
			reason: "insufficient_balance",
			reservationId: null,
			balance: { available: "3", held: "7" },
		});

		const confirm = await app.request(
			`/v1/billing-accounts/account_2/usage/reservations/${accepted.reservationId}/confirm`,
			{
				method: "POST",
				headers: jsonHeaders(authHeaders(), "confirm:1"),
				body: JSON.stringify({ quantity: "1000" }),
			},
		);
		expect(confirm.status).toBe(200);
		expect((await confirm.json()).data).toMatchObject({
			status: "confirmed",
			balance: { consumed: "5", held: "0", available: "5" },
		});

		const third = await reserveRequest(app, authHeaders(), "account_2", "reserve:3", "800");
		const thirdData = (await third.json()).data;
		expect(thirdData).toMatchObject({ allowed: true, walletQuantity: "4", status: "active" });
		const release = await app.request(
			`/v1/billing-accounts/account_2/usage/reservations/${thirdData.reservationId}/release`,
			{
				method: "POST",
				headers: jsonHeaders(authHeaders(), "release:1"),
				body: JSON.stringify({}),
			},
		);
		expect(release.status).toBe(200);
		expect((await release.json()).data).toMatchObject({
			status: "released",
			balance: { consumed: "5", held: "0", available: "5" },
		});
	});

	it("suppresses worker redelivery in its own idempotency lane", async () => {
		await context.repository.grantAllocation(integrationProjectContext(), {
			billingAccountId: "worker_account",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "fixture:worker_account",
		});
		const input = {
			billingAccountId: "worker_account",
			featureKey: "model_tokens",
			quantity: "200",
			deliveryId: "usage-delivery:1",
			requestContextId: "request-context:1",
		};
		const accepted = await context.repository.consumeWorkerUsage(
			integrationProjectContext(),
			input,
		);
		const redelivery = await context.repository.consumeWorkerUsage(
			integrationProjectContext(),
			input,
		);

		expect(accepted).toMatchObject({
			applied: true,
			result: { allowed: true, walletQuantity: "1", balance: { available: "9" } },
		});
		expect(redelivery).toEqual({ applied: false, result: null });
		const [counts] = await context.sql<
			Array<{ client_claims: number; worker_claims: number; usage_events: number }>
		>`
			SELECT
				(SELECT count(*)::integer FROM client_idempotency_claims) AS client_claims,
				(SELECT count(*)::integer FROM worker_delivery_claims) AS worker_claims,
				(SELECT count(*)::integer FROM usage_events) AS usage_events
		`;
		expect(counts).toEqual({ client_claims: 0, worker_claims: 1, usage_events: 1 });
	});

	it("records append-only partial corrections and restores only eligible source allocations", async () => {
		await context.repository.grantAllocation(integrationProjectContext(), {
			billingAccountId: "correction_account",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "fixture:correction_account",
		});
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const consumed = await usageRequest(
			app,
			authHeaders(),
			"correction_account",
			"consume",
			{ featureKey: "model_tokens", quantity: "400" },
			"correction:consume",
		);
		const original = (await consumed.json()).data;
		const correction = await app.request(
			`/v1/billing-accounts/correction_account/usage/events/${original.usageEventId}/corrections`,
			{
				method: "POST",
				headers: {
					...jsonHeaders(authHeaders(), "correction:partial"),
					"x-billing-actor": "product-worker",
				},
				body: JSON.stringify({
					originalRecordedAt: original.recordedAt,
					quantity: "100",
					reason: "generation returned fewer tokens",
				}),
			},
		);

		expect(correction.status).toBe(200);
		const correctionData = (await correction.json()).data;
		expect(correctionData).toMatchObject({
			originalUsageEventId: original.usageEventId,
			quantity: "-100",
			walletQuantity: "-0.5",
			balance: { consumed: "1.5", available: "8.5" },
			deductions: [expect.objectContaining({ quantity: "-0.5" })],
		});

		const finalCorrection = await context.repository.correctUsage(integrationProjectContext(), {
			billingAccountId: "correction_account",
			originalUsageEventId: original.usageEventId,
			originalRecordedAt: new Date(original.recordedAt),
			quantity: "300",
			idempotencyKey: "correction:final",
			actor: "billing-test",
			reason: "fully reverse the remaining usage",
		});
		expect(finalCorrection).toMatchObject({
			quantity: "-300",
			walletQuantity: "-1.5",
			balance: { consumed: "0", available: "10" },
		});

		const events = await context.sql<
			Array<{
				operation: string;
				quantity: string;
				wallet_quantity: string;
				original_event_id: string | null;
				metadata: Record<string, unknown>;
			}>
		>`
			SELECT
				operation,
				quantity::text,
				wallet_quantity::text,
				original_event_id,
				metadata
			FROM usage_events
			WHERE customer_id = (
				SELECT id FROM customers WHERE billing_account_id = 'correction_account'
			)
			ORDER BY recorded_at, id
		`;
		expect(
			events.map(({ operation, quantity, wallet_quantity }) => ({
				operation,
				quantity,
				wallet_quantity,
			})),
		).toEqual([
			{ operation: "consume", quantity: "400.000000000", wallet_quantity: "2.000000000" },
			{ operation: "correction", quantity: "-100.000000000", wallet_quantity: "-0.500000000" },
			{ operation: "correction", quantity: "-300.000000000", wallet_quantity: "-1.500000000" },
		]);
		expect(events[1]).toMatchObject({
			original_event_id: original.usageEventId,
			metadata: { actor: "product-worker", reason: "generation returned fewer tokens" },
		});
	});

	it("coalesces filtered entity caps and serializes consume, reserve, confirm, and correction", async () => {
		await seedMeterLimitSubscription(context.sql, "cap_account", "workspace_1");
		const [attachment] = await context.sql<
			Array<{
				subscriptions: number;
				plan_items: number;
				entities: number;
				active_versions: number;
			}>
		>`
			SELECT
				(SELECT count(*)::integer FROM subscriptions) AS subscriptions,
				(SELECT count(*)::integer FROM plan_items WHERE item_kind = 'meter_limit') AS plan_items,
				(SELECT count(*)::integer FROM entities) AS entities,
				(SELECT count(*)::integer FROM plans WHERE active_version_id IS NOT NULL) AS active_versions
		`;
		expect(attachment).toEqual({
			subscriptions: 1,
			plan_items: 1,
			entities: 1,
			active_versions: 1,
		});
		const project = integrationProjectContext();
		const subject = {
			billingAccountId: "cap_account",
			featureKey: "api_requests",
			entityId: "workspace_1",
			filters: { region: "us", model: "opus" },
		};

		expect(
			await context.repository.checkUsage(project, { ...subject, quantity: "125" }),
		).toMatchObject({
			allowed: true,
			walletQuantity: "125",
			balance: { granted: "200", consumed: "0", held: "0", available: "200" },
			rateCard: { path: "direct" },
		});
		expect(await countRows(context.sql, "usage_windows")).toBe(0);

		const consumed = await context.repository.consumeUsage(project, {
			...subject,
			quantity: "125",
			idempotencyKey: "cap:consume",
		});
		const [first, second] = await Promise.all([
			context.repository.reserveUsage(project, {
				...subject,
				filters: { model: "opus", region: "us" },
				quantity: "50",
				expiresInSeconds: 300,
				idempotencyKey: "cap:reserve:1",
			}),
			context.repository.reserveUsage(project, {
				...subject,
				quantity: "50",
				expiresInSeconds: 300,
				idempotencyKey: "cap:reserve:2",
			}),
		]);
		const accepted = [first, second].find((result) => result.allowed);
		const denied = [first, second].find((result) => !result.allowed);

		expect(consumed).toMatchObject({
			allowed: true,
			walletQuantity: "125",
			balance: { consumed: "125", available: "75" },
		});
		expect(accepted).toMatchObject({
			allowed: true,
			status: "active",
			balance: { consumed: "125", held: "50", available: "25" },
		});
		expect(denied).toMatchObject({
			allowed: false,
			reason: "insufficient_balance",
			reservationId: null,
			balance: { consumed: "125", held: "50", available: "25" },
		});
		if (accepted?.reservationId === null || accepted?.reservationId === undefined) {
			throw new Error("Expected one accepted cap reservation");
		}

		const confirmed = await context.repository.confirmUsageReservation(project, {
			billingAccountId: "cap_account",
			reservationId: accepted.reservationId,
			quantity: "40",
			idempotencyKey: "cap:confirm",
		});
		expect(confirmed).toMatchObject({
			allowed: true,
			status: "confirmed",
			balance: { granted: "200", consumed: "165", held: "0", available: "35" },
		});

		const corrected = await context.repository.correctUsage(project, {
			billingAccountId: "cap_account",
			originalUsageEventId: consumed.usageEventId ?? "",
			originalRecordedAt: new Date(consumed.recordedAt ?? ""),
			quantity: "25",
			idempotencyKey: "cap:correction",
			actor: "integration-test",
			reason: "request batch was partially rejected",
		});
		expect(corrected).toMatchObject({
			quantity: "-25",
			walletQuantity: "-25",
			balance: { granted: "200", consumed: "140", held: "0", available: "60" },
		});

		const windows = await context.sql<
			Array<{ usage: string; external_id: string; filter_key: string | null }>
		>`
			SELECT windows.usage::text, entities.external_id, windows.filter_key
			FROM usage_windows windows
			JOIN entities ON entities.project_id = windows.project_id AND entities.id = windows.entity_id
			WHERE entities.external_id = 'workspace_1'
		`;
		expect(windows).toEqual([
			{ usage: "140.000000000", external_id: "workspace_1", filter_key: expect.any(String) },
		]);
		expect(await countRows(context.sql, "usage_windows")).toBe(1);
	});

	it("rolls unused subscription allocations once with cap, expiry, and provenance", async () => {
		await seedMeterLimitSubscription(context.sql, "account_rollover", "workspace_rollover");
		const [origin] = await context.sql<Array<{ id: string }>>`
			INSERT INTO balance_allocations (
				project_id, customer_id, feature_id, plan_item_id, subscription_id,
				source_kind, source_key, quantity, consumed_quantity,
				period_start_at, period_end_at, expires_at
			)
			SELECT project.id, customer.id, feature.id, item.id, subscription.id,
				'subscription', 'rollover:fixture:origin', 100, 60,
				now() - INTERVAL '1 month 1 hour', now() - INTERVAL '1 hour',
				now() - INTERVAL '1 hour'
			FROM projects project
			JOIN customers customer ON customer.project_id = project.id
				AND customer.billing_account_id = 'account_rollover'
			JOIN subscriptions subscription ON subscription.project_id = customer.project_id
				AND subscription.customer_id = customer.id
			JOIN features feature ON feature.project_id = project.id AND feature.key = 'ai_credits'
			JOIN plan_items item ON item.project_id = project.id
				AND item.plan_version_id = subscription.plan_version_id
				AND item.feature_id = feature.id AND item.item_kind = 'allocation'
			WHERE project.key = 'voysee'
			RETURNING id::text
		`;
		expect(origin?.id).toEqual(expect.any(String));

		const first = await context.repository.runMeteringMaintenance(50);
		expect(first.rolledOverAllocations).toBe(1);
		const balance = await context.repository.getMeteringBalance(
			integrationProjectContext(),
			"account_rollover",
			"ai_credits",
		);
		expect(balance).toMatchObject({
			granted: "25",
			consumed: "0",
			held: "0",
			available: "25",
			breakdown: [
				{
					sourceKind: "rollover",
					quantity: "25",
					available: "25",
					rolloverOriginAllocationId: origin?.id,
					rolloverPolicyRevision: 1,
				},
			],
		});
		expect(balance.breakdown[0]?.expiresAt).not.toBeNull();
		const [processed] = await context.sql<Array<{ processed: boolean }>>`
			SELECT rollover_processed_at IS NOT NULL AS processed
			FROM balance_allocations WHERE id = ${origin?.id}::bigint
		`;
		expect(processed?.processed).toBe(true);
		expect((await context.repository.runMeteringMaintenance(50)).rolledOverAllocations).toBe(0);
	});

	it("enforces monetary spend limits over tier-aware overage and reverses exact correction exposure", async () => {
		await seedMeterLimitSubscription(context.sql, "account_spend", "workspace_spend");
		await context.sql`
			UPDATE plan_items item SET overage_policy = 'allowed'
			FROM features feature
			WHERE feature.project_id = item.project_id AND feature.id = item.feature_id
				AND feature.key = 'api_requests'
		`;
		await context.sql`
			INSERT INTO price_components (
				project_id, plan_version_id, plan_item_id, key, component_kind, charge_timing,
				currency, unit_amount_minor, billing_units, billing_interval
			)
			SELECT item.project_id, item.plan_version_id, item.id, 'api_overage',
				'metered_overage', 'in_arrears', 'USD', 200, 100, 'month'
			FROM plan_items item
			JOIN features feature ON feature.project_id = item.project_id AND feature.id = item.feature_id
			WHERE feature.key = 'api_requests'
		`;
		await context.repository.controlsEnterprise.upsertControl(integrationProjectContext(), {
			billingAccountId: "account_spend",
			controlKind: "spend_limit",
			currency: "USD",
			limitValue: "300",
			interval: "lifetime",
			actor: "integration-test",
		});

		const first = await context.repository.consumeUsage(integrationProjectContext(), {
			billingAccountId: "account_spend",
			featureKey: "api_requests",
			quantity: "300",
			idempotencyKey: "spend:first",
		});
		expect(first).toMatchObject({ allowed: true, balance: { consumed: "300" } });
		const denied = await context.repository.consumeUsage(integrationProjectContext(), {
			billingAccountId: "account_spend",
			featureKey: "api_requests",
			quantity: "100",
			idempotencyKey: "spend:denied",
		});
		expect(denied).toMatchObject({
			allowed: false,
			reason: "control_limit_exceeded",
			control: {
				kind: "spend_limit",
				limitValue: "300",
				currentValue: "200",
				requestedValue: "200",
				remainingValue: "100",
			},
		});

		await context.repository.correctUsage(integrationProjectContext(), {
			billingAccountId: "account_spend",
			originalUsageEventId: first.usageEventId ?? "",
			originalRecordedAt: new Date(first.recordedAt ?? ""),
			quantity: "100",
			idempotencyKey: "spend:correction",
			actor: "integration-test",
			reason: "remove duplicate requests",
		});
		const afterCorrection = await context.repository.consumeUsage(integrationProjectContext(), {
			billingAccountId: "account_spend",
			featureKey: "api_requests",
			quantity: "100",
			idempotencyKey: "spend:after-correction",
		});
		expect(afterCorrection).toMatchObject({ allowed: true, balance: { consumed: "300" } });
		const [control] = await context.sql<Array<{ consumed: string; receipts: number }>>`
			SELECT control_window.consumed_value::text AS consumed,
				(SELECT count(*)::integer FROM usage_event_control_entries) AS receipts
			FROM control_windows control_window
			JOIN control_policies policy ON policy.id = control_window.control_policy_id
			WHERE policy.control_kind = 'spend_limit'
		`;
		expect(control).toEqual({ consumed: "200.000000000", receipts: 3 });
	});

	it("expires holds, closes periods, and sweeps bounded metering state", async () => {
		await context.repository.grantAllocation(integrationProjectContext(), {
			billingAccountId: "maintenance_account",
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "fixture:maintenance_account",
		});
		await context.repository.consumeUsage(integrationProjectContext(), {
			billingAccountId: "maintenance_account",
			featureKey: "model_tokens",
			quantity: "100",
			idempotencyKey: "maintenance:consume",
		});
		await context.repository.reserveUsage(integrationProjectContext(), {
			billingAccountId: "maintenance_account",
			featureKey: "model_tokens",
			quantity: "100",
			expiresInSeconds: 300,
			idempotencyKey: "maintenance:reserve",
		});

		await context.sql`
			UPDATE reservations
			SET effective_at = now() - INTERVAL '2 hours', expires_at = now() - INTERVAL '1 hour'
			WHERE status = 'active'
		`;
		await context.sql`
			UPDATE client_idempotency_claims
			SET created_at = now() - INTERVAL '9 days', completed_at = now() - INTERVAL '8 days',
				result_expires_at = now() - INTERVAL '7 days', expires_at = now() - INTERVAL '1 day'
		`;
		await context.sql`
			INSERT INTO worker_delivery_claims (
				project_id, delivery_id, request_context_id, created_at, expires_at
			)
			SELECT id, 'maintenance:delivery', 'maintenance:request',
				now() - INTERVAL '2 days', now() - INTERVAL '1 day'
			FROM projects WHERE key = 'voysee'
		`;
		await context.sql`
			UPDATE usage_event_rollups
			SET period_start_at = now() - INTERVAL '2 months',
				period_end_at = now() - INTERVAL '1 month'
		`;
		await context.sql`
			UPDATE usage_events SET recorded_at = now() - INTERVAL '401 days'
		`;

		const result = await context.repository.runMeteringMaintenance(50);
		expect(result).toEqual({
			expiredReservations: 1,
			rolledOverAllocations: 0,
			closedPeriods: 1,
			deletedClientClaims: 2,
			deletedWorkerClaims: 1,
			expiredCatalogDrafts: 0,
			deletedRawUsageEvents: 1,
		});
		expect(await countRows(context.sql, "usage_events")).toBe(0);
		expect(await countRows(context.sql, "client_idempotency_claims")).toBe(0);
		expect(await countRows(context.sql, "worker_delivery_claims")).toBe(0);
		const [state] = await context.sql<Array<{ reservation_status: string; rollup_status: string }>>`
			SELECT
				(SELECT status FROM reservations LIMIT 1) AS reservation_status,
				(SELECT status FROM usage_event_rollups LIMIT 1) AS rollup_status
		`;
		expect(state).toEqual({ reservation_status: "expired", rollup_status: "closed" });
	});
});

async function seedMeteringCatalog(sql: SQL): Promise<void> {
	await sql`
		WITH project AS (
			SELECT id FROM projects WHERE key = 'voysee'
		), revision AS (
			INSERT INTO catalog_revisions (project_id, revision, status, intent_hash, created_by, published_at)
			SELECT id, 1, 'published', repeat('a', 64), 'integration-test', now()
			FROM project
			RETURNING id, project_id
		), wallets AS (
			INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
			SELECT project_id, 'ai_credits', 'AI credits', 'metered', 'consumable', 'credit', 3
			FROM revision
			RETURNING id, project_id
		), meters AS (
			INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
			SELECT project_id, 'model_tokens', 'Model tokens', 'metered', 'consumable', 'token', 0
			FROM revision
			RETURNING id, project_id
		), caps AS (
			INSERT INTO features (
				project_id, key, name, kind, meter_kind, unit, credit_scale, filter_dimensions
			)
			SELECT project_id, 'api_requests', 'API requests', 'metered', 'consumable',
				'request', 0, ARRAY['model', 'region']::text[]
			FROM revision
			RETURNING id, project_id
		), cap_plan AS (
			INSERT INTO plans (project_id, key, name)
			SELECT project_id, 'api_monthly', 'API Monthly' FROM revision
			RETURNING id, project_id
		), cap_version AS (
			INSERT INTO plan_versions (
				project_id, plan_id, catalog_revision_id, version, status,
				currency, base_amount_minor, billing_interval
			)
			SELECT cap_plan.project_id, cap_plan.id, revision.id, 1, 'published', 'USD', 999, 'month'
			FROM cap_plan, revision
			RETURNING id, project_id, plan_id
		), cap_item AS (
			INSERT INTO plan_items (
				project_id, plan_version_id, feature_id, item_kind, quantity, reset_interval
			)
			SELECT cap_version.project_id, cap_version.id, caps.id, 'meter_limit', 200, 'month'
			FROM cap_version, caps
		), wallet_item AS (
			INSERT INTO plan_items (
				project_id, plan_version_id, feature_id, item_kind, quantity, reset_interval,
				rollover_enabled, rollover_max_quantity, rollover_expiry_mode,
				rollover_expiry_months
			)
			SELECT cap_version.project_id, cap_version.id, wallets.id, 'allocation', 100, 'month',
				true, 25, 'months', 2
			FROM cap_version, wallets
		), rate AS (
			INSERT INTO rate_card_entries (
				project_id,
				catalog_revision_id,
				meter_feature_id,
				wallet_feature_id,
				rate_per_unit
			)
			SELECT revision.project_id, revision.id, meters.id, wallets.id, 0.005
			FROM revision, meters, wallets
		)
		UPDATE projects
		SET published_catalog_revision_id = revision.id
		FROM revision
		WHERE projects.id = revision.project_id
	`;
	await sql`
		UPDATE plans
		SET active_version_id = plan_versions.id, updated_at = now()
		FROM plan_versions
		WHERE plans.project_id = plan_versions.project_id
			AND plans.id = plan_versions.plan_id
			AND plans.key = 'api_monthly'
			AND plan_versions.version = 1
	`;
}

async function seedMeterLimitSubscription(
	sql: SQL,
	billingAccountId: string,
	entityExternalId: string,
): Promise<void> {
	await sql`
		WITH customer AS (
			INSERT INTO customers (project_id, billing_account_id)
			SELECT id, ${billingAccountId} FROM projects WHERE key = 'voysee'
			RETURNING id, project_id
		), entity AS (
			INSERT INTO entities (project_id, customer_id, external_id, kind)
			SELECT project_id, id, ${entityExternalId}, 'workspace' FROM customer
		), target AS (
			SELECT
				customer.id AS customer_id,
				customer.project_id,
				products.id AS product_id,
				store_products.id AS store_product_id,
				plan_versions.id AS plan_version_id,
				plan_versions.catalog_revision_id
			FROM customer
			JOIN products ON products.project_id = customer.project_id AND products.key = 'premium_monthly'
			JOIN store_products ON store_products.project_id = products.project_id
				AND store_products.product_id = products.id
				AND store_products.provider = 'stripe'
			JOIN plans ON plans.project_id = customer.project_id AND plans.key = 'api_monthly'
			JOIN plan_versions ON plan_versions.project_id = plans.project_id
				AND plan_versions.id = plans.active_version_id
		)
		INSERT INTO subscriptions (
			project_id, customer_id, product_id, store_product_id, provider, channel,
			external_subscription_id, external_product_id, external_price_id, status,
			starts_at, expires_at, current_period_start, current_period_end,
			plan_version_id, catalog_revision_id
		)
		SELECT
			project_id, customer_id, product_id, store_product_id, 'stripe', 'web',
			${`subscription:${billingAccountId}`}, 'prod_stripe_premium', 'price_premium_monthly',
			'active', date_trunc('month', now()), date_trunc('month', now()) + INTERVAL '1 month',
			date_trunc('month', now()), date_trunc('month', now()) + INTERVAL '1 month',
			plan_version_id, catalog_revision_id
		FROM target
	`;
}

async function countRows(sql: SQL, table: string): Promise<number> {
	const [row] = await sql.unsafe<{ count: number }[]>(
		`SELECT count(*)::integer AS count FROM ${table}`,
	);
	return row?.count ?? 0;
}

function usageRequest(
	app: ReturnType<typeof createIntegrationApp>["app"],
	authHeaders: HeadersInit,
	billingAccountId: string,
	operation: "check" | "consume",
	body: Record<string, unknown>,
	idempotencyKey?: string,
) {
	return app.request(`/v1/billing-accounts/${billingAccountId}/usage/${operation}`, {
		method: "POST",
		headers: jsonHeaders(authHeaders, idempotencyKey),
		body: JSON.stringify(body),
	});
}

function reserveRequest(
	app: ReturnType<typeof createIntegrationApp>["app"],
	authHeaders: HeadersInit,
	billingAccountId: string,
	idempotencyKey: string,
	quantity: string,
) {
	return app.request(`/v1/billing-accounts/${billingAccountId}/usage/reservations`, {
		method: "POST",
		headers: jsonHeaders(authHeaders, idempotencyKey),
		body: JSON.stringify({
			featureKey: "model_tokens",
			quantity,
			expiresInSeconds: 300,
		}),
	});
}

function jsonHeaders(authHeaders: HeadersInit, idempotencyKey?: string): HeadersInit {
	return {
		...authHeaders,
		"content-type": "application/json",
		...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
	};
}
