import { afterAll, beforeAll, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
let context: LocalPostgresContext;
const controls = () => context.repository.controlsEnterprise;

/**
 * A wallet-rated confirmation settles its usage against the account's limits. Which limits are
 * active, and which window counts, is decided on the database clock, as for consume and reserve.
 */
localDescribe("confirming a hold when the API clock trails the database", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
	});
	afterAll(async () => {
		await context.sql.close();
	});

	async function accountWithHold(billingAccountId: string, quantity: string): Promise<string> {
		await context.repository.usageApi.createAccount(project, billingAccountId);
		await context.repository.grantAllocation(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity: "1000",
			sourceKind: "credit_grant",
			sourceKey: `${billingAccountId}:wallet`,
		});
		const held = await context.repository.reserveUsage(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity,
			idempotencyKey: `${billingAccountId}:hold`,
			expiresInSeconds: 300,
		});
		if (held.reservationId === null) throw new Error("the hold was not admitted");
		return held.reservationId;
	}

	/** A limit that becomes active now, after the hold was taken. */
	const limit = (billingAccountId: string, limitValue: string) =>
		controls().upsertControl(project, {
			billingAccountId,
			entityId: null,
			controlKind: "usage_limit",
			featureKey: "ai_credits",
			limitValue,
			interval: "day",
			actor: "integration-test",
		});

	const confirm = (billingAccountId: string, reservationId: string, quantity: string) =>
		context.repository.confirmUsageReservation(project, {
			billingAccountId,
			reservationId,
			quantity,
			idempotencyKey: `${billingAccountId}:confirm`,
		});

	async function counted(billingAccountId: string) {
		const [control] = await controls().listEffectiveControls(project, billingAccountId);
		return { limit: control?.limitValue, consumed: control?.consumedValue };
	}

	it("refuses a confirmation that would pass a limit activated after the hold", async () => {
		const reservationId = await accountWithHold("skew-over", "30");
		await limit("skew-over", "20");
		setSystemTime(new Date(Date.now() - 60_000));
		try {
			expect(await confirm("skew-over", reservationId, "30")).toMatchObject({
				allowed: false,
				reason: "control_limit_exceeded",
				control: { kind: "usage_limit", limitValue: "20" },
			});
		} finally {
			setSystemTime();
		}
		expect(await counted("skew-over")).toEqual({ limit: "20", consumed: "0" });
	});

	it("counts a confirmation within that limit in its window", async () => {
		const reservationId = await accountWithHold("skew-within", "30");
		await limit("skew-within", "20");
		setSystemTime(new Date(Date.now() - 60_000));
		try {
			expect(await confirm("skew-within", reservationId, "15")).toMatchObject({ allowed: true });
		} finally {
			setSystemTime();
		}
		expect(await counted("skew-within")).toEqual({ limit: "20", consumed: "15" });
	});
});
