import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { resetAndSeedIntegrationData } from "../integration/helpers/catalog-fixtures";
import {
	linkStripeCustomer,
	seedPhase3CatalogMigration,
	seedPhase3ControlCatalog,
	seedPhase3MeteringCatalog,
	seedPhase3MeteringSubscription,
} from "../integration/helpers/phase3-fixtures";
import { e2eApiKey, e2eOperatorKey, e2eServiceEnv } from "./helpers/e2e-env";
import { describeE2e } from "./helpers/gating";
import { type BillingServiceProcess, startBillingService } from "./helpers/service-process";

const e2eDescribe = describeE2e(describe, describe.skip);
const actor = "phase3-e2e";
let sql: SQL;
let service: BillingServiceProcess | null = null;

e2eDescribe("E2E Phase 3 release journeys", () => {
	beforeEach(async () => {
		const postgresUri = process.env.POSTGRES_URI;
		if (postgresUri === undefined || postgresUri.trim() === "") {
			throw new Error("POSTGRES_URI is required for E2E tests");
		}
		sql = new SQL(postgresUri, { max: 2, idleTimeout: 1, maxLifetime: 0 });
		await resetAndSeedIntegrationData(sql);
	});

	afterEach(async () => {
		await service?.stop();
		service = null;
		await sql?.close();
	});

	it("enforces controls and operator contracts and assigns licenses over the real HTTP process", async () => {
		await seedPhase3ControlCatalog(sql);
		await seedPhase3CatalogMigration(sql);
		await seedBalanceAllocation("phase3-http", "ai_credits", "20");
		service = await startBillingService(runtimeEnv());

		expect(
			(await putJson("/v1/billing-accounts/phase3-http/controls", {}, usageLimitBody("6"))).status,
		).toBe(401);
		expect(
			(
				await putJson(
					"/v1/billing-accounts/phase3-http/controls",
					actorHeaders(),
					usageLimitBody("6"),
				)
			).status,
		).toBe(200);
		expect(
			(
				await postJson("/v1/billing-accounts/phase3-http/usage-alerts", actorHeaders(), {
					featureKey: "ai_credits",
					thresholdType: "absolute",
					thresholdValue: "5",
					interval: "lifetime",
				})
			).status,
		).toBe(201);
		await consume("phase3-http", "3", "phase3-e2e:consume:1");
		await consume("phase3-http", "3", "phase3-e2e:consume:2");
		expect(await consume("phase3-http", "1", "phase3-e2e:consume:denied")).toMatchObject({
			allowed: false,
			reason: "control_limit_exceeded",
		});
		const events = await requireService().request(
			"/v1/billing-accounts/phase3-http/usage-alert-events",
			{ headers: authHeaders() },
		);
		expect((await events.json()).data).toMatchObject([
			{ eventType: "threshold_crossed", currentValue: "6.000000000" },
		]);
		const balance = await requireService().request(
			"/v1/billing-accounts/phase3-http/balances/ai_credits",
			{ headers: authHeaders() },
		);
		expect((await balance.json()).data).toMatchObject({
			granted: "20",
			consumed: "6",
			available: "14",
			breakdown: [{ sourceKind: "operator", quantity: "20", available: "14" }],
		});

		const contractIntent = {
			billingAccountId: "migration-stripe",
			contractKey: "e2e-enterprise",
			version: 1,
			planKey: "migration-plan",
			effectiveAt: new Date(Date.now() - 60_000).toISOString(),
			replacesCommercialDefaults: true,
			controls: [],
		};
		expect(
			(await postJson("/v1/admin/contracts/preview", actorHeaders(), contractIntent)).status,
		).toBe(401);
		const preview = await postJson(
			"/v1/admin/contracts/preview",
			operatorHeaders(),
			contractIntent,
		);
		expect(preview.status).toBe(200);
		const previewData = (await preview.json()).data;
		expect(
			(
				await postJson("/v1/admin/contracts/publish", operatorHeaders(), {
					...contractIntent,
					previewToken: previewData.previewToken,
				})
			).status,
		).toBe(200);

		expect(
			(
				await postJson("/v1/billing-accounts/migration-stripe/entities", authHeaders(), {
					externalId: "e2e-workspace",
					kind: "workspace",
				})
			).status,
		).toBe(201);
		const pools = await requireService().request(
			"/v1/billing-accounts/migration-stripe/license-pools",
			{ headers: authHeaders() },
		);
		const [pool] = (await pools.json()).data as Array<{ id: string }>;
		expect(
			(
				await postJson(
					"/v1/billing-accounts/migration-stripe/license-assignments",
					actorHeaders(),
					{ poolId: pool?.id, entityId: "e2e-workspace", quantity: 7 },
				)
			).status,
		).toBe(201);
		const license = await requireService().request(
			"/v1/billing-accounts/migration-stripe/entities/e2e-workspace/licenses/licensed_seats?quantity=7",
			{ headers: authHeaders() },
		);
		expect((await license.json()).data).toMatchObject({ allowed: true, assignedQuantity: 7 });
	});

	it("materializes one rollover across a real worker run and service restart", async () => {
		await seedPhase3MeteringCatalog(sql);
		await seedPhase3MeteringSubscription(sql, "phase3-rollover", "rollover-workspace");
		await sql`
			INSERT INTO balance_allocations (
				project_id, customer_id, feature_id, plan_item_id, subscription_id,
				source_kind, source_key, quantity, consumed_quantity,
				period_start_at, period_end_at, expires_at
			)
			SELECT project.id, customer.id, feature.id, item.id, subscription.id,
				'subscription', 'e2e:rollover:origin', 100, 60,
				now() - interval '1 month 1 hour', now() - interval '1 hour', now() - interval '1 hour'
			FROM projects project
			JOIN customers customer ON customer.project_id = project.id
				AND customer.billing_account_id = 'phase3-rollover'
			JOIN subscriptions subscription ON subscription.project_id = customer.project_id
				AND subscription.customer_id = customer.id
			JOIN features feature ON feature.project_id = project.id AND feature.key = 'ai_credits'
			JOIN plan_items item ON item.project_id = project.id
				AND item.plan_version_id = subscription.plan_version_id
				AND item.feature_id = feature.id AND item.item_kind = 'allocation'
			WHERE project.key = 'voysee'
		`;

		service = await startBillingService(runtimeEnv());
		await waitFor(async () => {
			const response = await requireService().request(
				"/v1/billing-accounts/phase3-rollover/balances/ai_credits",
				{ headers: authHeaders() },
			);
			if (response.status !== 200) return false;
			return (await response.json()).data.available === "25";
		}, "rollover balance");
		await service.stop();
		service = await startBillingService(runtimeEnv());
		await waitFor(async () => (await rolloverCount()) === 1, "single rollover after restart");
		const [rollover] = await sql<
			Array<{ quantity: string; origin: string | null; revision: number | null }>
		>`
			SELECT quantity::text AS quantity, rollover_origin_allocation_id::text AS origin,
				rollover_policy_revision AS revision
			FROM balance_allocations WHERE source_kind = 'rollover'
		`;
		expect(rollover).toEqual({ quantity: "25.000000000", origin: expect.any(String), revision: 1 });
	});

	it("executes an automatic top-up and catalog migration once through the fake Stripe process", async () => {
		await seedPhase3ControlCatalog(sql);
		await seedPhase3CatalogMigration(sql);
		await linkStripeCustomer(sql, "phase3-topup", "cus_phase3_topup");
		await seedBalanceAllocation("phase3-topup", "ai_credits", "10");
		service = await startBillingService(fakeStripeRuntimeEnv(), {
			entrypoint: "src/testing/test-stripe-entrypoint.ts",
		});

		expect(
			(
				await putJson("/v1/billing-accounts/phase3-topup/auto-topup", actorHeaders(), {
					featureKey: "ai_credits",
					topupKey: "credits_10",
					provider: "stripe",
					thresholdQuantity: "5",
					cooldownSeconds: 30,
					limitIntervalSeconds: 86400,
					maxPurchasesPerInterval: 2,
					maxSpendMinor: 1000,
					maxConsecutiveFailures: 3,
				})
			).status,
		).toBe(200);
		await consume("phase3-topup", "6", "phase3-e2e:topup-trigger");

		const migrationIntent = {
			fromPlanKey: "migration-plan",
			fromVersion: 1,
			toPlanKey: "migration-plan",
			toVersion: 2,
			effectiveMode: "immediate",
		};
		const preview = await postJson(
			"/v1/admin/catalog-migrations/preview",
			operatorHeaders(),
			migrationIntent,
		);
		const previewData = (await preview.json()).data;
		expect(
			(
				await postJson("/v1/admin/catalog-migrations/publish", operatorHeaders(), {
					...migrationIntent,
					previewToken: previewData.previewToken,
				})
			).status,
		).toBe(200);

		await waitFor(async () => {
			const [state] = await sql<Array<{ topup: number; applied: number; skipped: number }>>`
				SELECT
					(SELECT count(*)::integer FROM auto_topup_jobs WHERE status = 'succeeded') AS topup,
					(SELECT count(*)::integer FROM catalog_migration_jobs WHERE status = 'applied') AS applied,
					(SELECT count(*)::integer FROM catalog_migration_jobs WHERE status = 'skipped') AS skipped
			`;
			return state?.topup === 1 && state.applied === 1 && state.skipped === 1;
		}, "automatic top-up and catalog migration");
		const beforeRestart = await commercialCounts();
		expect(beforeRestart).toEqual({
			jobs: 1,
			purchases: 1,
			invoices: 1,
			allocations: 1,
			migrations: 2,
		});

		await service.stop();
		service = await startBillingService(fakeStripeRuntimeEnv(), {
			entrypoint: "src/testing/test-stripe-entrypoint.ts",
		});
		await Bun.sleep(350);
		expect(await commercialCounts()).toEqual(beforeRestart);
		const balance = await requireService().request(
			"/v1/billing-accounts/phase3-topup/balances/ai_credits",
			{ headers: authHeaders() },
		);
		expect((await balance.json()).data).toMatchObject({
			granted: "20",
			consumed: "6",
			available: "14",
		});
	});
});

