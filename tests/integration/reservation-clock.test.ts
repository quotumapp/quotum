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
