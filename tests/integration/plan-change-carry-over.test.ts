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

async function available(): Promise<string> {
	return (await context.repository.getMeteringBalance(project, "migration-stripe", "ai_credits"))
		.available;
}

/** An `ai_credits` allowance on one version of the migration plan, for the whole monthly period. */
async function addAllowance(version: number, quantity: string): Promise<void> {
	await context.sql`
		INSERT INTO plan_items (
			project_id, plan_version_id, feature_id, item_kind, quantity, reset_interval
		)
		SELECT version.project_id, version.id, feature.id, 'allocation', ${quantity}::numeric, 'month'
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
		}>
	>`
		SELECT allocation.id::text, allocation.source_kind, version.version,
			allocation.quantity::text AS quantity, allocation.consumed_quantity::text AS consumed,
			(allocation.expires_at IS NOT NULL AND allocation.expires_at <= now()) AS ended,
			allocation.rollover_processed_at IS NULL AS rolls,
			allocation.carry_over_origin_allocation_id::text AS origin,
			allocation.expires_at = subscription.current_period_end AS expires_at_period_end
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
	`;
	return rows.map((row) => ({ ...row }));
}
