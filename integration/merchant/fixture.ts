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
import type { MerchantEmail, MerchantMailer } from "../../src/platform/email";
import { MerchantOnboarding } from "../../src/platform/onboarding";
import { CSRF_COOKIE } from "../../src/platform/security";
import { MerchantStore } from "../../src/platform/store";
import { createIntegrationBillingEnv } from "../../tests/integration/helpers/local-postgres";

export const password = "Merchant test password 123!";
export const serviceToken = "merchant-integration-service-token-synthetic";
export const testConfig: MerchantConfig = {
	enabled: true,
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
	options: { google?: { clientId: string; clientSecret: string } } = {},
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
				env,
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
	const app = createMerchantApp({ store, mailer, auth, onboarding, billing });
	return {
		client,
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
			await sql`TRUNCATE platform_idempotency,platform_audit_events,platform_policy_acceptances,platform_service_principals,platform_step_up_grants,platform_project_api_credentials,platform_provisioning_steps,platform_provisioning_operations,platform_project_runtime_modes,platform_projects,platform_onboarding_drafts,platform_invitations,platform_memberships,platform_organizations,platform_merchant_sessions,platform_external_identities,platform_principals,platform_auth_users,platform_auth_verifications,platform_auth_rate_limits,platform_rate_limits,platform_auth_links,projects CASCADE`;
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
