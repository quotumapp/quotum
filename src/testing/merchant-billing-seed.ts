import type { SQL } from "bun";
import { seedIntegrationProjectsAndCatalog } from "../../tests/integration/helpers/catalog-fixtures";
import { publishAiCreditsCatalog } from "../../tests/integration/helpers/metering-catalog";
import { seedPhase3CatalogMigration } from "../../tests/integration/helpers/phase3-fixtures";
import type { AppDependencies } from "../app/types";
import { PostgresProjectInstanceContextResolver } from "../composition/project-instance-persistence";
import { BillingRepository } from "../db/repository";
import type { BillingEnv } from "../env";
import { buildStripeConfig } from "../providers/stripe/client";
import { StripeBillingService } from "../providers/stripe/service";
import { FakeStripeBillingClient } from "../providers/stripe/testing/fake-client";

/** Only imported by the guarded, loopback-only merchant integration entrypoint. */
export async function seedMerchantBilling(
	database: SQL,
	env: BillingEnv,
	services: NonNullable<AppDependencies["projectProviderServices"]>,
	scope: { organizationSlug: string; projectKey: string; environment: "sandbox" | "production" },
) {
	const [instance] = await database<
		{ id: string; key: string; name: string }[]
	>`SELECT i.id,i.key,i.name FROM projects i JOIN platform_projects p ON p.id=i.platform_project_id JOIN platform_organizations o ON o.id=p.organization_id WHERE o.slug=${scope.organizationSlug} AND p.key=${scope.projectKey} AND i.environment=${scope.environment} AND i.lifecycle_status='active'`;
	if (!instance) throw new Error("Synthetic scenario requires an active merchant instance");
	const resolved = await new PostgresProjectInstanceContextResolver(database).resolveInstanceId(
		instance.id,
	);
	if (resolved.kind !== "resolved") throw new Error("Synthetic project context missing");
	const context = resolved.context;
	const template = env.projectRuntime.find((project) => project.stripe);
	if (!template?.stripe) throw new Error("Synthetic Stripe template is missing");
	const billingAccountId = "merchant-synthetic-account";
	const repository = new BillingRepository();
	const existing =
		await database`SELECT id FROM customers WHERE project_id=${instance.id} AND billing_account_id=${billingAccountId}`;
	if (!existing.length) {
		await seedIntegrationProjectsAndCatalog(database, [
			{
				projectInstanceKey: instance.key,
				name: instance.name,
				projectionUrl: template.projectionUrl,
				projectionSecret: template.projectionSecret,
			},
		]);
		await publishAiCreditsCatalog(repository, context);
		await seedPhase3CatalogMigration(database, instance.key);
		await repository.grantAllocation(context, {
			billingAccountId,
			featureKey: "ai_credits",
			quantity: "20",
			sourceKind: "operator",
			sourceKey: "merchant:synthetic:grant",
		});
		await repository.consumeUsage(context, {
			billingAccountId,
			featureKey: "model_tokens",
			quantity: "400",
			idempotencyKey: "merchant:synthetic:consume",
		});
		await database`UPDATE projection_sync_jobs SET status='failed',attempts=10,last_error='Synthetic receiver unavailable' WHERE project_id=${instance.id}`;
		const payload = {
			id: "evt_merchant_synthetic",
			type: "customer.created",
			data: { object: { id: "cus_merchant_synthetic" } },
		};
		await database`INSERT INTO store_events(project_id,provider,channel,external_event_id,event_type,processing_status,processing_error,raw_payload) VALUES(${instance.id},'stripe','web','evt_merchant_synthetic','customer.created','failed','Synthetic processing failure',${JSON.stringify(payload)}::text::jsonb)`;
	}
	// Reuse only the runner's fake Stripe/loopback projection configuration. No provider secrets leave this process.
	if (!env.projectRuntime.some((project) => project.projectInstanceKey === instance.key)) {
		env.projectRuntime.push({
			...template,
			projectInstanceKey: instance.key,
		});
		const stripeConfig = buildStripeConfig(template.stripe);
		services[instance.key] = {
			stripeBillingService: new StripeBillingService({
				config: {
					...stripeConfig,
					projectKey: instance.key,
					projectionContract: "billing_state_v1",
				},
				client: new FakeStripeBillingClient(stripeConfig),
				repository: repository.forProject(context),
			}),
		};
	}
	const [event] = await database<
		{ id: string }[]
	>`SELECT id FROM store_events WHERE project_id=${instance.id} AND external_event_id='evt_merchant_synthetic'`;
	const [job] = await database<
		{ id: string }[]
	>`SELECT id FROM projection_sync_jobs WHERE project_id=${instance.id} ORDER BY created_at LIMIT 1`;
	const [usage] = await database<
		{ id: string; recorded_at: Date }[]
	>`SELECT id,recorded_at FROM usage_events WHERE project_id=${instance.id} AND operation='consume' ORDER BY recorded_at LIMIT 1`;
	if (!event || !job || !usage) throw new Error("Synthetic billing seed did not complete");
	const [subscription] = await database<
		{ id: string }[]
	>`SELECT id FROM subscriptions WHERE project_id=${instance.id} AND external_subscription_id='sub_migrate_stripe'`;
	return {
		billingAccountId,
		usageEventId: usage.id,
		originalRecordedAt: usage.recorded_at.toISOString(),
		eventId: event.id,
		jobId: job.id,
		subscriptionId: subscription?.id,
		externalSubscriptionId: "sub_migrate_stripe",
		commercialAccountId: "migration-stripe",
		planKey: "migration-plan",
	};
}
