import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { testRequest } from "../helpers/openapi";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { seedPhase3CatalogMigration, seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";

const project = integrationProjectContext();
let context: LocalPostgresContext;
let eventOrder = 100;

describeLocalPostgres(describe, describe.skip)("carry-over on an immediate plan change", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
		eventOrder = 100;
		await context.sql`
			INSERT INTO provider_plan_bindings (
				project_id, plan_version_id, store_product_id, provider, channel, status
			)
			SELECT price.project_id, price.plan_version_id, binding.store_product_id,
				'stripe', 'web', 'published'
			FROM price_components price
			JOIN provider_price_bindings binding
				ON binding.project_id = price.project_id AND binding.price_component_id = price.id
			WHERE price.key = 'base'
		`;
	});
	afterAll(async () => {
		await context.sql.close();
	});

	it("carries the unused balance and the period's usage into the new version once", async () => {
		await addAllowance(1, "100");
		await addAllowance(2, "300");
		await sync(1);
		await spend(30, "spend-before-change");
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });
		const intent = {
			...changeIntent("immediate"),
			carryOver: { balances: ["ai_credits"], usages: ["ai_credits", "ai_credits"] },
		};

		const preview = await previewChange(fixture, intent);
		expect(preview.status).toBe(200);
		const previewBody = (await preview.json()).data;
		expect(previewBody.carryOver).toEqual({
			features: [
				{
					featureKey: "ai_credits",
					balance: { carried: true, quantity: "70" },
					usage: { carried: true, quantity: "30" },
				},
			],
		});
		const executed = await testRequest(
			fixture.app,
			"/v1/billing-accounts/migration-stripe/commercial-actions",
			{
				method: "POST",
				headers: { ...jsonHeaders(fixture), "idempotency-key": "carry-change" },
				body: JSON.stringify({ previewToken: previewBody.previewToken }),
			},
		);
		expect(executed.status).toBe(202);
		const [stored] = await context.sql<Array<{ carry_over: unknown }>>`
			SELECT carry_over FROM subscription_changes
		`;
		expect(stored?.carry_over).toEqual({ balances: ["ai_credits"], usages: ["ai_credits"] });
		await applyClaimedChange();
		await sync(2);

		const rows = await allowances();
		const outgoing = rows.find((row) => row.source_kind === "subscription" && row.version === 1);
		expect(outgoing).toMatchObject({ consumed: "30.000000000", ended: true, rolls: false });
		expect(rows.find((row) => row.source_kind === "carry_over")).toMatchObject({
			quantity: "70.000000000",
			origin: outgoing?.id,
			expires_at_period_end: true,
		});
		expect(rows.find((row) => row.version === 2)).toMatchObject({
			quantity: "300.000000000",
			consumed: "30.000000000",
		});
		const balance = await context.repository.getMeteringBalance(
			project,
			"migration-stripe",
			"ai_credits",
		);
		expect(balance).toMatchObject({ available: "340" });
		expect(balance.breakdown.find((row) => row.sourceKind === "carry_over")).toMatchObject({
			carryOverOriginAllocationId: outgoing?.id,
		});
		expect(await carriedUsage()).toEqual([{ requested: "30.000000000", applied: "30.000000000" }]);

		await sync(2);
		expect((await allowances()).filter((row) => row.source_kind === "carry_over")).toHaveLength(1);
		expect(await carriedUsage()).toHaveLength(1);
	});

	it("hands an unspent carry back to its origin when the subscription returns, without counting it twice", async () => {
		await carryIntoVersionTwo();
		expect(await available()).toBe("370");

		await migrateBackToVersionOne();
		const rows = await allowances();
		const origin = rows.find((row) => row.source_kind === "subscription" && row.version === 1);
		expect(origin).toMatchObject({ consumed: "30.000000000", ended: false, rolls: true });
		expect(rows.find((row) => row.source_kind === "carry_over")).toMatchObject({ ended: true });
		expect(rows.find((row) => row.version === 2)).toMatchObject({ ended: true });
		expect(await available()).toBe("70");

		// Switching away again does not bring the ended carry back.
		await migrate(1, 2);
		expect(await available()).toBe("300");
	});

	it("takes what a carry spent from its origin when the subscription returns", async () => {
		await carryIntoVersionTwo();
		await spend(370, "spend-everything-on-2");
		expect(await available()).toBe("0");

		await migrateBackToVersionOne();
		const [origin] = await context.sql<Array<{ reversed: string }>>`
			SELECT reversed_quantity::text AS reversed FROM balance_allocations allocation
			JOIN plan_items item ON item.id = allocation.plan_item_id
			JOIN plan_versions version ON version.id = item.plan_version_id
			WHERE allocation.source_kind = 'subscription' AND version.version = 1
		`;
		expect(origin?.reversed).toBe("70.000000000");
		expect(await available()).toBe("0");
	});

	it("grants an allowance without a reset once per subscription, however often it renews", async () => {
		await addAllowance(1, "100", null);
		await sync(1);
		await spend(30, "lifetime-spend");
		await renew();
		await sync(1);
		await renew();
		await sync(1);

		expect(await planAllowances()).toEqual([[1, "100.000000000", "30.000000000", false]]);
		expect(await available()).toBe("70");
	});

	it("grants no lifetime allowance to a subscription that holds one granted per period", async () => {
		await addAllowance(1, "100", null);
		// What a sync before lifetime allowances left: the quantity granted under a period's key.
		await context.sql`
			INSERT INTO balance_allocations (
				project_id, customer_id, feature_id, plan_item_id, subscription_id, source_kind,
				source_key, quantity, period_start_at, period_end_at
			)
			SELECT subscription.project_id, subscription.customer_id, item.feature_id, item.id,
				subscription.id, 'subscription', concat('subscription:', subscription.id, ':', item.id, ':p1'),
				item.quantity, subscription.current_period_start, subscription.current_period_end
			FROM subscriptions subscription
			JOIN plan_versions version ON version.project_id = subscription.project_id
			JOIN plans plan ON plan.id = version.plan_id AND plan.key = 'migration-plan'
			JOIN features feature ON feature.project_id = version.project_id AND feature.key = 'ai_credits'
			JOIN plan_items item
				ON item.plan_version_id = version.id
				AND item.feature_id = feature.id
				AND item.item_kind = 'allocation'
			WHERE subscription.external_subscription_id = 'sub_migrate_stripe' AND version.version = 1
		`;
		await sync(1);
		await renew();
		await sync(1);

		expect(await planAllowances()).toEqual([[1, "100.000000000", "0.000000000", false]]);
		expect(await available()).toBe("100");
	});

	it("ends a lifetime allowance at a switch and resumes it on a return in a later period", async () => {
		await addAllowance(1, "100", null);
		await addAllowance(2, "300", null);
		await sync(1);
		await spend(30, "lifetime-before-switch");

		await migrate(1, 2);
		expect(await planAllowances()).toEqual([
			[1, "100.000000000", "30.000000000", true],
			[2, "300.000000000", "0.000000000", false],
		]);
		expect(await available()).toBe("300");

		await renew();
		await sync(2);
		expect(await planAllowances()).toHaveLength(2);

		// The version gave its lifetime allowance once, so returning to it resumes what was left.
		await migrateBackToVersionOne();
		expect(await planAllowances()).toEqual([
			[1, "100.000000000", "30.000000000", false],
			[2, "300.000000000", "0.000000000", true],
		]);
		expect(await available()).toBe("70");
	});

	it("carries the unused part of a lifetime allowance as credit that never expires", async () => {
		await addAllowance(1, "100", null);
		await addAllowance(2, "300");
		await sync(1);
		await spend(30, "lifetime-before-carry");
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });
		const preview = await previewChange(fixture, {
			...changeIntent("immediate"),
			carryOver: { balances: ["ai_credits"] },
		});
		const executed = await testRequest(
			fixture.app,
			"/v1/billing-accounts/migration-stripe/commercial-actions",
			{
				method: "POST",
				headers: { ...jsonHeaders(fixture), "idempotency-key": "lifetime-carry" },
				body: JSON.stringify({ previewToken: (await preview.json()).data.previewToken }),
			},
		);
		expect(executed.status).toBe(202);
		await applyClaimedChange();
		await sync(2);

		expect((await allowances()).find((row) => row.source_kind === "carry_over")).toMatchObject({
			quantity: "70.000000000",
			never_expires: true,
		});
		expect(await available()).toBe("370");
	});

	it("carries over once when Stripe reports the switch while the change is pending", async () => {
		await carryWhenStripeReportsEarly("pending");
	});

	it("carries over once when Stripe reports the switch before the worker records it", async () => {
		await carryWhenStripeReportsEarly("processing");
	});

	it("caps carried usage at the new allowance and forgives the rest", async () => {
		await addAllowance(1, "100");
		await addAllowance(2, "20");
		await sync(1);
		await spend(30, "spend-before-downgrade");
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });
		const preview = await previewChange(fixture, {
			...changeIntent("immediate"),
			carryOver: { usages: ["ai_credits"] },
		});
		const previewBody = (await preview.json()).data;
		expect(previewBody.carryOver.features[0].balance).toEqual({ carried: false, quantity: "70" });
		await testRequest(fixture.app, "/v1/billing-accounts/migration-stripe/commercial-actions", {
			method: "POST",
			headers: { ...jsonHeaders(fixture), "idempotency-key": "capped-change" },
			body: JSON.stringify({ previewToken: previewBody.previewToken }),
		});
		await applyClaimedChange();
		await sync(2);

		expect(await carriedUsage()).toEqual([{ requested: "30.000000000", applied: "20.000000000" }]);
		expect(
			await context.repository.getMeteringBalance(project, "migration-stripe", "ai_credits"),
		).toMatchObject({ available: "0" });
		expect((await allowances()).some((row) => row.source_kind === "carry_over")).toBe(false);
	});

	it("does not count usage again when it is carried back to the allowance it came from", async () => {
		await addAllowance(1, "100");
		await addAllowance(2, "300");
		await separatePlans();
		await sync(1);
		await spend(30, "spend-before-round-trip");
		await commercialSwitch("other-plan", "round-trip-out", { usages: ["ai_credits"] });
		await sync(2);
		expect(await available()).toBe("270");

		// The returning allowance resumes with its own 30; version 2 holds only that same usage, so
		// the preview carries nothing and the change carries nothing.
		const back = await commercialSwitch("migration-plan", "round-trip-back", {
			usages: ["ai_credits"],
		});
		expect(back).toEqual({
			features: [
				{
					featureKey: "ai_credits",
					balance: { carried: false, quantity: "270" },
					usage: { carried: true, quantity: "0" },
				},
			],
		});
		await sync(1);
		expect(await available()).toBe("70");
		// Nothing new was carried back, so nothing is recorded as carried or forgiven.
		expect(await carriedUsage()).toEqual([{ requested: "30.000000000", applied: "30.000000000" }]);
	});

	it("carries only usage the returning allowance does not hold, however often the plan changes", async () => {
		await addAllowance(1, "100");
		await addAllowance(2, "300");
		await separatePlans();
		await sync(1);
		await spend(30, "spend-on-one");
		await commercialSwitch("other-plan", "cycle-out", { usages: ["ai_credits"] });
		await sync(2);
		await spend(10, "spend-on-two");
		expect(await available()).toBe("260");

		// Back on version 1: its own 30 plus version 2's own 10.
		const back = await commercialSwitch("migration-plan", "cycle-back", { usages: ["ai_credits"] });
		expect(back).toMatchObject({ features: [{ usage: { carried: true, quantity: "10" } }] });
		await sync(1);
		expect(await available()).toBe("60");

		// Version 2 resumes with the 30 it was carried and its own 10; version 1 holds nothing else.
		await commercialSwitch("other-plan", "cycle-out-again", { usages: ["ai_credits"] });
		await sync(2);
		expect(await available()).toBe("260");
		expect((await carriedUsage()).map((row) => row.applied)).toEqual([
			"30.000000000",
			"10.000000000",
		]);
	});

	it("refuses carry-over on a period-end change, for an unallocated feature and on the direct route", async () => {
		await addAllowance(1, "100");
		await addAllowance(2, "300");
		await sync(1);
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });

		const periodEnd = await previewChange(fixture, {
			...changeIntent("period_end"),
			carryOver: { balances: ["ai_credits"] },
		});
		const unallocated = await previewChange(fixture, {
			...changeIntent("immediate"),
			carryOver: { balances: ["model_tokens"] },
		});
		const direct = await testRequest(
			fixture.app,
			"/v1/billing-accounts/migration-stripe/subscriptions/sub_migrate_stripe/changes",
			{
				method: "POST",
				headers: { ...jsonHeaders(fixture), "idempotency-key": "direct-carry" },
				body: JSON.stringify({
					targetPlanKey: "migration-plan",
					quantities: { licensed_seats: 7 },
					carryOver: { balances: ["ai_credits"] },
				}),
			},
		);

		expect(periodEnd.status).toBe(400);
		expect((await periodEnd.json()).error.code).toBe("CARRY_OVER_REQUIRES_IMMEDIATE_CHANGE");
		expect(unallocated.status).toBe(400);
		expect((await unallocated.json()).error.message).toBe(
			"Feature model_tokens has no allowance in the current plan to carry over",
		);
		expect(direct.status).toBe(400);
	});

	it("refuses a non-consumable, usage without a new allowance and a quantity-only change", async () => {
		await addAllowance(1, "100");
		await addAllowance(2, "300");
		// Version 1 also allocates model tokens, which version 2 does not, and holds seats, a
		// non-consumable meter.
		await context.sql`
			INSERT INTO plan_items (
				project_id, plan_version_id, feature_id, item_kind, quantity, reset_interval
			)
			SELECT version.project_id, version.id, feature.id, 'allocation', 5000, 'month'
			FROM plan_versions version
			JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
			JOIN features feature
				ON feature.project_id = version.project_id AND feature.key = 'model_tokens'
			WHERE plan.key = 'migration-plan' AND version.version = 1
		`;
		await sync(1);
		const fixture = createIntegrationApp({ env: context.env, repository: context.repository });
		const refusal = async (carryOver: unknown, quantities = { licensed_seats: 7 }) => {
			const response = await previewChange(fixture, {
				...changeIntent("immediate"),
				quantities,
				carryOver,
			});
			return { status: response.status, error: (await response.json()).error };
		};

		expect(await refusal({ balances: ["licensed_seats"] })).toEqual({
			status: 400,
			error: expect.objectContaining({
				code: "INVALID_REQUEST",
				message: "Feature licensed_seats is not a consumable meter, so it cannot carry over",
			}),
		});
		expect(await refusal({ usages: ["model_tokens"] })).toEqual({
			status: 400,
			error: expect.objectContaining({
				code: "INVALID_REQUEST",
				message: "Feature model_tokens has no allowance in the new plan to carry its usage into",
			}),
		});
		// A balance of a feature the new plan lacks still carries, until the period ends.
		const balanceOnly = await previewChange(fixture, {
			...changeIntent("immediate"),
			carryOver: { balances: ["model_tokens"] },
		});
		expect(balanceOnly.status).toBe(200);
		expect((await balanceOnly.json()).data.carryOver).toMatchObject({
			features: [{ featureKey: "model_tokens", balance: { carried: true } }],
		});

		// On version 2, a change of seats alone keeps the version, so nothing ends or carries.
		await migrate(1, 2);
		expect(await refusal({ balances: ["ai_credits"] }, { licensed_seats: 8 })).toEqual({
			status: 400,
			error: expect.objectContaining({
				code: "INVALID_REQUEST",
				message: "Allowances carry over only when the change moves to another plan version",
			}),
		});
	});

	it("keeps a non-consumable level through a plan change and shrinks it to the new allowance", async () => {
		await addProjects(1, "5");
		await addProjects(2, "3");
		await addAllowance(1, "100");
		await addAllowance(2, "300");
		await sync(1);
		const events = [];
		for (const n of [1, 2, 3, 4, 5]) events.push(await addProject(`project-${n}`));
		await spend(30, "spend-before-level-change");

		await migrate(1, 2);
		// Five projects stay in use on version 2, which allows three: the excess is kept.
		expect(await projects()).toMatchObject({ granted: "5", consumed: "5", available: "0" });
		expect(await projectAllowances()).toEqual([[2, "5.000000000", "5.000000000", false]]);
		expect(await tryAddProject("project-6")).toBe(false);
		// A consumable allowance still ends with its version, and nothing is carried.
		expect(await planAllowances()).toEqual([
			[2, "5.000000000", "5.000000000", false],
			[1, "100.000000000", "30.000000000", true],
			[2, "300.000000000", "0.000000000", false],
		]);
		expect(await carriedUsage()).toEqual([]);

		// Removing two projects brings the level down to the new allowance, which then caps it.
		await removeProject(events[0], "remove-1");
		await removeProject(events[1], "remove-2");
		expect(await projects()).toMatchObject({ granted: "3", consumed: "3", available: "0" });
		expect(await tryAddProject("project-7")).toBe(false);
		await removeProject(events[2], "remove-3");
		expect(await projects()).toMatchObject({ granted: "3", consumed: "2", available: "1" });
		expect(await tryAddProject("project-8")).toBe(true);

		// A later sync of the same period grants version 2's allowance no second time.
		await sync(2);
		expect(await projectAllowances()).toEqual([[2, "3.000000000", "3.000000000", false]]);
	});

	it("keeps a level held by stacked allowances blocked until it falls below the new allowance", async () => {
		await addProjects(1, "3");
		await addProjects(2, "3");
		await sync(1);
		const events = [];
		for (const n of [1, 2, 3]) events.push(await addProject(`stack-${n}`));
		// Before lifetime grants, every renewal stacked another allowance of the item, keyed and
		// bounded by its period.
		await context.sql`
			INSERT INTO balance_allocations (
				project_id, customer_id, feature_id, plan_item_id, subscription_id,
				source_kind, source_key, quantity, period_start_at, period_end_at
			)
			SELECT allocation.project_id, allocation.customer_id, allocation.feature_id,
				allocation.plan_item_id, allocation.subscription_id, 'subscription',
				concat('subscription:', subscription.id::text, ':', allocation.plan_item_id::text,
					':legacy-period'),
				allocation.quantity, subscription.current_period_start, subscription.current_period_end
			FROM balance_allocations allocation
			JOIN subscriptions subscription ON subscription.id = allocation.subscription_id
			JOIN features feature ON feature.id = allocation.feature_id AND feature.key = 'projects'
			WHERE allocation.source_kind = 'subscription'
		`;
		// The stacked allowances grant 6 on version 1, and a correction there leaves that room.
		for (const n of [4, 5, 6]) events.push(await addProject(`stack-${n}`));
		await removeProject(events[0], "stack-remove-on-1");
		expect(await projects()).toMatchObject({ granted: "6", consumed: "5", available: "1" });
		await addProject("stack-refill");

		await migrate(1, 2);
		expect(await projects()).toMatchObject({ granted: "6", consumed: "6", available: "0" });
		// A level of 5 is still above version 2's 3, so the group's room does not come back.
		await removeProject(events[1], "stack-remove-on-2");
		expect(await projects()).toMatchObject({ granted: "5", consumed: "5", available: "0" });
		expect(await tryAddProject("stack-over-limit")).toBe(false);
		// Once the level falls below the new allowance, that allowance caps it.
		for (const n of [2, 3, 4]) await removeProject(events[n], `stack-remove-more-${n}`);
		expect(await projects()).toMatchObject({ granted: "3", consumed: "2", available: "1" });
		expect(await tryAddProject("stack-under-limit")).toBe(true);
	});

	it("keeps a non-consumable level when Stripe reports a switch to another version", async () => {
		await addProjects(1, "5", "month");
		await addProjects(2, "8", "month");
		await sync(1);
		for (const n of [1, 2, 3, 4]) await addProject(`portal-${n}`);

		// The customer switches in the portal: no change row, Stripe reports version 2's prices.
		await sync(2);
		expect(await projects()).toMatchObject({ granted: "8", consumed: "4", available: "4" });
		expect(await projectAllowances()).toEqual([[2, "8.000000000", "4.000000000", false]]);

		// Switching back keeps it too, on the one allowance, and grants version 1 nothing more.
		await sync(1);
		expect(await projects()).toMatchObject({ granted: "5", consumed: "4", available: "1" });
		expect(await projectAllowances()).toEqual([[1, "5.000000000", "4.000000000", false]]);
	});
});

