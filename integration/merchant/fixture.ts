import { SQL } from "bun";
import { createProjectProviderServiceResolver } from "../../src/app/provider-services";
import { createMerchantBillingPort } from "../../src/composition/merchant-billing";
import { merchantAuthDatabase, merchantSql } from "../../src/composition/merchant-persistence";
import { PostgresProjectInstanceContextResolver } from "../../src/composition/project-instance-persistence";
import { AdminBillingRepository } from "../../src/db/admin-repository";
import { BillingRepository } from "../../src/db/repository";
import { createMerchantApp } from "../../src/platform/app";
import { createMerchantAuth } from "../../src/platform/auth";
import { createMerchantBilling } from "../../src/platform/billing";
import type { MerchantConfig } from "../../src/platform/config";
import { ConnectionCipher } from "../../src/platform/connections/cipher";
import { MerchantStripeOAuth } from "../../src/platform/connections/oauth";
import type { StripeOAuthPort } from "../../src/platform/connections/oauth-port";
import type {
	ConnectionValidationPort,
	EnvironmentBillingPort,
} from "../../src/platform/connections/ports";
import { ConnectionRepository } from "../../src/platform/connections/repository";
import { MerchantConnections } from "../../src/platform/connections/service";
import type {
	MerchantScope,
	OnboardingDraftView,
	ProvisioningOperationView,
} from "../../src/platform/contracts";
import type { MerchantEmail, MerchantMailer } from "../../src/platform/email";
import { MerchantOnboarding } from "../../src/platform/onboarding";
import { CSRF_COOKIE } from "../../src/platform/security";
import { MerchantStore } from "../../src/platform/store";
import { fixtureConnections } from "../../src/testing/connection-fixtures";
import { assertOpenApiResponse } from "../../tests/helpers/openapi";
import { createIntegrationBillingEnv } from "../../tests/integration/helpers/local-postgres";

