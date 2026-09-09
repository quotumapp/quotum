import { SQL } from "bun";
import { z } from "zod";
import { bootstrapTestPlatform } from "../../scripts/lib/test-platform-bootstrap";
import { resetAndSeedIntegrationData } from "../../tests/integration/helpers/catalog-fixtures";
import type { AppDependencies } from "../app/types";
import { PostgresProjectInstanceContextResolver } from "../composition/project-instance-persistence";
import { initializePostgresHealth } from "../db/client";
import { BillingRepository } from "../db/repository";
import { ProjectionSyncJobRepository } from "../db/repository-domains";
import { createMerchantAuth } from "../platform/auth";
import { loadMerchantConfig } from "../platform/config";
import { secureEqual, tokenHash } from "../platform/security";
import { FakeStripeBillingClient } from "../providers/stripe/testing/fake-client";
import { createBillingRuntimeApp } from "../runtime";
import { ProjectionSyncWorker } from "../workers/projection-sync";
import {
	fixtureConnections,
	loadFixtureEnv,
	FixtureProjectionHttpClient as ProjectionHttpClient,
} from "./connection-fixtures";
import { seedMerchantBilling } from "./merchant-billing-seed";
import { FakeMerchantGoogle, MerchantCaptureMailer } from "./merchant-fakes";

if (
	process.env.BILLING_ENV !== "test" ||
	process.env.BILLING_TEST_FAKE_STRIPE !== "true" ||
	process.env.MERCHANT_TEST_MODE !== "true"
)
	throw new Error(
		"Merchant test entrypoint requires explicitly enabled test mode and fake providers",
	);