function changeIntent(effectiveMode: "immediate" | "period_end") {
	return {
		kind: "subscription_change",
		externalSubscriptionId: "sub_migrate_stripe",
		targetPlanKey: "migration-plan",
		quantities: { licensed_seats: 7 },
		effectiveMode,
	};
}

function jsonHeaders(fixture: ReturnType<typeof createIntegrationApp>): Record<string, string> {
	return {
		...(fixture.authHeaders("acme") as Record<string, string>),
		"content-type": "application/json",
	};
}

async function previewChange(fixture: ReturnType<typeof createIntegrationApp>, intent: unknown) {
	return await testRequest(
		fixture.app,
		"/v1/billing-accounts/migration-stripe/commercial-actions/preview",
		{ method: "POST", headers: jsonHeaders(fixture), body: JSON.stringify({ intent }) },
	);
}

/**
 * Moves version 2 of the migration plan to a plan of its own, so a commercial change can target
 * either version by plan key and switch back and forth.
 */
async function separatePlans(): Promise<void> {
	await context.sql`
		INSERT INTO plans (project_id, key, name, active)
		SELECT project_id, 'other-plan', 'Other plan', true FROM plans WHERE key = 'migration-plan'
	`;
	await context.sql`
		UPDATE plan_versions version SET plan_id = other.id
		FROM plans original, plans other
		WHERE original.key = 'migration-plan' AND other.key = 'other-plan'
			AND version.plan_id = original.id AND version.version = 2
	`;
	await context.sql`
		UPDATE plans plan SET active_version_id = version.id
		FROM plan_versions version WHERE version.plan_id = plan.id
	`;
}