export const password = "Merchant test password 123!";
export const serviceToken = "merchant-integration-service-token-synthetic";
export const testConfig: MerchantConfig = {
	signupEnabled: true,
	origin: "https://merchant.example.test",
	publicUrl: "https://quotum.dev",
	secret: "merchant-integration-secret-at-least-32-characters",
	termsVersion: "test-2026-09-05",
	privacyVersion: "test-2026-09-05",
	google: null,
	email: null,
	testMode: true,
};
export class CaptureMailer implements MerchantMailer {
	messages: MerchantEmail[] = [];
	fail = false;
	async send(message: MerchantEmail) {
		if (this.fail) throw new Error("synthetic delivery failure");
		this.messages.push(message);
	}
	link(kind: MerchantEmail["kind"], email: string): string {
		const message = this.messages.findLast((m) => m.kind === kind && m.to === email);
		const link = message?.text.match(/https:\/\/[^\s]+/)?.[0];
		if (!link) throw new Error(`No ${kind} message captured`);
		return new URLSearchParams(new URL(link).hash.slice(1)).get("token") ?? "";
	}
	otp(email: string): string {
		const result = this.messages
			.findLast((m) => m.kind === "otp" && m.to === email)
			?.text.match(/\b\d{6}\b/)?.[0];
		if (!result) throw new Error("No OTP captured");
		return result;
	}
}
export function merchantFixture(
	options: {
		google?: { clientId: string; clientSecret: string };
		connectionValidation?: ConnectionValidationPort;
		environmentBilling?: EnvironmentBillingPort;
	} = {},
) {
	if (process.env.RUN_POSTGRES_INTEGRATION_TESTS !== "1" || !process.env.POSTGRES_URI)
		throw new Error(
			"Run with bun run test:merchant:integration; a disposable database is required",
		);
	const client = new SQL(process.env.POSTGRES_URI, { max: 10, idleTimeout: 5, prepare: false });
	const sql = Object.assign(merchantSql(client), { close: () => client.close() });
	const mailer = new CaptureMailer();
	let timeOffset = 0;
	let failEnvironment: "sandbox" | "production" | null = null;
	const store = new MerchantStore(
		sql,
		{ ...testConfig, google: options.google ?? null },
		() => new Date(Date.now() + timeOffset),
	);
	const auth = createMerchantAuth(store, mailer, merchantAuthDatabase(client));
	const onboarding = new MerchantOnboarding(store, async (environment) => {
		if (failEnvironment === environment) throw new Error("Synthetic provisioning failure");
	});
	const env = createIntegrationBillingEnv(process.env.POSTGRES_URI);
	const repository = new BillingRepository();
	const resolver = new PostgresProjectInstanceContextResolver(client);
	const billing = createMerchantBilling(
		store,
		createMerchantBillingPort({
			repository,
			reader: new AdminBillingRepository({
				providerReconciliationStaleAfterMs: env.providerReconciliationStaleAfterMs,
			}),
			resolver,
			providers: createProjectProviderServiceResolver({
				connections: fixtureConnections(env.connectionFixtures),
				getRepository: () => repository,
				projectProviderServices: undefined,
				legacyServices: {
					appleStoreKitService: undefined,
					googlePlayBillingService: undefined,
					stripeBillingService: undefined,
				},
			}),
		}),
	);
	const connectionRepository = new ConnectionRepository(
		sql,
		new ConnectionCipher("test", new Map([["test", Buffer.alloc(32, 7)]])),
	);
	const connections =
		options.connectionValidation && options.environmentBilling
			? new MerchantConnections(
					store,
					connectionRepository,
					options.connectionValidation,
					options.environmentBilling,
				)
			: undefined;
	const app = createMerchantApp({ store, mailer, auth, onboarding, billing, connections });
	return {
		client,
		connectionRepository,
		connections,
		sql,
		store,
		auth,
		app,
		mailer,
		onboarding,
		advance(ms: number) {
			timeOffset += ms;
		},
		failProvisioning(environment: "sandbox" | "production" | null) {
			failEnvironment = environment;
		},
		async reset() {
			timeOffset = 0;
			failEnvironment = null;
			mailer.messages = [];
			mailer.fail = false;
			await sql`TRUNCATE platform_idempotency,platform_audit_events,platform_policy_acceptances,platform_service_principals,platform_step_up_grants,platform_project_api_credentials,platform_provisioning_steps,platform_provisioning_operations,platform_projects,platform_onboarding_drafts,platform_invitations,platform_memberships,platform_organizations,platform_merchant_sessions,platform_external_identities,platform_principals,platform_auth_users,platform_auth_verifications,platform_auth_rate_limits,platform_rate_limits,platform_auth_links,projects CASCADE`;
			await sql`INSERT INTO platform_service_principals(name,token_hash) VALUES('merchant-integration',${store.hash(serviceToken)})`;
		},
	};
}
export type MerchantFixture = ReturnType<typeof merchantFixture>;
export class MerchantBrowser {
	cookies = new Map<string, string>();
	constructor(readonly fixture: MerchantFixture) {}
	async request(
		path: string,
		body?: unknown,
		options: { key?: string; headers?: Record<string, string>; method?: string } = {},
	): Promise<Response> {
		const method = options.method ?? (body === undefined ? "GET" : "POST");
		const headers = new Headers({
			"x-quotum-service-token": serviceToken,
			"x-quotum-client-ip": "192.0.2.10",
			origin: testConfig.origin,
			"content-type": "application/json",
			cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
			"x-csrf-token": this.cookies.get(CSRF_COOKIE) ?? "",
			"idempotency-key": options.key ?? crypto.randomUUID(),
			...options.headers,
		});
		const response = await this.fixture.app.fetch(
			new Request(`${testConfig.origin}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
		);
		await assertOpenApiResponse(method, path, response, {
			requestBody: body,
			requestContentType: body === undefined ? null : "application/json",
		});
		for (const cookie of response.headers.getSetCookie()) {
			const first = cookie.split(";")[0] ?? "";
			const separator = first.indexOf("=");
			const name = first.slice(0, separator);
			const value = first.slice(separator + 1);
			if (value) this.cookies.set(name, value);
			else this.cookies.delete(name);
		}
		return response;
	}
	async json<T = Record<string, unknown>>(
		path: string,
		body?: unknown,
		options?: Parameters<MerchantBrowser["request"]>[2],
	): Promise<T> {
		const response = await this.request(path, body, options);
		const result = await response.json();
		if (!response.ok)
			throw new Error(
				`${path} failed (${response.status}): ${result.error?.code ?? result.code ?? "UNKNOWN"}`,
			);
		return result.data ?? result;
	}
	async signup(email = "owner@example.com") {
		await this.json("/api/platform/config");
		await this.json("/api/platform/signup-intent", {
			accepted: true,
			termsVersion: testConfig.termsVersion,
			privacyVersion: testConfig.privacyVersion,
		});
		await this.json("/api/auth/sign-up/email", { name: "Test Merchant", email, password });
		await this.json("/api/platform/verify-email", {
			token: this.fixture.mailer.link("verification", email),
		});
		return this.login(email);
	}
	async login(email: string) {
		await this.json("/api/platform/config");
		await this.json("/api/auth/sign-in/email", { email, password });
		await this.json("/api/auth/two-factor/send-otp", {});
		await this.json("/api/auth/two-factor/verify-otp", {
			code: this.fixture.mailer.otp(email),
			trustDevice: false,
		});
		await this.json("/api/platform/session/exchange", {});
		return email;
	}
}

export const merchantTestScope: MerchantScope = {
	kind: "merchant",
	organizationSlug: "acme",
	projectKey: "example",
	environment: "sandbox",
};

export const stripeCheckoutSettings = {
	checkoutSuccessUrl: "https://shop.example/success?session_id={CHECKOUT_SESSION_ID}",
	checkoutCancelUrl: "https://shop.example/cancel",
	portalReturnUrl: "https://shop.example/billing",
};

export function stubConnectionValidation(): ConnectionValidationPort {
	return {
		normalize: (_kind, _environment, input) => input,
		async validate(kind) {
			return {
				identity: kind === "stripe" ? "acct_isolated" : kind,
				eventVerified: true,
				checks: [{ code: "TEST_VERIFIED", passed: true }],
			};
		},
	};
}

export function stubEnvironmentBilling(sql: () => MerchantFixture["sql"]): EnvironmentBillingPort {
	return {
		async catalogReadiness(id) {
			const [row] = await sql()<{ revision: string | null }[]>`
				SELECT published_catalog_revision_id::text AS revision FROM projects WHERE id=${id}
			`;
			return {
				revisionId: row?.revision ?? null,
				providers: row?.revision ? ["stripe"] : [],
				ready: !!row?.revision,
			};
		},
		async promote() {
			throw new Error("Unused");
		},
	};
}

export async function onboard(browser: MerchantBrowser): Promise<void> {
	await browser.signup();
	const org = await browser.json<OnboardingDraftView>("/api/platform/onboarding/organization", {
		name: "Acme Company",
		slug: "acme",
	});
	const draft = await browser.json<OnboardingDraftView>("/api/platform/onboarding/project", {
		name: "Example Project",
		key: "example",
		revision: org.revision,
	});
	await browser.json<ProvisioningOperationView>("/api/platform/onboarding/provision", {
		revision: draft.revision,
	});
}

export async function grant(
	fixture: MerchantFixture,
	browser: MerchantBrowser,
	target: string,
	action: string,
): Promise<string> {
	const prod = { ...merchantTestScope, environment: "production" as const };
	const challenge = await browser.json<{ id: string }>("/api/platform/step-up", {
		scope: prod,
		action,
		target,
		returnTo: "/",
	});
	await fixture.sql`DELETE FROM platform_rate_limits`;
	await browser.json("/api/auth/sign-in/email", { email: "owner@example.com", password });
	await browser.json("/api/auth/two-factor/send-otp", {});
	await browser.json("/api/auth/two-factor/verify-otp", {
		code: fixture.mailer.otp("owner@example.com"),
		trustDevice: false,
	});
	return (
		await browser.json<{ grant: string }>(`/api/platform/step-up/${challenge.id}/complete`, {})
	).grant;
}

export function isolatedStripeOAuthPort(): StripeOAuthPort {
	return {
		authorize: (_environment, state) =>
			`https://marketplace.stripe.com/oauth/v2/authorize?state=${state}`,
		exchange: async () => ({
			accessToken: "initial-synthetic-access",
			refreshToken: "initial-synthetic-refresh",
			expiresAt: Date.now() - 1000,
			accountId: "acct_isolated",
			livemode: false,
		}),
		refresh: async () => ({
			accessToken: "rotated-synthetic-access",
			refreshToken: "rotated-synthetic-refresh",
			expiresAt: Date.now() + 3_600_000,
			accountId: "acct_isolated",
			livemode: false,
		}),
		webhookSecret: () => "whsec_app_synthetic",
	};
}

export async function authorizeStripeApp(
	fixture: MerchantFixture,
	browser: MerchantBrowser,
	provider: StripeOAuthPort,
	validator: ConnectionValidationPort,
): Promise<{ draftId: string }> {
	if (!fixture.connections) throw new Error("Connection test service unavailable");
	const identity = await fixture.store.authenticate(
		new Request("https://quotum.example/api/platform/session", {
			headers: { cookie: [...browser.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
		}),
	);
	const oauth = new MerchantStripeOAuth(
		fixture.store,
		fixture.connections,
		fixture.connectionRepository,
		provider,
		validator,
	);
	const start = await oauth.start(identity, merchantTestScope, stripeCheckoutSettings, 0);
	const state = new URL(start.authorizeUrl).searchParams.get("state");
	if (!state) throw new Error("Missing OAuth state");
	const draft = await oauth.complete(identity, state, "code");
	await fixture.connections.validate(identity, merchantTestScope, "stripe", draft.draftId);
	await fixture.connections.commit(
		identity,
		merchantTestScope,
		"stripe",
		draft.draftId,
		"oauth-commit",
		null,
	);
	return draft;
}
