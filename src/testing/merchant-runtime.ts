import { SQL } from "bun";
import { z } from "zod";
import { bootstrapTestPlatform } from "../../scripts/lib/test-platform-bootstrap";
import {
	resetAndSeedIntegrationData,
	seedIntegrationProjectsAndCatalog,
} from "../../tests/integration/helpers/catalog-fixtures";
import { publishAiCreditsCatalog } from "../../tests/integration/helpers/metering-catalog";
import type { AppDependencies } from "../app/types";
import { PostgresProjectInstanceContextResolver } from "../composition/project-instance-persistence";
import type { QuotumApp, QuotumRuntime } from "../composition/runtime-lifecycle";
import { createWorkerProviderSelectors } from "../composition/worker-providers";
import { BillingRepository } from "../db/repository";
import { ProjectionSyncJobRepository } from "../db/repository-domains";
import { createMerchantAuth } from "../platform/auth";
import { loadMerchantConfig, merchantPlatformEnabled } from "../platform/config";
import { secureEqual, tokenHash } from "../platform/security";
import { ProjectionHttpClient } from "../projections/http-client";
import { createProviderRegistry } from "../providers/registry";
import { FakeStripeBillingClient } from "../providers/stripe/testing/fake-client";
import { createBillingRuntime } from "../runtime";
import { ProjectionSyncWorker } from "../workers/projection-sync";
import { PromotionMaintenanceWorker } from "../workers/promotion-maintenance";
import { fixtureConnections, loadFixtureEnv } from "./connection-fixtures";
import { createMerchantOtpFixture } from "./merchant-auth-fixture";
import { seedMerchantBilling } from "./merchant-billing-seed";
import { merchantTestConnections } from "./merchant-connections";
import { FakeMerchantGoogle, MerchantCaptureMailer } from "./merchant-fakes";