/**
 * An immediate commercial change to a plan's active version, previewed, executed and applied. It
 * returns what the preview said the change would carry.
 */
async function commercialSwitch(
	targetPlanKey: string,
	idempotencyKey: string,
	carryOver: { balances?: string[]; usages?: string[] },
): Promise<unknown> {
	const fixture = createIntegrationApp({ env: context.env, repository: context.repository });
	const preview = await previewChange(fixture, {
		...changeIntent("immediate"),
		targetPlanKey,
		carryOver,
	});
	expect(preview.status).toBe(200);
	const previewBody = (await preview.json()).data;
	const executed = await testRequest(
		fixture.app,
		"/v1/billing-accounts/migration-stripe/commercial-actions",
		{
			method: "POST",
			headers: { ...jsonHeaders(fixture), "idempotency-key": idempotencyKey },
			body: JSON.stringify({ previewToken: previewBody.previewToken }),
		},
	);
	expect(executed.status).toBe(202);
	await applyClaimedChange();
	return previewBody.carryOver;
}

/** Version 1 with 30 of 100 spent, then an immediate change to version 2 carrying the other 70. */
async function carryIntoVersionTwo(): Promise<void> {
	await addAllowance(1, "100");
	await addAllowance(2, "300");
	await sync(1);
	await spend(30, "spend-before-carry");
	const fixture = createIntegrationApp({ env: context.env, repository: context.repository });
	const preview = await previewChange(fixture, {
		...changeIntent("immediate"),
		carryOver: { balances: ["ai_credits"] },
	});
	const previewToken = (await preview.json()).data.previewToken;
	const executed = await testRequest(
		fixture.app,
		"/v1/billing-accounts/migration-stripe/commercial-actions",
		{
			method: "POST",
			headers: { ...jsonHeaders(fixture), "idempotency-key": "carry-then-return" },
			body: JSON.stringify({ previewToken }),
		},
	);
	expect(executed.status).toBe(202);
	await applyClaimedChange();
	await sync(2);
}

