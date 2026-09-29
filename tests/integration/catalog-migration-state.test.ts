import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
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

interface ItemRow {
	id: string;
	version: number;
	key: string;
	provider_item_id: string | null;
	quantity: number;
	active: boolean;
	ended: boolean;
}

describeLocalPostgres(describe, describe.skip)("Catalog migration synchronization", () => {
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

	it("ends the outgoing version's live allowance at the switch, not rolled over, while its holds settle", async () => {
		await addAllowance(1, "100", true);
		await addAllowance(2, "300", false);
		await sync(1);
		const balance = async () =>
			(await context.repository.getMeteringBalance(project, "migration-stripe", "ai_credits"))
				.available;
		expect(await balance()).toBe("100");
		const hold = await context.repository.reserveUsage(project, {
			billingAccountId: "migration-stripe",
			featureKey: "model_tokens",
			quantity: "10",
			idempotencyKey: "hold-before-switch",
			expiresInSeconds: 300,
		});
		if (hold.reservationId === null) throw new Error("Expected a reservation");

		await stageMigration(1, 2);
		await sync(2);

		expect(await allowanceRows()).toEqual([
			{ version: 1, quantity: "100.000000000", consumed: "0.000000000", ended: true, rolls: false },
			{ version: 2, quantity: "300.000000000", consumed: "0.000000000", ended: false, rolls: true },
		]);
		// Only the incoming allowance counts: no double allowance after an immediate change.
		expect(await balance()).toBe("300");
		const confirmed = await context.repository.confirmUsageReservation(project, {
			billingAccountId: "migration-stripe",
			reservationId: hold.reservationId,
			quantity: "10",
			idempotencyKey: "confirm-after-switch",
		});
		expect(confirmed).toMatchObject({ status: "confirmed" });
		expect((await allowanceRows())[0]).toMatchObject({ version: 1, consumed: "10.000000000" });
		await context.repository.runMeteringMaintenance(100);
		const [rollovers] = await context.sql<Array<{ count: number }>>`
			SELECT count(*)::integer AS count FROM balance_allocations WHERE source_kind = 'rollover'
		`;
		expect(rollovers?.count).toBe(0);
		await sync(2);
		expect(await allowanceRows()).toHaveLength(2);
	});

	it("keeps a 1 → 2 → 1 migration settled through ordinary item updates", async () => {
		const original = await itemRows();
		await context.repository.controlsEnterprise.createEntity(project, {
			billingAccountId: "migration-stripe",
			externalId: "workspace-a",
			kind: "workspace",
		});
		const [pool] = await context.repository.controlsEnterprise.listLicensePools(
			project,
			"migration-stripe",
		);
		if (pool === undefined) throw new Error("Expected a purchased license pool");
		const assignment = await context.repository.controlsEnterprise.assignLicense(project, {
			billingAccountId: "migration-stripe",
			poolId: pool.id,
			entityId: "workspace-a",
			quantity: 3,
			actor: "integration-test",
		});

		await stageMigration(1, 2);
		await sync(2);
		expect(await pinnedVersion()).toBe(2);
		const upgraded = await itemRows();
		expect(upgraded).toHaveLength(4);
		expect(upgraded.filter((row) => row.version === 1)).toEqual(
			original.map((row) => ({ ...row, provider_item_id: null, active: false, ended: true })),
		);
		expect(upgraded.filter((row) => row.active).map((row) => row.provider_item_id)).toEqual([
			"si_migrate_base",
			"si_migrate_seats",
		]);

		await stageMigration(2, 1);
		await sync(1);
		await sync(1, 5);
		await sync(1, 5);
		expect(await pinnedVersion()).toBe(1);
		const returned = await itemRows();
		expect(returned).toHaveLength(4);
		expect(returned.filter((row) => row.version === 1)).toEqual(
			original.map((row) => ({ ...row, quantity: row.key === "seats" ? 5 : 1 })),
		);
		expect(returned.filter((row) => row.version === 2)).toEqual(
			upgraded
				.filter((row) => row.version === 2)
				.map((row) => ({ ...row, provider_item_id: null, active: false, ended: true })),
		);
		expect(
			await context.repository.controlsEnterprise.listLicensePools(project, "migration-stripe"),
		).toContainEqual(expect.objectContaining({ id: pool.id, active: true, quantity: 5 }));
		const [retainedAssignment] = await context.sql`
			SELECT id::text, license_pool_id::text, revoked_at FROM license_assignments
			WHERE id = ${assignment.id}::bigint
		`;
		expect(retainedAssignment).toEqual({
			id: assignment.id,
			license_pool_id: pool.id,
			revoked_at: null,
		});
		expect(
			await context.repository.controlsEnterprise.checkEntityLicense(project, {
				billingAccountId: "migration-stripe",
				entityId: "workspace-a",
				featureKey: "licensed_seats",
				requiredQuantity: 3,
			}),
		).toMatchObject({ assignedQuantity: 3 });
		const [changes] = await context.sql`
			SELECT count(*)::integer AS total,
				count(synchronized_at)::integer AS synchronized FROM subscription_changes
		`;
		expect(changes).toEqual({ total: 2, synchronized: 2 });
	});

	it("does not replay an applied change after a provider-side return to its source plan", async () => {
		// Give version 2 its own plan so a provider-side product switch is an admitted plan switch.
		await context.sql`
			INSERT INTO plans (project_id, key, name)
			VALUES (${project.projectInstanceId}::uuid, 'other-plan', 'Other plan')
		`;
		await context.sql`
			UPDATE plan_versions version SET plan_id = plan.id FROM plans plan
			WHERE version.project_id = plan.project_id AND version.version = 2
				AND plan.key = 'other-plan'
		`;
		await context.sql`
			UPDATE plans plan SET active_version_id = version.id FROM plan_versions version
			WHERE version.project_id = plan.project_id AND version.plan_id = plan.id
		`;
		await stageMigration(1, 2, "other-plan");
		await sync(2);
		expect(await pinnedVersion()).toBe(2);
		await sync(1);
		await sync(1);
		expect(await pinnedVersion()).toBe(1);
		expect((await itemRows()).filter((row) => row.active).map((row) => row.version)).toEqual([
			1, 1,
		]);
	});

	it("rolls back migration synchronization and item transfers when a provider item is unbound", async () => {
		const original = await itemRows();
		await stageMigration(1, 2);
		await expect(sync(2, 7, true)).rejects.toThrow("has no published price binding");
		expect(await pinnedVersion()).toBe(1);
		expect(await itemRows()).toEqual(original);
		const [change] = await context.sql`SELECT synchronized_at FROM subscription_changes`;
		expect(change?.synchronized_at).toBeNull();
		await sync(2);
		expect(await pinnedVersion()).toBe(2);
	});
});

