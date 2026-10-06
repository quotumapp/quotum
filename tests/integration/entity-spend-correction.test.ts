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
const controls = () => context.repository.controlsEnterprise;

/**
 * The fixture gives 25 units free and prices the rest by volume: up to 100 billable units cost 2
 * each, more cost 1.2 each plus 40. So 125 units cost 200 and 126 cost 161: one unit can lower the
 * charge, and correcting it raises the charge again.
 */
localDescribe("corrections in an entity's spend window", () => {
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

	/** An account limited to 10000 with two entities, the named ones limited to 500 each. */
	async function subscriber(account: string, limited: string[]) {
		await seedOverageSubscriber(context.sql, {
			account,
			provider: "stripe",
			pricingModel: "volume",
		});
		for (const externalId of ["w1", "w2"]) {
			await controls().createEntity(project, {
				billingAccountId: account,
				externalId,
				kind: "workspace",
			});
		}
		for (const [entityId, limitValue] of [
			[null, "10000"],
			...limited.map((externalId) => [externalId, "500"]),
		] as Array<[string | null, string]>) {
			await controls().upsertControl(project, {
				billingAccountId: account,
				entityId,
				controlKind: "spend_limit",
				featureKey: null,
				currency: "USD",
				limitValue,
				interval: "month",
				actor: "integration-test",
			});
		}
	}

	const consume = (account: string, quantity: string, key: string, entityId: string) =>
		context.repository.consumeUsage(project, {
			billingAccountId: account,
			featureKey: overageFeatureKey(account),
			quantity,
			idempotencyKey: `${account}:${key}`,
			entityId,
		});

	const correct = (
		account: string,
		original: { usageEventId: string | null; recordedAt: string | null },
		quantity: string,
		key: string,
	) =>
		context.repository.correctUsage(project, {
			billingAccountId: account,
			originalUsageEventId: original.usageEventId ?? "",
			originalRecordedAt: new Date(original.recordedAt ?? ""),
			quantity,
			idempotencyKey: `${account}:${key}`,
			actor: "integration-test",
			reason: "duplicate call",
		});

	/** The spend each limit that counts the entity's usage holds, by the limit's source. */
	async function spend(account: string, entityId: string) {
		const listed = await controls().listEffectiveControls(project, account, entityId);
		return Object.fromEntries(
			listed
				.filter((control) => control.controlKind === "spend_limit")
				.map((control) => [control.source, Number(control.consumedValue)]),
		);
	}

	it("does not return a falling charge to an entity's window that it never lowered", async () => {
		const account = "spend-floor";
		await subscriber(account, ["w2"]);
		expect(await consume(account, "125", "first", "w1")).toMatchObject({ allowed: true });
		// One more unit moves every billable unit to the cheaper tier. The account's window falls
		// by 39; the entity's own window holds nothing, so there is nothing to lower.
		const boundary = await consume(account, "1", "boundary", "w2");
		expect(await spend(account, "w2")).toEqual({ entity: 0, account: 161 });

		await correct(account, boundary, "1", "fix");

		expect(await spend(account, "w2")).toEqual({ entity: 0, account: 200 });
	});

	it("returns to an entity's window what a falling charge took from it", async () => {
		const account = "spend-return";
		await subscriber(account, ["w2"]);
		expect(await consume(account, "125", "first", "w2")).toMatchObject({ allowed: true });
		const boundary = await consume(account, "1", "boundary", "w2");
		expect(await spend(account, "w2")).toEqual({ entity: 161, account: 161 });

		await correct(account, boundary, "1", "fix");

		expect(await spend(account, "w2")).toEqual({ entity: 200, account: 200 });
	});

	it("leaves nothing of a fully corrected event that later usage re-priced", async () => {
		const account = "spend-repriced";
		await subscriber(account, ["w1"]);
		// 120 units cost 190. Ten more from another entity reach the cheaper tier: 130 cost 166.
		const first = await consume(account, "120", "first", "w1");
		expect(await consume(account, "10", "later", "w2")).toMatchObject({ allowed: true });
		expect(await spend(account, "w1")).toEqual({ entity: 190, account: 166 });

		// Half of it: the charge falls to 90 (70 units), and what the event still holds in the
		// entity's window is capped at half of what it added.
		await correct(account, first, "60", "half");
		expect(await spend(account, "w1")).toEqual({ entity: 95, account: 90 });

		// The rest: the ten remaining units are free, and the entity has no usage left.
		await correct(account, first, "60", "rest");
		expect(await spend(account, "w1")).toEqual({ entity: 0, account: 0 });
	});

	it("follows the re-rated charge of a partly corrected event", async () => {
		const account = "spend-partial";
		await subscriber(account, ["w1"]);
		// 60 units: 35 billable, 70. Correcting 30 leaves 5 billable, 10, well under the event's
		// uncorrected half.
		const first = await consume(account, "60", "first", "w1");
		expect(await spend(account, "w1")).toEqual({ entity: 70, account: 70 });

		await correct(account, first, "30", "half");
		expect(await spend(account, "w1")).toEqual({ entity: 10, account: 10 });

		await correct(account, first, "30", "rest");
		expect(await spend(account, "w1")).toEqual({ entity: 0, account: 0 });
	});
});