/** A catalog migration of the subscription between versions, applied and synced. */
async function migrate(fromVersion: number, toVersion: number): Promise<void> {
	const input = {
		fromPlanKey: "migration-plan",
		fromVersion,
		toPlanKey: "migration-plan",
		toVersion,
		effectiveMode: "immediate" as const,
		actor: "integration-test",
	};
	const preview = await context.repository.controlsEnterprise.previewCatalogMigration(
		project,
		input,
	);
	await context.repository.controlsEnterprise.publishCatalogMigration(project, {
		...input,
		previewToken: preview.previewToken,
	});
	await applyClaimedChange();
	await sync(toVersion);
}

async function migrateBackToVersionOne(): Promise<void> {
	await migrate(2, 1);
}

/**
 * An immediate change carrying balance and usage, whose Stripe update is recorded while the change is
 * still pending, or claimed by a worker that updated Stripe but has not recorded it yet.
 */
async function carryWhenStripeReportsEarly(stage: "pending" | "processing"): Promise<void> {
	await addAllowance(1, "100");
	await addAllowance(2, "300");
	await sync(1);
	await spend(30, "spend-before-early-switch");
	const fixture = createIntegrationApp({ env: context.env, repository: context.repository });
	const preview = await previewChange(fixture, {
		...changeIntent("immediate"),
		carryOver: { balances: ["ai_credits"], usages: ["ai_credits"] },
	});
	const previewToken = (await preview.json()).data.previewToken;
	const executed = await testRequest(
		fixture.app,
		"/v1/billing-accounts/migration-stripe/commercial-actions",
		{
			method: "POST",
			headers: { ...jsonHeaders(fixture), "idempotency-key": "early-switch" },
			body: JSON.stringify({ previewToken }),
		},
	);
	expect(executed.status).toBe(202);
	let claimedId: string | null = null;
	if (stage === "processing") {
		const [claimed] = await context.repository.claimSubscriptionChanges("carry-worker", 10);
		if (claimed === undefined) throw new Error("Expected a claimed change");
		claimedId = claimed.changeId;
	}

	// Stripe's update for the new version arrives before the change is marked applied.
	await sync(2);
	expect(await available()).toBe("340");
	expect(await carriedUsage()).toEqual([{ requested: "30.000000000", applied: "30.000000000" }]);

	if (claimedId === null) {
		await applyClaimedChange();
	} else {
		await context.repository.markSubscriptionChangeApplied(
			project.projectInstanceId,
			claimedId,
			"sub_migrate_stripe",
			"carry-worker",
		);
	}
	await sync(2);
	expect(await available()).toBe("340");
	expect((await allowances()).filter((row) => row.source_kind === "carry_over")).toHaveLength(1);
	expect(await carriedUsage()).toHaveLength(1);
}

