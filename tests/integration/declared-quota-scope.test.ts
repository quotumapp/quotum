import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BillingError } from "../../src/billing/errors";
import type { CatalogIntent, CatalogPlanIntent } from "../../src/catalog/types";
import { readProjectionBalances } from "../../src/db/repository/entitlements";
import type { QueryExecutor } from "../../src/db/repository/types";
import type { CadenceUnit } from "../../src/shared/cadence";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { seedPhase3CatalogMigration, seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

type Scope = "account" | "entity";

/** PC-04: a meter limit's declared scope decides which usage it counts. */
localDescribe("declared meter-limit scope", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("caps an account's usage across entities and filters", async () => {
		await publish(catalog([plan("pro", "base", 1, cap("50", "day", "account"))]), null);
		await subscribe("scoped", "pro", 1);
		const project = integrationProjectContext();
		const usage = { billingAccountId: "scoped", featureKey: "api_requests", quantity: "50" };
		expect(
			await context.repository.consumeUsage(project, { ...usage, idempotencyKey: "account" }),
		).toMatchObject({ allowed: true });
		await entity("scoped", "workspace-a");

		// The QA probe's expectations, reversed: neither an entity nor a filter creates capacity.
		for (const subject of [
			{ entityId: "workspace-a" },
			{ filters: { region: "west" } },
			{ filters: { region: "east" } },
			{ entityId: "workspace-a", filters: { region: "west" } },
		]) {
			expect(
				await context.repository.checkUsage(project, { ...usage, ...subject, quantity: "1" }),
			).toMatchObject({
				allowed: false,
				balance: { granted: "50", consumed: "50", available: "0" },
			});
		}
		expect(
			await context.repository.consumeUsage(project, {
				...usage,
				entityId: "workspace-a",
				filters: { region: "west" },
				quantity: "1",
				idempotencyKey: "entity-west",
			}),
		).toMatchObject({ allowed: false, reason: "insufficient_balance" });
		expect(
			await context.repository.getMeteringBalance(project, "scoped", "api_requests", "workspace-a"),
		).toMatchObject({ consumed: "50", available: "0" });
		expect(await windows()).toEqual([
			{ entity: null, filter_key: null, scope: "account", usage: "50.000000000" },
		]);
	});

	it("gives each entity an entity-scoped limit and keeps a separate no-entity bucket", async () => {
		await publish(catalog([plan("team", "base", 1, cap("50", "day", "entity"))]), null);
		await subscribe("fan-out", "team", 1);
		await entity("fan-out", "workspace-a");
		await entity("fan-out", "workspace-b");
		const project = integrationProjectContext();
		const usage = { billingAccountId: "fan-out", featureKey: "api_requests" };

		for (const entityId of ["workspace-a", "workspace-b", null]) {
			expect(
				await context.repository.consumeUsage(project, {
					...usage,
					...(entityId === null ? {} : { entityId }),
					filters: { region: "west" },
					quantity: "50",
					idempotencyKey: `fan-out:${entityId}`,
				}),
			).toMatchObject({ allowed: true, balance: { granted: "50", consumed: "50" } });
			// Another filter value gives the same entity nothing more.
			expect(
				await context.repository.checkUsage(project, {
					...usage,
					...(entityId === null ? {} : { entityId }),
					filters: { region: "east" },
					quantity: "1",
				}),
			).toMatchObject({ allowed: false, balance: { available: "0" } });
		}
		await entity("fan-out", "workspace-c");
		expect(
			await context.repository.checkUsage(project, {
				...usage,
				entityId: "workspace-c",
				quantity: "50",
			}),
		).toMatchObject({ allowed: true, balance: { available: "50" } });
		expect(await windows()).toEqual([
			{ entity: null, filter_key: null, scope: "entity", usage: "50.000000000" },
			{ entity: "workspace-a", filter_key: null, scope: "entity", usage: "50.000000000" },
			{ entity: "workspace-b", filter_key: null, scope: "entity", usage: "50.000000000" },
		]);
		// The projection is the account's own view: the no-entity bucket, not every entity's sum.
		const balances = await readProjectionBalances(
			context.db as unknown as QueryExecutor,
			project.projectInstanceId,
			await customerId("fan-out"),
		);
		expect(balances.filter(({ featureKey }) => featureKey === "api_requests")).toMatchObject([
			{ available: "0", held: "0" },
		]);
	});

	it("counts usage and holds recorded before declared scopes, and corrects them", async () => {
		await publish(catalog([plan("pro", "base", 1, cap("50", "day", "account"))]), null);
		await subscribe("legacy", "pro", 1);
		await entity("legacy", "workspace-a");
		const project = integrationProjectContext();
		const usage = { billingAccountId: "legacy", featureKey: "api_requests" };
		const first = await context.repository.consumeUsage(project, {
			...usage,
			entityId: "workspace-a",
			quantity: "20",
			idempotencyKey: "legacy:first",
		});
		const hold = await context.repository.reserveUsage(project, {
			...usage,
			entityId: "workspace-a",
			quantity: "10",
			expiresInSeconds: 300,
			idempotencyKey: "legacy:hold",
		});
		// The way a window written before declared scopes looks: per entity and filter, no scope.
		await context.sql`
			UPDATE usage_windows SET scope = NULL, filter_key = 'legacy-filter',
				entity_id = (SELECT id FROM entities WHERE external_id = 'workspace-a')
		`;
		expect(
			await context.repository.consumeUsage(project, {
				...usage,
				quantity: "20",
				idempotencyKey: "legacy:after",
			}),
		).toMatchObject({ allowed: true, balance: { consumed: "40", held: "10", available: "0" } });
		expect(await context.repository.checkUsage(project, { ...usage, quantity: "1" })).toMatchObject(
			{ allowed: false },
		);

		// Correcting the pre-upgrade event frees capacity where the limit counts.
		expect(
			await context.repository.correctUsage(project, {
				billingAccountId: "legacy",
				originalUsageEventId: first.usageEventId ?? "",
				originalRecordedAt: new Date(first.recordedAt ?? ""),
				quantity: "5",
				idempotencyKey: "legacy:correct",
				actor: "integration-test",
				reason: "partially rejected",
			}),
		).toMatchObject({ balance: { consumed: "35", held: "10", available: "5" } });
		// The pre-upgrade hold settles on its own row.
		expect(
			await context.repository.confirmUsageReservation(project, {
				billingAccountId: "legacy",
				reservationId: hold.reservationId ?? "",
				quantity: "10",
				idempotencyKey: "legacy:confirm",
			}),
		).toMatchObject({ allowed: true, balance: { consumed: "45", held: "0", available: "5" } });
		expect(await windows()).toEqual([
			{ entity: null, filter_key: null, scope: "account", usage: "20.000000000" },
			{ entity: "workspace-a", filter_key: "legacy-filter", scope: null, usage: "25.000000000" },
		]);
	});

	it("keeps holds and denies usage while an account is over its cap at upgrade", async () => {
		await publish(catalog([plan("pro", "base", 1, cap("50", "day", "account"))]), null);
		await subscribe("over", "pro", 1);
		await entity("over", "workspace-a");
		const project = integrationProjectContext();
		const usage = { billingAccountId: "over", featureKey: "api_requests" };
		const consumed = await context.repository.consumeUsage(project, {
			...usage,
			quantity: "30",
			idempotencyKey: "over:consume",
		});
		const confirmed = await context.repository.reserveUsage(project, {
			...usage,
			quantity: "10",
			expiresInSeconds: 300,
			idempotencyKey: "over:hold-1",
		});
		const released = await context.repository.reserveUsage(project, {
			...usage,
			quantity: "5",
			expiresInSeconds: 300,
			idempotencyKey: "over:hold-2",
		});
		// Usage another entity recorded in its own window before the upgrade now counts too.
		await context.sql`
			INSERT INTO usage_windows (
				project_id, customer_id, entity_id, feature_id, window_start_at, window_end_at, usage,
				subscription_id, anchor_plan_item_id
			)
			SELECT project_id, customer_id, (SELECT id FROM entities WHERE external_id = 'workspace-a'),
				feature_id, window_start_at, window_end_at, 10, subscription_id, anchor_plan_item_id
			FROM usage_windows
		`;
		expect(
			await context.repository.consumeUsage(project, {
				...usage,
				quantity: "1",
				idempotencyKey: "over:denied",
			}),
		).toMatchObject({ allowed: false, balance: { consumed: "40", held: "15", available: "0" } });
		// A hold admitted before the upgrade confirms up to its held quantity.
		expect(
			await context.repository.confirmUsageReservation(project, {
				billingAccountId: "over",
				reservationId: confirmed.reservationId ?? "",
				quantity: "10",
				idempotencyKey: "over:confirm",
			}),
		).toMatchObject({ allowed: true, balance: { consumed: "50", held: "5" } });
		await context.repository.releaseUsageReservation(project, {
			billingAccountId: "over",
			reservationId: released.reservationId ?? "",
			idempotencyKey: "over:release",
		});
		expect(await context.repository.checkUsage(project, { ...usage, quantity: "1" })).toMatchObject(
			{ allowed: false, balance: { consumed: "50", held: "0" } },
		);
		// A correction that frees enough capacity admits usage again within the window.
		await context.repository.correctUsage(project, {
			billingAccountId: "over",
			originalUsageEventId: consumed.usageEventId ?? "",
			originalRecordedAt: new Date(consumed.recordedAt ?? ""),
			quantity: "3",
			idempotencyKey: "over:correct",
			actor: "integration-test",
			reason: "partially rejected",
		});
		expect(
			await context.repository.consumeUsage(project, {
				...usage,
				quantity: "3",
				idempotencyKey: "over:admitted",
			}),
		).toMatchObject({ allowed: true, balance: { consumed: "50", available: "0" } });
		expect(
			await context.sql<Array<{ status: string }>>`
				SELECT status FROM reservations ORDER BY created_at, id
			`,
		).toEqual([{ status: "confirmed" }, { status: "released" }]);
	});

	it("applies an account scope at once after a switch from entity scope", async () => {
		await publish(catalog([plan("pro", "base", 1, cap("50", "day", "entity"))]), null);
		await publish(catalog([plan("pro", "base", 2, cap("50", "day", "account"))]), 1);
		await subscribe("widened", "pro", 1);
		await entity("widened", "workspace-a");
		await entity("widened", "workspace-b");
		const project = integrationProjectContext();
		const usage = { billingAccountId: "widened", featureKey: "api_requests" };
		for (const entityId of ["workspace-a", "workspace-b"]) {
			await context.repository.consumeUsage(project, {
				...usage,
				entityId,
				quantity: "30",
				idempotencyKey: `widened:${entityId}`,
			});
		}
		await movePinnedVersion("widened", "pro", 2);
		// The account set already holds both entities' usage: nothing is gained.
		expect(await context.repository.checkUsage(project, { ...usage, quantity: "1" })).toMatchObject(
			{ allowed: false, balance: { consumed: "60", available: "0" } },
		);
	});

	it("keeps the account aggregate after a switch to entity scope until the window ends", async () => {
		await publish(catalog([plan("pro", "base", 1, cap("50", "day", "account"))]), null);
		await publish(catalog([plan("pro", "base", 2, cap("50", "day", "entity"))]), 1);
		await subscribe("narrowed", "pro", 1);
		await entity("narrowed", "workspace-a");
		const project = integrationProjectContext();
		const usage = { billingAccountId: "narrowed", featureKey: "api_requests" };
		await context.repository.consumeUsage(project, {
			...usage,
			quantity: "40",
			idempotencyKey: "narrowed:account",
		});
		await movePinnedVersion("narrowed", "pro", 2);
		expect(
			await context.repository.checkUsage(project, {
				...usage,
				entityId: "workspace-a",
				quantity: "20",
			}),
		).toMatchObject({ allowed: false, balance: { consumed: "40", available: "10" } });
		// The next window counts per entity.
		await context.sql`
			UPDATE usage_windows
			SET window_start_at = window_start_at - INTERVAL '1 day',
				window_end_at = window_end_at - INTERVAL '1 day'
		`;
		expect(
			await context.repository.checkUsage(project, {
				...usage,
				entityId: "workspace-a",
				quantity: "50",
			}),
		).toMatchObject({ allowed: true, balance: { consumed: "0", available: "50" } });
	});

	it("refuses scopes an account could hold together, and postpaid entity limits", async () => {
		await expect(
			preview(
				catalog([
					plan("pro", "base", 1, cap("100", "day", "account")),
					plan("boost", "addon", 1, cap("50", "day", "entity")),
				]),
				null,
			),
		).rejects.toThrow("must all declare the same allocationScope");
		const postpaid = plan("metered", "base", 1, cap("100", "month", "entity"));
		const [item] = postpaid.items;
		if (item === undefined) throw new Error("plan has no item");
		item.overagePolicy = "allowed";
		item.price = {
			key: "overage",
			currency: "USD",
			unitAmountMinor: 1,
			billingUnits: "1",
			billingInterval: "month",
			minimumQuantity: 1,
			maximumQuantity: null,
			taxBehavior: "unspecified",
			providerBindings: [{ productKey: "premium_monthly", provider: "stripe", channel: "web" }],
		};
		await expect(preview(catalog([postpaid]), null)).rejects.toThrow(
			"entity scope is only available to blocked limits",
		);

		// Two base plans never coexist, so they may differ.
		await publish(
			catalog([
				plan("pro", "base", 1, cap("100", "day", "account")),
				plan("team", "base", 1, cap("100", "day", "entity")),
			]),
			null,
		);
		await subscribe("pinned", "pro", 1);
		// An entity add-on would now be held with the pinned account base, even though the team
		// base it matches is in the intent.
		await expect(
			preview(
				catalog([
					plan("pro", "base", 2, cap("100", "day", "entity")),
					plan("team", "base", 1, cap("100", "day", "entity")),
					plan("boost", "addon", 1, cap("50", "day", "entity")),
				]),
				1,
			),
		).rejects.toThrow("1 subscriptions still use plan pro version 1");
		const accepted = await preview(
			catalog([
				plan("pro", "base", 2, cap("100", "day", "entity")),
				plan("team", "base", 1, cap("100", "day", "entity")),
			]),
			1,
		);
		expect(accepted.scopeImpact).toEqual([
			{
				featureKey: "api_requests",
				scopes: [
					{ plan: "pro", scope: "entity" },
					{ plan: "team", scope: "entity" },
				],
				pinnedVersions: [{ plan: "pro", version: 1, scope: "account", subscriptions: 1 }],
			},
		]);
	});

	it("refuses a purchase that would mix scopes", async () => {
		await publish(
			catalog([
				plan("pro", "base", 1, cap("100", "day", "account")),
				plan("boost", "addon", 1, cap("50", "day", "account")),
			]),
			null,
		);
		// An add-on published before declared scopes were checked, capping per entity.
		await setScope("boost", "entity");
		await subscribe("buyer", "pro", 1);
		const { versionId } = await versionOf("boost", 1);
		expect(
			await context.repository.meterLimitScopeConflicts(
				integrationProjectContext(),
				"buyer",
				versionId,
			),
		).toEqual(["api_requests"]);
		const { versionId: base } = await versionOf("pro", 1);
		expect(
			await context.repository.meterLimitScopeConflicts(integrationProjectContext(), "buyer", base),
		).toEqual([]);
	});

	it("refuses metering a mixed-scope feature but keeps release and corrections", async () => {
		await publish(
			catalog([
				plan("pro", "base", 1, cap("100", "day", "account")),
				plan("boost", "addon", 1, cap("50", "day", "account")),
			]),
			null,
		);
		await subscribe("mixed", "pro", 1);
		await subscribe("mixed", "boost", 1);
		const project = integrationProjectContext();
		const usage = { billingAccountId: "mixed", featureKey: "api_requests" };
		const consumed = await context.repository.consumeUsage(project, {
			...usage,
			quantity: "10",
			idempotencyKey: "mixed:consume",
		});
		const confirmable = await context.repository.reserveUsage(project, {
			...usage,
			quantity: "5",
			expiresInSeconds: 300,
			idempotencyKey: "mixed:hold-1",
		});
		const releasable = await context.repository.reserveUsage(project, {
			...usage,
			quantity: "5",
			expiresInSeconds: 300,
			idempotencyKey: "mixed:hold-2",
		});
		await setScope("boost", "entity");

		const refusals = [
			() => context.repository.checkUsage(project, { ...usage, quantity: "1" }),
			() =>
				context.repository.consumeUsage(project, {
					...usage,
					quantity: "1",
					idempotencyKey: "mixed:refused",
				}),
			() =>
				context.repository.reserveUsage(project, {
					...usage,
					quantity: "1",
					expiresInSeconds: 300,
					idempotencyKey: "mixed:refused-hold",
				}),
			() =>
				context.repository.confirmUsageReservation(project, {
					billingAccountId: "mixed",
					reservationId: confirmable.reservationId ?? "",
					quantity: "5",
					idempotencyKey: "mixed:refused-confirm",
				}),
		];
		for (const refusal of refusals) {
			const error = await refusal().then(
				() => null,
				(caught: unknown) => caught,
			);
			expect(error).toBeInstanceOf(BillingError);
			expect(error).toMatchObject({
				code: "METERING_CONFIGURATION_ERROR",
				status: 409,
				details: { reason: "mixed_scope", featureKey: "api_requests" },
			});
		}
		expect(
			await context.repository.releaseUsageReservation(project, {
				billingAccountId: "mixed",
				reservationId: releasable.reservationId ?? "",
				idempotencyKey: "mixed:release",
			}),
		).toMatchObject({ status: "released" });
		expect(
			await context.repository.correctUsage(project, {
				billingAccountId: "mixed",
				originalUsageEventId: consumed.usageEventId ?? "",
				originalRecordedAt: new Date(consumed.recordedAt ?? ""),
				quantity: "4",
				idempotencyKey: "mixed:correct",
				actor: "integration-test",
				reason: "partially rejected",
			}),
		).toMatchObject({ quantity: "-4" });
		expect(
			await context.sql<Array<{ status: string }>>`
				SELECT status FROM reservations ORDER BY created_at, id
			`,
		).toEqual([{ status: "active" }, { status: "released" }]);

		// Over HTTP the refusal is counted and logged.
		const { app, authHeaders, metrics } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const response = await app.handle(
			new Request("http://localhost/v1/billing-accounts/mixed/usage/check", {
				method: "POST",
				headers: { ...authHeaders(), "content-type": "application/json" },
				body: JSON.stringify({ featureId: "api_requests", value: "1" }),
			}),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: { code: "METERING_CONFIGURATION_ERROR", details: { reason: "mixed_scope" } },
		});
		expect(metrics.renderPrometheus()).toContain(
			'billing_metering_mixed_scope_total{route_group="metering"} 1',
		);
	});
});

