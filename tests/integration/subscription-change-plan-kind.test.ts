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

const localDescribe = describeLocalPostgres(describe, describe.skip);
const project = integrationProjectContext();
let context: LocalPostgresContext;

localDescribe("subscription change to a plan of another kind", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("answers a base plan changing to an add-on as a conflict, not as a missing plan", async () => {
		// The subscription stays on its base version; the version a change would target is an add-on.
		await context.sql`
			UPDATE plan_versions version
			SET plan_kind = 'addon', trial_days = NULL
			FROM plans plan
			WHERE version.project_id = plan.project_id AND version.id = plan.active_version_id
				AND plan.project_id = ${project.projectInstanceId}::uuid AND plan.key = 'migration-plan'
		`;
		const { app, stripe, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const post = async (path: string, body: unknown, idempotencyKey?: string) => {
			const response = await testRequest(app, `/v1/billing-accounts/migration-stripe${path}`, {
				method: "POST",
				headers: {
					...authHeaders("acme"),
					"content-type": "application/json",
					...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
				},
				body: JSON.stringify(body),
			});
			const { error } = await response.json();
			return { status: response.status, code: error?.code, message: error?.message };
		};
		const change = (targetPlanKey: string, idempotencyKey: string) =>
			post(
				"/subscriptions/sub_migrate_stripe/changes",
				{ targetPlanKey, quantities: { licensed_seats: 7 } },
				idempotencyKey,
			);
		const mismatch = {
			status: 409,
			code: "SUBSCRIPTION_CHANGE_PLAN_KIND_MISMATCH",
			message:
				"Plan migration-plan is an add-on; a subscription to a base plan cannot change to it",
		};

		expect(await change("migration-plan", "kind:direct")).toEqual(mismatch);
		expect(
			await post("/commercial-actions/preview", {
				intent: {
					kind: "subscription_change",
					externalSubscriptionId: "sub_migrate_stripe",
					targetPlanKey: "migration-plan",
					quantities: { licensed_seats: 7 },
				},
			}),
		).toEqual(mismatch);
		// A plan the project does not have is still the one that is not found.
		expect(await change("no-such-plan", "kind:missing")).toMatchObject({
			status: 404,
			code: "SUBSCRIPTION_CHANGE_TARGET_NOT_FOUND",
		});

		expect(stripe.subscriptionUpdates).toEqual([]);
		const [rows] = await context.sql`
			SELECT
				(SELECT count(*)::int FROM subscription_changes
					WHERE project_id = ${project.projectInstanceId}::uuid) AS changes,
				(SELECT count(*)::int FROM commercial_action_previews
					WHERE project_id = ${project.projectInstanceId}::uuid) AS previews`;
		expect(rows).toEqual({ changes: 0, previews: 0 });
	});
});