/** Stripe renews the subscription: the next monthly period starts where the current one ends. */
async function renew(): Promise<void> {
	await context.sql`
		UPDATE subscriptions
		SET current_period_start = current_period_end,
			current_period_end = current_period_end + interval '1 month'
		WHERE external_subscription_id = 'sub_migrate_stripe'
	`;
}

/** The subscription's plan allowances, as version, quantity, consumed and whether they ended. */
async function planAllowances() {
	return (await allowances())
		.filter((row) => row.source_kind === "subscription")
		.map((row) => [row.version, row.quantity, row.consumed, row.ended]);
}

async function available(): Promise<string> {
	return (await context.repository.getMeteringBalance(project, "migration-stripe", "ai_credits"))
		.available;
}

/**
 * An `ai_credits` allowance on one version of the migration plan: for the whole monthly period, or,
 * without a reset, for the subscription's lifetime.
 */
async function addAllowance(
	version: number,
	quantity: string,
	reset: "month" | null = "month",
): Promise<void> {
	await context.sql`
		INSERT INTO plan_items (
			project_id, plan_version_id, feature_id, item_kind, quantity, reset_interval
		)
		SELECT version.project_id, version.id, feature.id, 'allocation', ${quantity}::numeric, ${reset}
		FROM plan_versions version
		JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
		JOIN features feature ON feature.project_id = version.project_id AND feature.key = 'ai_credits'
		WHERE plan.key = 'migration-plan' AND version.version = ${version}
	`;
}

