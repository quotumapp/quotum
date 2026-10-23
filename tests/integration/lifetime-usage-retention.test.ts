import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";

let context: LocalPostgresContext;
const project = () => integrationProjectContext();
describeLocalPostgres(describe, describe.skip)("lifetime usage after raw retention", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3ControlCatalog(context.sql);
	});
	afterAll(() => context.sql.close());
	async function consume(quantity: string, key: string, entityId?: string) {
		return context.repository.consumeUsage(project(), {
			billingAccountId: "historical",
			featureKey: "ai_credits",
			quantity,
			idempotencyKey: key,
			entityId,
		});
	}
	async function history() {
		await context.repository.grantAllocation(project(), {
			billingAccountId: "historical",
			featureKey: "ai_credits",
			quantity: "100",
			sourceKind: "credit_grant",
			sourceKey: "history-wallet",
		});
		for (const externalId of ["a", "b"])
			await context.repository.controlsEnterprise.createEntity(project(), {
				billingAccountId: "historical",
				externalId,
				kind: "workspace",
			});
		await consume("10", "history-a", "a");
		const b = await consume("7", "history-b", "b");
		await consume("3", "history-shared");
		await context.repository.correctUsage(project(), {
			billingAccountId: "historical",
			originalUsageEventId: b.usageEventId ?? "",
			originalRecordedAt: new Date(b.recordedAt ?? ""),
			quantity: "2",
			idempotencyKey: "history-correction",
			actor: "qa",
			reason: "net history",
		});
		// Move the committed facts and their monthly aggregates together, preserving correction links.
		await context.sql`UPDATE usage_events SET recorded_at=recorded_at-interval '401 days', original_event_recorded_at=original_event_recorded_at-interval '401 days'`;
		await context.sql`UPDATE usage_event_rollups SET period_start_at=date_trunc('month',now()-interval '401 days'),period_end_at=date_trunc('month',now()-interval '401 days')+interval '1 month',status='closed',closed_at=now()`;
		await context.repository.runMeteringMaintenance(100);
		expect((await context.sql`SELECT id FROM usage_events`).length).toBe(0);
	}
	it("keeps whole-history account/entity counts after raw events are pruned", async () => {
		await history();
		for (const [entityId, limitValue] of [
			[undefined, "20"],
			["a", "9"],
			["b", "6"],
		] as const) {
			await context.repository.controlsEnterprise.upsertControl(project(), {
				billingAccountId: "historical",
				entityId,
				controlKind: "usage_limit",
				featureKey: "ai_credits",
				limitValue,
				interval: "lifetime",
				actor: "qa",
			});
		}
		const account = await context.repository.controlsEnterprise.listEffectiveControls(
			project(),
			"historical",
		);
		expect(account[0]?.consumedValue).toBe("18");
		expect((await consume("1", "denied-a", "a")).allowed).toBe(false);
		expect((await consume("2", "fill-account")).allowed).toBe(true);
		// A window left undercounted by an older release must not authorize fresh allowance.
		await context.sql`UPDATE control_windows SET consumed_value=0`;
		expect((await consume("1", "underseeded-window")).allowed).toBe(false);
		expect(
			(
				await context.repository.controlsEnterprise.listEffectiveControls(project(), "historical")
			)[0]?.consumedValue,
		).toBe("20");
	});
	it("seeds, crosses and rearms lifetime alerts without double-counting current deltas", async () => {
		await history();
		const alert = await context.repository.controlsEnterprise.createUsageAlert(project(), {
			billingAccountId: "historical",
			featureKey: "ai_credits",
			thresholdType: "absolute",
			thresholdValue: "20",
			interval: "lifetime",
			actor: "qa",
		});
		expect(alert).toMatchObject({ currentValue: "18", crossed: false });
		const crossing = await consume("2", "cross");
		expect(
			(await context.repository.controlsEnterprise.listUsageAlerts(project(), "historical"))[0],
		).toMatchObject({ currentValue: "20", crossed: true });
		await context.repository.correctUsage(project(), {
			billingAccountId: "historical",
			originalUsageEventId: crossing.usageEventId ?? "",
			originalRecordedAt: new Date(crossing.recordedAt ?? ""),
			quantity: "2",
			idempotencyKey: "rearm",
			actor: "qa",
			reason: "rearm",
		});
		expect(
			(await context.repository.controlsEnterprise.listUsageAlerts(project(), "historical"))[0],
		).toMatchObject({ currentValue: "18", crossed: false });
		await consume("2", "cross-again");
		expect(
			(
				await context.repository.controlsEnterprise.listUsageAlertEvents(
					project(),
					"historical",
					100,
				)
			)
				.map((e) => e.eventType)
				.reverse(),
		).toEqual(["threshold_crossed", "threshold_rearmed", "threshold_crossed"]);
	});
});
