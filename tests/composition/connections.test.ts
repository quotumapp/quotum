import { describe, expect, it } from "bun:test";
import { BillingError } from "../../src/billing/errors";
import {
	connectionDescription,
	createRuntimeConnectionResolver,
} from "../../src/composition/connections";
import type { StripeOAuthPort } from "../../src/platform/connections/oauth-port";
import type {
	ConnectionDescriptionRow,
	ConnectionRepository,
	ConnectionVersion,
} from "../../src/platform/connections/repository";
import type { MerchantSql } from "../../src/platform/database";
import type { RuntimeConnectionKind } from "../../src/projects/connections";
import { projectInstanceContext } from "../helpers/project-context";

const project = projectInstanceContext("acme");
const sandboxProject = projectInstanceContext("acme", { environment: "sandbox" });

const stripeSettings = {
	checkoutSuccessUrl: "https://acme.example.com/success?session_id={CHECKOUT_SESSION_ID}",
	checkoutCancelUrl: "https://acme.example.com/cancel",
	portalReturnUrl: "https://acme.example.com/account",
};

const settingsByKind: Record<RuntimeConnectionKind, Record<string, unknown>> = {
	paddle: {
		notificationSettingId: `ntfset_${"a".repeat(26)}`,
		paymentPageUrl: "https://example.com/pay",
		clientToken: "test_example",
	},
	apple: {
		bundleId: "com.acme.app",
		appAppleId: 123456789,
		issuerId: "issuer",
		keyId: "key",
		environment: "production",
		enableOnlineChecks: true,
	},
	google: {
		packageName: "com.acme.app",
		serviceAccountJson: null,
		rtdnAudience: null,
		rtdnServiceAccountEmail: null,
		enablePublisherMutations: true,
	},
	stripe: stripeSettings,
	projection: { projectionUrl: "https://acme.example.com/billing/projection" },
};