async function spend(credits: number, key: string): Promise<void> {
	const result = await context.repository.consumeUsage(project, {
		billingAccountId: "migration-stripe",
		featureKey: "model_tokens",
		quantity: String(credits),
		idempotencyKey: key,
	});
	expect(result.allowed).toBe(true);
}

/** The worker's side of the change: claim it and record Stripe's acceptance. */
async function applyClaimedChange(): Promise<void> {
	const [claimed] = await context.repository.claimSubscriptionChanges("carry-worker", 10);
	if (claimed === undefined) throw new Error("Expected a claimed change");
	await context.repository.loadClaimedSubscriptionChange(
		claimed.projectInstanceId,
		claimed.changeId,
		"carry-worker",
	);
	await context.repository.markSubscriptionChangeApplied(
		project.projectInstanceId,
		claimed.changeId,
		"sub_migrate_stripe",
		"carry-worker",
	);
}

/** Stripe's `customer.subscription.updated` for the version the subscription now bills. */
async function sync(version: number) {
	const [subscription] = await context.sql`
		SELECT current_period_start, current_period_end FROM subscriptions
		WHERE external_subscription_id = 'sub_migrate_stripe'
	`;
	if (subscription === undefined) throw new Error("Expected the seeded subscription");
	const id = `evt_carry_${++eventOrder}`;
	return await context.repository.recordStripeSubscriptionAndEnqueueProjection(project, {
		billingAccountId: "migration-stripe",
		stripeCustomerId: "cus_migration",
		stripeSubscriptionId: "sub_migrate_stripe",
		invoiceId: null,
		externalProductId: `prod_migrate_v${version}_base`,
		externalPriceId: `price_migrate_v${version}_base`,
		subscriptionStatus: "active",
		purchasedAt: subscription.current_period_start,
		startsAt: subscription.current_period_start,
		expiresAt: subscription.current_period_end,
		currentPeriodStart: subscription.current_period_start,
		currentPeriodEnd: subscription.current_period_end,
		autoRenew: true,
		items: [
			{
				providerSubscriptionItemId: "si_migrate_base",
				externalProductId: `prod_migrate_v${version}_base`,
				externalPriceId: `price_migrate_v${version}_base`,
				quantity: 1,
			},
			{
				providerSubscriptionItemId: "si_migrate_seats",
				externalProductId: `prod_migrate_v${version}_seats`,
				externalPriceId: `price_migrate_v${version}_seats`,
				quantity: 7,
			},
		],
		rawPayload: {},
		eventType: "customer.subscription.updated",
		externalEventId: id,
		projectionReason: "provider_webhook",
		projectionIdempotencyKey: `${id}:projection`,
		providerEventCreated: eventOrder,
	});
}

