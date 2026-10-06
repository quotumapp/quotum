import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
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

localDescribe("an entity's limit beside the account's", () => {
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

	async function account(billingAccountId: string, entities: string[] = ["w1", "w2"]) {
		await context.repository.usageApi.createAccount(project, billingAccountId);
		await context.repository.grantAllocation(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity: "100000",
			sourceKind: "credit_grant",
			sourceKey: `${billingAccountId}:wallet`,
		});
		for (const externalId of entities) {
			await controls().createEntity(project, { billingAccountId, externalId, kind: "workspace" });
		}
	}

	const limit = (billingAccountId: string, limitValue: string, entityId: string | null = null) =>
		controls().upsertControl(project, {
			billingAccountId,
			entityId,
			controlKind: "usage_limit",
			featureKey: "ai_credits",
			limitValue,
			interval: "day",
			actor: "integration-test",
		});

	const consume = (billingAccountId: string, quantity: string, key: string, entityId?: string) =>
		context.repository.consumeUsage(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity,
			idempotencyKey: key,
			entityId,
		});

	const reserve = (billingAccountId: string, quantity: string, key: string, entityId?: string) =>
		context.repository.reserveUsage(project, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity,
			idempotencyKey: key,
			expiresInSeconds: 300,
			entityId,
		});

	/** What each effective control of an account, or of one of its entities, has counted. */
	async function windows(billingAccountId: string, entityId?: string) {
		const listed = await controls().listEffectiveControls(project, billingAccountId, entityId);
		return Object.fromEntries(
			listed.map((control) => [
				control.source,
				{ limit: control.limitValue, consumed: control.consumedValue, held: control.heldValue },
			]),
		);
	}

	async function eventSum(billingAccountId: string, entityExternalId: string | null = null) {
		const [row] = await context.sql<Array<{ total: string }>>`
			SELECT COALESCE(sum(event.quantity), 0)::text AS total
			FROM usage_events event
			JOIN customers customer ON customer.id = event.customer_id
			LEFT JOIN entities entity ON entity.id = event.entity_id
			JOIN features feature ON feature.id = event.meter_feature_id AND feature.key = 'ai_credits'
			WHERE customer.billing_account_id = ${billingAccountId}
				AND (${entityExternalId}::text IS NULL OR entity.external_id = ${entityExternalId})`;
		return Number(row?.total ?? 0);
	}

	it("counts an entity's usage against its own limit and the account's", async () => {
		await account("scopes");
		await limit("scopes", "100");
		await limit("scopes", "40", "w1");
		const outcomes: Array<[string, boolean, string | undefined]> = [];
		for (const [quantity, key, entityId] of [
			["30", "e1", "w1"],
			["30", "e2", "w2"],
			["15", "e3", "w1"],
			["20", "e4", "w1"],
			["40", "e5", undefined],
			["20", "e6", "w2"],
			["1", "e7", undefined],
		] as const) {
			const result = await consume("scopes", quantity, key, entityId);
			outcomes.push([key, result.allowed, result.control?.source]);
		}
		expect(outcomes).toEqual([
			["e1", true, undefined],
			["e2", true, undefined],
			// The entity's own 40 refuses the 15 that would make 45; the account has room for it.
			["e3", false, "entity"],
			["e4", false, "entity"],
			["e5", true, undefined],
			// 30 + 30 + 40 fill the account's 100, so nothing more is allowed, from any entity.
			["e6", false, "account"],
			["e7", false, "account"],
		]);
		expect(await eventSum("scopes")).toBe(100);
		expect(await windows("scopes")).toMatchObject({ account: { limit: "100", consumed: "100" } });
		expect(await windows("scopes", "w1")).toMatchObject({
			account: { limit: "100", consumed: "100" },
			entity: { limit: "40", consumed: "30" },
		});
		// w2 has no limit of its own, so only the account's applies.
		expect(Object.keys(await windows("scopes", "w2"))).toEqual(["account"]);
	});

	it("keeps counting an entity in the account's window when its own limit is the looser one", async () => {
		await account("looser");
		await limit("looser", "100");
		await limit("looser", "200", "w1");
		expect((await consume("looser", "60", "looser-1", "w1")).allowed).toBe(true);
		expect(await windows("looser", "w1")).toMatchObject({
			account: { consumed: "60" },
			entity: { consumed: "60" },
		});
		const over = await consume("looser", "50", "looser-2", "w1");
		expect(over.allowed).toBe(false);
		expect(over.control?.source).toBe("account");
		expect(await eventSum("looser")).toBe(60);
	});

	it("holds, confirms and releases in both windows", async () => {
		await account("holds");
		await limit("holds", "100");
		await limit("holds", "40", "w1");
		const hold = await reserve("holds", "30", "hold-1", "w1");
		expect(hold.allowed).toBe(true);
		expect(await windows("holds", "w1")).toMatchObject({
			account: { consumed: "0", held: "30" },
			entity: { consumed: "0", held: "30" },
		});
		// 30 held leave the account 70, so another entity cannot take 75.
		const refused = await consume("holds", "75", "hold-2", "w2");
		expect(refused.allowed).toBe(false);
		expect(refused.control?.source).toBe("account");
		expect((await consume("holds", "70", "hold-3", "w2")).allowed).toBe(true);

		await context.repository.confirmUsageReservation(project, {
			billingAccountId: "holds",
			reservationId: hold.reservationId ?? "",
			quantity: "20",
			idempotencyKey: "hold-confirm",
		});
		expect(await windows("holds", "w1")).toMatchObject({
			account: { consumed: "90", held: "0" },
			entity: { consumed: "20", held: "0" },
		});

		const second = await reserve("holds", "10", "hold-4", "w1");
		expect(second.allowed).toBe(true);
		expect(await windows("holds", "w1")).toMatchObject({
			account: { consumed: "90", held: "10" },
			entity: { consumed: "20", held: "10" },
		});
		await context.repository.releaseUsageReservation(project, {
			billingAccountId: "holds",
			reservationId: second.reservationId ?? "",
			idempotencyKey: "hold-release",
		});
		expect(await windows("holds", "w1")).toMatchObject({
			account: { consumed: "90", held: "0" },
			entity: { consumed: "20", held: "0" },
		});
	});

	it("takes a correction out of both windows", async () => {
		await account("fixes");
		await limit("fixes", "100");
		await limit("fixes", "40", "w1");
		const first = await consume("fixes", "30", "fix-1", "w1");
		await consume("fixes", "30", "fix-2", "w2");
		await context.repository.correctUsage(project, {
			billingAccountId: "fixes",
			originalUsageEventId: first.usageEventId ?? "",
			originalRecordedAt: new Date(first.recordedAtExact ?? first.recordedAt ?? ""),
			quantity: "12",
			idempotencyKey: "fix-correction",
			actor: "integration-test",
			reason: "duplicate",
		});
		expect(await windows("fixes", "w1")).toMatchObject({
			account: { consumed: "48" },
			entity: { consumed: "18" },
		});
	});

	it("never admits more than either limit when requests race", async () => {
		await account("race");
		await limit("race", "100");
		await limit("race", "40", "w1");
		const attempts = Array.from({ length: 48 }, (_, index) => ({
			key: `race-${index}`,
			entityId: index % 3 === 0 ? "w1" : index % 3 === 1 ? "w2" : undefined,
		}));
		const results = await Promise.all(
			attempts.map((attempt) => consume("race", "5", attempt.key, attempt.entityId)),
		);
		const allowed = results.filter((result) => result.allowed).length;
		expect(await eventSum("race")).toBe(allowed * 5);
		expect(await eventSum("race")).toBeLessThanOrEqual(100);
		expect(await eventSum("race", "w1")).toBeLessThanOrEqual(40);
		expect(await windows("race", "w1")).toMatchObject({
			account: { consumed: String(await eventSum("race")) },
			entity: { consumed: String(await eventSum("race", "w1")) },
		});
		// 48 requests of 5 asked for 240; the account's 100 admits exactly 20 of them.
		expect(allowed).toBe(20);
	});

	it("lists an entity's spend limit beside the account's", async () => {
		await account("spend");
		const spendLimit = (limitValue: string, entityId: string | null) =>
			controls().upsertControl(project, {
				billingAccountId: "spend",
				entityId,
				controlKind: "spend_limit",
				currency: "USD",
				limitValue,
				interval: "day",
				actor: "integration-test",
			});
		await spendLimit("1000", null);
		await spendLimit("400", "w1");
		const listed = await controls().listEffectiveControls(project, "spend", "w1");
		expect(
			listed.map((control) => [control.controlKind, control.source, control.limitValue]),
		).toEqual([
			["spend_limit", "entity", "400"],
			["spend_limit", "account", "1000"],
		]);
	});

	it("scales a percentage alert on an entity from the tighter of its limits", async () => {
		await account("alerts");
		await limit("alerts", "100");
		await limit("alerts", "40", "w1");
		await controls().createUsageAlert(project, {
			billingAccountId: "alerts",
			featureKey: "ai_credits",
			entityId: "w1",
			thresholdType: "percentage",
			thresholdValue: "50",
			interval: "day",
			actor: "integration-test",
		});
		const [state] = await context.sql<Array<{ threshold_value: string }>>`
			SELECT threshold_value::text FROM usage_alert_states`;
		expect(state?.threshold_value).toBe("20.000000000");
	});
});
