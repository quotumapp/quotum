import { describe, expect, it } from "bun:test";
import {
	projectProviderServiceResolver,
	requireAppleStoreKitService,
	requireGooglePlayBillingService,
	requireStripeBillingService,
} from "../../src/app/provider-services";
import type {
	AppleStoreKitServiceLike,
	GooglePlayBillingServiceLike,
	StripeBillingServiceLike,
} from "../../src/app/types";
import { CapabilityError, NotConfiguredError } from "../../src/billing/errors";
import type { BillingRepository } from "../../src/db/repository";
import type { AppleBillingEnv, GooglePlayBillingEnv, StripeBillingEnv } from "../../src/env";
import type {
	ProviderConnectionKind,
	RuntimeConnectionDescription,
	RuntimeConnectionKind,
	RuntimeConnectionResolver,
} from "../../src/projects/connections";
import { appleRegistryEntry } from "../../src/providers/apple/adapter";
import { appleCapabilities } from "../../src/providers/apple/capabilities";
import { AppleStoreKitService } from "../../src/providers/apple/service";
import { admittedProviders, providerCapabilityDeclaration } from "../../src/providers/capabilities";
import {
	type AnyProviderAdapter,
	type AnyProviderRegistryEntry,
	adapterServesOperation,
	missingAdapterOperations,
	type ProviderAdapter,
	type ProviderClientFactories,
	type ProviderRegistryEntry,
	providerOperationMethods,
} from "../../src/providers/contract";
import { GooglePlayBillingService } from "../../src/providers/google/service";
import { paddleCapabilities } from "../../src/providers/paddle/capabilities";
import {
	createProviderRegistry,
	defaultProviderRegistryEntries,
	type ProviderRegistry,
	type ProviderRegistryDependencies,
} from "../../src/providers/registry";
import { stripeRegistryEntry, wrapStripeService } from "../../src/providers/stripe/adapter";
import { stripeCapabilities } from "../../src/providers/stripe/capabilities";
import { StripeBillingService } from "../../src/providers/stripe/service";
import { FakeStripeBillingClient } from "../../src/providers/stripe/testing/fake-client";
import {
	type BillingProvider,
	billingProviders,
	declaredProviders,
	evaluateCapability,
	type ProviderOperation,
	providerOperations,
} from "../../src/shared/provider-capabilities";
import { fixtureConnections } from "../../src/testing/connection-fixtures";
import { projectInstanceContext } from "../helpers/project-context";
import {
	createFakeAppleStoreKitClient,
	createFakeGooglePlayClient,
} from "../integration/helpers/fake-provider-clients";

const project = projectInstanceContext("voysee");
const otherProject = projectInstanceContext("wiseley");

const appleConfig: AppleBillingEnv = {
	bundleId: "com.voysee.app",
	appAppleId: null,
	issuerId: "issuer",
	keyId: "key",
	privateKey: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
	environment: "sandbox",
	enableOnlineChecks: false,
	rootCertificatesDir: null,
};

const googleConfig: GooglePlayBillingEnv = {
	packageName: "com.voysee.app",
	serviceAccountJson: JSON.stringify({
		type: "service_account",
		client_email: "play-publisher@example.iam.gserviceaccount.com",
		private_key: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n",
	}),
	serviceAccountKeyFile: null,
	obfuscatedAccountIdSecret: "account-link-secret",
	previousObfuscatedAccountIdSecrets: [],
	rtdnAudience: null,
	rtdnServiceAccountEmail: null,
	rtdnAuthorizedParty: null,
	enablePublisherMutations: true,
};

const stripeConfig: StripeBillingEnv = {
	connectedAccountId: "acct_voysee",
	secretKey: "sk_test_registry",
	webhookSecret: "whsec_registry",
	checkoutSuccessUrl: "https://voysee.example.com/success?session_id={CHECKOUT_SESSION_ID}",
	checkoutCancelUrl: "https://voysee.example.com/cancel",
	portalReturnUrl: "https://voysee.example.com/account",
};

const configs = { apple: appleConfig, google: googleConfig, stripe: stripeConfig };

function recordingConnections(configured: Partial<typeof configs> = configs) {
	const resolved: Array<{ project: string; kind: RuntimeConnectionKind; purpose?: string }> = [];
	const connections = {
		async resolve(context, kind, purpose) {
			resolved.push({ project: context.projectInstanceKey, kind, purpose });
			if (context.projectInstanceKey !== project.projectInstanceKey) return null;
			return (configured as Record<string, unknown>)[kind] ?? null;
		},
	} as RuntimeConnectionResolver;
	return { connections, resolved };
}