/** A plan change or migration must not leave an account holding both scopes on one feature. */
localDescribe("declared meter-limit scope across plan changes", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
		// Version 2 of the migration plan caps a feature for the account; the account also holds an
		// add-on, published before declared scopes were checked, that caps it per entity.
		await context.sql`
			INSERT INTO features (project_id, key, name, kind, meter_kind, unit, credit_scale)
			SELECT id, 'scoped_requests', 'Scoped requests', 'metered', 'consumable', 'request', 0
			FROM projects WHERE key = 'acme'
		`;
		await context.sql`
			WITH addon AS (
				INSERT INTO plans (project_id, key, name)
				SELECT id, 'scope-addon', 'Scope add-on' FROM projects WHERE key = 'acme'
				RETURNING id, project_id
			)
			INSERT INTO plan_versions (
				project_id, plan_id, catalog_revision_id, version, status, currency,
				base_amount_minor, billing_interval, tier_rank, plan_kind
			)
			SELECT addon.project_id, addon.id, revision.id, 1, 'published', 'USD', 300, 'month', 0,
				'addon'
			FROM addon
			JOIN catalog_revisions revision
				ON revision.project_id = addon.project_id AND revision.revision = 1
		`;
		await context.sql`
			INSERT INTO plan_items (
				project_id, plan_version_id, feature_id, item_kind, quantity, reset_interval,
				allocation_scope
			)
			SELECT version.project_id, version.id, feature.id, 'meter_limit', 100, 'day',
				CASE plan.key WHEN 'scope-addon' THEN 'entity' ELSE 'account' END
			FROM plan_versions version
			JOIN plans plan ON plan.project_id = version.project_id AND plan.id = version.plan_id
			JOIN features feature
				ON feature.project_id = version.project_id AND feature.key = 'scoped_requests'
			WHERE (plan.key = 'migration-plan' AND version.version = 2) OR plan.key = 'scope-addon'
		`;
		await context.sql`
			INSERT INTO subscriptions (
				project_id, customer_id, product_id, store_product_id, provider, channel,
				external_subscription_id, external_product_id, external_price_id, status,
				starts_at, current_period_start, current_period_end, plan_version_id, catalog_revision_id
			)
			SELECT base.project_id, base.customer_id, base.product_id, base.store_product_id, 'stripe',
				'web', 'sub_scope_addon', base.external_product_id, base.external_price_id, 'active',
				base.starts_at, base.current_period_start, base.current_period_end, version.id,
				version.catalog_revision_id
			FROM subscriptions base
			JOIN plans plan ON plan.project_id = base.project_id AND plan.key = 'scope-addon'
			JOIN plan_versions version ON version.project_id = plan.project_id AND version.plan_id = plan.id
			WHERE base.external_subscription_id = 'sub_migrate_stripe'
		`;
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("refuses a plan change to a version with another scope than the account's add-on", async () => {
		const project = integrationProjectContext();
		const input = {
			billingAccountId: "migration-stripe",
			externalSubscriptionId: "sub_migrate_stripe",
			targetPlanKey: "migration-plan",
			quantities: { licensed_seats: 7 },
		};
		for (const attempt of [
			() => context.repository.previewSubscriptionChange(project, input),
			() =>
				context.repository.prepareSubscriptionChange(project, {
					...input,
					idempotencyKey: "scope-change",
				}),
		]) {
			const error = await attempt().then(
				() => null,
				(caught: unknown) => caught,
			);
			expect(error).toMatchObject({
				code: "ADDON_METER_LIMIT_CONFLICT",
				status: 409,
				details: { reason: "scope", featureKeys: ["scoped_requests"] },
			});
		}
		expect(await context.sql<Array<{ id: string }>>`SELECT id FROM subscription_changes`).toEqual(
			[],
		);
	});

	it("fails a catalog migration job that would mix scopes and leaves others alone", async () => {
		const project = integrationProjectContext();
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
		await context.repository.claimSubscriptionChanges("migration-worker", 10);
		const jobs = await context.sql<
			Array<{ external_subscription_id: string; status: string; last_error: string | null }>
		>`
			SELECT subscription.external_subscription_id, job.status, job.last_error
			FROM catalog_migration_jobs job
			JOIN subscriptions subscription ON subscription.id = job.subscription_id
			ORDER BY subscription.external_subscription_id
		`;
		expect(jobs).toContainEqual({
			external_subscription_id: "sub_migrate_stripe",
			status: "failed",
			last_error:
				"Target plan's meter limits on scoped_requests declare a different scope than the account's other subscriptions",
		});
		expect(
			await context.sql<Array<{ id: string }>>`
				SELECT change.id FROM subscription_changes change
				JOIN subscriptions subscription ON subscription.id = change.subscription_id
				WHERE subscription.external_subscription_id = 'sub_migrate_stripe'
			`,
		).toEqual([]);
	});
});

