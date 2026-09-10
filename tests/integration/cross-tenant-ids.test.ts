import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { createIntegrationApp } from "./helpers/app-fixture";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import { expectTableCounts } from "./helpers/db-assertions";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";
import { seedPhase3CatalogMigration, seedPhase3ControlCatalog } from "./helpers/phase3-fixtures";

const localDescribe = describeLocalPostgres(describe, describe.skip);
const voysee = integrationProjectContext("voysee");
const wiseley = integrationProjectContext("wiseley");
const sharedAccount = "shared-account";
let context: LocalPostgresContext;

localDescribe("Cross-tenant identifiers", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("rejects reservation confirm and release against another project's id", async () => {
		await publishAiCreditsCatalog(context.repository, "voysee");
		await publishAiCreditsCatalog(context.repository, "wiseley");
		await context.repository.grantAllocation(voysee, {
			billingAccountId: sharedAccount,
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "fixture:voysee-shared",
		});
		await context.repository.grantAllocation(wiseley, {
			billingAccountId: sharedAccount,
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "fixture:wiseley-shared",
		});
		const reserved = await context.repository.reserveUsage(voysee, {
			billingAccountId: sharedAccount,
			featureKey: "model_tokens",
			quantity: "100",
			idempotencyKey: "reserve:shared",
		});
		expect(reserved.allowed).toBe(true);
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const confirm = await app.request(
			`/v1/billing-accounts/${sharedAccount}/usage/reservations/${reserved.reservationId}/confirm`,
			{
				method: "POST",
				headers: {
					...authHeaders("wiseley"),
					"content-type": "application/json",
					"idempotency-key": "confirm:foreign",
				},
				body: JSON.stringify({ quantity: "100" }),
			},
		);
		expect(confirm.status).toBe(404);
		expect((await confirm.json()).error.code).toBe("RESERVATION_NOT_FOUND");
		const release = await app.request(
			`/v1/billing-accounts/${sharedAccount}/usage/reservations/${reserved.reservationId}/release`,
			{
				method: "POST",
				headers: {
					...authHeaders("wiseley"),
					"content-type": "application/json",
					"idempotency-key": "release:foreign",
				},
				body: JSON.stringify({}),
			},
		);
		expect(release.status).toBe(404);
		expect((await release.json()).error.code).toBe("RESERVATION_NOT_FOUND");
		expect(
			await context.repository.getMeteringBalance(voysee, sharedAccount, "ai_credits"),
		).toMatchObject({ held: "0.5" });
		await expectTableCounts(context.sql, {
			reservations: 1,
			usage_events: 0,
			client_idempotency_claims: 1,
		});
	});

	it("rejects usage-event corrections against another project's id", async () => {
		await publishAiCreditsCatalog(context.repository, "voysee");
		await publishAiCreditsCatalog(context.repository, "wiseley");
		await context.repository.grantAllocation(voysee, {
			billingAccountId: sharedAccount,
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "fixture:voysee-shared",
		});
		await context.repository.grantAllocation(wiseley, {
			billingAccountId: sharedAccount,
			featureKey: "ai_credits",
			quantity: "10",
			sourceKind: "operator",
			sourceKey: "fixture:wiseley-shared",
		});
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const consumed = await app.request(`/v1/billing-accounts/${sharedAccount}/usage/consume`, {
			method: "POST",
			headers: {
				...authHeaders("voysee"),
				"content-type": "application/json",
				"idempotency-key": "consume:shared",
			},
			body: JSON.stringify({ featureKey: "model_tokens", quantity: "400" }),
		});
		expect(consumed.status).toBe(200);
		const original = (await consumed.json()).data;
		const correction = await app.request(
			`/v1/billing-accounts/${sharedAccount}/usage/events/${original.usageEventId}/corrections`,
			{
				method: "POST",
				headers: {
					...authHeaders("wiseley"),
					"content-type": "application/json",
					"idempotency-key": "correction:foreign",
					"x-billing-actor": "product-worker",
				},
				body: JSON.stringify({
					originalRecordedAt: original.recordedAt,
					quantity: "100",
					reason: "foreign correction",
				}),
			},
		);
		expect(correction.status).toBe(404);
		expect((await correction.json()).error.code).toBe("USAGE_EVENT_NOT_FOUND");
		await expectTableCounts(context.sql, { usage_events: 1 });
	});

	it("rejects license revoke and contract terminate against another project's ids", async () => {
		await seedPhase3ControlCatalog(context.sql);
		await seedPhase3CatalogMigration(context.sql);
		await context.sql`
			INSERT INTO customers (project_id, billing_account_id)
			SELECT id, 'migration-stripe' FROM projects WHERE key = 'wiseley'
		`;
		await context.repository.controlsEnterprise.createEntity(voysee, {
			billingAccountId: "migration-stripe",
			externalId: "workspace-a",
			kind: "workspace",
		});
		const [pool] = await context.repository.controlsEnterprise.listLicensePools(
			voysee,
			"migration-stripe",
		);
		const assignment = await context.repository.controlsEnterprise.assignLicense(voysee, {
			billingAccountId: "migration-stripe",
			poolId: pool?.id ?? "",
			entityId: "workspace-a",
			quantity: 3,
			actor: "integration-test",
		});
		await expect(
			context.repository.controlsEnterprise.revokeLicense(wiseley, {
				billingAccountId: "migration-stripe",
				assignmentId: String(assignment.id),
				actor: "integration-test",
			}),
		).rejects.toMatchObject({ code: "LICENSE_ASSIGNMENT_NOT_FOUND" });

		await context.sql`
			UPDATE plan_versions version
			SET visibility = 'customer_specific', customer_id = customer.id
			FROM plans plan, customers customer, projects project
			WHERE version.project_id = project.id AND version.plan_id = plan.id
				AND customer.project_id = project.id
				AND project.key = 'voysee' AND plan.key = 'migration-plan'
				AND version.version = 2 AND customer.billing_account_id = 'migration-stripe'
		`;
		const currentIntent = {
			billingAccountId: "migration-stripe",
			contractKey: "negotiated-2026",
			version: 1,
			planKey: "migration-plan",
			effectiveAt: new Date(Date.now() - 60_000),
			replacesCommercialDefaults: true,
			controls: [
				{
					controlKind: "usage_limit" as const,
					featureKey: "ai_credits",
					currency: null,
					limitValue: "150",
					interval: "lifetime" as const,
				},
			],
			actor: "integration-test",
		};
		const preview = await context.repository.controlsEnterprise.previewEnterpriseContract(
			voysee,
			currentIntent,
		);
		const published = await context.repository.controlsEnterprise.publishEnterpriseContract(
			voysee,
			{
				...currentIntent,
				previewToken: preview.previewToken,
			},
		);
		await expect(
			context.repository.controlsEnterprise.terminateEnterpriseContract(
				wiseley,
				"migration-stripe",
				String(published.id),
				"integration-test",
			),
		).rejects.toMatchObject({ code: "ENTERPRISE_CONTRACT_NOT_FOUND" });

		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const httpTerminate = await app.request(
			`/v1/admin/contracts/migration-stripe/${published.id}`,
			{
				method: "DELETE",
				headers: {
					...authHeaders("wiseley"),
					"x-billing-operator-key": context.env.operatorApiKey ?? "",
					"x-billing-actor": "integration-test",
				},
			},
		);
		expect(httpTerminate.status).toBe(404);
		const [contract] = await context.sql<{ status: string }[]>`
			SELECT status FROM enterprise_contracts WHERE id = ${published.id}
		`;
		expect(contract.status).toBe("published");
		const [assignmentRow] = await context.sql<{ revoked_at: string | null }[]>`
			SELECT revoked_at::text FROM license_assignments WHERE id = ${assignment.id}
		`;
		expect(assignmentRow.revoked_at).toBeNull();
	});

	it("rejects commercial preview execution against another project", async () => {
		const { app, authHeaders } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
		});
		const previewResponse = await app.request(
			`/v1/billing-accounts/${sharedAccount}/commercial-actions/preview`,
			{
				method: "POST",
				headers: {
					...authHeaders("voysee"),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					intent: { kind: "checkout_product", productKey: "echo_credits_10" },
				}),
			},
		);
		expect(previewResponse.status).toBe(200);
		const preview = (await previewResponse.json()).data;
		const execute = await app.request(`/v1/billing-accounts/${sharedAccount}/commercial-actions`, {
			method: "POST",
			headers: {
				...authHeaders("wiseley"),
				"content-type": "application/json",
				"idempotency-key": "commercial:foreign",
			},
			body: JSON.stringify({ previewToken: preview.previewToken }),
		});
		expect(execute.status).toBe(409);
		expect((await execute.json()).error.code).toBe("COMMERCIAL_PREVIEW_NOT_FOUND");
	});

	it("expires an owned checkout session and rejects a billing-account mismatch", async () => {
		const { app, authHeaders, stripe } = createIntegrationApp({
			env: context.env,
			repository: context.repository,
			stripeCheckoutSession: {
				status: "open",
				payment_status: "unpaid",
				client_reference_id: sharedAccount,
				metadata: { billingAccountId: sharedAccount },
			},
		});
		const expired = await app.request(
			`/v1/billing-accounts/${sharedAccount}/providers/stripe/checkout-sessions/cs_test_integration/expire`,
			{
				method: "POST",
				headers: authHeaders("voysee"),
			},
		);
		expect(expired.status).toBe(200);
		expect((await expired.json()).data).toMatchObject({ status: "expired" });
		expect(stripe.calls).toContain("expireCheckoutSession:cs_test_integration");

		const mismatched = await app.request(
			"/v1/billing-accounts/other-account/providers/stripe/checkout-sessions/cs_test_integration/expire",
			{
				method: "POST",
				headers: authHeaders("voysee"),
			},
		);
		expect(mismatched.status).toBe(403);
		expect((await mismatched.json()).error.code).toBe("INVALID_REQUEST");
		await expectTableCounts(context.sql, {
			purchases: 0,
			customers: 0,
		});
	});
});
