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
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	databaseNow,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import {
	seedPhase3MeteringCatalog,
	seedPhase3MeteringSubscription,
} from "./helpers/phase3-fixtures";

let context: LocalPostgresContext;
describeLocalPostgres(describe, describe.skip)("reservation timestamp clock", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3MeteringCatalog(context.sql);
	});
	afterEach(() => setSystemTime());
	afterAll(() => context.sql.close());
	it.each(["wallet", "meter_limit"] as const)(
		"starts %s lifetime after waiting for control admission",
		async (kind) => {
			const project = integrationProjectContext();
			const account = "control-wait-account";
			const featureId = kind === "wallet" ? "model_tokens" : "api_requests";
			if (kind === "meter_limit")
				await seedPhase3MeteringSubscription(context.sql, account, "workspace");
			else
				await context.repository.grantAllocation(project, {
					billingAccountId: account,
					featureKey: "ai_credits",
					quantity: "100",
					sourceKind: "credit_grant",
					sourceKey: "control-wait-wallet",
				});
			await context.repository.controlsEnterprise.upsertControl(project, {
				billingAccountId: account,
				controlKind: "usage_limit",
				featureKey: featureId,
				limitValue: "1",
				interval: "lifetime",
				actor: "integration-test",
			});
			const [customer] = await context.sql<{ id: string }[]>`
				SELECT id FROM customers
				WHERE project_id = ${project.projectInstanceId} AND billing_account_id = ${account}
			`;
			if (!customer) throw new Error("Customer missing");
			const locked = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const blocking = context.sql.begin(async (tx) => {
				await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`billing-controls:${project.projectInstanceId}:${customer.id}`}, 0))`;
				locked.resolve();
				await release.promise;
			});
			await locked.promise;
			const input = {
				billingAccountId: account,
				featureId,
				value: "1",
				operationId: `control-wait:${kind}`,
				expiresInSeconds: 1,
			};
			const reserving = context.repository.usageApi.reserve(project, input);
			let admittedAfter: Date;
			try {
				await waitForControlLock();
				await context.sql`SELECT pg_sleep(1.05)`;
				admittedAfter = await databaseNow(context.sql);
			} finally {
				release.resolve();
				await blocking;
			}
			const result = await reserving;
			expect(result.allowed).toBe(true);
			if (!result.allowed) throw new Error("Reservation denied");
			const [stored] = await context.sql<
				{ effective_at: Date; expires_at: Date; seconds: string; active_holds: string }[]
			>`
				SELECT effective_at, expires_at,
					extract(epoch FROM expires_at-effective_at)::text AS seconds,
					(SELECT COALESCE(sum(hold.held_value), 0)::text
					 FROM reservation_control_holds hold
					 WHERE hold.project_id = reservations.project_id AND hold.reservation_id = reservations.id
						AND reservations.expires_at > clock_timestamp()) AS active_holds
				FROM reservations WHERE id = ${result.reservationId}
			`;
			expect(stored?.effective_at.getTime()).toBeGreaterThanOrEqual(admittedAfter.getTime());
			expect(Number(stored?.seconds)).toBe(1);
			expect(result.expiresAt).toBe(stored?.expires_at.toISOString());
			expect(Number(stored?.active_holds)).toBe(1);
			expect(await context.repository.usageApi.reserve(project, input)).toEqual(result);
			const denied = await context.repository.usageApi.reserve(project, {
				...input,
				operationId: `${input.operationId}:other`,
			});
			expect(denied.allowed).toBe(false);
		},
	);
	it.each(["wallet", "meter_limit"] as const)(
		"inserts %s holds from one DB instant under skew",
		async (kind) => {
			const project = integrationProjectContext();
			if (kind === "meter_limit")
				await seedPhase3MeteringSubscription(context.sql, "clock-account", "workspace");
			else
				await context.repository.grantAllocation(project, {
					billingAccountId: "clock-account",
					featureKey: "ai_credits",
					quantity: "100",
					sourceKind: "credit_grant",
					sourceKey: "clock-wallet",
				});
			for (const skew of [-600_000, 600_000])
				for (const ttl of [1, 300]) {
					const [clock] = await context.sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
					if (!clock) throw new Error("Database clock missing");
					setSystemTime(new Date(clock.now.getTime() + skew));
					const result = await context.repository.usageApi.reserve(project, {
						billingAccountId: "clock-account",
						featureId: kind === "wallet" ? "model_tokens" : "api_requests",
						value: "1",
						operationId: `${skew}:${ttl}`,
						expiresInSeconds: ttl,
					});
					expect(result.allowed).toBe(true);
					if (!result.allowed) throw new Error("Reservation denied");
					const [stored] = await context.sql<
						{ seconds: string; starts_near_db: boolean }[]
					>`SELECT extract(epoch FROM expires_at-effective_at)::text AS seconds, abs(extract(epoch FROM effective_at-clock_timestamp())) < 5 AS starts_near_db FROM reservations WHERE id=${result.reservationId}`;
					expect(Number(stored?.seconds)).toBe(ttl);
					expect(stored?.starts_near_db).toBe(true);
					await context.repository.usageApi.release(project, {
						billingAccountId: "clock-account",
						reservationId: result.reservationId,
						operationId: `release:${skew}:${ttl}`,
					});
				}
		},
	);
});

async function waitForControlLock(): Promise<void> {
	const deadline = performance.now() + 5000;
	while (performance.now() < deadline) {
		const [row] = await context.sql<{ waiting: number }[]>`
			SELECT count(*)::int AS waiting FROM pg_stat_activity
			WHERE datname = current_database() AND wait_event_type = 'Lock'
				AND query LIKE '%pg_advisory_xact_lock%'
		`;
		if (row && row.waiting > 0) return;
		await Bun.sleep(5);
	}
	throw new Error("Expected reservation to wait on its control admission lock");
}