function cap(quantity: string, resetInterval: CadenceUnit, scope: Scope) {
	return { quantity, resetInterval, scope };
}

function plan(
	key: string,
	kind: "base" | "addon",
	version: number,
	limit: ReturnType<typeof cap> | null,
): CatalogPlanIntent {
	return {
		key,
		name: key,
		version,
		currency: "USD",
		baseAmountMinor: (kind === "base" ? 1000 : 300) * version,
		billingInterval: "month",
		trialDays: null,
		kind,
		items:
			limit === null
				? []
				: [
						{
							featureKey: "api_requests",
							itemKind: "meter_limit",
							quantity: limit.quantity,
							resetInterval: limit.resetInterval,
							expiresAfterSeconds: null,
							overagePolicy: "blocked",
							allocationScope: limit.scope,
						},
					],
		providerBindings: [],
	};
}

function catalog(plans: CatalogPlanIntent[]): CatalogIntent {
	return {
		features: [
			{
				key: "api_requests",
				name: "API requests",
				kind: "metered",
				meterKind: "consumable",
				unit: "request",
				creditScale: 0,
				filterDimensions: ["region"],
			},
		],
		plans,
		topups: [],
		rateCards: [],
	};
}

async function preview(intent: CatalogIntent, expectedRevision: number | null) {
	return await context.repository.previewCatalog(integrationProjectContext(), {
		expectedRevision,
		actor: "integration-declared-scope",
		catalog: intent,
	});
}

