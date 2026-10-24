import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	setSystemTime,
} from "bun:test";
import { readProjectionBalances } from "../../src/db/repository/entitlements";
import {
	applyMeterLimitConsumption,
	lockMeterLimitWindow,
	requireMeteredFeature,
	resolveMeterLimit,
} from "../../src/db/repository/metering-persistence";
import type { QueryExecutor } from "../../src/db/repository/types";
import { materializeUsageInvoicePeriod } from "../../src/db/repository/usage-invoice-periods";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import {
	seedPhase3MeteringCatalog,
	seedPhase3MeteringSubscription,
} from "./helpers/phase3-fixtures";

let context: LocalPostgresContext;
const project = () => integrationProjectContext();
describeLocalPostgres(describe, describe.skip)("meter-limit database clock", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3MeteringCatalog(context.sql);
		await seedPhase3MeteringSubscription(context.sql, "clock-cap", "workspace");
		await context.sql`UPDATE plan_versions SET billing_interval='year'`;
		await context.sql`UPDATE subscriptions SET starts_at=date_trunc('year',now()), current_period_start=date_trunc('year',now()), current_period_end=date_trunc('year',now())+interval '1 year', expires_at=date_trunc('year',now())+interval '1 year'`;
	});
	afterEach(() => setSystemTime());
	afterAll(() => context.sql.close());
	it("keeps consumption and projected balances in the DB month under both clock skews", async () => {
		const input = { billingAccountId: "clock-cap", featureId: "api_requests", value: "200" };
		expect(
			(
				await context.repository.usageApi.consume(project(), {
					...input,
					operationId: "fill-current",
				})
			).allowed,
		).toBe(true);
		const [clock] = await context.sql<
			{ next: Date; previous: Date }[]
		>`SELECT date_trunc('month',now())+interval '1 month 1 minute' AS next, date_trunc('month',now())-interval '1 minute' AS previous`;
		if (!clock) throw new Error("Missing clock");
		for (const [key, instant] of [
			["next", clock.next],
			["previous", clock.previous],
		] as const) {
			setSystemTime(instant);
			expect(
				(await context.repository.usageApi.consume(project(), { ...input, operationId: key }))
					.allowed,
			).toBe(false);
			const [customer] = await context.sql<
				{ id: string }[]
			>`SELECT id FROM customers WHERE billing_account_id='clock-cap'`;
			if (!customer) throw new Error("Missing customer");
			const balances = await readProjectionBalances(
				context.db as unknown as QueryExecutor,
				project().projectInstanceId,
				customer.id,
			);
			expect(balances.find((b) => b.featureKey === "api_requests")).toMatchObject({
				available: "0",
			});
		}
		const [totals] = await context.sql<
			{ windows: number; used: string; recorded_near_db: boolean }[]
		>`SELECT count(*)::int AS windows,sum(usage)::text AS used,(SELECT bool_and(abs(extract(epoch FROM recorded_at-clock_timestamp())) < 5) FROM usage_events) AS recorded_near_db FROM usage_windows`;
		expect(totals?.windows).toBe(1);
		expect(Number(totals?.used)).toBe(200);
		expect(totals?.recorded_near_db).toBe(true);
	});
	it("adjusts a materialized invoice when a pinned decision commits after closing", async () => {
		await context.sql`UPDATE plan_items SET overage_policy='allowed' WHERE item_kind='meter_limit'`;
		await context.sql`INSERT INTO price_components(project_id,plan_version_id,plan_item_id,key,component_kind,charge_timing,currency,unit_amount_minor,billing_units,billing_interval) SELECT project_id,plan_version_id,id,'clock-overage','metered_overage','in_arrears','USD',10,1,'month' FROM plan_items WHERE item_kind='meter_limit'`;
		const [customer] = await context.sql<
			{ id: string }[]
		>`SELECT id FROM customers WHERE billing_account_id='clock-cap'`;
		const [clock] = await context.sql<
			{ start: Date; end: Date }[]
		>`SELECT date_trunc('month',now())-interval '1 month' AS start,date_trunc('month',now()) AS end`;
		if (!customer || !clock) throw new Error("Missing fixture");
		const feature = await requireMeteredFeature(
			context.db as unknown as QueryExecutor,
			project().projectInstanceId,
			"api_requests",
		);
		const current = await resolveMeterLimit(
			context.db as unknown as QueryExecutor,
			project().projectInstanceId,
			customer.id,
			feature,
		);
		if (!current) throw new Error("Missing limit");
		// A decision selected before the boundary may wait on locks until its period has closed.
		const meterLimit = { ...current, windowStartAt: clock.start, windowEndAt: clock.end };
		const input = {
			projectId: project().projectInstanceId,
			customerId: customer.id,
			entityId: null,
			filterKey: null,
			meterLimit,
			quantity: "250",
		};
		const consume = (key: string) =>
			context.db.transaction(async (tx) => {
				const locked = await lockMeterLimitWindow(tx as unknown as QueryExecutor, input);
				return applyMeterLimitConsumption(tx as unknown as QueryExecutor, locked, {
					...input,
					occurredAt: null,
					metadata: {},
					projectionKey: key,
				});
			});
		expect((await consume("before-close")).allowed).toBe(true);
		const [window] = await context.sql<
			{
				subscription_id: string;
				anchor_plan_item_id: string;
				window_start_at: Date;
				window_end_at: Date;
			}[]
		>`SELECT * FROM usage_windows`;
		if (!window) throw new Error("Missing window");
		const period = await context.db.transaction((tx) =>
			materializeUsageInvoicePeriod(tx as unknown as QueryExecutor, {
				projectId: project().projectInstanceId,
				subscriptionId: window.subscription_id,
				planItemId: String(window.anchor_plan_item_id),
				periodStartAt: window.window_start_at,
				periodEndAt: window.window_end_at,
			}),
		);
		expect(period?.inserted).toBe(true);
		expect((await consume("after-close")).allowed).toBe(true);
		const [adjustment] = await context.sql<
			{ quantity: string; amount_minor: string }[]
		>`SELECT quantity::text,amount_minor::text FROM usage_invoice_adjustments`;
		expect(Number(adjustment?.quantity)).toBe(250);
		expect(Number(adjustment?.amount_minor)).toBe(2500);
	});
});
