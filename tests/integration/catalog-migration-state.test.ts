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