async function allowances() {
	const rows = await context.sql<
		Array<{
			id: string;
			source_kind: string;
			version: number | null;
			quantity: string;
			consumed: string;
			ended: boolean;
			rolls: boolean;
			origin: string | null;
			expires_at_period_end: boolean;
			never_expires: boolean;
		}>
	>`
		SELECT allocation.id::text, allocation.source_kind, version.version,
			allocation.quantity::text AS quantity, allocation.consumed_quantity::text AS consumed,
			(allocation.expires_at IS NOT NULL AND allocation.expires_at <= now()) AS ended,
			allocation.rollover_processed_at IS NULL AS rolls,
			allocation.carry_over_origin_allocation_id::text AS origin,
			allocation.expires_at = subscription.current_period_end AS expires_at_period_end,
			allocation.expires_at IS NULL AS never_expires
		FROM balance_allocations allocation
		JOIN subscriptions subscription ON subscription.id = allocation.subscription_id
		LEFT JOIN plan_items item ON item.id = allocation.plan_item_id
		LEFT JOIN plan_versions version ON version.id = item.plan_version_id
		WHERE subscription.external_subscription_id = 'sub_migrate_stripe'
		ORDER BY allocation.id
	`;
	return rows.map((row) => ({ ...row }));
}

async function carriedUsage() {
	const rows = await context.sql<Array<{ requested: string; applied: string }>>`
		SELECT requested_quantity::text AS requested, applied_quantity::text AS applied
		FROM carried_usages
		ORDER BY created_at, from_allocation_id
	`;
	return rows.map((row) => ({ ...row }));
}