async function publish(intent: CatalogIntent, expectedRevision: number | null): Promise<void> {
	const created = await preview(intent, expectedRevision);
	await context.repository.publishCatalog(integrationProjectContext(), {
		expectedRevision,
		actor: "integration-declared-scope",
		previewToken: created.previewToken,
		catalog: intent,
	});
}

/** The plan's version published in the given catalog revision. */
async function versionOf(
	planKey: string,
	revision: number,
): Promise<{ versionId: string; revisionId: string }> {
	const [row] = await context.sql<Array<{ id: string; catalog_revision_id: string }>>`
		SELECT version.id::text, version.catalog_revision_id::text
		FROM plan_versions version
		JOIN plans ON plans.project_id = version.project_id AND plans.id = version.plan_id
		JOIN catalog_revisions cr
			ON cr.project_id = version.project_id AND cr.id = version.catalog_revision_id
		JOIN projects ON projects.id = version.project_id AND projects.key = 'acme'
		WHERE plans.key = ${planKey} AND cr.revision = ${revision}
	`;
	if (row === undefined) throw new Error(`Plan ${planKey} has no version in revision ${revision}`);
	return { versionId: row.id, revisionId: row.catalog_revision_id };
}

/** Rewrites a published limit's scope the way a catalog published before PC-04 could hold it. */
async function setScope(planKey: string, scope: Scope): Promise<void> {
	await context.sql`
		UPDATE plan_items item SET allocation_scope = ${scope}
		FROM plan_versions version
		JOIN plans ON plans.project_id = version.project_id AND plans.id = version.plan_id
		WHERE version.project_id = item.project_id AND version.id = item.plan_version_id
			AND plans.key = ${planKey} AND item.item_kind = 'meter_limit'
	`;
}