function fakeRepository() {
	const scopedFor: string[] = [];
	const repository = {
		forProject(context: { projectInstanceKey: string }) {
			scopedFor.push(context.projectInstanceKey);
			return {};
		},
	} as unknown as BillingRepository;
	return { getRepository: () => repository, scopedFor };
}

function fakeClientFactories(): ProviderClientFactories {
	return {
		apple: () =>
			createFakeAppleStoreKitClient({
				transactionId: "2000000000000001",
				originalTransactionId: "2000000000000000",
			}).client as unknown as ReturnType<NonNullable<ProviderClientFactories["apple"]>>,
		google: () =>
			createFakeGooglePlayClient({ obfuscatedAccountId: "gpa-user_1" })
				.client as unknown as ReturnType<NonNullable<ProviderClientFactories["google"]>>,
		stripe: (config) => new FakeStripeBillingClient(config),
	};
}

function realRegistry(overrides: Partial<ProviderRegistryDependencies> = {}) {
	return createProviderRegistry({
		connections: recordingConnections().connections,
		getRepository: fakeRepository().getRepository,
		clientFactories: fakeClientFactories(),
		...overrides,
	});
}

const stripeFake: StripeBillingServiceLike = {
	async createCheckoutSession() {
		return { sessionId: "cs_override", url: "https://checkout.stripe.com/c/pay/cs_override" };
	},
	async createPortalSession() {
		return { url: "https://billing.stripe.com/p/session" };
	},
	async getCheckoutSessionStatus(input) {
		return {
			sessionId: input.sessionId,
			status: "open",
			paymentStatus: "unpaid",
			customerEmail: null,
			productKey: null,
		};
	},
	async handleWebhook() {
		return { status: "processed" };
	},
};

const appleFake: AppleStoreKitServiceLike = {
	async getOrCreateAppAccountToken(billingAccountId) {
		return `token-for-${billingAccountId}`;
	},
	async verifyPurchase() {
		return {};
	},
	async handleNotification() {
		return { status: "ignored", entitlements: null };
	},
};

const googleFake: GooglePlayBillingServiceLike = {
	async getAccountLink(billingAccountId) {
		return { obfuscatedAccountId: `gpa-for-${billingAccountId}` };
	},
	async verifyPurchase() {
		return {};
	},
	async handleRtdn() {
		return {};
	},
};

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

function errorShape(error: unknown) {
	if (!(error instanceof NotConfiguredError)) throw new Error("expected a NotConfiguredError");
	return {
		name: error.name,
		message: error.message,
		code: error.code,
		status: error.status,
		classification: error.classification,
	};
}

function capabilityErrorShape(error: unknown) {
	if (!(error instanceof CapabilityError)) throw new Error("expected a CapabilityError");
	return {
		name: error.name,
		message: error.message,
		code: error.code,
		status: error.status,
		classification: error.classification,
		exposeMessage: error.exposeMessage,
		blockingLayer: error.blockingLayer,
		details: error.details,
	};
}

function implementedOperations(adapter: AnyProviderAdapter): ProviderOperation[] {
	return providerOperations.filter((operation) => {
		const support = adapter.declaration.operations[operation];
		return (
			(support.level === "native" || support.level === "quotum_composed") &&
			(support.verification.status === "verified" || support.verification.status === "conditional")
		);
	});
}

