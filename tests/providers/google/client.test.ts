import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GooglePlayBillingEnv } from "../../../src/env";
import {
	buildGooglePlayConfig,
	GooglePlayDeveloperClient,
} from "../../../src/providers/google/client";

const serviceAccount = {
	type: "service_account",
	client_email: "play-publisher@example.iam.gserviceaccount.com",
	private_key: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----\\n",
};

const googleEnv = (overrides: Partial<GooglePlayBillingEnv> = {}): GooglePlayBillingEnv => ({
	packageName: "com.voysee.app",
	serviceAccountJson: JSON.stringify(serviceAccount),
	serviceAccountKeyFile: null,
	obfuscatedAccountIdSecret: "account-link-secret",
	previousObfuscatedAccountIdSecrets: [],
	rtdnAudience: null,
	rtdnServiceAccountEmail: null,
	rtdnAuthorizedParty: null,
	enablePublisherMutations: true,
	...overrides,
});

describe("Google Play developer client", () => {
	it("builds config from service account JSON", () => {
		const config = buildGooglePlayConfig(googleEnv());

		expect(config.packageName).toBe("com.voysee.app");
		expect(config.serviceAccountCredentials).toEqual(serviceAccount);
		expect(config.enablePublisherMutations).toBe(true);
	});

	it("builds config from a service account key file", () => {
		const directory = mkdtempSync(join(tmpdir(), "google-play-"));
		const keyFile = join(directory, "service-account.json");
		try {
			writeFileSync(keyFile, JSON.stringify(serviceAccount));

			const config = buildGooglePlayConfig(
				googleEnv({ serviceAccountJson: null, serviceAccountKeyFile: keyFile }),
			);

			expect(config.serviceAccountCredentials).toEqual(serviceAccount);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects invalid service account credentials", () => {
		expect(() =>
			buildGooglePlayConfig(
				googleEnv({
					serviceAccountJson: JSON.stringify({ client_email: "missing-private-key" }),
				}),
			),
		).toThrow("Google Play service account credentials must include client_email and private_key");
	});

	it("gets subscription purchases through subscriptionsv2", async () => {
		const calls: unknown[] = [];
		const client = new GooglePlayDeveloperClient(buildGooglePlayConfig(googleEnv()), async () => ({
			purchases: {
				subscriptionsv2: {
					get(args: Record<string, unknown>) {
						calls.push({ method: "subscriptionsv2.get", args });
						return Promise.resolve({ data: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" } });
					},
				},
			},
		}));

		const result = await client.getSubscriptionPurchase("purchase_token_1");

		expect(result.subscriptionState).toBe("SUBSCRIPTION_STATE_ACTIVE");
		expect(calls).toEqual([
			{
				method: "subscriptionsv2.get",
				args: { packageName: "com.voysee.app", token: "purchase_token_1" },
			},
		]);
	});

	it("acknowledges subscription purchases with the installed client's required subscriptionId", async () => {
		const calls: unknown[] = [];
		const client = new GooglePlayDeveloperClient(buildGooglePlayConfig(googleEnv()), async () => ({
			purchases: {
				subscriptions: {
					acknowledge(args: Record<string, unknown>) {
						calls.push(args);
						return Promise.resolve({ data: undefined });
					},
				},
			},
		}));

		await client.acknowledgeSubscriptionPurchase(
			"premium_monthly",
			"purchase_token_1",
			"gpa_account_1",
		);

		expect(calls).toEqual([
			{
				packageName: "com.voysee.app",
				subscriptionId: "premium_monthly",
				token: "purchase_token_1",
				requestBody: { developerPayload: "gpa_account_1" },
			},
		]);
	});

	it("gets and mutates one-time product purchases", async () => {
		const calls: unknown[] = [];
		const client = new GooglePlayDeveloperClient(buildGooglePlayConfig(googleEnv()), async () => ({
			purchases: {
				productsv2: {
					getproductpurchasev2(args: Record<string, unknown>) {
						calls.push({ method: "productsv2.getproductpurchasev2", args });
						return Promise.resolve({
							data: { purchaseStateContext: { purchaseState: "PURCHASED" } },
						});
					},
				},
				products: {
					acknowledge(args: Record<string, unknown>) {
						calls.push({ method: "products.acknowledge", args });
						return Promise.resolve({ data: undefined });
					},
					consume(args: Record<string, unknown>) {
						calls.push({ method: "products.consume", args });
						return Promise.resolve({ data: undefined });
					},
				},
			},
		}));

		await client.getProductPurchase("purchase_token_1");
		await client.acknowledgeProductPurchase("credits_10", "purchase_token_1");
		await client.consumeProductPurchase("credits_10", "purchase_token_1");

		expect(calls).toEqual([
			{
				method: "productsv2.getproductpurchasev2",
				args: { packageName: "com.voysee.app", token: "purchase_token_1" },
			},
			{
				method: "products.acknowledge",
				args: {
					packageName: "com.voysee.app",
					productId: "credits_10",
					token: "purchase_token_1",
					requestBody: {},
				},
			},
			{
				method: "products.consume",
				args: {
					packageName: "com.voysee.app",
					productId: "credits_10",
					token: "purchase_token_1",
				},
			},
		]);
	});

	it("retries publisher initialization after a transient factory failure", async () => {
		let factoryCalls = 0;
		const client = new GooglePlayDeveloperClient(buildGooglePlayConfig(googleEnv()), async () => {
			factoryCalls += 1;
			if (factoryCalls === 1) {
				throw new Error("credentials unavailable");
			}

			return {
				purchases: {
					subscriptionsv2: {
						get() {
							return Promise.resolve({
								data: { subscriptionState: "SUBSCRIPTION_STATE_ACTIVE" },
							});
						},
					},
				},
			};
		});

		await expect(client.getSubscriptionPurchase("purchase_token_1")).rejects.toThrow(
			"Google Play Developer API is unavailable",
		);
		await expect(client.getSubscriptionPurchase("purchase_token_1")).resolves.toEqual({
			subscriptionState: "SUBSCRIPTION_STATE_ACTIVE",
		});
		expect(factoryCalls).toBe(2);
	});
});