/** An `ai_credits` allowance on one version of the migration plan, resetting monthly. */
async function addAllowance(version: number, quantity: string, rollover: boolean): Promise<void> {
	await context.sql`
		INSERT INTO plan_items (
			project_id, plan_version_id, feature_id, item_kind, quantity, reset_interval,
			rollover_enabled, rollover_max_quantity, rollover_expiry_mode, rollover_expiry_interval,
			rollover_expiry_interval_count
		)
		SELECT version.project_id, version.id, feature.id, 'allocation', ${quantity}::numeric, 'month',
			${rollover}, NULL, ${rollover ? "forever" : "none"}, NULL, 1
		FROM plan_versions version
		JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
		JOIN features feature ON feature.project_id = version.project_id AND feature.key = 'ai_credits'
		WHERE plan.key = 'migration-plan' AND version.version = ${version}
	`;
}

async function allowanceRows() {
	const rows = await context.sql<
		Array<{ version: number; quantity: string; consumed: string; ended: boolean; rolls: boolean }>
	>`
		SELECT version.version, allocation.quantity::text AS quantity,
			allocation.consumed_quantity::text AS consumed,
			(allocation.expires_at IS NOT NULL AND allocation.expires_at <= now()) AS ended,
			allocation.rollover_processed_at IS NULL AS rolls
		FROM balance_allocations allocation
		JOIN plan_items item ON item.id = allocation.plan_item_id
		JOIN plan_versions version ON version.id = item.plan_version_id
		JOIN subscriptions subscription ON subscription.id = allocation.subscription_id
		WHERE subscription.external_subscription_id = 'sub_migrate_stripe'
			AND allocation.source_kind = 'subscription'
		ORDER BY version.version
	`;
	return rows.map((row) => ({ ...row }));
}

async function stageMigration(
	fromVersion: number,
	toVersion: number,
	toPlanKey = "migration-plan",
) {
	const input = {
		fromPlanKey: "migration-plan",
		fromVersion,
		toPlanKey,
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
	const [claimed] = await context.repository.claimSubscriptionChanges("migration-worker", 10);
	if (claimed === undefined) throw new Error("Expected a claimed migration change");
	const change = await context.repository.loadClaimedSubscriptionChange(
		claimed.projectInstanceId,
		claimed.changeId,
		"migration-worker",
	);
	expect(change).toMatchObject({
		targetPlanVersionId: preview.toPlanVersionId,
		items: [
			{
				providerSubscriptionItemId: "si_migrate_base",
				externalPriceId: `price_migrate_v${toVersion}_base`,
				quantity: 1,
			},
			{
				providerSubscriptionItemId: "si_migrate_seats",
				externalPriceId: `price_migrate_v${toVersion}_seats`,
				quantity: 7,
			},
		],
	});
	await context.repository.markSubscriptionChangeApplied(
		project.projectInstanceId,
		claimed.changeId,
		"sub_migrate_stripe",
		"migration-worker",
	);
}

async function sync(version: number, seats = 7, unboundSeat = false) {
	const [subscription] = await context.sql`
		SELECT current_period_start, current_period_end FROM subscriptions
		WHERE external_subscription_id = 'sub_migrate_stripe'
	`;
	if (subscription === undefined) throw new Error("Expected the seeded subscription");
	const id = `evt_sync_${++eventOrder}`;
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
				externalPriceId: unboundSeat ? "price_unknown" : `price_migrate_v${version}_seats`,
				quantity: seats,
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

async function pinnedVersion(): Promise<number> {
	const [row] = await context.sql`
		SELECT version.version FROM subscriptions subscription
		JOIN plan_versions version ON version.id = subscription.plan_version_id
		WHERE subscription.external_subscription_id = 'sub_migrate_stripe'
	`;
	if (row === undefined) throw new Error("Expected the seeded subscription");
	return row.version;
}

async function itemRows(): Promise<ItemRow[]> {
	return await context.sql<ItemRow[]>`
		SELECT item.id::text, version.version, price.key,
			item.provider_subscription_item_id AS provider_item_id, item.quantity,
			item.active, item.ends_at IS NOT NULL AS ended
		FROM subscription_items item
		JOIN price_components price ON price.id = item.price_component_id
		JOIN plan_versions version ON version.id = price.plan_version_id
		ORDER BY version.version, price.key
	`;
}