describe("provider registry", () => {
	it("admits exactly the billing providers and declares every provider", () => {
		const registry = realRegistry();

		expect(registry.admitted()).toEqual([...billingProviders]);
		expect(registry.admitted()).toEqual(admittedProviders());
		expect(registry.declarations().map((declaration) => declaration.provider)).toEqual([
			...declaredProviders,
		]);
	});

	it("declares planned Paddle but never builds it", async () => {
		const registry = realRegistry();
		const paddle = registry.declarations().find((declaration) => declaration.provider === "paddle");
		const unadmitted = "paddle" as unknown as BillingProvider;

		expect(paddle?.availability).toBe("planned");
		expect(registry.admitted()).not.toContain(unadmitted);
		for (const lookup of [
			registry.service(project, unadmitted),
			registry.adapter(project, unadmitted),
			registry.require(project, unadmitted, "checkout.hosted"),
		]) {
			expect(await rejection(lookup)).toEqual(
				new Error("Provider paddle is not admitted by the runtime"),
			);
		}
		expect(() =>
			createProviderRegistry({
				getRepository: fakeRepository().getRepository,
				entries: [
					{
						...stripeRegistryEntry,
						provider: "paddle",
						declaration: paddleCapabilities,
					} as unknown as AnyProviderRegistryEntry,
				],
			}),
		).toThrow("Provider paddle is not available and cannot be registered");
	});

	it("rejects entries that disagree with their declaration or repeat a provider", () => {
		const { getRepository } = fakeRepository();

		expect(() =>
			createProviderRegistry({
				getRepository,
				entries: [
					{ ...stripeRegistryEntry, provider: "apple" } as unknown as AnyProviderRegistryEntry,
				],
			}),
		).toThrow("Provider registry entry apple carries another declaration");
		expect(() =>
			createProviderRegistry({
				getRepository,
				entries: [stripeRegistryEntry, stripeRegistryEntry],
			}),
		).toThrow("Provider stripe is registered twice");
	});

	it("labels admitted providers with their entry names", () => {
		const registry = realRegistry();

		expect(billingProviders.map((provider) => registry.label(provider))).toEqual([
			"Apple StoreKit",
			"Google Play",
			"Stripe",
		]);
		expect(() => registry.label("paddle" as unknown as BillingProvider)).toThrow(
			"Provider paddle is not admitted by the runtime",
		);
	});

	it("resolves and describes the connection kind each declaration reports", () => {
		// describe() queries the entry's kind while the capabilities read reports the declaration's.
		expect(
			defaultProviderRegistryEntries.map((entry): string[] => [
				entry.provider,
				entry.connectionKind,
			]),
		).toEqual(
			billingProviders.map((provider) => [
				provider,
				providerCapabilityDeclaration(provider).connectionKind,
			]),
		);
	});

	it("refuses reconcile-required declarations that implement money-moving worker writes", () => {
		const { getRepository } = fakeRepository();
		const withAutomaticTopups = {
			...appleRegistryEntry,
			declaration: {
				...appleCapabilities,
				operations: {
					...appleCapabilities.operations,
					"topup.automatic": stripeCapabilities.operations["topup.automatic"],
				},
			},
		} as unknown as AnyProviderRegistryEntry;
		const reconcilingStripe = {
			...stripeRegistryEntry,
			declaration: {
				...stripeCapabilities,
				writeSemantics: { clientIdempotencyKeys: false, uncertainWrite: "reconcile_required" },
			},
		} as unknown as AnyProviderRegistryEntry;

		expect(appleCapabilities.writeSemantics.uncertainWrite).toBe("reconcile_required");
		expect(() => realRegistry()).not.toThrow();
		expect(() => createProviderRegistry({ getRepository, entries: [withAutomaticTopups] })).toThrow(
			new Error(
				"Provider apple requires reconciliation of uncertain writes and cannot implement topup.automatic until an uncertain-write ledger exists",
			),
		);
		expect(() => createProviderRegistry({ getRepository, entries: [reconcilingStripe] })).toThrow(
			new Error(
				"Provider stripe requires reconciliation of uncertain writes and cannot implement subscription.change.apply, subscription.change.period_end, settlement.collect_finalized_charge, adjustment.issue, topup.automatic until an uncertain-write ledger exists",
			),
		);
		const withPlannedAutomaticTopups = {
			...appleRegistryEntry,
			declaration: {
				...appleCapabilities,
				operations: {
					...appleCapabilities.operations,
					"topup.automatic": {
						level: "native",
						verification: { status: "planned", trackedBy: "P4" },
						conditions: [],
					},
				},
			},
		} as unknown as AnyProviderRegistryEntry;
		expect(() =>
			createProviderRegistry({ getRepository, entries: [withPlannedAutomaticTopups] }),
		).toThrow(
			new Error(
				"Provider apple requires reconciliation of uncertain writes and cannot implement topup.automatic until an uncertain-write ledger exists",
			),
		);
	});

	it("reads adapter account identity from the connection before the connected account", async () => {
		const { connectedAccountId: _, ...apiKeyStripe } = stripeConfig;
		const identities = async (configured: typeof configs) => {
			const registry = realRegistry({ connections: recordingConnections(configured).connections });
			const adapters = await Promise.all(
				billingProviders.map((provider) => registry.adapter(project, provider)),
			);
			return adapters.map((adapter) => adapter?.accountIdentity);
		};

		expect(
			await identities({
				apple: { ...appleConfig, accountIdentity: "com.voysee.app" },
				google: { ...googleConfig, accountIdentity: "com.voysee.android" },
				stripe: { ...stripeConfig, accountIdentity: "acct_identity" },
			}),
		).toEqual(["com.voysee.app", "com.voysee.android", "acct_identity"]);
		expect(
			await identities({ ...configs, stripe: { ...stripeConfig, accountIdentity: null } }),
		).toEqual([null, null, "acct_voysee"]);
		expect(
			await identities({
				...configs,
				stripe: { ...apiKeyStripe, accountIdentity: "acct_api_key" },
			}),
		).toEqual([null, null, "acct_api_key"]);
		expect(await identities({ ...configs, stripe: apiKeyStripe })).toEqual([null, null, null]);
	});

	it("builds real services from connections with the requested purpose", async () => {
		const { connections, resolved } = recordingConnections();
		const { getRepository, scopedFor } = fakeRepository();
		const registry = createProviderRegistry({
			connections,
			getRepository,
			clientFactories: fakeClientFactories(),
		});

		expect(await registry.service(project, "apple")).toBeInstanceOf(AppleStoreKitService);
		expect(await registry.service(project, "google", "recovery")).toBeInstanceOf(
			GooglePlayBillingService,
		);
		expect(await registry.service(project, "stripe", "recovery")).toBeInstanceOf(
			StripeBillingService,
		);
		expect(resolved).toEqual([
			{ project: "voysee", kind: "apple", purpose: "new" },
			{ project: "voysee", kind: "google", purpose: "recovery" },
			{ project: "voysee", kind: "stripe", purpose: "recovery" },
		]);
		expect(scopedFor).toEqual(["voysee", "voysee", "voysee"]);
	});

	it("returns null without touching the repository when a project has no connection", async () => {
		const { connections } = recordingConnections();
		const { getRepository, scopedFor } = fakeRepository();
		const registry = createProviderRegistry({ connections, getRepository });

		for (const provider of billingProviders) {
			expect(await registry.service(otherProject, provider)).toBeNull();
			expect(await registry.adapter(otherProject, provider)).toBeNull();
		}
		expect(scopedFor).toEqual([]);
	});

	it("throws the facade's not-configured error when require finds no adapter", async () => {
		const registry = createProviderRegistry({
			connections: recordingConnections().connections,
			getRepository: fakeRepository().getRepository,
		});
		const facadeErrors: Record<BillingProvider, () => unknown> = {
			apple: () => requireAppleStoreKitService(null),
			google: () => requireGooglePlayBillingService(null),
			stripe: () => requireStripeBillingService(null),
		};

		for (const provider of billingProviders) {
			let facadeError: unknown;
			try {
				facadeErrors[provider]();
			} catch (error) {
				facadeError = error;
			}
			const error = await rejection(registry.require(otherProject, provider, "webhook.ingest"));
			expect(error).toBeInstanceOf(NotConfiguredError);
			expect(errorShape(error)).toEqual(errorShape(facadeError));
			expect(errorShape(error).code).toBe("BILLING_PROVIDER_NOT_CONFIGURED");
		}
	});

	it("rejects require for an operation the adapter cannot serve and returns it otherwise", async () => {
		const registry = realRegistry({
			overrides: { voysee: { stripeBillingService: stripeFake, appleStoreKitService: appleFake } },
		});

		const through = { through: "implementation" } as const;
		const appleCheckoutVerdict = evaluateCapability(
			appleCapabilities,
			"checkout.hosted",
			{},
			through,
		);

		const stripe = await registry.require(project, "stripe", "checkout.hosted");
		expect(stripe.provider).toBe("stripe");
		const unserved = await rejection(
			registry.require(project, "stripe", "subscription.change.apply"),
		);
		expect(errorShape(unserved)).toEqual({
			name: "NotConfiguredError",
			message: "Stripe provider does not serve subscription.change.apply",
			code: "BILLING_PROVIDER_NOT_CONFIGURED",
			status: 503,
			classification: "not_configured",
		});
		expect((unserved as NotConfiguredError).details).toEqual({
			provider: "stripe",
			operation: "subscription.change.apply",
		});
		expect(
			capabilityErrorShape(await rejection(registry.require(project, "apple", "checkout.hosted"))),
		).toEqual({
			name: "CapabilityError",
			message: "Apple StoreKit provider does not support checkout.hosted",
			code: "PROVIDER_CAPABILITY_UNSUPPORTED",
			status: 400,
			classification: "invalid_request",
			exposeMessage: true,
			blockingLayer: "provider",
			details: { verdict: { ...appleCheckoutVerdict, provider: "apple" } },
		});
		expect((await registry.require(project, "apple", "purchase.verify")).provider).toBe("apple");
	});

	it("checks the declaration before resolving a connection", async () => {
		const { connections, resolved } = recordingConnections();
		const { getRepository, scopedFor } = fakeRepository();
		const registry = createProviderRegistry({
			connections,
			getRepository,
			clientFactories: fakeClientFactories(),
		});

		for (const provider of ["apple", "google"] as const) {
			const error = await rejection(registry.require(project, provider, "checkout.hosted"));
			expect(error).toBeInstanceOf(CapabilityError);
			expect((error as CapabilityError).details).toEqual({
				verdict: expect.objectContaining({
					provider,
					operation: "checkout.hosted",
					outcome: "blocked",
					blockingLayer: "provider",
				}),
			});
			const unconfigured = await rejection(
				registry.require(otherProject, provider, "checkout.hosted"),
			);
			expect(unconfigured).toBeInstanceOf(CapabilityError);
		}
		expect(resolved).toEqual([]);
		expect(scopedFor).toEqual([]);

		expect((await registry.require(project, "apple", "purchase.verify")).provider).toBe("apple");
		expect(resolved).toEqual([{ project: "voysee", kind: "apple", purpose: "new" }]);
	});

	it("reports a planned implementation from the registered declaration", async () => {
		const { connections, resolved } = recordingConnections();
		const plannedCheckout = {
			...stripeRegistryEntry,
			declaration: {
				...stripeCapabilities,
				operations: {
					...stripeCapabilities.operations,
					"checkout.hosted": {
						...stripeCapabilities.operations["checkout.hosted"],
						verification: {
							...stripeCapabilities.operations["checkout.hosted"].verification,
							status: "planned",
						},
					},
				},
			},
		} as AnyProviderRegistryEntry;
		const registry = createProviderRegistry({
			connections,
			getRepository: fakeRepository().getRepository,
			entries: [plannedCheckout],
		});

		const error = await rejection(registry.require(project, "stripe", "checkout.hosted"));
		expect(capabilityErrorShape(error)).toMatchObject({
			name: "CapabilityError",
			message: "Stripe provider does not support checkout.hosted",
			code: "PROVIDER_CAPABILITY_UNSUPPORTED",
			status: 400,
			blockingLayer: "implementation",
			details: {
				verdict: {
					provider: "stripe",
					blockingLayer: "implementation",
					reasons: [expect.objectContaining({ layer: "implementation" })],
				},
			},
		});
		expect(resolved).toEqual([]);
	});

	it("uses per-project overrides by override key, including an explicit null", async () => {
		const { connections, resolved } = recordingConnections();
		const registry = createProviderRegistry({
			connections,
			getRepository: fakeRepository().getRepository,
			clientFactories: fakeClientFactories(),
			overrides: {
				voysee: { stripeBillingService: stripeFake, googlePlayBillingService: null },
			},
		});

		expect(await registry.service(project, "stripe")).toBe(stripeFake);
		expect(await registry.service(project, "google")).toBeNull();
		expect(await registry.adapter(project, "google")).toBeNull();
		expect(resolved).toEqual([]);
		expect(await registry.service(project, "apple")).toBeInstanceOf(AppleStoreKitService);
		expect(resolved).toEqual([{ project: "voysee", kind: "apple", purpose: "new" }]);

		const adapter = await registry.adapter(project, "stripe");
		const session = await adapter?.checkout?.createHosted({
			billingAccountId: "user_1",
			productKey: "credits_100",
		});
		expect(session?.sessionId).toBe("cs_override");
		expect(adapter?.accountIdentity).toBeNull();
	});

	it("prefers overrides to legacy services and legacy services to connections", async () => {
		const { connections, resolved } = recordingConnections();
		const legacyStripe: StripeBillingServiceLike = { ...stripeFake };
		const registry = createProviderRegistry({
			connections,
			getRepository: fakeRepository().getRepository,
			overrides: { wiseley: { stripeBillingService: stripeFake } },
			legacyServices: {
				appleStoreKitService: appleFake,
				googlePlayBillingService: null,
				stripeBillingService: legacyStripe,
			},
		});

		expect(await registry.service(otherProject, "stripe")).toBe(stripeFake);
		expect(await registry.service(project, "stripe")).toBe(legacyStripe);
		expect(await registry.service(project, "apple")).toBe(appleFake);
		expect(await registry.service(project, "google")).toBeNull();
		expect(resolved).toEqual([]);
	});

	it("skips the declaration check for overrides that lack groups", async () => {
		const registry = realRegistry({
			overrides: {
				voysee: {
					appleStoreKitService: appleFake,
					googlePlayBillingService: googleFake,
					stripeBillingService: stripeFake,
				},
			},
		});

		for (const provider of billingProviders) {
			const adapter = (await registry.adapter(project, provider)) as AnyProviderAdapter;
			expect(adapter.replay).toBeUndefined();
			expect(missingAdapterOperations(adapter)).toContain("event.replay");
		}
	});

	it("passes the built client config and project key to the client factory", async () => {
		const calls: Array<{ secretKey: string; apiVersion: string; projectKey: string }> = [];
		const registry = realRegistry({
			clientFactories: {
				stripe(config, projectInstanceKey) {
					calls.push({
						secretKey: config.secretKey,
						apiVersion: config.apiVersion,
						projectKey: projectInstanceKey,
					});
					return new FakeStripeBillingClient(config);
				},
			},
		});

		const adapter = await registry.adapter(project, "stripe", "recovery");

		expect(calls).toHaveLength(1);
		expect(calls[0]?.secretKey).toBe("sk_test_registry");
		expect(calls[0]?.apiVersion).toBeString();
		expect(calls[0]?.projectKey).toBe("voysee");
		expect(adapter?.accountIdentity).toBe("acct_voysee");
	});

	it("builds real clients when no factory is given", async () => {
		const registry = createProviderRegistry({
			connections: recordingConnections().connections,
			getRepository: fakeRepository().getRepository,
		});

		for (const provider of billingProviders) {
			const adapter = await registry.adapter(project, provider);
			expect(adapter?.provider).toBe(provider);
		}
	});

	it("gives adapters built from connections every group their declaration implements", async () => {
		const registry = realRegistry();

		for (const provider of billingProviders) {
			const adapter = (await registry.adapter(project, provider)) as AnyProviderAdapter;
			expect(missingAdapterOperations(adapter)).toEqual([]);
			for (const operation of implementedOperations(adapter)) {
				expect(adapterServesOperation(adapter, operation)).toBe(true);
			}
		}
	});

	it("refuses a connection-built adapter missing a group its declaration implements", async () => {
		const withoutCheckout: ProviderRegistryEntry<"stripe"> = {
			...stripeRegistryEntry,
			wrap: (service, accountIdentity) => ({
				...wrapStripeService(service, accountIdentity),
				checkout: undefined,
			}),
		};
		const registry = realRegistry({ entries: [withoutCheckout] });

		expect(await rejection(registry.adapter(project, "stripe"))).toEqual(
			new Error(
				"Provider stripe adapter has no method for declared operations: checkout.hosted, checkout.plan, topup.customer_initiated",
			),
		);
	});

	it("maps every operation to adapter methods and only catalog constructs to none", () => {
		for (const operation of providerOperations) {
			expect(providerOperationMethods[operation].length === 0).toBe(
				operation.startsWith("catalog."),
			);
		}
	});

	it("evaluates declarations for admitted and planned providers from caller facts", async () => {
		const registry = realRegistry();

		expect(await registry.verdict(project, "stripe", "checkout.hosted")).toMatchObject({
			provider: "stripe",
			outcome: "available",
			blockingLayer: null,
		});
		expect(
			await registry.verdict(project, "stripe", "topup.automatic", {
				operation: { savedPaymentMethod: false },
			}),
		).toMatchObject({ outcome: "blocked", blockingLayer: "operation" });
		expect(await registry.verdict(project, "paddle", "checkout.plan")).toMatchObject({
			provider: "paddle",
			outcome: "blocked",
			blockingLayer: "implementation",
		});
	});

	it("never infers a provider from an external id, even when declarations share its prefix", async () => {
		const { connections, resolved } = recordingConnections();
		const registry = createProviderRegistry({
			connections,
			getRepository: fakeRepository().getRepository,
			clientFactories: fakeClientFactories(),
		});
		const sharedPrefixId = "sub_01h2xcejqtf2nbrexx3vqjhp41";

		// Stripe and Paddle both issue `sub_` subscription ids; both declarations stay valid side by side.
		expect(registry.declarations().map((declaration) => declaration.provider)).toEqual(
			expect.arrayContaining(["stripe", "paddle"]),
		);
		expect(await rejection(registry.service(project, sharedPrefixId as BillingProvider))).toEqual(
			new Error(`Provider ${sharedPrefixId} is not admitted by the runtime`),
		);
		expect(resolved).toEqual([]);

		const stripe = await registry.verdict(project, "stripe", "subscription.change.apply");
		const paddle = await registry.verdict(project, "paddle", "subscription.change.apply");
		expect(stripe.provider).toBe("stripe");
		expect(paddle.provider).toBe("paddle");
		expect(paddle.blockingLayer).toBe("implementation");

		const adapter = (await registry.adapter(project, "stripe")) as ProviderAdapter<"stripe">;
		expect(adapter.provider).toBe("stripe");
		expect(resolved).toEqual([{ project: "voysee", kind: "stripe", purpose: "new" }]);
	});

	it("keeps the request-path resolver a facade over the registry", async () => {
		const { connections, resolved } = recordingConnections();
		const resolver = projectProviderServiceResolver(
			createProviderRegistry({
				connections,
				getRepository: fakeRepository().getRepository,
				overrides: { wiseley: { stripeBillingService: stripeFake } },
			}),
		);

		expect(await resolver.stripeBillingService(otherProject)).toBe(stripeFake);
		expect(await resolver.appleStoreKitService(project)).toBeInstanceOf(AppleStoreKitService);
		expect(await resolver.googlePlayBillingService(project, "recovery")).toBeInstanceOf(
			GooglePlayBillingService,
		);
		expect(await resolver.stripeBillingService(project, "recovery")).toBeInstanceOf(
			StripeBillingService,
		);
		expect(await resolver.appleStoreKitService(otherProject)).toBeNull();
		expect(resolved).toEqual([
			{ project: "voysee", kind: "apple", purpose: "new" },
			{ project: "voysee", kind: "google", purpose: "recovery" },
			{ project: "voysee", kind: "stripe", purpose: "recovery" },
			{ project: "wiseley", kind: "apple", purpose: "new" },
		]);
	});

	it("types lookups by provider", async () => {
		const registry: ProviderRegistry = realRegistry({
			overrides: { voysee: { appleStoreKitService: appleFake } },
		});
		const apple = await registry.require(project, "apple", "purchase.verify");

		expect(await apple.purchases?.accountLink("user_1")).toBe("token-for-user_1");
	});
});