async function customerId(billingAccountId: string): Promise<string> {
	const [row] = await context.sql<Array<{ id: string }>>`
		SELECT customers.id FROM customers
		JOIN projects ON projects.id = customers.project_id AND projects.key = 'acme'
		WHERE customers.billing_account_id = ${billingAccountId}
	`;
	if (row === undefined) throw new Error(`No customer ${billingAccountId}`);
	return row.id;
}

async function entity(billingAccountId: string, externalId: string): Promise<void> {
	await context.repository.controlsEnterprise.createEntity(integrationProjectContext(), {
		billingAccountId,
		externalId,
		kind: "workspace",
	});
}

/** The account's usage windows, entity by external id. */
async function windows() {
	return await context.sql<
		Array<{ entity: string | null; filter_key: string | null; scope: string | null; usage: string }>
	>`
		SELECT entities.external_id AS entity, windows.filter_key, windows.scope,
			windows.usage::text AS usage
		FROM usage_windows windows
		LEFT JOIN entities ON entities.project_id = windows.project_id AND entities.id = windows.entity_id
		ORDER BY entities.external_id NULLS FIRST, windows.filter_key NULLS FIRST, windows.id
	`;
}

/** Moves the account's subscription to another version of its plan inside the same period. */
async function movePinnedVersion(
	billingAccountId: string,
	planKey: string,
	revision: number,
): Promise<void> {
	const target = await versionOf(planKey, revision);
	await context.sql`
		UPDATE subscriptions
		SET plan_version_id = ${target.versionId}::bigint,
			catalog_revision_id = ${target.revisionId}::bigint
		WHERE external_subscription_id = ${`${billingAccountId}:${planKey}`}
	`;
}