/** A `projects` allowance, a non-consumable level, on one version of the migration plan. */
async function addProjects(
	version: number,
	quantity: string,
	reset: "month" | null = null,
): Promise<void> {
	await context.sql`
		INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
		SELECT id, 'projects', 'Projects', 'metered', 'non_consumable', 'project', 0
		FROM projects WHERE key = 'acme'
		ON CONFLICT DO NOTHING
	`;
	await context.sql`
		INSERT INTO plan_items (
			project_id, plan_version_id, feature_id, item_kind, quantity, reset_interval
		)
		SELECT version.project_id, version.id, feature.id, 'allocation', ${quantity}::numeric, ${reset}
		FROM plan_versions version
		JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
		JOIN features feature ON feature.project_id = version.project_id AND feature.key = 'projects'
		WHERE plan.key = 'migration-plan' AND version.version = ${version}
	`;
}

async function tryAddProject(key: string): Promise<boolean> {
	const result = await context.repository.consumeUsage(project, {
		billingAccountId: "migration-stripe",
		featureKey: "projects",
		quantity: "1",
		idempotencyKey: key,
	});
	return result.allowed;
}

async function addProject(key: string): Promise<{ id: string; recordedAt: Date }> {
	const result = await context.repository.consumeUsage(project, {
		billingAccountId: "migration-stripe",
		featureKey: "projects",
		quantity: "1",
		idempotencyKey: key,
	});
	expect(result.allowed).toBe(true);
	return { id: result.usageEventId ?? "", recordedAt: new Date(result.recordedAt ?? "") };
}

async function removeProject(
	event: { id: string; recordedAt: Date } | undefined,
	key: string,
): Promise<void> {
	if (event === undefined) throw new Error("Expected a recorded project event");
	await context.repository.correctUsage(project, {
		billingAccountId: "migration-stripe",
		originalUsageEventId: event.id,
		originalRecordedAt: event.recordedAt,
		quantity: "1",
		idempotencyKey: key,
		actor: "integration-test",
		reason: "project deleted",
	});
}

async function projects() {
	return await context.repository.getMeteringBalance(project, "migration-stripe", "projects");
}

/** Live `projects` plan allowances, as version, quantity, consumed and whether they ended. */
async function projectAllowances() {
	const rows = await context.sql<
		Array<{ version: number; quantity: string; consumed: string; ended: boolean }>
	>`
		SELECT version.version, allocation.quantity::text AS quantity,
			allocation.consumed_quantity::text AS consumed,
			(allocation.expires_at IS NOT NULL AND allocation.expires_at <= now()) AS ended
		FROM balance_allocations allocation
		JOIN features feature ON feature.id = allocation.feature_id AND feature.key = 'projects'
		JOIN plan_items item ON item.id = allocation.plan_item_id
		JOIN plan_versions version ON version.id = item.plan_version_id
		WHERE allocation.source_kind = 'subscription'
			AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
		ORDER BY allocation.id
	`;
	return rows.map((row) => [row.version, row.quantity, row.consumed, row.ended]);
}
