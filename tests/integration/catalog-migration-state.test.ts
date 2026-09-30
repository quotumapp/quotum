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

	it("resumes a version's allowance, as it was left, when the subscription returns to it in the same period", async () => {
		await addAllowance(1, "100", true);
		await addAllowance(2, "300", false);
		await sync(1);
		const balance = async () =>
			(await context.repository.getMeteringBalance(project, "migration-stripe", "ai_credits"))
				.available;
		const spend = async (quantity: string, key: string) => {
			await context.repository.consumeUsage(project, {
				billingAccountId: "migration-stripe",
				featureKey: "model_tokens",
				quantity,
				idempotencyKey: key,
			});
		};
		await spend("30", "spend-on-1");

		await stageMigration(1, 2);
		await sync(2);
		expect(await balance()).toBe("300");
		await spend("50", "spend-on-2");

		await stageMigration(2, 1);
		await sync(1);
		// Version 1's allowance comes back with its earlier use; version 2's ends. No fresh grant.
		expect(await allowanceRows()).toEqual([
			{
				version: 1,
				quantity: "100.000000000",
				consumed: "30.000000000",
				ended: false,
				rolls: true,
			},
			{
				version: 2,
				quantity: "300.000000000",
				consumed: "50.000000000",
				ended: true,
				rolls: false,
			},
		]);
		expect(await balance()).toBe("70");
		await sync(1);
		expect(await allowanceRows()).toHaveLength(2);
		expect(await balance()).toBe("70");

		await stageMigration(1, 2);
		await sync(2);
		expect(await balance()).toBe("250");
		expect(await allowanceRows()).toHaveLength(2);
	});

	it("resumes the current reset window's allowance when the subscription returns within it", async () => {
		await addAllowance(1, "40", false, "week");
		await addAllowance(2, "90", false, "week");
		await sync(1);
		await context.repository.consumeUsage(project, {
			billingAccountId: "migration-stripe",
			featureKey: "model_tokens",
			quantity: "15",
			idempotencyKey: "weekly-spend-on-1",
		});
		await stageMigration(1, 2);
		await sync(2);
		await stageMigration(2, 1);
		await sync(1);
		expect(await allowanceRows()).toEqual([
			{ version: 1, quantity: "40.000000000", consumed: "15.000000000", ended: false, rolls: true },
			{ version: 2, quantity: "90.000000000", consumed: "0.000000000", ended: true, rolls: false },
		]);
		expect(
			(await context.repository.getMeteringBalance(project, "migration-stripe", "ai_credits"))
				.available,
		).toBe("25");
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

	it("moves to another version of the same plan when the customer switches to its price in the portal", async () => {
		await addAllowance(1, "100", true);
		await addAllowance(2, "300", false);
		await sync(1);
		await context.repository.consumeUsage(project, {
			billingAccountId: "migration-stripe",
			featureKey: "model_tokens",
			quantity: "30",
			idempotencyKey: "spend-before-portal-switch",
		});

		// No change was staged: Stripe reports version 2's price, so the subscription follows it.
		const switched = await sync(2);
		expect(switched.processingStatus).toBe("processed");
		expect(await pinnedVersion()).toBe(2);
		expect((await itemRows()).filter((row) => row.active).map((row) => row.version)).toEqual([
			2, 2,
		]);
		expect(await allowanceRows()).toEqual([
			{
				version: 1,
				quantity: "100.000000000",
				consumed: "30.000000000",
				ended: true,
				rolls: false,
			},
			{ version: 2, quantity: "300.000000000", consumed: "0.000000000", ended: false, rolls: true },
		]);

		// Switching back in the same period resumes version 1's allowance as it was left.
		await sync(1);
		expect(await pinnedVersion()).toBe(1);
		expect(
			(await context.repository.getMeteringBalance(project, "migration-stripe", "ai_credits"))
				.available,
		).toBe("70");
	});

	it("follows Stripe to a third version when the customer switches after an applied change", async () => {
		await addVersion(3);
		await addAllowance(1, "100", true);
		await sync(1);
		const changeId = await stageMigration(1, 2);
		await carryOverOnChange(["ai_credits"]);

		// The switch happened after the change reached Stripe, so the snapshot carries its stamp.
		const switched = await sync(3, 7, false, {
			created: secondsFromNow(60),
			billingChangeId: changeId,
		});
		expect(switched.processingStatus).toBe("processed");
		expect(await pinnedVersion()).toBe(3);
		expect((await itemRows()).filter((row) => row.active).map((row) => row.version)).toEqual([
			3, 3,
		]);
		// The change Stripe no longer reflects is settled without effect and never carries over.
		expect(await changeRows()).toEqual([{ status: "applied", synchronized: true, to: 2 }]);
		expect(await carryOverRows()).toBe(0);

		// Its own, older event arrives late: the subscription does not move back.
		await sync(2, 7, false, { created: secondsFromNow(30), billingChangeId: changeId });
		expect(await pinnedVersion()).toBe(3);
	});

	it("stays on the source version when the customer switches back after an applied change", async () => {
		await addAllowance(1, "100", true);
		await addAllowance(2, "300", false);
		await sync(1);
		const changeId = await stageMigration(1, 2);
		await carryOverOnChange(["ai_credits"]);

		// The stamp says the snapshot was taken after the change reached Stripe, even though its
		// timestamp reads a few seconds earlier than the database's record of the apply.
		await sync(1, 7, false, { created: secondsFromNow(-5), billingChangeId: changeId });
		expect(await pinnedVersion()).toBe(1);
		expect(await changeRows()).toEqual([{ status: "applied", synchronized: true, to: 2 }]);
		expect(await allowanceRows()).toEqual([
			{ version: 1, quantity: "100.000000000", consumed: "0.000000000", ended: false, rolls: true },
		]);
		expect(await carryOverRows()).toBe(0);
	});

	it("keeps an applied change waiting while Stripe still reports the state from before it", async () => {
		const changeId = await stageMigration(1, 2);

		// An event from before the change shows the source price and no stamp: nothing moves yet.
		const early = await sync(1, 7, false, { created: 100, billingChangeId: null });
		expect(early.processingStatus).toBe("processed");
		expect(await pinnedVersion()).toBe(1);
		expect(await changeRows()).toEqual([{ status: "applied", synchronized: false, to: 2 }]);

		await sync(2, 7, false, { created: secondsFromNow(60), billingChangeId: changeId });
		expect(await pinnedVersion()).toBe(2);
		expect(await changeRows()).toEqual([{ status: "applied", synchronized: true, to: 2 }]);
	});

	it("keeps an applied change and its carry-over through a reconciliation read from before it", async () => {
		await addAllowance(1, "100", true);
		await addAllowance(2, "300", false);
		await sync(1);
		const changeId = await stageMigration(1, 2);
		await carryOverOnChange(["ai_credits"]);

		// Reconciliation read Stripe before the worker's update landed and recorded it afterwards:
		// a live read, with no timestamp, still showing the source price and no stamp.
		const stale = await sync(1, 7, false, { reconciliation: true, billingChangeId: null });
		expect(stale.processingStatus).toBe("processed");
		expect(await pinnedVersion()).toBe(1);
		expect(await changeRows()).toEqual([{ status: "applied", synchronized: false, to: 2 }]);

		await sync(2, 7, false, { created: secondsFromNow(60), billingChangeId: changeId });
		expect(await pinnedVersion()).toBe(2);
		expect(await changeRows()).toEqual([{ status: "applied", synchronized: true, to: 2 }]);
		expect(await carryOverRows()).toBe(1);
	});

	it("keeps an applied change waiting for an unstamped event from its own second", async () => {
		await addAllowance(1, "100", true);
		await addAllowance(2, "300", false);
		await sync(1);
		const changeId = await stageMigration(1, 2);
		await carryOverOnChange(["ai_credits"]);
		// The database clock runs a second behind Stripe's, so by the clocks alone an event Stripe
		// created in the second of the apply would look later than the apply.
		await context.sql`
			UPDATE subscription_changes SET applied_at = applied_at - interval '1 second'
		`;

		await sync(1, 7, false, { created: secondsFromNow(0), billingChangeId: null });
		expect(await pinnedVersion()).toBe(1);
		expect(await changeRows()).toEqual([{ status: "applied", synchronized: false, to: 2 }]);

		await sync(2, 7, false, { created: secondsFromNow(60), billingChangeId: changeId });
		expect(await pinnedVersion()).toBe(2);
		expect(await carryOverRows()).toBe(1);
	});

	it("cancels a queued change that a provider-side switch left behind", async () => {
		await addVersion(3);
		await context.sql`
			INSERT INTO subscription_changes (
				project_id, customer_id, subscription_id, provider, from_plan_version_id,
				to_plan_version_id, change_kind, effective_mode, effective_at, proration_behavior,
				status, idempotency_key, request_hash
			)
			SELECT subscription.project_id, subscription.customer_id, subscription.id, 'stripe',
				source.id, target.id, 'upgrade', 'period_end', now() + interval '10 days', 'none',
				'pending', 'queued-before-switch', repeat('c', 64)
			FROM subscriptions subscription
			JOIN plan_versions source ON source.id = subscription.plan_version_id
			JOIN plan_versions target
				ON target.project_id = source.project_id AND target.plan_id = source.plan_id
				AND target.version = 2
			WHERE subscription.external_subscription_id = 'sub_migrate_stripe'
		`;

		await sync(3, 7, false, { created: secondsFromNow(60) });
		expect(await pinnedVersion()).toBe(3);
		const [change] = await context.sql<Array<{ status: string; last_error: string | null }>>`
			SELECT status, last_error FROM subscription_changes
		`;
		expect(change).toEqual({
			status: "cancelled",
			last_error: "The subscription moved to another plan version at the provider",
		});
	});

	it("tells the worker holding a change that a provider-side switch superseded it", async () => {
		await addVersion(3);
		const input = {
			fromPlanKey: "migration-plan",
			fromVersion: 1,
			toPlanKey: "migration-plan",
			toVersion: 2,
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
		const load = () =>
			context.repository.loadClaimedSubscriptionChange(
				claimed.projectInstanceId,
				claimed.changeId,
				"migration-worker",
			);
		expect(await load()).toMatchObject({ sourceSuperseded: false });

		await sync(3, 7, false, { created: secondsFromNow(60) });
		expect(await pinnedVersion()).toBe(3);
		// The sync leaves a held change to its worker, which ends it instead of calling Stripe.
		expect(await load()).toMatchObject({ status: "processing", sourceSuperseded: true });
	});

	it("records a subscription whose Stripe price no published version binds", async () => {
		await context.sql`
			INSERT INTO store_products (
				project_id, product_id, provider, channel, external_product_id,
				external_price_id, billing_period, currency, price_amount
			)
			SELECT project.id, product.id, 'stripe', 'web', 'prod_migrate_orphan_base',
				'price_migrate_orphan_base', 'month', 'USD', 2500
			FROM projects project
			JOIN products product ON product.project_id = project.id AND product.key = 'premium_monthly'
			WHERE project.key = 'acme'
		`;
		const original = await itemRows();

		const orphan = await sync("orphan", 7, false, { created: secondsFromNow(60) });
		expect(orphan.processingStatus).toBe("processed");
		// The pinned version and its tracked items stay; the event records what was not bound.
		expect(await pinnedVersion()).toBe(1);
		expect(await itemRows()).toEqual(original);
		expect(await lastEventError()).toBe(
			"Stripe prices price_migrate_orphan_base, price_migrate_orphan_seats have no published binding on the subscription's plan version; it keeps plan migration-plan version 1",
		);

		// Cancellation is always recorded, whatever the price.
		const deleted = await sync("orphan", 7, false, {
			created: secondsFromNow(90),
			eventType: "customer.subscription.deleted",
			status: "expired",
		});
		expect(deleted.processingStatus).toBe("processed");
		const [subscription] = await context.sql<Array<{ status: string }>>`
			SELECT status FROM subscriptions WHERE external_subscription_id = 'sub_migrate_stripe'
		`;
		expect(subscription?.status).toBe("expired");
	});

	it("synchronizes a migration whose seat price is unbound and keeps tracking that item", async () => {
		const original = await itemRows();
		await stageMigration(1, 2);
		const result = await sync(2, 7, true);
		expect(result.processingStatus).toBe("processed");
		expect(await pinnedVersion()).toBe(2);
		expect(await changeRows()).toEqual([{ status: "applied", synchronized: true, to: 2 }]);
		// The base item moves to version 2; the unbound seat item keeps its earlier price component.
		const seats = original.find((row) => row.key === "seats");
		expect((await itemRows()).filter((row) => row.active)).toEqual([
			{ ...seats, active: true },
			expect.objectContaining({ version: 2, key: "base", provider_item_id: "si_migrate_base" }),
		] as ItemRow[]);
		expect(await lastEventError()).toBe(
			"Stripe prices price_unknown have no published binding on the subscription's plan version; it keeps plan migration-plan version 2",
		);
		await sync(2);
		expect((await itemRows()).filter((row) => row.active).map((row) => row.version)).toEqual([
			2, 2,
		]);
	});
});

/** A published version of the migration plan with its own Stripe prices, bound like the others. */
async function addVersion(version: number): Promise<void> {
	await context.sql`
		INSERT INTO plan_versions (
			project_id, plan_id, catalog_revision_id, version, status, currency,
			base_amount_minor, billing_interval, tier_rank
		)
		SELECT plan.project_id, plan.id, source.catalog_revision_id, ${version}, 'published', 'USD',
			2000, 'month', ${version * 10}
		FROM plans plan
		JOIN plan_versions source ON source.plan_id = plan.id AND source.version = 1
		WHERE plan.key = 'migration-plan'
	`;
	await context.sql`
		INSERT INTO plan_items (
			project_id, plan_version_id, feature_id, item_kind, quantity, reset_interval, allocation_scope
		)
		SELECT version.project_id, version.id, feature.id, 'licensed_quantity', 1, NULL, 'license_pool'
		FROM plan_versions version
		JOIN plans plan ON plan.id = version.plan_id AND plan.key = 'migration-plan'
		JOIN features feature ON feature.project_id = version.project_id AND feature.key = 'licensed_seats'
		WHERE version.version = ${version}
	`;
	await context.sql`
		INSERT INTO price_components (
			project_id, plan_version_id, plan_item_id, key, component_kind, charge_timing,
			currency, unit_amount_minor, billing_units, billing_interval, minimum_quantity,
			maximum_quantity
		)
		SELECT version.project_id, version.id, NULL, 'base', 'base', 'in_advance', 'USD', 2000, 1,
			'month', 1, 1
		FROM plan_versions version
		JOIN plans plan ON plan.id = version.plan_id AND plan.key = 'migration-plan'
		WHERE version.version = ${version}
		UNION ALL
		SELECT version.project_id, version.id, item.id, 'seats', 'licensed', 'in_advance', 'USD', 200,
			1, 'month', 1, 100
		FROM plan_versions version
		JOIN plans plan ON plan.id = version.plan_id AND plan.key = 'migration-plan'
		JOIN plan_items item ON item.plan_version_id = version.id
		WHERE version.version = ${version}
	`;
	await context.sql`
		INSERT INTO store_products (
			project_id, product_id, provider, channel, external_product_id,
			external_price_id, billing_period, currency, price_amount
		)
		SELECT project.id, product.id, 'stripe', 'web',
			concat('prod_migrate_v', ${version}::text, '_', component.kind),
			concat('price_migrate_v', ${version}::text, '_', component.kind),
			'month', 'USD', component.amount
		FROM projects project
		JOIN products product ON product.project_id = project.id AND product.key = 'premium_monthly'
		CROSS JOIN (VALUES ('base', 2000), ('seats', 200)) AS component(kind, amount)
		WHERE project.key = 'acme'
	`;
	await context.sql`
		INSERT INTO provider_price_bindings (
			project_id, price_component_id, store_product_id, provider, channel, status
		)
		SELECT price.project_id, price.id, store.id, 'stripe', 'web', 'published'
		FROM price_components price
		JOIN plan_versions version ON version.id = price.plan_version_id
		JOIN plans plan ON plan.id = version.plan_id AND plan.key = 'migration-plan'
		JOIN store_products store ON store.project_id = price.project_id
			AND store.external_price_id = concat('price_migrate_v', version.version::text, '_', price.key)
		WHERE version.version = ${version}
	`;
	await context.sql`
		INSERT INTO provider_plan_bindings (
			project_id, plan_version_id, store_product_id, provider, channel, status
		)
		SELECT price.project_id, price.plan_version_id, binding.store_product_id, 'stripe', 'web',
			'published'
		FROM price_components price
		JOIN plan_versions version ON version.id = price.plan_version_id
		JOIN provider_price_bindings binding ON binding.price_component_id = price.id
		WHERE price.key = 'base' AND version.version = ${version}
	`;
}

/** Gives the staged change a carry-over, as a previewed immediate plan change would. */
async function carryOverOnChange(balances: string[]): Promise<void> {
	await context.sql`
		UPDATE subscription_changes SET carry_over = (${JSON.stringify({ balances })}::text)::jsonb
	`;
}

async function changeRows() {
	return await context.sql<Array<{ status: string; synchronized: boolean; to: number }>>`
		SELECT change.status, change.synchronized_at IS NOT NULL AS synchronized,
			version.version AS to
		FROM subscription_changes change
		JOIN plan_versions version ON version.id = change.to_plan_version_id
		ORDER BY change.created_at
	`.then((rows) => rows.map((row) => ({ ...row })));
}

async function carryOverRows(): Promise<number> {
	const [row] = await context.sql<Array<{ count: number }>>`
		SELECT count(*)::integer AS count FROM balance_allocations WHERE source_kind = 'carry_over'
	`;
	return row?.count ?? 0;
}

async function lastEventError(): Promise<string | null> {
	const [row] = await context.sql<Array<{ processing_error: string | null }>>`
		SELECT processing_error FROM store_events
		WHERE external_event_id = ${`evt_sync_${eventOrder}`}
	`;
	return row?.processing_error ?? null;
}

/** A Stripe event timestamp: seconds since the epoch, offset from now. */
function secondsFromNow(seconds: number): number {
	return Math.floor(Date.now() / 1000) + seconds;
}

/** An `ai_credits` allowance on one version of the migration plan, resetting monthly by default. */
async function addAllowance(
	version: number,
	quantity: string,
	rollover: boolean,
	reset: "month" | "week" = "month",
): Promise<void> {
	await context.sql`
		INSERT INTO plan_items (
			project_id, plan_version_id, feature_id, item_kind, quantity, reset_interval,
			rollover_enabled, rollover_max_quantity, rollover_expiry_mode, rollover_expiry_interval,
			rollover_expiry_interval_count
		)
		SELECT version.project_id, version.id, feature.id, 'allocation', ${quantity}::numeric, ${reset},
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

/** Applies an immediate catalog migration at "Stripe" and returns the change's id. */
async function stageMigration(
	fromVersion: number,
	toVersion: number,
	toPlanKey = "migration-plan",
): Promise<string> {
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
	return String(claimed.changeId);
}

/**
 * Records a Stripe snapshot of the subscription on `version`'s prices. `created` is the event's
 * Stripe timestamp; by default events are ordered by a counter far in the past. `billingChangeId`
 * is the change stamp in the snapshot's metadata (null: metadata without one; omitted: no metadata).
 * A `reconciliation` snapshot is a live read, with no event id or timestamp.
 */
async function sync(
	version: number | string,
	seats = 7,
	unboundSeat = false,
	options: {
		created?: number;
		eventType?: "customer.subscription.updated" | "customer.subscription.deleted";
		status?: "active" | "expired";
		billingChangeId?: string | null;
		reconciliation?: boolean;
	} = {},
) {
	const [subscription] = await context.sql`
		SELECT current_period_start, current_period_end FROM subscriptions
		WHERE external_subscription_id = 'sub_migrate_stripe'
	`;
	if (subscription === undefined) throw new Error("Expected the seeded subscription");
	const id = `evt_sync_${++eventOrder}`;
	const prices = typeof version === "number" ? `v${version}` : version;
	return await context.repository.recordStripeSubscriptionAndEnqueueProjection(project, {
		billingAccountId: "migration-stripe",
		stripeCustomerId: "cus_migration",
		stripeSubscriptionId: "sub_migrate_stripe",
		invoiceId: null,
		externalProductId: `prod_migrate_${prices}_base`,
		externalPriceId: `price_migrate_${prices}_base`,
		subscriptionStatus: options.status ?? "active",
		purchasedAt: subscription.current_period_start,
		startsAt: subscription.current_period_start,
		expiresAt: subscription.current_period_end,
		currentPeriodStart: subscription.current_period_start,
		currentPeriodEnd: subscription.current_period_end,
		autoRenew: true,
		items: [
			{
				providerSubscriptionItemId: "si_migrate_base",
				externalProductId: `prod_migrate_${prices}_base`,
				externalPriceId: `price_migrate_${prices}_base`,
				quantity: 1,
			},
			{
				providerSubscriptionItemId: "si_migrate_seats",
				externalProductId: `prod_migrate_${prices}_seats`,
				externalPriceId: unboundSeat ? "price_unknown" : `price_migrate_${prices}_seats`,
				quantity: seats,
			},
		],
		...(options.billingChangeId === undefined ? {} : { billingChangeId: options.billingChangeId }),
		rawPayload: {},
		eventType: options.reconciliation
			? "provider_reconciliation"
			: (options.eventType ?? "customer.subscription.updated"),
		externalEventId: options.reconciliation ? null : id,
		projectionReason: options.reconciliation ? "provider_reconciliation" : "provider_webhook",
		projectionIdempotencyKey: `${id}:projection`,
		providerEventCreated: options.reconciliation ? 0 : (options.created ?? eventOrder),
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