/** A Stripe subscription to the plan version the given revision published, pinned to it. */
async function subscribe(billingAccountId: string, planKey: string, revision: number) {
	const target = await versionOf(planKey, revision);
	await context.sql`
		INSERT INTO customers (project_id, billing_account_id)
		SELECT id, ${billingAccountId} FROM projects WHERE key = 'acme'
		ON CONFLICT DO NOTHING
	`;
	await context.sql`
		INSERT INTO subscriptions (
			project_id, customer_id, product_id, store_product_id, provider, channel,
			external_subscription_id, external_product_id, external_price_id, status,
			starts_at, expires_at, current_period_start, current_period_end,
			plan_version_id, catalog_revision_id
		)
		SELECT
			customers.project_id, customers.id, products.id, store_products.id, 'stripe', 'web',
			${`${billingAccountId}:${planKey}`}, 'prod_stripe_premium', 'price_premium_monthly',
			'active', now() - INTERVAL '1 hour', now() + INTERVAL '30 days',
			now() - INTERVAL '1 hour', now() + INTERVAL '30 days',
			${target.versionId}::bigint, ${target.revisionId}::bigint
		FROM customers
		JOIN projects ON projects.id = customers.project_id AND projects.key = 'acme'
		JOIN products ON products.project_id = customers.project_id AND products.key = 'premium_monthly'
		JOIN store_products ON store_products.project_id = products.project_id
			AND store_products.product_id = products.id
			AND store_products.provider = 'stripe'
		WHERE customers.billing_account_id = ${billingAccountId}
	`;
}