function runtimeEnv(): NodeJS.ProcessEnv {
	return e2eServiceEnv({
		postgresUri: process.env.POSTGRES_URI ?? "",
		overrides: {
			BILLING_WORKER_POLL_INTERVAL_MS: "3600000",
			BILLING_STORE_EVENT_REPLAY_POLL_INTERVAL_MS: "3600000",
			BILLING_METERING_MAINTENANCE_POLL_INTERVAL_MS: "100",
		},
	});
}

function fakeStripeRuntimeEnv(): NodeJS.ProcessEnv {
	return {
		...runtimeEnv(),
		BILLING_ENV: "test",
		BILLING_TEST_FAKE_STRIPE: "true",
		BILLING_TEST_FAKE_STRIPE_PRICE_AMOUNTS_JSON: JSON.stringify({ price_credits_10: 499 }),
	};
}

async function seedBalanceAllocation(
	billingAccountId: string,
	featureKey: string,
	quantity: string,
): Promise<void> {
	await sql`
		INSERT INTO customers (project_id, billing_account_id)
		SELECT id, ${billingAccountId} FROM projects WHERE key = 'voysee'
		ON CONFLICT (project_id, billing_account_id) DO NOTHING
	`;
	await sql`
		INSERT INTO balance_allocations (
			project_id, customer_id, feature_id, source_kind, source_key, quantity
		)
		SELECT project.id, customer.id, feature.id, 'operator', ${`e2e:${billingAccountId}`},
			${quantity}::numeric
		FROM projects project
		JOIN customers customer ON customer.project_id = project.id
			AND customer.billing_account_id = ${billingAccountId}
		JOIN features feature ON feature.project_id = project.id AND feature.key = ${featureKey}
		WHERE project.key = 'voysee'
	`;
}

