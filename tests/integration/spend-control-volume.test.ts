import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { overageFeatureKey, seedOverageSubscriber } from "./helpers/overage-fixtures";
import { seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
let context: LocalPostgresContext;

/**
 * Volume pricing charges the whole billable quantity at the tier it lands in, so one more unit
 * can lower the total: 100 billable units cost 200, 101 cost 161 (12 each plus a 40 flat fee).
 * A spend limit must follow that signed movement instead of rejecting the request.
 */
localDescribe("spend controls over volume-priced overage", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3ControlCatalog(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("records a falling charge as lower exposure and still denies the next real increase", async () => {
		await seedOverageSubscriber(context.sql, {
			account: "volume-fall",
			provider: "stripe",
			pricingModel: "volume",
		});
		await seedOverageSubscriber(context.sql, {
			account: "volume-cap",
			provider: "stripe",
			pricingModel: "volume",
		});
		await upsertSpendLimit("volume-fall", "10000");
		await upsertSpendLimit("volume-cap", "280");

		expect(await consume("volume-fall", "125", "first")).toMatchObject({ allowed: true });
		expect(await spendExposure("volume-fall")).toBe("200");
		const step = await consume("volume-fall", "1", "boundary");
		expect(step).toMatchObject({ allowed: true, balance: { consumed: "126" } });
		expect(await spendExposure("volume-fall")).toBe("161");
		expect(await controlEntries(step.usageEventId)).toEqual(["-39"]);

		expect(await consume("volume-fall", "100", "climb")).toMatchObject({ allowed: true });
		expect(await spendExposure("volume-fall")).toBe("281");

		// Correcting the boundary event lowers usage by one unit and the charge by one minor unit.
		await context.repository.correctUsage(project, {
			billingAccountId: "volume-fall",
			originalUsageEventId: step.usageEventId ?? "",
			originalRecordedAt: new Date(step.recordedAt ?? ""),
			quantity: "1",
			idempotencyKey: "volume-fall:correct",
			actor: "integration-test",
			reason: "duplicate call",
		});
		expect(await spendExposure("volume-fall")).toBe("280");

		expect(await consume("volume-cap", "125", "first")).toMatchObject({ allowed: true });
		expect(await consume("volume-cap", "1", "boundary")).toMatchObject({ allowed: true });
		expect(await spendExposure("volume-cap")).toBe("161");
		expect(await consume("volume-cap", "100", "climb")).toMatchObject({
			allowed: false,
			reason: "control_limit_exceeded",
			control: {
				kind: "spend_limit",
				limitValue: "280",
				currentValue: "161",
				requestedValue: "120",
				remainingValue: "119",
			},
		});
		expect(await spendExposure("volume-cap")).toBe("161");
	});

	it("holds nothing for a falling charge and confirms the signed target", async () => {
		await seedOverageSubscriber(context.sql, {
			account: "volume-hold",
			provider: "stripe",
			pricingModel: "volume",
		});
		await upsertSpendLimit("volume-hold", "10000");
		expect(await consume("volume-hold", "125", "first")).toMatchObject({ allowed: true });

		const reservation = await context.repository.reserveUsage(project, {
			billingAccountId: "volume-hold",
			featureKey: overageFeatureKey("volume-hold"),
			quantity: "1",
			idempotencyKey: "volume-hold:reserve",
			expiresInSeconds: 300,
		});
		expect(reservation).toMatchObject({ allowed: true, status: "active" });
		expect(await spendWindow("volume-hold")).toEqual({ consumed: "200", held: "0", holds: 0 });

		const confirmation = await context.repository.confirmUsageReservation(project, {
			billingAccountId: "volume-hold",
			reservationId: reservation.reservationId ?? "",
			quantity: "1",
			idempotencyKey: "volume-hold:confirm",
		});
		expect(confirmation).toMatchObject({ allowed: true, status: "confirmed" });
		expect(await spendWindow("volume-hold")).toEqual({ consumed: "161", held: "0", holds: 0 });
		expect(await controlEntries(confirmation.usageEventId)).toEqual(["-39"]);
	});
});

async function upsertSpendLimit(billingAccountId: string, limitValue: string): Promise<void> {
	await context.repository.controlsEnterprise.upsertControl(project, {
		billingAccountId,
		controlKind: "spend_limit",
		featureKey: null,
		currency: "USD",
		limitValue,
		interval: "month",
		actor: "integration-test",
	});
}

async function consume(billingAccountId: string, quantity: string, step: string) {
	return await context.repository.consumeUsage(project, {
		billingAccountId,
		featureKey: overageFeatureKey(billingAccountId),
		quantity,
		idempotencyKey: `${billingAccountId}:${step}`,
	});
}

async function spendExposure(billingAccountId: string): Promise<string> {
	return (await spendWindow(billingAccountId)).consumed;
}

async function spendWindow(
	billingAccountId: string,
): Promise<{ consumed: string; held: string; holds: number }> {
	const [row] = await context.sql<Array<{ consumed: string; held: string; holds: number }>>`
		SELECT trim(trailing '.' FROM trim(trailing '0' FROM control_window.consumed_value::text)) AS consumed,
			trim(trailing '.' FROM trim(trailing '0' FROM control_window.held_value::text)) AS held,
			(
				SELECT count(*)::integer FROM reservation_control_holds hold
				WHERE hold.project_id = control_window.project_id
					AND hold.control_window_id = control_window.id
			) AS holds
		FROM control_windows control_window
		JOIN control_policies policy
			ON policy.project_id = control_window.project_id
			AND policy.id = control_window.control_policy_id
		JOIN customers customer
			ON customer.project_id = control_window.project_id
			AND customer.id = control_window.customer_id
		WHERE control_window.project_id = ${project.projectInstanceId}::uuid
			AND customer.billing_account_id = ${billingAccountId}
			AND policy.control_kind = 'spend_limit'
	`;
	if (row === undefined) throw new Error(`No spend control window for ${billingAccountId}`);
	return row;
}

async function controlEntries(usageEventId: string | null): Promise<string[]> {
	if (usageEventId === null) throw new Error("Expected an accepted usage event");
	const rows = await context.sql<Array<{ value: string }>>`
		SELECT trim(trailing '.' FROM trim(trailing '0' FROM value::text)) AS value
		FROM usage_event_control_entries
		WHERE project_id = ${project.projectInstanceId}::uuid AND usage_event_id = ${usageEventId}::uuid
		ORDER BY control_window_id
	`;
	return rows.map((row) => row.value);
}
