import { afterAll, beforeEach, expect, test } from "bun:test";
import { createConnectionValidation } from "../../src/composition/connection-validation";
import type { StripeOAuthPort } from "../../src/platform/connections/oauth-port";
import type { ConnectionValidationPort } from "../../src/platform/connections/ports";
import { FakeStripeBillingClient } from "../../src/providers/stripe/testing/fake-client";
import { type BillingRuntimeDependencies, createBillingRuntime } from "../../src/runtime";
import { createIntegrationBillingEnv } from "../../tests/integration/helpers/local-postgres";
import {
	isolatedStripeOAuthPort,
	MerchantBrowser,
	merchantFixture,
	merchantTestScope,
	onboard,
	stripeCheckoutSettings,
	testConfig,
} from "./fixture";

const fixture = merchantFixture();
beforeEach(() => fixture.reset());
afterAll(() => fixture.sql.close());

async function withRuntime(
	dependencies: BillingRuntimeDependencies,
	run: (browser: MerchantBrowser) => Promise<void>,
) {
	const syntheticSecrets = {
		QUOTUM_SECRETS_KEY_ID: "test",
		QUOTUM_SECRETS_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
		QUOTUM_AUTH_SECRET: testConfig.secret,
	};
	const previous = Object.fromEntries(
		Object.keys(syntheticSecrets).map((key) => [key, process.env[key]]),
	);
	Object.assign(process.env, syntheticSecrets);
	let runtime: ReturnType<typeof createBillingRuntime> | undefined;
	try {
		runtime = createBillingRuntime(createIntegrationBillingEnv(process.env.POSTGRES_URI ?? ""), {
			...dependencies,
			merchant: { config: testConfig, mailer: fixture.mailer, ...dependencies.merchant },
			// These assertions drive requests explicitly; no worker may call a provider in the background.
			scheduler: { schedule: () => ({ async stop() {} }) },
		});
		await runtime.start();
		const app = runtime.app;
		await run(new MerchantBrowser(fixture, async (request) => app.fetch(request)));
	} finally {
		try {
			await runtime?.stop();
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}
}

test.each([
	["general factory", false],
	["legacy factory override", true],
] as const)(
	"runtime composes managed validation/OAuth and scoped provider factories (%s)",
	async (_name, legacyOverride) => {
		const normalized = createConnectionValidation();
		let validationCalls = 0;
		let validatedContext:
			| { instanceId: string; instanceKey: string; versionId: string }
			| undefined;
		const validator: ConnectionValidationPort = {
			normalize: normalized.normalize,
			async validate(kind, environment, _input, context) {
				expect(kind).toBe("stripe");
				expect(environment).toBe("sandbox");
				validationCalls += 1;
				validatedContext = context;
				return { identity: "acct_synthetic", eventVerified: true, checks: [] };
			},
		};
		let generalCalls = 0;
		let legacyCalls = 0;
		let factoryScope: string | undefined;
		let oauthCalls = 0;
		const oauth = {
			...isolatedStripeOAuthPort(),
			authorize(environment: "sandbox" | "production", state: string) {
				expect(environment).toBe("sandbox");
				expect(state.length >= 32).toBe(true);
				oauthCalls += 1;
				return "https://connect.example.test/authorize";
			},
		};
		await withRuntime(
			{
				merchant: { connectionValidation: validator, stripeOAuth: oauth },
				providerClientFactories: {
					stripe(config, instanceKey) {
						generalCalls += 1;
						factoryScope = instanceKey;
						return new FakeStripeBillingClient(config);
					},
				},
				...(legacyOverride
					? {
							stripeClientFactory(config, instanceKey) {
								legacyCalls += 1;
								factoryScope = instanceKey;
								return new FakeStripeBillingClient(config);
							},
						}
					: {}),
			},
			async (browser) => {
				await onboard(browser);
				const secrets = {
					secretKey: "rk_test_synthetic_runtime_restricted",
					webhookSecret: "whsec_synthetic_runtime",
				};
				const path = "/api/platform/connections/stripe";
				const invalid = await browser.request(`${path}/drafts`, {
					scope: merchantTestScope,
					expectedRevision: 0,
					settings: { ...stripeCheckoutSettings, secretKey: secrets.secretKey },
					secrets: {},
				});
				expect(invalid.status).toBe(400);
				expect((await invalid.json()).error.code).toBe("INVALID_CONNECTION");
				expect(validationCalls).toBe(0);
				const [before] = await fixture.sql<{ count: number }[]>`
					SELECT count(*)::int AS count FROM platform_connection_versions`;
				expect(before?.count).toBe(0);
				const draft = await browser.json<{ draftId: string }>(`${path}/drafts`, {
					scope: merchantTestScope,
					expectedRevision: 0,
					settings: stripeCheckoutSettings,
					secrets,
				});
				const body = { scope: merchantTestScope, draftId: draft.draftId };
				await browser.json(`${path}/validate`, body);
				await browser.json(`${path}/commit`, body);
				expect(validationCalls).toBe(1);
				const [instance] = await fixture.sql<{ id: string; key: string }[]>`
					SELECT id::text,key FROM projects WHERE environment='sandbox'`;
				expect(validatedContext).toEqual({
					instanceId: instance?.id,
					instanceKey: instance?.key,
					versionId: draft.draftId,
				});
				const catalog = await browser.request("/api/billing/catalog", undefined, {
					headers: {
						"x-quotum-organization": merchantTestScope.organizationSlug,
						"x-quotum-project": merchantTestScope.projectKey,
						"x-quotum-environment": merchantTestScope.environment,
					},
				});
				expect(catalog.status).toBe(200);
				expect(generalCalls > 0).toBe(!legacyOverride);
				expect(legacyCalls > 0).toBe(legacyOverride);
				expect(factoryScope).toBe(instance?.key);
				const authorization = await browser.json<{ authorizeUrl: string }>(`${path}/oauth/start`, {
					scope: merchantTestScope,
					expectedRevision: 1,
					settings: stripeCheckoutSettings,
				});
				expect(authorization.authorizeUrl).toBe("https://connect.example.test/authorize");
				expect(oauthCalls).toBe(1);
			},
		);
	},
);

test("runtime shares the OAuth port between authorization and persisted connection refresh", async () => {
	const issued = {
		accessToken: "sk_test_synthetic_oauth_initial",
		refreshToken: "synthetic_oauth_refresh_initial",
		expiresAt: Date.now() + 3_600_000,
		accountId: "acct_runtime_oauth",
		livemode: false,
	};
	const rotated = {
		...issued,
		accessToken: "sk_test_synthetic_oauth_rotated",
		refreshToken: "synthetic_oauth_refresh_rotated",
	};
	const webhookSecret = "whsec_runtime_oauth";
	let state = "";
	let exchanges = 0;
	let refreshes = 0;
	let factoryReceivedRotatedCredentials = false;
	let factoryScope: string | undefined;
	const oauth: StripeOAuthPort = {
		authorize(environment, value) {
			expect(environment).toBe("sandbox");
			state = value;
			return `https://connect.example.test/authorize?state=${value}`;
		},
		async exchange(environment, code) {
			expect(environment).toBe("sandbox");
			expect(code === "synthetic_installation_code").toBe(true);
			exchanges += 1;
			return issued;
		},
		async refresh(environment, token) {
			expect(environment).toBe("sandbox");
			expect(token === issued.refreshToken).toBe(true);
			refreshes += 1;
			return rotated;
		},
		webhookSecret(environment) {
			expect(environment).toBe("sandbox");
			return webhookSecret;
		},
	};
	await withRuntime(
		{
			merchant: {
				stripeOAuth: oauth,
				connectionValidation: {
					normalize: createConnectionValidation().normalize,
					async validate(kind, environment, input) {
						expect(kind).toBe("stripe");
						expect(environment).toBe("sandbox");
						expect(input.secrets.secretKey === issued.accessToken).toBe(true);
						expect(input.secrets.webhookSecret === webhookSecret).toBe(true);
						return { identity: issued.accountId, eventVerified: false, checks: [] };
					},
				},
			},
			providerClientFactories: {
				stripe(config, instanceKey) {
					factoryScope = instanceKey;
					factoryReceivedRotatedCredentials =
						config.secretKey === rotated.accessToken &&
						config.webhookSecret === webhookSecret &&
						config.connectedAccountId === issued.accountId;
					return new FakeStripeBillingClient(config);
				},
			},
		},
		async (browser) => {
			await onboard(browser);
			const path = "/api/platform/connections/stripe";
			const authorization = await browser.json<{ authorizeUrl: string }>(`${path}/oauth/start`, {
				scope: merchantTestScope,
				expectedRevision: 0,
				settings: stripeCheckoutSettings,
			});
			expect(new URL(authorization.authorizeUrl).searchParams.get("state") === state).toBe(true);
			const draft = await browser.json<{ draftId: string; secretDisclosed: boolean }>(
				`${path}/oauth/complete`,
				{ state, code: "synthetic_installation_code" },
			);
			expect(draft.secretDisclosed).toBe(false);
			expect(exchanges).toBe(1);
			const body = { scope: merchantTestScope, draftId: draft.draftId };
			await browser.json(`${path}/validate`, body);
			await browser.json(`${path}/commit`, body);
			expect(refreshes).toBe(0);
			const [instance] = await fixture.sql<{ id: string; key: string }[]>`
				SELECT id::text,key FROM projects WHERE environment='sandbox'`;
			const version = await fixture.connectionRepository.version(instance?.id ?? "", draft.draftId);
			const expired = fixture.connectionRepository.cipher.encrypt(String(Date.now() - 1000), {
				instanceId: version.project_instance_id,
				connectionId: version.connection_id,
				versionId: version.id,
				purpose: "expiresAt",
			});
			await fixture.sql`
				UPDATE platform_connection_secrets SET envelope=${JSON.stringify(expired)}::text::jsonb
				WHERE version_id=${version.id} AND purpose='expiresAt'`;
			const scopeHeaders = {
				"x-quotum-organization": merchantTestScope.organizationSlug,
				"x-quotum-project": merchantTestScope.projectKey,
				"x-quotum-environment": merchantTestScope.environment,
			};
			for (let read = 0; read < 2; read += 1) {
				const catalog = await browser.request("/api/billing/catalog", undefined, {
					headers: scopeHeaders,
				});
				expect(catalog.status).toBe(200);
				expect(refreshes).toBe(1);
				expect(factoryReceivedRotatedCredentials).toBe(true);
				expect(factoryScope).toBe(instance?.key);
			}
			const stored = await fixture.connectionRepository.secrets(version);
			expect(stored.accessToken === rotated.accessToken).toBe(true);
			expect(stored.refreshToken === rotated.refreshToken).toBe(true);
			const [lease] = await fixture.sql<{ clear: boolean }[]>`
				SELECT refresh_lease_id IS NULL AND refresh_lease_until IS NULL AS clear
				FROM platform_connection_versions WHERE id=${version.id}`;
			expect(lease?.clear).toBe(true);
		},
	);
});
