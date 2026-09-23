import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import {
	closeUsageWindows,
	overageFeatureKey,
	seedOverageSubscriber,
} from "./helpers/overage-fixtures";
import { seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";

const project = integrationProjectContext();
const account = "filtered-spend";
const featureKey = overageFeatureKey(account);
let context: LocalPostgresContext;

describeLocalPostgres(describe, describe.skip)("spend controls across invoice filters", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3ControlCatalog(context.sql);
		await seedOverageSubscriber(context.sql, { account, provider: "stripe" });
		await context.sql`UPDATE features SET filter_dimensions=ARRAY['region']::text[] WHERE key=${featureKey}`;
		await setCap("60");
	});
	afterAll(async () => {
		await context.sql.close();
	});

	it("shares the included allowance while retaining scoped balances and read-only checks", async () => {
		expect(await consume("us", "75", "first")).toMatchObject({
			allowed: true,
			balance: { consumed: "75" },
		});
		const input = {
			billingAccountId: account,
			featureKey,
			quantity: "75",
			filters: { region: "eu" },
		};
		expect(await context.repository.checkUsage(project, input)).toMatchObject({
			allowed: false,
			reason: "control_limit_exceeded",
			balance: { consumed: "0" },
		});
		expect(await consume("eu", "75", "second")).toMatchObject({
			allowed: false,
			reason: "control_limit_exceeded",
		});
		expect(await spent()).toBe(25);
		expect(await consume("eu", "70", "fits")).toMatchObject({
			allowed: true,
			balance: { consumed: "70" },
		});
		expect(await spent()).toBe(60);
		await closeUsageWindows(context.sql);
		await context.repository.materializeAndClaimUsageInvoicePeriods("filter-test", 10);
		const [invoice] =
			await context.sql`SELECT usage_quantity::text AS quantity, amount_minor FROM usage_invoice_periods`;
		expect(Number(invoice?.quantity)).toBe(145);
		expect(Number(invoice?.amount_minor)).toBe(60);
	});

	it("serializes concurrent creation of distinct filtered windows", async () => {
		const results = await Promise.all([
			consume("us", "75", "race-us"),
			consume("eu", "75", "race-eu"),
		]);
		expect(results.filter((r) => r.allowed)).toHaveLength(1);
		expect(results.filter((r) => !r.allowed)).toHaveLength(1);
		expect(await spent()).toBe(25);
		const [usage] = await context.sql`SELECT sum(usage)::text AS quantity FROM usage_windows`;
		expect(Number(usage?.quantity)).toBe(75);
	});

	it("rates cross-filter reservations and confirmation against the shared allowance", async () => {
		expect(await consume("us", "75", "consume")).toMatchObject({ allowed: true });
		const reserve = (quantity: string, key: string) =>
			context.repository.reserveUsage(project, {
				billingAccountId: account,
				featureKey,
				quantity,
				filters: { region: "eu" },
				idempotencyKey: key,
				expiresInSeconds: 300,
			});
		expect(await reserve("75", "too-much")).toMatchObject({
			allowed: false,
			reason: "control_limit_exceeded",
		});
		const held = await reserve("70", "fits");
		expect(held).toMatchObject({ allowed: true, status: "active" });
		expect(await spent(true)).toBe(60);
		expect(
			await context.repository.confirmUsageReservation(project, {
				billingAccountId: account,
				reservationId: held.reservationId ?? "",
				quantity: "70",
				idempotencyKey: "confirm",
			}),
		).toMatchObject({ allowed: true, status: "confirmed" });
		expect(await spent()).toBe(60);
		expect(await spent(true)).toBe(60);
	});

	it.each(["subscription", "item"])(
		"uses scoped usage for confirmation when a historical window lacks %s identity",
		async (missing) => {
			await setCap("1000");
			await consume("us", "75", "before");
			const held = await context.repository.reserveUsage(project, {
				billingAccountId: account,
				featureKey,
				quantity: "20",
				filters: { region: "us" },
				idempotencyKey: "hold",
				expiresInSeconds: 300,
			});
			await clearWindowIdentity(missing);
			expect(
				await context.repository.confirmUsageReservation(project, {
					billingAccountId: account,
					reservationId: held.reservationId ?? "",
					quantity: "20",
					idempotencyKey: "confirm",
				}),
			).toMatchObject({ allowed: true, status: "confirmed" });
			expect(await spent()).toBe(35);
		},
	);

	it.each(["subscription", "item"])(
		"uses scoped usage for correction when a historical window lacks %s identity",
		async (missing) => {
			const first = await consume("us", "75", "before");
			await clearWindowIdentity(missing);
			await context.repository.correctUsage(project, {
				billingAccountId: account,
				originalUsageEventId: first.usageEventId ?? "",
				originalRecordedAt: new Date(first.recordedAt ?? ""),
				quantity: "25",
				idempotencyKey: "correct",
				actor: "integration-test",
				reason: "duplicate",
			});
			expect(await spent()).toBe(13);
		},
	);

	it("rerates a correction using total usage while restoring only its original filter", async () => {
		await setCap("1000");
		const first = await consume("us", "75", "us");
		await consume("eu", "75", "eu");
		expect(await spent()).toBe(63);
		await context.repository.correctUsage(project, {
			billingAccountId: account,
			originalUsageEventId: first.usageEventId ?? "",
			originalRecordedAt: new Date(first.recordedAt ?? ""),
			quantity: "25",
			idempotencyKey: "correct",
			actor: "integration-test",
			reason: "duplicate",
		});
		expect(await spent()).toBe(50);
		const rows = await context.sql<
			Array<{ usage: string }>
		>`SELECT usage::text FROM usage_windows ORDER BY usage`;
		expect(rows.map((r) => Number(r.usage))).toEqual([50, 75]);
		await closeUsageWindows(context.sql);
		await context.repository.materializeAndClaimUsageInvoicePeriods("filter-test", 10);
		const [invoice] = await context.sql`SELECT amount_minor FROM usage_invoice_periods`;
		expect(Number(invoice?.amount_minor)).toBe(50);
	});
});
function consume(region: string, quantity: string, idempotencyKey: string) {
	return context.repository.consumeUsage(project, {
		billingAccountId: account,
		featureKey,
		quantity,
		filters: { region },
		idempotencyKey,
	});
}
async function setCap(limitValue: string) {
	await context.repository.controlsEnterprise.upsertControl(project, {
		billingAccountId: account,
		controlKind: "spend_limit",
		featureKey: null,
		currency: "USD",
		limitValue,
		interval: "month",
		actor: "integration-test",
	});
}
async function spent(includeHolds = false) {
	const [row] =
		await context.sql`SELECT consumed_value::text AS consumed,held_value::text AS held FROM control_windows`;
	return Number(row?.consumed ?? 0) + (includeHolds ? Number(row?.held ?? 0) : 0);
}

async function clearWindowIdentity(missing: string) {
	await context.sql`UPDATE usage_windows SET
		subscription_id = CASE WHEN ${missing} = 'subscription' THEN NULL ELSE subscription_id END,
		anchor_plan_item_id = CASE WHEN ${missing} = 'item' THEN NULL ELSE anchor_plan_item_id END`;
}