const secretsByKind: Record<RuntimeConnectionKind, Record<string, string>> = {
	paddle: { apiKey: "pdl_sdbx_test", webhookSecret: "sandbox-test-webhook-secret" },
	apple: { privateKey: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----" },
	google: {
		serviceAccountJson: JSON.stringify({ client_email: "play@example.iam.gserviceaccount.com" }),
		obfuscatedAccountIdSecret: "account-link-secret",
	},
	stripe: { secretKey: "sk_live_acme", webhookSecret: "whsec_acme" },
	projection: { projectionSecret: "projection-secret" },
};

function connectionVersion(
	settings: Record<string, unknown>,
	externalIdentity: string | null,
): ConnectionVersion {
	return {
		id: "version_1",
		connection_id: "connection_1",
		project_instance_id: project.projectInstanceId,
		expected_revision: 1,
		settings,
		status: "active",
		validated_at: null,
		event_verified_at: null,
		validation: null,
		external_identity: externalIdentity,
		expires_at: new Date("2027-01-01T00:00:00.000Z"),
	};
}

function apiKeyRepository(kind: RuntimeConnectionKind, externalIdentity: string | null) {
	const lookups: Array<{ instanceId: string; kind: string; recovery: boolean }> = [];
	const repository = {
		async active(instanceId: string, lookupKind: string, recovery = false) {
			lookups.push({ instanceId, kind: lookupKind, recovery });
			return {
				version: connectionVersion(settingsByKind[kind], externalIdentity),
				secrets: secretsByKind[kind],
			};
		},
	} as unknown as ConnectionRepository;
	return { repository, lookups };
}

/** An OAuth version whose stored access token is still fresh, so no refresh is attempted. */
function oauthRepository(externalIdentity: string) {
	const version = connectionVersion({ ...stripeSettings, authMethod: "oauth" }, externalIdentity);
	const envelopes = [
		{ purpose: "accessToken", envelope: { value: "rk_test_access" } },
		{ purpose: "refreshToken", envelope: { value: "rt_acme" } },
		{ purpose: "expiresAt", envelope: { value: String(Date.now() + 3_600_000) } },
	];
	const tx = Object.assign(
		async (strings: TemplateStringsArray) => {
			const text = strings.join("?");
			if (text.includes("SELECT purpose,envelope")) return envelopes;
			if (text.includes("SELECT kind")) return [{ kind: "stripe" }];
			return [];
		},
		{
			query: async <Row>({ text }: { text: string }) => {
				if (text.includes("SELECT purpose, envelope"))
					return envelopes as unknown as readonly Row[];
				if (text.includes("SELECT kind")) return [{ kind: "stripe" }] as unknown as readonly Row[];
				return [] as readonly Row[];
			},
		},
	);
	const persistence = {
		begin: async (callback: (sql: typeof tx) => unknown) => callback(tx),
	} as unknown as MerchantSql;
	return {
		repository: {
			async active() {
				return { version, secrets: {} };
			},
			cipher: { decrypt: (envelope: { value: string }) => envelope.value },
		} as unknown as ConnectionRepository,
		persistence,
	};
}

const stripeAppEnv = {
	STRIPE_APP_CLIENT_ID: "ca_test",
	STRIPE_APP_REDIRECT_URI: "https://app.quotum.dev/stripe/callback",
	STRIPE_APP_TEST_API_KEY: "sk_test_app",
	STRIPE_APP_TEST_WEBHOOK_SECRET: "whsec_app_test",
};

async function withStripeAppEnv<T>(run: () => Promise<T>): Promise<T> {
	const previous = Object.fromEntries(
		Object.keys(stripeAppEnv).map((name) => [name, process.env[name]]),
	);
	Object.assign(process.env, stripeAppEnv);
	try {
		return await run();
	} finally {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

describe("runtime connection resolver account identity", () => {
	it("fills accountIdentity for a Stripe API-key connection without a connected account", async () => {
		const { repository, lookups } = apiKeyRepository("stripe", "acct_api_key");
		const resolver = createRuntimeConnectionResolver(repository);

		const config = await resolver.resolve(project, "stripe", "recovery");

		expect(config?.accountIdentity).toBe("acct_api_key");
		expect(config?.secretKey).toBe("sk_live_acme");
		expect(config).not.toHaveProperty("connectedAccountId");
		expect(config).not.toHaveProperty("connectedAccountLivemode");
		expect(lookups).toEqual([
			{ instanceId: project.projectInstanceId, kind: "stripe", recovery: true },
		]);
	});

	it("sets a null accountIdentity when a connection has no external identity", async () => {
		const resolver = createRuntimeConnectionResolver(apiKeyRepository("stripe", null).repository);

		const config = await resolver.resolve(project, "stripe");

		expect(config?.accountIdentity).toBeNull();
		expect(config).not.toHaveProperty("connectedAccountId");
	});

	it("fills accountIdentity and the connected account for a Stripe OAuth connection", async () => {
		const { repository, persistence } = oauthRepository("acct_oauth");
		const resolver = createRuntimeConnectionResolver(repository, persistence);

		const config = await withStripeAppEnv(() => resolver.resolve(sandboxProject, "stripe"));

		expect(config).toMatchObject({
			accountIdentity: "acct_oauth",
			connectedAccountId: "acct_oauth",
			connectedAccountLivemode: false,
			secretKey: "rk_test_access",
			webhookSecret: "whsec_app_test",
		});
	});

	it("uses an injected OAuth port without requiring provider app environment", async () => {
		const { repository, persistence } = oauthRepository("acct_injected");
		const port: StripeOAuthPort = {
			authorize() {
				throw new Error("Unexpected authorization");
			},
			async exchange() {
				throw new Error("Unexpected exchange");
			},
			async refresh() {
				throw new Error("Fresh access must not refresh");
			},
			webhookSecret: () => "whsec_synthetic_injected",
		};
		const resolved = await createRuntimeConnectionResolver(repository, persistence, port).resolve(
			sandboxProject,
			"stripe",
		);
		expect(resolved?.accountIdentity).toBe("acct_injected");
		expect(resolved?.webhookSecret === "whsec_synthetic_injected").toBe(true);
	});

	it("keeps disabled projections unavailable for new work while allowing recovery", async () => {
		const { repository } = apiKeyRepository("projection", null);
		const active = repository.active.bind(repository);
		repository.active = async (instance, kind, recovery) =>
			recovery ? active(instance, kind, recovery) : null;
		const resolver = createRuntimeConnectionResolver(repository);
		expect(await resolver.resolve(project, "projection", "new")).toBeNull();
		expect((await resolver.resolve(project, "projection", "recovery"))?.projectionUrl).toBe(
			"https://acme.example.com/billing/projection",
		);
	});

	it("fills accountIdentity for Apple and Google connections", async () => {
		const apple = await createRuntimeConnectionResolver(
			apiKeyRepository("apple", "com.acme.app").repository,
		).resolve(project, "apple");
		const google = await createRuntimeConnectionResolver(
			apiKeyRepository("google", "com.acme.android").repository,
		).resolve(project, "google");

		expect(apple).toMatchObject({ bundleId: "com.acme.app", accountIdentity: "com.acme.app" });
		expect(google).toMatchObject({
			packageName: "com.acme.app",
			accountIdentity: "com.acme.android",
		});
	});

	it("leaves projection connections without an account identity", async () => {
		const config = await createRuntimeConnectionResolver(
			apiKeyRepository("projection", "https://acme.example.com").repository,
		).resolve(project, "projection");

		expect(config).toEqual({
			projectionUrl: "https://acme.example.com/billing/projection",
			projectionSecret: "projection-secret",
			projectionContract: "billing_state_v1",
			usageDelivery: "coalesced",
		});
	});
});

describe("connection description", () => {
	const row: ConnectionDescriptionRow = {
		enabled: true,
		active_version_id: "version_1",
		settings: {
			...stripeSettings,
			authMethod: "oauth",
			livemode: false,
			appAppleId: 123456789,
			serviceAccountJson: null,
			nested: { secret: "never" },
			list: ["a"],
		},
		validated_at: new Date("2026-09-18T10:00:00.000Z"),
		external_identity: "acct_acme",
	};

	it("keeps only string and boolean settings of the active version", () => {
		expect(connectionDescription(row)).toEqual({
			enabled: true,
			active: true,
			validated: true,
			validatedAt: "2026-09-18T10:00:00.000Z",
			accountIdentity: "acct_acme",
			settings: { ...stripeSettings, authMethod: "oauth", livemode: false },
		});
	});

	it("reports a disabled or unvalidated version as persisted, with no freshness window", () => {
		expect(
			connectionDescription({
				...row,
				enabled: false,
				validated_at: "2020-01-01T00:00:00Z",
				settings: null,
			}),
		).toEqual({
			enabled: false,
			active: true,
			validated: true,
			validatedAt: "2020-01-01T00:00:00.000Z",
			accountIdentity: "acct_acme",
			settings: {},
		});
		expect(connectionDescription({ ...row, validated_at: null })).toMatchObject({
			active: true,
			validated: false,
			validatedAt: null,
		});
	});

	it("reports nothing validated or identified without an active version", () => {
		expect(
			connectionDescription({
				enabled: true,
				active_version_id: null,
				settings: null,
				validated_at: new Date("2026-09-18T10:00:00.000Z"),
				external_identity: "acct_stale",
			}),
		).toEqual({
			enabled: true,
			active: false,
			validated: false,
			validatedAt: null,
			accountIdentity: null,
			settings: {},
		});
		// Platform list rows carry no external identity.
		const { external_identity: _, ...listRow } = row;
		expect(connectionDescription(listRow).accountIdentity).toBeNull();
	});
});

describe("runtime connection resolver describe", () => {
	function describingRepository(result: () => Promise<ConnectionDescriptionRow | null>) {
		const lookups: Array<{ instanceId: string; kind: string }> = [];
		const repository = {
			async describe(instanceId: string, kind: string) {
				lookups.push({ instanceId, kind });
				return result();
			},
			async active() {
				throw new Error("describe must not read secrets");
			},
			async secrets() {
				throw new Error("describe must not read secrets");
			},
		} as unknown as ConnectionRepository;
		return { repository, lookups };
	}

	it("maps the persisted row and returns null when the project has none", async () => {
		const { repository, lookups } = describingRepository(async () => ({
			enabled: false,
			active_version_id: "version_1",
			settings: { bundleId: "com.acme.app", appAppleId: 123456789 },
			validated_at: new Date("2026-09-18T10:00:00.000Z"),
			external_identity: "com.acme.app",
		}));
		const resolver = createRuntimeConnectionResolver(repository);

		expect(await resolver.describe?.(project, "apple")).toEqual({
			enabled: false,
			active: true,
			validated: true,
			validatedAt: "2026-09-18T10:00:00.000Z",
			accountIdentity: "com.acme.app",
			settings: { bundleId: "com.acme.app" },
		});
		expect(
			await createRuntimeConnectionResolver(
				describingRepository(async () => null).repository,
			).describe?.(project, "stripe"),
		).toBeNull();
		expect(lookups).toEqual([{ instanceId: project.projectInstanceId, kind: "apple" }]);
	});

	it("reports a failing read as the unavailable integration error", async () => {
		const resolver = createRuntimeConnectionResolver(
			describingRepository(async () => {
				throw new Error("connection refused");
			}).repository,
		);

		let error: unknown;
		try {
			await resolver.describe?.(project, "google");
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(BillingError);
		expect(error).toMatchObject({
			message: "This project integration is unavailable",
			code: "CONNECTION_UNAVAILABLE",
			status: 503,
		});
	});
});

describe("pinned Paddle connection recovery", () => {
	it("reads a validated retired version, without falling back to the active connection", async () => {
		const identity = `paddle:sandbox:ntfset_${"a".repeat(26)}`;
		const version = {
			...connectionVersion(
				{
					...settingsByKind.paddle,
					webhookUrl: "https://example.com/v1/projects/acme/webhooks/paddle",
				},
				identity,
			),
			id: crypto.randomUUID(),
			status: "retired",
			validated_at: new Date(),
		} as ConnectionVersion;
		let activeReads = 0;
		let decryptions = 0;
		const repository = {
			version: async (instanceId: string, versionId: string) => {
				expect(instanceId).toBe(sandboxProject.projectInstanceId);
				expect(versionId).toBe(version.id);
				return version;
			},
			matchesKind: async (connectionId: string, kind: string) => {
				expect([connectionId, kind]).toEqual([version.connection_id, "paddle"]);
				return true;
			},
			secrets: async () => {
				decryptions++;
				return secretsByKind.paddle;
			},
			active: async () => {
				activeReads++;
				throw new Error("wrong version");
			},
		} as unknown as ConnectionRepository;
		const resolver = createRuntimeConnectionResolver(repository);
		expect(await resolver.resolvePaddleVersion?.(sandboxProject, version.id)).toMatchObject({
			versionId: version.id,
			accountIdentity: identity,
			apiKey: "pdl_sdbx_test",
		});
		expect(activeReads).toBe(0);
		expect(decryptions).toBe(1);
		version.validated_at = null;
		expect(await resolver.resolvePaddleVersion?.(sandboxProject, version.id)).toBeNull();
		expect(decryptions).toBe(1);
	});
});