export async function createMerchantTestRuntime(
	options: { composeApp?: (app: QuotumApp) => QuotumApp } = {},
) {
	if (
		process.env.BILLING_ENV !== "test" ||
		process.env.BILLING_TEST_FAKE_STRIPE !== "true" ||
		process.env.MERCHANT_TEST_MODE !== "true"
	)
		throw new Error(
			"Merchant test entrypoint requires explicitly enabled test mode and fake providers",
		);
	if (!merchantPlatformEnabled())
		throw new Error("Merchant test entrypoint cannot run with QUOTUM_MERCHANT_ENABLED=false");
	const env = loadFixtureEnv();
	const projectServices: NonNullable<AppDependencies["projectProviderServices"]> = {};
	const config = loadMerchantConfig();
	if (
		!config.testMode ||
		!["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.origin).hostname)
	)
		throw new Error("Merchant integration origin must be loopback");
	const controlToken = z.string().min(32).parse(process.env.MERCHANT_TEST_CONTROL_TOKEN);
	const serviceToken = z.string().min(32).parse(process.env.MERCHANT_TEST_SERVICE_TOKEN);
	const mailer = new MerchantCaptureMailer();
	const google = new FakeMerchantGoogle();
	const restoreFetch = google.install(true);
	const database = new SQL(env.postgresUri, { max: 4, idleTimeout: 1 });
	const refuseUnseededProviderOperation = async (): Promise<never> => {
		throw new Error("Synthetic provider operation has no scenario");
	};
	let runtime: QuotumRuntime | undefined;
	let control: ReturnType<typeof Bun.serve> | undefined;
	try {
		const synthetic = merchantTestConnections(database, fixtureConnections(env.connectionFixtures));
		const otpFixture = createMerchantOtpFixture(database, mailer);
		const promotionRepository = new BillingRepository();
		const promotionProviders = createWorkerProviderSelectors(
			createProviderRegistry({
				connections: synthetic.connections,
				getRepository: () => promotionRepository,
				overrides: projectServices,
				clientFactories: { stripe: (stripeConfig) => new FakeStripeBillingClient(stripeConfig) },
			}),
		);
		control = Bun.serve({
			hostname: "127.0.0.1",
			port: Number(process.env.MERCHANT_TEST_CONTROL_PORT ?? "0"),
			async fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/health") return Response.json({ status: "ok" });
				if (request.method === "GET" && url.pathname === `/google/${controlToken}/authorize`)
					return Response.redirect(google.authorize(url.href), 302);
				if (request.method === "GET" && url.pathname === `/stripe/${controlToken}/authorize`)
					return Response.redirect(synthetic.authorize(url), 302);
				const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
				if (!secureEqual(bearer, controlToken))
					return new Response("Unauthorized", { status: 401 });
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
						await database`INSERT INTO platform_auth_oauth_clients(client_id,name,redirect_uris,scopes,grant_types,response_types,token_endpoint_auth_method,require_p_k_c_e,skip_consent,created_at,updated_at) VALUES
						('quotum-claude-code','Claude Code',ARRAY['http://localhost:8788/callback'],ARRAY['quotum.read','offline_access'],ARRAY['authorization_code','refresh_token'],ARRAY['code'],'none',true,false,now(),now()),
						('quotum-cursor','Cursor',ARRAY['http://localhost:8787/callback'],ARRAY['quotum.read','offline_access'],ARRAY['authorization_code','refresh_token'],ARRAY['code'],'none',true,false,now(),now())`;
						await bootstrapTestPlatform(env.postgresUri, ["acme", "globex"]);
						await resetAndSeedIntegrationData(database);
						await database`INSERT INTO platform_service_principals(name,token_hash) VALUES('merchant-e2e',${tokenHash(serviceToken, config.secret)})`;
						mailer.reset();
						synthetic.reset();
						otpFixture.reset();
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
								managed: z.boolean().optional(),
							})
							.parse(await request.json());
						return Response.json(
							await seedMerchantBilling(database, env, projectServices, scope, {
								configureFixtures: scope.managed !== true,
							}),
						);
					}
					if (request.method === "POST" && url.pathname === "/seed/catalog") {
						const scope = z
							.strictObject({
								organizationSlug: z.string(),
								projectKey: z.string(),
								environment: z.enum(["sandbox", "production"]),
							})
							.parse(await request.json());
						const [instance] = await database<
							{ key: string; name: string }[]
						>`SELECT i.key,i.name FROM projects i JOIN platform_projects p ON p.id=i.platform_project_id JOIN platform_organizations o ON o.id=p.organization_id WHERE o.slug=${scope.organizationSlug} AND p.key=${scope.projectKey} AND i.environment=${scope.environment}`;
						if (!instance) return Response.json({ seeded: false });
						await seedIntegrationProjectsAndCatalog(database, [
							{
								projectInstanceKey: instance.key,
								name: instance.name,
								projectionUrl: "https://receiver.example.test",
								projectionSecret: "synthetic-unused-catalog-fixture",
							},
						]);
						const resolved = await new PostgresProjectInstanceContextResolver(
							database,
						).resolveInstanceKey(instance.key);
						if (resolved.kind !== "resolved")
							throw new Error("Synthetic catalog context unavailable");
						await publishAiCreditsCatalog(new BillingRepository(), resolved.context);
						return Response.json({ seeded: true });
					}
					if (request.method === "POST" && url.pathname === "/connections/expire") {
						const { scope, kind } = z
							.strictObject({
								scope: z.strictObject({
									organizationSlug: z.string(),
									projectKey: z.string(),
									environment: z.enum(["sandbox", "production"]),
								}),
								kind: z.enum(["stripe", "apple", "google", "projection"]),
							})
							.parse(await request.json());
						const rows =
							await database`UPDATE platform_connection_versions SET validated_at=now()-interval '16 minutes' WHERE id IN(SELECT c.active_version_id FROM platform_connections c JOIN projects i ON i.id=c.project_instance_id JOIN platform_projects p ON p.id=i.platform_project_id JOIN platform_organizations o ON o.id=p.organization_id WHERE o.slug=${scope.organizationSlug} AND p.key=${scope.projectKey} AND i.environment=${scope.environment} AND c.kind=${kind}) RETURNING id`;
						return Response.json({ expired: rows.length === 1 });
					}
					if (request.method === "POST" && url.pathname === "/projections/run") {
						const resolver = new PostgresProjectInstanceContextResolver(database);
						const worker = new ProjectionSyncWorker({
							workerId: "merchant-e2e-control",
							projectContextResolver: new PostgresProjectInstanceContextResolver(database),
							maxAttempts: 5,
							batchSize: 25,
							repository: new ProjectionSyncJobRepository(new BillingRepository()),
							delivery: new ProjectionHttpClient({
								async resolveProject(key) {
									const result = await resolver.resolveInstanceKey(key);
									return result.kind === "resolved"
										? synthetic.connections.resolve(result.context, "projection", "recovery")
										: null;
								},
								fetch: synthetic.fetch,
							}),
						});
						return Response.json(await worker.runOnce());
					}
					if (request.method === "GET" && url.pathname === "/projections/state")
						return Response.json({ captures: synthetic.state(url.searchParams.get("projectKey")) });
					if (request.method === "POST" && url.pathname === "/promotions/run") {
						const worker = new PromotionMaintenanceWorker({
							workerId: "merchant-e2e-promotions",
							projectContextResolver: new PostgresProjectInstanceContextResolver(database),
							adapterForJob: promotionProviders.promotionMaintenance,
							logger: { error() {} },
							repository: {
								releaseExpiredPromotionReservations: (limit) =>
									promotionRepository.promotions.releaseExpiredPromotionReservations(limit),
								reconcilePromotionCoupons: (limit) =>
									promotionRepository.promotionProviders.reconcilePromotionCoupons(limit),
								ensureHostedPromotionCodeObjects: (limit) =>
									promotionRepository.promotionProviders.ensureHostedPromotionCodeObjects(limit),
								claimStripeObjects: (workerId, limit, staleBefore) =>
									promotionRepository.promotionProviders.claimStripeObjects(
										workerId,
										limit,
										staleBefore,
									),
								markStripeObjectOutcome: (projectId, objectId, workerId, outcome) =>
									promotionRepository.promotionProviders.markStripeObjectOutcome(
										projectId,
										objectId,
										workerId,
										outcome,
									),
							},
						});
						return Response.json(await worker.runOnce());
					}
					if (request.method === "POST" && url.pathname === "/projections/respond") {
						const { status } = z
							.strictObject({ status: z.union([z.literal(200), z.literal(503)]) })
							.parse(await request.json());
						synthetic.respond(status);
						return Response.json({ configured: true });
					}
					if (request.method === "POST" && url.pathname === "/auth/expire") {
						const { email, kind } = z
							.strictObject({ email: z.email(), kind: z.enum(["reset", "verification", "otp"]) })
							.parse(await request.json());
						if (kind === "otp") {
							return Response.json({ expired: await otpFixture.expire(email) });
						}
						const message = mailer.messages.findLast(
							(candidate) => candidate.to === email && candidate.kind === kind,
						);
						const link = message?.text.match(/https?:\/\/[^\s]+/)?.[0];
						const token = link
							? new URLSearchParams(new URL(link).hash.slice(1)).get("token")
							: null;
						if (!token) return Response.json({ expired: false });
						const rows =
							await database`UPDATE platform_auth_links SET expires_at=now()-interval '1 minute' WHERE token_hash=${tokenHash(token, config.secret)} AND kind=${kind} RETURNING token_hash`;
						return Response.json({ expired: rows.length === 1 });
					}
					if (request.method === "POST" && url.pathname === "/auth/cooldown") {
						const { email } = z.strictObject({ email: z.email() }).parse(await request.json());
						const [user] = await database<
							{ id: string }[]
						>`SELECT id FROM platform_auth_users WHERE email=${email}`;
						if (!user) return Response.json({ cleared: false });
						await database`DELETE FROM platform_rate_limits WHERE key_hash=${tokenHash(`otp:cooldown:${user.id}`, config.secret)}`;
						return Response.json({ cleared: true });
					}
					if (request.method === "POST" && url.pathname === "/stripe/oauth/expire") {
						const { email } = z.strictObject({ email: z.email() }).parse(await request.json());
						const rows =
							await database`UPDATE platform_connection_oauth_states SET expires_at=now()-interval '1 minute' WHERE consumed_at IS NULL AND principal_id IN(SELECT p.id FROM platform_principals p JOIN platform_auth_users u ON u.id=p.auth_user_id WHERE u.email=${email}) RETURNING id`;
						return Response.json({ expired: rows.length > 0 });
					}
					if (request.method === "POST" && url.pathname === "/mcp/expire-refresh-grace") {
						const input = z
							.strictObject({
								email: z.email(),
								organizationSlug: z.string().min(1),
								projectKey: z.string().min(1),
								environment: z.enum(["sandbox", "production"]),
								clientId: z.enum(["quotum-claude-code", "quotum-cursor"]),
							})
							.parse(await request.json());
						const rows = await database`UPDATE platform_auth_oauth_refresh_tokens
							SET rotation_replay_expires_at=now()-interval '1 second'
							WHERE rotated_at IS NOT NULL AND authorization_code_id=(
								SELECT g.code_hash FROM platform_mcp_authorizations g
								JOIN platform_principals principal ON principal.id=g.principal_id
								JOIN platform_auth_users u ON u.id=principal.auth_user_id
								JOIN projects i ON i.id=g.project_instance_id
								JOIN platform_projects p ON p.id=i.platform_project_id
								JOIN platform_organizations o ON o.id=p.organization_id
								WHERE u.email=${input.email} AND o.slug=${input.organizationSlug}
								AND p.key=${input.projectKey} AND i.environment=${input.environment}
								AND g.client_id=${input.clientId} AND g.revoked_at IS NULL
								ORDER BY g.created_at DESC LIMIT 1
							) RETURNING id`;
						return Response.json({ expired: rows.length > 0 });
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
						if (url.searchParams.size > 0) {
							const scope = z
								.strictObject({
									organizationSlug: z.string(),
									projectKey: z.string(),
									environment: z.enum(["sandbox", "production"]),
								})
								.parse(Object.fromEntries(url.searchParams));
							const [instance] = await database<
								{ id: string; organization_id: string; key: string; lifecycle_status: string }[]
							>`SELECT i.id,i.key,i.lifecycle_status,p.organization_id FROM projects i JOIN platform_projects p ON p.id=i.platform_project_id JOIN platform_organizations o ON o.id=p.organization_id WHERE o.slug=${scope.organizationSlug} AND p.key=${scope.projectKey} AND i.environment=${scope.environment}`;
							if (!instance) return Response.json({ code: "SCOPE_NOT_FOUND" }, { status: 404 });
							const events =
								await database`SELECT id,processing_status AS status FROM store_events WHERE project_id=${instance.id}`;
							const jobs =
								await database`SELECT id,status,attempts FROM projection_sync_jobs WHERE project_id=${instance.id}`;
							const usageEvents =
								await database`SELECT id,operation,quantity::text,metadata->>'actor' AS actor FROM usage_events WHERE project_id=${instance.id}`;
							const connections =
								await database`SELECT c.kind,c.enabled,c.revision,c.active_version_id IS NOT NULL AS active,v.validated_at IS NOT NULL AS validated,v.event_verified_at IS NOT NULL AS event_verified FROM platform_connections c LEFT JOIN platform_connection_versions v ON v.id=c.active_version_id WHERE c.project_instance_id=${instance.id}`;
							const credentials =
								await database`SELECT revoked_at IS NOT NULL AS revoked,octet_length(secret_verifier)=32 AS hashed,access FROM platform_project_api_credentials WHERE project_instance_id=${instance.id}`;
							const audit =
								await database`SELECT action,metadata FROM platform_audit_events WHERE organization_id=${instance.organization_id} ORDER BY created_at`;
							return Response.json({
								projectKey: instance.key,
								active: instance.lifecycle_status === "active",
								events,
								jobs,
								usageEvents,
								connections,
								credentials,
								audit,
							});
						}
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

		runtime = createBillingRuntime(env, {
			connections: synthetic.connections,
			projectionFetch: synthetic.fetch,
			projectProviderServices: projectServices,
			stripeClientFactory: (stripeConfig) => new FakeStripeBillingClient(stripeConfig),
			providerClientFactories: {
				apple: () => ({
					verifyTransaction: refuseUnseededProviderOperation,
					verifyNotification: refuseUnseededProviderOperation,
					getLatestSubscriptionStatus: refuseUnseededProviderOperation,
				}),
				google: () => ({
					getSubscriptionPurchase: refuseUnseededProviderOperation,
					getProductPurchase: refuseUnseededProviderOperation,
					acknowledgeSubscriptionPurchase: refuseUnseededProviderOperation,
					acknowledgeProductPurchase: refuseUnseededProviderOperation,
					consumeProductPurchase: refuseUnseededProviderOperation,
				}),
			},
			merchant: {
				connectionValidation: synthetic.validation,
				stripeOAuth: synthetic.oauth,
				config: {
					...config,
					google: { clientId: google.clientId, clientSecret: google.clientSecret },
				},
				mailer,
				createAuth: (store, sender, authDatabase) =>
					createMerchantAuth(store, sender, authDatabase, {
						googleAuthorizationEndpoint: `http://127.0.0.1:${control?.port}/google/${controlToken}/authorize`,
					}),
			},
		});
		synthetic.configure(
			config.origin,
			`http://127.0.0.1:${control.port}/stripe/${controlToken}/authorize`,
		);
		await runtime.start();
		const coreRuntime = runtime;
		const observedApp: QuotumApp = {
			async fetch(request, server) {
				const dispatch = async () => coreRuntime.app.fetch(request, server);
				return request.method === "POST" &&
					new URL(request.url).pathname === "/api/auth/two-factor/send-otp"
					? otpFixture.track(dispatch)
					: dispatch();
			},
		};
		const app = options.composeApp ? options.composeApp(observedApp) : observedApp;
		let stopped: Promise<void> | undefined;
		return {
			app,
			hostname: "127.0.0.1" as const,
			port: Number(process.env.PORT ?? "3000"),
			stop() {
				stopped ??= (async () => {
					control?.stop(true);
					try {
						await coreRuntime.stop();
					} finally {
						restoreFetch();
						await database.close();
					}
				})();
				return stopped;
			},
		};
	} catch (error) {
		control?.stop(true);
		try {
			await runtime?.stop();
		} finally {
			restoreFetch();
			await database.close();
		}
		throw error;
	}
}