const validatedDescription: RuntimeConnectionDescription = {
	enabled: true,
	active: true,
	validated: true,
	validatedAt: "2026-09-18T10:00:00.000Z",
	accountIdentity: "acct_voysee",
	settings: { authMethod: "api_key" },
};

/** A resolver whose resolve throws, so a test fails if describe ever resolves a connection. */
function describingConnections(
	descriptions: Partial<Record<ProviderConnectionKind, RuntimeConnectionDescription | null>>,
) {
	const described: Array<{ project: string; kind: ProviderConnectionKind }> = [];
	const connections: RuntimeConnectionResolver = {
		async resolve() {
			throw new Error("describe must not resolve a connection");
		},
		async describe(context, kind) {
			described.push({ project: context.projectInstanceKey, kind });
			return descriptions[kind] ?? null;
		},
	};
	return { connections, described };
}

function describingRegistry(
	connections: RuntimeConnectionResolver,
	overrides: Partial<ProviderRegistryDependencies> = {},
) {
	const { getRepository, scopedFor } = fakeRepository();
	const built: string[] = [];
	const registry = createProviderRegistry({
		connections,
		getRepository,
		clientFactories: {
			apple: () => {
				built.push("apple");
				throw new Error("describe must not build a client");
			},
			google: () => {
				built.push("google");
				throw new Error("describe must not build a client");
			},
			stripe: () => {
				built.push("stripe");
				throw new Error("describe must not build a client");
			},
		},
		...overrides,
	});
	return { registry, scopedFor, built };
}