async function consume(billingAccountId: string, quantity: string, idempotencyKey: string) {
	const response = await postJson(
		`/v1/billing-accounts/${billingAccountId}/usage/consume`,
		{ ...authHeaders(), "idempotency-key": idempotencyKey },
		{ featureKey: "ai_credits", quantity },
	);
	expect(response.status).toBe(200);
	return (await response.json()).data as { allowed: boolean; reason: string | null };
}

async function rolloverCount(): Promise<number> {
	const [row] = await sql<Array<{ count: number }>>`
		SELECT count(*)::integer AS count FROM balance_allocations WHERE source_kind = 'rollover'
	`;
	return row?.count ?? 0;
}

async function commercialCounts(): Promise<{
	jobs: number;
	purchases: number;
	invoices: number;
	allocations: number;
	migrations: number;
}> {
	const [row] = await sql<
		Array<{
			jobs: number;
			purchases: number;
			invoices: number;
			allocations: number;
			migrations: number;
		}>
	>`
		SELECT
			(SELECT count(*)::integer FROM auto_topup_jobs) AS jobs,
			(SELECT count(*)::integer FROM purchases) AS purchases,
			(SELECT count(*)::integer FROM billing_invoices) AS invoices,
			(SELECT count(*)::integer FROM balance_allocations WHERE source_kind = 'topup') AS allocations,
			(SELECT count(*)::integer FROM catalog_migration_jobs) AS migrations
	`;
	if (row === undefined) throw new Error("Commercial counts are unavailable");
	return row;
}

function usageLimitBody(limitValue: string) {
	return {
		controlKind: "usage_limit",
		featureKey: "ai_credits",
		limitValue,
		interval: "lifetime",
	};
}

function authHeaders(): HeadersInit {
	return { authorization: `Bearer ${e2eApiKey}` };
}

function actorHeaders(): HeadersInit {
	return { ...authHeaders(), "x-billing-actor": actor };
}

function operatorHeaders(): HeadersInit {
	return { ...actorHeaders(), "x-billing-operator-key": e2eOperatorKey };
}

async function postJson(path: string, headers: HeadersInit, body: unknown): Promise<Response> {
	return await requireService().request(path, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

async function putJson(path: string, headers: HeadersInit, body: unknown): Promise<Response> {
	return await requireService().request(path, {
		method: "PUT",
		headers: { ...headers, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function requireService(): BillingServiceProcess {
	if (service === null) throw new Error("Billing service is not running");
	return service;
}

async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await Bun.sleep(100);
	}
	throw new Error(`Timed out waiting for ${label}\n${service?.logs() ?? ""}`);
}
