import { afterAll, beforeAll, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
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

	it("enforces new controls when the API clock trails the database", async () => {
		const account = "clock-skew";
		await seedOverageSubscriber(context.sql, {
			account,
			provider: "stripe",
			pricingModel: "volume",
		});
		await upsertSpendLimit(account, "200");
		setSystemTime(new Date(Date.now() - 60_000));
		try {
			expect(await consume(account, "125", "first")).toMatchObject({ allowed: true });
			expect(await spendExposure(account)).toBe("200");
			expect(
				await context.repository.checkUsage(project, {
					billingAccountId: account,
					featureKey: overageFeatureKey(account),
					quantity: "100",
				}),
			).toMatchObject({ allowed: false, reason: "control_limit_exceeded" });
			const held = await reserve(account, "1", "hold");
			expect(await confirm(account, held, "1")).toMatchObject({ allowed: true });
			expect(await spendExposure(account)).toBe("161");
		} finally {
			setSystemTime();
		}
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
	it("keeps committed spend exact when consuming across a held discount and then releasing", async () => {
		const account = "volume-interleaved";
		await seedOverageSubscriber(context.sql, {
			account,
			provider: "stripe",
			pricingModel: "volume",
		});
		await upsertSpendLimit(account, "201");
		expect(await consume(account, "125", "initial")).toMatchObject({ allowed: true });
		const reservationId = await reserve(account, "1", "discount");
		expect(await consume(account, "1", "while-held")).toMatchObject({ allowed: true });
		expect(await spendExposure(account)).toBe("161");
		await release(account, reservationId);
		expect(await spendExposure(account)).toBe("161");
		expect(await consume(account, "26", "within-cap")).toMatchObject({ allowed: true });
		expect(await spendExposure(account)).toBe("192");
		await closeUsageWindows(context.sql);
		await context.repository.materializeAndClaimUsageInvoicePeriods("volume-worker", 10);
		const [invoice] =
			await context.sql`SELECT amount_minor::text AS amount FROM usage_invoice_periods`;
		expect(invoice?.amount).toBe("192");
	});

	it("quotes multiple holds conservatively and settles partial confirmation, release, and correction", async () => {
		const account = "volume-multiple";
		await seedOverageSubscriber(context.sql, {
			account,
			provider: "stripe",
			pricingModel: "volume",
		});
		await upsertSpendLimit(account, "260");
		expect(await consume(account, "100", "initial")).toMatchObject({ allowed: true });
		const first = await reserve(account, "50", "first");
		const second = await reserve(account, "25", "second");
		// Each quote protects the 125-unit peak, even though confirming all 50 costs only 40 more.
		expect(await spendWindow(account)).toMatchObject({ consumed: "150", held: "100" });
		expect(await consume(account, "1", "intervening")).toMatchObject({ allowed: true });
		expect(await spendWindow(account)).toMatchObject({ consumed: "152", held: "100" });
		const confirmed = await confirm(account, first, "10");
		expect(confirmed).toMatchObject({ allowed: true, status: "confirmed" });
		expect(await spendWindow(account)).toMatchObject({ consumed: "172", held: "50" });
		await release(account, second);
		expect(await spendWindow(account)).toMatchObject({ consumed: "172", held: "0" });
		await correct(account, confirmed, "10");
		expect(await spendWindow(account)).toMatchObject({ consumed: "152", held: "0" });
	});

	it("rechecks the actual confirmation charge after a zero quote and intervening usage", async () => {
		const account = "volume-confirm-budget";
		await seedOverageSubscriber(context.sql, {
			account,
			provider: "stripe",
			pricingModel: "volume",
		});
		await upsertSpendLimit(account, "201");
		expect(await consume(account, "125", "initial")).toMatchObject({ allowed: true });
		const reservationId = await reserve(account, "1", "discount");
		expect(await consume(account, "34", "intervening")).toMatchObject({ allowed: true });
		expect(await spendExposure(account)).toBe("201");
		expect(await confirm(account, reservationId, "1")).toMatchObject({
			allowed: false,
			reason: "control_limit_exceeded",
			status: "active",
		});
		expect(await spendExposure(account)).toBe("201");
		await release(account, reservationId);
		expect(await spendWindow(account)).toMatchObject({ consumed: "201", held: "0" });
	});

	for (const operation of ["consume", "confirm"] as const) {
		it(`retains zero-cost ${operation} provenance for a later correction that raises the volume charge`, async () => {
			const account = `volume-zero-${operation}`;
			await seedOverageSubscriber(context.sql, {
				account,
				provider: "stripe",
				pricingModel: "volume",
			});
			await upsertSpendLimit(account, "201");
			const original =
				operation === "consume"
					? await consume(account, "1", "free")
					: await confirm(account, await reserve(account, "1", "free"), "1");
			expect(original).toMatchObject({ allowed: true });
			expect(await controlEntries(original.usageEventId)).toEqual(["0"]);
			expect(await consume(account, "125", "later")).toMatchObject({ allowed: true });
			expect(await spendExposure(account)).toBe("161");
			const held = await reserve(account, "1", "pending");
			await correct(account, original, "1");
			// Removing the earlier free unit crosses back to the dearer tier: a +39 correction.
			expect(await spendExposure(account)).toBe("200");
			await release(account, held);
			expect(await spendWindow(account)).toMatchObject({ consumed: "200", held: "0" });
		});
	}
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

async function reserve(account: string, quantity: string, key: string): Promise<string> {
	const result = await context.repository.reserveUsage(project, {
		billingAccountId: account,
		featureKey: overageFeatureKey(account),
		quantity,
		idempotencyKey: `${account}:reserve:${key}`,
		expiresInSeconds: 300,
	});
	expect(result).toMatchObject({ allowed: true, status: "active" });
	if (result.reservationId === null) throw new Error("Expected reservation id");
	return result.reservationId;
}

async function confirm(account: string, reservationId: string, quantity: string) {
	return await context.repository.confirmUsageReservation(project, {
		billingAccountId: account,
		reservationId,
		quantity,
		idempotencyKey: `${account}:confirm:${reservationId}`,
	});
}

async function release(account: string, reservationId: string) {
	return await context.repository.releaseUsageReservation(project, {
		billingAccountId: account,
		reservationId,
		idempotencyKey: `${account}:release:${reservationId}`,
	});
}

async function correct(
	account: string,
	original: { usageEventId: string | null; recordedAt: string | null },
	quantity: string,
) {
	return await context.repository.correctUsage(project, {
		billingAccountId: account,
		originalUsageEventId: original.usageEventId ?? "",
		originalRecordedAt: new Date(original.recordedAt ?? ""),
		quantity,
		idempotencyKey: `${account}:correct:${original.usageEventId}`,
		actor: "integration-test",
		reason: "unused quantity",
	});
}