const env = loadFixtureEnv();
const projectServices: NonNullable<AppDependencies["projectProviderServices"]> = {};
const config = loadMerchantConfig();
if (
	!config?.testMode ||
	!["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.origin).hostname)
)
	throw new Error("Merchant integration origin must be loopback");
const controlToken = z.string().min(32).parse(process.env.MERCHANT_TEST_CONTROL_TOKEN);
const serviceToken = z.string().min(32).parse(process.env.MERCHANT_TEST_SERVICE_TOKEN);
const mailer = new MerchantCaptureMailer();
const google = new FakeMerchantGoogle();
const restoreFetch = google.install(true);
const database = new SQL(env.postgresUri, { max: 4, idleTimeout: 1 });
const control = Bun.serve({
	hostname: "127.0.0.1",
	port: Number(process.env.MERCHANT_TEST_CONTROL_PORT ?? "0"),
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/health") return Response.json({ status: "ok" });
		if (request.method === "GET" && url.pathname === `/google/${controlToken}/authorize`)
			return Response.redirect(google.authorize(url.href), 302);
		const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
		if (!secureEqual(bearer, controlToken)) return new Response("Unauthorized", { status: 401 });
		try {
			if (request.method === "POST" && url.pathname === "/reset") {
				env.connectionFixtures.splice(
					0,
					env.connectionFixtures.length,
					...env.connectionFixtures.filter(
						(project) => !project.projectInstanceKey.startsWith("merchant_"),
					),
				);
				for (const key of Object.keys(projectServices))
					if (key.startsWith("merchant_")) delete projectServices[key];
				await database`TRUNCATE platform_idempotency,platform_audit_events,platform_policy_acceptances,platform_service_principals,platform_step_up_grants,platform_project_api_credentials,platform_provisioning_steps,platform_provisioning_operations,platform_projects,platform_onboarding_drafts,platform_invitations,platform_memberships,platform_organizations,platform_merchant_sessions,platform_external_identities,platform_principals,platform_auth_users,platform_auth_verifications,platform_auth_rate_limits,platform_rate_limits,platform_auth_links CASCADE`;
				await bootstrapTestPlatform(env.postgresUri, ["voysee", "wiseley"]);
				await resetAndSeedIntegrationData(database);
				await database`INSERT INTO platform_service_principals(name,token_hash) VALUES('merchant-e2e',${tokenHash(serviceToken, config.secret)})`;
				mailer.reset();
				google.reset();
				google.profile = {
					subject: "synthetic-google-subject",
					email: "google@example.com",
					name: "Google Merchant",
					verified: true,
				};
				return Response.json({ status: "ready" });
			}
			if (request.method === "GET" && url.pathname === "/email") {
				const message = mailer.messages.findLast(
					(candidate) =>
						candidate.to === url.searchParams.get("to") &&
						candidate.kind === url.searchParams.get("kind"),
				);
				if (!message) return Response.json({ code: "NOT_READY" }, { status: 404 });
				if (message.kind === "otp")
					return Response.json({ code: message.text.match(/\b\d{6}\b/)?.[0] });
				const link = message.text.match(/https?:\/\/[^\s]+/)?.[0];
				return Response.json({
					url: link,
					token: link ? new URLSearchParams(new URL(link).hash.slice(1)).get("token") : null,
				});
			}
			if (request.method === "POST" && url.pathname === "/seed/billing") {
				const scope = z
					.strictObject({
						organizationSlug: z.string(),
						projectKey: z.string(),
						environment: z.enum(["sandbox", "production"]),
					})
					.parse(await request.json());
				return Response.json(await seedMerchantBilling(database, env, projectServices, scope));
			}
			if (request.method === "POST" && url.pathname === "/projections/run") {
				const worker = new ProjectionSyncWorker({
					workerId: "merchant-e2e-control",
					projectContextResolver: new PostgresProjectInstanceContextResolver(database),
					maxAttempts: 5,
					batchSize: 25,
					repository: new ProjectionSyncJobRepository(new BillingRepository()),
					delivery: new ProjectionHttpClient({
						projects: env.connectionFixtures,
						fetch: globalThis.fetch,
					}),
				});
				return Response.json(await worker.runOnce());
			}
			if (request.method === "POST" && url.pathname === "/google/profile") {
				google.profile = z
					.object({
						subject: z.string().min(1),
						email: z.email(),
						name: z.string().default("Google Merchant"),
						verified: z.boolean().default(true),
						nonce: z.string().optional(),
						issuer: z.string().optional(),
						expiresIn: z.number().optional(),
					})
					.parse(await request.json());
				return Response.json({ status: "configured" });
			}
			if (request.method === "POST" && url.pathname === "/email/fail-next") {
				mailer.failNext = true;
				return Response.json({ status: "configured" });
			}
			if (request.method === "POST" && url.pathname === "/session/expire") {
				const { email } = z.object({ email: z.email() }).parse(await request.json());
				await database`UPDATE platform_merchant_sessions SET last_seen_at=now()-interval '31 minutes' WHERE principal_id IN(SELECT p.id FROM platform_principals p JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE u.email=${email})`;
				return Response.json({ status: "expired" });
			}
			if (request.method === "POST" && url.pathname === "/production/activate") {
				const { organizationSlug, projectKey } = z
					.object({ organizationSlug: z.string(), projectKey: z.string() })
					.parse(await request.json());
				await database`UPDATE projects SET lifecycle_status='active' WHERE environment='production' AND platform_project_id IN(SELECT p.id FROM platform_projects p JOIN platform_organizations o ON o.id=p.organization_id WHERE o.slug=${organizationSlug} AND p.key=${projectKey})`;
				return Response.json({ status: "active" });
			}
			if (request.method === "GET" && url.pathname === "/state") {
				const counts =
					await database`SELECT (SELECT count(*)::int FROM platform_principals) AS principals,(SELECT count(*)::int FROM platform_organizations WHERE slug NOT LIKE '%-test-organization') AS organizations,(SELECT count(*)::int FROM platform_memberships WHERE status='active') AS members,(SELECT count(*)::int FROM projects WHERE key LIKE 'merchant_%') AS instances,(SELECT count(*)::int FROM platform_auth_sessions) AS transient_sessions,(SELECT bool_and(length(token_hash)=64) FROM platform_merchant_sessions) AS sessions_hashed`;
				const audit =
					await database`SELECT action,metadata FROM platform_audit_events ORDER BY created_at`;
				const credentials =
					await database`SELECT revoked_at IS NOT NULL AS revoked,octet_length(secret_verifier)=32 AS hashed FROM platform_project_api_credentials WHERE project_instance_id IN (SELECT id FROM projects WHERE key LIKE 'merchant_%')`;
				const usageEvents =
					await database`SELECT id,operation,quantity::text,metadata->>'actor' AS actor FROM usage_events`;
				const events = await database`SELECT id,processing_status AS status FROM store_events`;
				const jobs = await database`SELECT id,status,attempts FROM projection_sync_jobs`;
				const commercial =
					await database`SELECT (SELECT count(*)::int FROM enterprise_contracts) AS contracts,(SELECT count(*)::int FROM catalog_migration_jobs) AS migrations,(SELECT count(*)::int FROM subscription_changes) AS subscription_changes`;
				return Response.json({
					...counts[0],
					...commercial[0],
					audit,
					credentials,
					usageEvents,
					events,
					jobs,
					googleRequests: google.externalRequests,
				});
			}
			return new Response("Not found", { status: 404 });
		} catch {
			return Response.json({ error: "Synthetic control operation failed" }, { status: 500 });
		}
	},
});

await initializePostgresHealth();
const app = createBillingRuntimeApp(env, {
	connections: fixtureConnections(env.connectionFixtures),
	projectionFetch: globalThis.fetch,
	projectProviderServices: projectServices,
	stripeClientFactory: (stripeConfig) => new FakeStripeBillingClient(stripeConfig),
	merchant: {
		config: { ...config, google: { clientId: google.clientId, clientSecret: google.clientSecret } },
		mailer,
		createAuth: (store, sender, authDatabase) =>
			createMerchantAuth(store, sender, authDatabase, {
				googleAuthorizationEndpoint: `http://127.0.0.1:${control.port}/google/${controlToken}/authorize`,
			}),
	},
});
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.once(signal, () => {
		control.stop(true);
		restoreFetch();
		void database.close();
	});
export default {
	hostname: "127.0.0.1",
	port: Number(process.env.PORT ?? "3000"),
	fetch: app.fetch,
};