const presentOverride = {
	connection: {
		configured: true,
		enabled: true,
		validated: true,
		validatedAt: null,
		accountIdentity: null,
	},
	configuration: { connectionEnabled: true, connectionValidated: true, accountFlags: {} },
};

const absentConnection = {
	connection: {
		configured: false,
		enabled: false,
		validated: false,
		validatedAt: null,
		accountIdentity: null,
	},
	configuration: { connectionEnabled: false, connectionValidated: false, accountFlags: {} },
};

describe("provider registry describe", () => {
	it("reports a project override as configured and an explicit null override as absent", async () => {
		const { connections, described } = describingConnections({ google: validatedDescription });
		const { registry, scopedFor, built } = describingRegistry(connections, {
			overrides: {
				voysee: { stripeBillingService: stripeFake, appleStoreKitService: null },
			},
			legacyServices: { stripeBillingService: null, appleStoreKitService: appleFake },
		});

		expect(await registry.describe(project, "stripe")).toEqual(presentOverride);
		expect(await registry.describe(project, "apple")).toEqual(absentConnection);
		expect(described).toEqual([]);
		expect(await registry.describe(project, "google")).toMatchObject({
			connection: { configured: true, accountIdentity: "acct_voysee" },
		});
		expect(described).toEqual([{ project: "voysee", kind: "google" }]);
		expect(scopedFor).toEqual([]);
		expect(built).toEqual([]);
	});

	it("falls back to legacy services, including an explicit null, before the resolver", async () => {
		const { connections, described } = describingConnections({
			apple: validatedDescription,
			google: validatedDescription,
			stripe: validatedDescription,
		});
		const { registry } = describingRegistry(connections, {
			overrides: { wiseley: { stripeBillingService: null } },
			legacyServices: { stripeBillingService: stripeFake, googlePlayBillingService: null },
		});

		expect(await registry.describe(project, "stripe")).toEqual(presentOverride);
		expect(await registry.describe(project, "google")).toEqual(absentConnection);
		expect(await registry.describe(otherProject, "stripe")).toEqual(absentConnection);
		expect(described).toEqual([]);
		expect((await registry.describe(project, "apple")).connection?.configured).toBe(true);
		expect(described).toEqual([{ project: "voysee", kind: "apple" }]);
	});

	it("leaves the state unknown when the resolver cannot describe connections", async () => {
		const resolveOnly: RuntimeConnectionResolver = {
			async resolve() {
				throw new Error("describe must not resolve a connection");
			},
		};
		const { registry, scopedFor, built } = describingRegistry(resolveOnly);

		for (const provider of billingProviders) {
			expect(await registry.describe(project, provider)).toEqual({
				connection: null,
				configuration: undefined,
			});
		}
		expect(scopedFor).toEqual([]);
		expect(built).toEqual([]);
	});

	it("reads persisted rows by connection kind: missing, disabled, unvalidated and validated", async () => {
		const { connections, described } = describingConnections({
			apple: { ...validatedDescription, enabled: false, accountIdentity: "com.voysee.app" },
			google: {
				...validatedDescription,
				validated: false,
				validatedAt: null,
				accountIdentity: null,
				settings: {},
			},
			stripe: validatedDescription,
		});
		const { registry, scopedFor, built } = describingRegistry(connections);

		expect(await registry.describe(project, "apple")).toEqual({
			connection: {
				configured: true,
				enabled: false,
				validated: true,
				validatedAt: "2026-09-18T10:00:00.000Z",
				accountIdentity: "com.voysee.app",
			},
			configuration: {
				connectionEnabled: false,
				connectionValidated: true,
				accountFlags: { authMethod: "api_key" },
			},
		});
		expect(await registry.describe(project, "google")).toEqual({
			connection: {
				configured: true,
				enabled: true,
				validated: false,
				validatedAt: null,
				accountIdentity: null,
			},
			configuration: { connectionEnabled: true, connectionValidated: false, accountFlags: {} },
		});
		expect(await registry.describe(project, "stripe")).toEqual({
			connection: {
				configured: true,
				enabled: true,
				validated: true,
				validatedAt: "2026-09-18T10:00:00.000Z",
				accountIdentity: "acct_voysee",
			},
			configuration: {
				connectionEnabled: true,
				connectionValidated: true,
				accountFlags: { authMethod: "api_key" },
			},
		});
		expect(
			await describingRegistry(describingConnections({}).connections).registry.describe(
				project,
				"stripe",
			),
		).toEqual(absentConnection);
		expect(
			await describingRegistry(
				describingConnections({
					stripe: { ...validatedDescription, active: false, settings: {} },
				}).connections,
			).registry.describe(project, "stripe"),
		).toEqual(absentConnection);
		expect(described).toEqual([
			{ project: "voysee", kind: "apple" },
			{ project: "voysee", kind: "google" },
			{ project: "voysee", kind: "stripe" },
		]);
		expect(scopedFor).toEqual([]);
		expect(built).toEqual([]);
	});

	it("describes fixture connections as enabled and validated with their account identity", async () => {
		const { connectedAccountId: _, ...apiKeyStripe } = stripeConfig;
		const connections = fixtureConnections([
			{
				projectInstanceKey: "voysee",
				projectionUrl: "https://voysee.example.com/billing/projection",
				projectionSecret: "projection-secret",
				apple: { ...appleConfig, accountIdentity: "com.voysee.app" },
				googlePlay: null,
				stripe: stripeConfig,
			},
			{
				projectInstanceKey: "wiseley",
				projectionUrl: "https://wiseley.example.com/billing/projection",
				projectionSecret: "projection-secret",
				stripe: apiKeyStripe,
			},
		]);
		const { registry, scopedFor, built } = describingRegistry(connections);
		const fixture = (accountIdentity: string | null) => ({
			connection: {
				configured: true,
				enabled: true,
				validated: true,
				validatedAt: null,
				accountIdentity,
			},
			configuration: { connectionEnabled: true, connectionValidated: true, accountFlags: {} },
		});

		expect(await registry.describe(project, "apple")).toEqual(fixture("com.voysee.app"));
		expect(await registry.describe(project, "google")).toEqual(absentConnection);
		expect(await registry.describe(project, "stripe")).toEqual(fixture("acct_voysee"));
		expect(await registry.describe(otherProject, "stripe")).toEqual(fixture(null));
		expect(await registry.describe(otherProject, "apple")).toEqual(absentConnection);
		expect(await registry.describe(projectInstanceContext("unknown"), "stripe")).toEqual(
			absentConnection,
		);
		expect(scopedFor).toEqual([]);
		expect(built).toEqual([]);
	});

	it("describes no connection by default and refuses providers the runtime does not admit", async () => {
		const registry = createProviderRegistry({ getRepository: fakeRepository().getRepository });

		expect(await registry.describe(project, "stripe")).toEqual(absentConnection);
		expect(
			await rejection(registry.describe(project, "paddle" as unknown as BillingProvider)),
		).toEqual(new Error("Provider paddle is not admitted by the runtime"));
	});
});
