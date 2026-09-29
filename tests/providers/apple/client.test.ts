import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Environment,
	VerificationException,
	VerificationStatus,
} from "@apple/app-store-server-library";
import type { AppleBillingEnv } from "../../../src/env";
import {
	AppleStoreKitClient,
	buildAppleStoreKitConfig,
	loadAppleRootCertificates,
	toAppleLibraryEnvironment,
} from "../../../src/providers/apple/client";

const appleEnv = (overrides: Partial<AppleBillingEnv> = {}): AppleBillingEnv => ({
	bundleId: "com.acme.app",
	appAppleId: null,
	issuerId: "99b16628-15e4-4668-972b-eeff55eeff55",
	keyId: "ABCDEFGHIJ",
	privateKey: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
	environment: "sandbox",
	enableOnlineChecks: false,
	rootCertificatesDir: null,
	...overrides,
});

/** A client whose notification verifier runs `verify`; the API client is never reached. */
function notificationClient(
	environment: AppleBillingEnv["environment"],
	verify: (environment: Environment) => Promise<unknown>,
): AppleStoreKitClient {
	return new AppleStoreKitClient(
		{
			...buildAppleStoreKitConfig(
				appleEnv(
					environment === "production" ? { environment, appAppleId: 1234567890 } : { environment },
				),
			),
			rootCertificates: [Buffer.from("root")],
		},
		{
			createApiClient() {
				return {
					getTransactionInfo: () => Promise.reject(new Error("unused")),
					getAllSubscriptionStatuses: () => Promise.reject(new Error("unused")),
				};
			},
			createVerifier(verifierEnvironment) {
				return {
					verifyAndDecodeTransaction: () => Promise.reject(new Error("unused")),
					verifyAndDecodeRenewalInfo: () => Promise.reject(new Error("unused")),
					verifyAndDecodeNotification: async () => (await verify(verifierEnvironment)) as never,
				};
			},
		},
	);
}

describe("Apple StoreKit client", () => {
	it("maps configured environments to Apple library environments", () => {
		expect(toAppleLibraryEnvironment("sandbox")).toBe(Environment.SANDBOX);
		expect(toAppleLibraryEnvironment("production")).toBe(Environment.PRODUCTION);
	});

	it("requires app Apple ID before building production verifier config", () => {
		expect(() => buildAppleStoreKitConfig(appleEnv({ environment: "production" }))).toThrow(
			"apple.appAppleId is required when apple.environment is production",
		);
	});

	it("loads root certificate files from a configured directory", () => {
		const directory = mkdtempSync(join(tmpdir(), "apple-certs-"));
		try {
			writeFileSync(join(directory, "AppleIncRootCertificate.cer"), "root-1");
			writeFileSync(join(directory, "AppleRootCA-G2.cer"), "root-2");
			writeFileSync(join(directory, "AppleRootCA-G3.cer"), "root-3");

			const certificates = loadAppleRootCertificates(directory);

			expect(certificates.map((certificate) => certificate.toString())).toEqual([
				"root-1",
				"root-2",
				"root-3",
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("constructs production and sandbox runtimes for production configuration", () => {
		const apiEnvironments: Environment[] = [];
		const verifierEnvironments: Environment[] = [];

		new AppleStoreKitClient(
			{
				...buildAppleStoreKitConfig(
					appleEnv({ environment: "production", appAppleId: 1234567890 }),
				),
				rootCertificates: [Buffer.from("root")],
			},
			{
				createApiClient(environment) {
					apiEnvironments.push(environment);
					return {
						getTransactionInfo() {
							return Promise.resolve({ signedTransactionInfo: "signed-transaction" });
						},
						getAllSubscriptionStatuses() {
							return Promise.resolve({});
						},
					};
				},
				createVerifier(environment) {
					verifierEnvironments.push(environment);
					return {
						verifyAndDecodeTransaction() {
							return Promise.resolve({});
						},
						verifyAndDecodeRenewalInfo() {
							return Promise.resolve({});
						},
						verifyAndDecodeNotification() {
							return Promise.resolve({});
						},
					};
				},
			},
		);

		expect(apiEnvironments).toEqual([Environment.PRODUCTION, Environment.SANDBOX]);
		expect(verifierEnvironments).toEqual([Environment.PRODUCTION, Environment.SANDBOX]);
	});

	it("verifies transaction info from App Store Server API signed payloads", async () => {
		const client = new AppleStoreKitClient(
			{
				...buildAppleStoreKitConfig(appleEnv()),
				rootCertificates: [Buffer.from("root")],
			},
			{
				createApiClient() {
					return {
						getTransactionInfo(transactionId) {
							expect(transactionId).toBe("200000000000001");
							return Promise.resolve({ signedTransactionInfo: "signed-transaction" });
						},
						getAllSubscriptionStatuses() {
							return Promise.resolve({});
						},
					};
				},
				createVerifier() {
					return {
						verifyAndDecodeTransaction(signedTransactionInfo) {
							expect(signedTransactionInfo).toBe("signed-transaction");
							return Promise.resolve({
								transactionId: "200000000000001",
								bundleId: "com.acme.app",
								environment: "Sandbox",
							});
						},
						verifyAndDecodeRenewalInfo() {
							return Promise.resolve({});
						},
						verifyAndDecodeNotification() {
							return Promise.resolve({});
						},
					};
				},
			},
		);

		const result = await client.verifyTransaction("200000000000001");

		expect(result.environment).toBe("sandbox");
		expect(result.signedTransactionInfo).toBe("signed-transaction");
		expect(result.transaction.transactionId).toBe("200000000000001");
	});

	it("does not fall back to sandbox transaction lookup after production API lookup failures", async () => {
		const attempts: Environment[] = [];
		const client = new AppleStoreKitClient(
			{
				...buildAppleStoreKitConfig(
					appleEnv({ environment: "production", appAppleId: 1234567890 }),
				),
				rootCertificates: [Buffer.from("root")],
			},
			{
				createApiClient(environment) {
					return {
						getTransactionInfo() {
							attempts.push(environment);
							if (environment === Environment.PRODUCTION) {
								return Promise.reject({ apiError: 4040010 });
							}
							return Promise.resolve({ signedTransactionInfo: "sandbox-transaction" });
						},
						getAllSubscriptionStatuses() {
							return Promise.resolve({});
						},
					};
				},
				createVerifier(environment) {
					return {
						verifyAndDecodeTransaction() {
							return Promise.resolve({
								transactionId: "200000000000001",
								bundleId: "com.acme.app",
								environment,
							});
						},
						verifyAndDecodeRenewalInfo() {
							return Promise.resolve({});
						},
						verifyAndDecodeNotification() {
							return Promise.resolve({});
						},
					};
				},
			},
		);

		await expect(client.verifyTransaction("200000000000001")).rejects.toMatchObject({
			apiError: 4040010,
		});
		expect(attempts).toEqual([Environment.PRODUCTION]);
	});

	it("verifies notification payloads and nested transaction and renewal info", async () => {
		const client = new AppleStoreKitClient(
			{
				...buildAppleStoreKitConfig(appleEnv()),
				rootCertificates: [Buffer.from("root")],
			},
			{
				createApiClient() {
					return {
						getTransactionInfo() {
							return Promise.resolve({ signedTransactionInfo: "signed-transaction" });
						},
						getAllSubscriptionStatuses() {
							return Promise.resolve({});
						},
					};
				},
				createVerifier() {
					return {
						verifyAndDecodeTransaction(signedTransactionInfo) {
							expect(signedTransactionInfo).toBe("nested-transaction");
							return Promise.resolve({ transactionId: "200000000000001" });
						},
						verifyAndDecodeRenewalInfo(signedRenewalInfo) {
							expect(signedRenewalInfo).toBe("nested-renewal");
							return Promise.resolve({ autoRenewStatus: 1 });
						},
						verifyAndDecodeNotification(signedPayload) {
							expect(signedPayload).toBe("signed-notification");
							return Promise.resolve({
								notificationType: "DID_RENEW",
								notificationUUID: "notification_1",
								data: {
									environment: "Sandbox",
									bundleId: "com.acme.app",
									signedTransactionInfo: "nested-transaction",
									signedRenewalInfo: "nested-renewal",
								},
							});
						},
					};
				},
			},
		);

		const result = await client.verifyNotification("signed-notification");

		expect(result.environment).toBe("sandbox");
		expect(result.notification.notificationType).toBe("DID_RENEW");
		expect(result.transaction?.transactionId).toBe("200000000000001");
		expect(result.renewalInfo?.autoRenewStatus).toBe(1);
	});

	it("falls back to sandbox notification verification only for environment mismatches", async () => {
		const attempts: Environment[] = [];
		const client = new AppleStoreKitClient(
			{
				...buildAppleStoreKitConfig(
					appleEnv({ environment: "production", appAppleId: 1234567890 }),
				),
				rootCertificates: [Buffer.from("root")],
			},
			{
				createApiClient() {
					return {
						getTransactionInfo() {
							return Promise.resolve({ signedTransactionInfo: "signed-transaction" });
						},
						getAllSubscriptionStatuses() {
							return Promise.resolve({});
						},
					};
				},
				createVerifier(environment) {
					return {
						verifyAndDecodeTransaction() {
							return Promise.resolve({
								transactionId: "200000000000001",
								environment,
							});
						},
						verifyAndDecodeRenewalInfo() {
							return Promise.resolve({});
						},
						verifyAndDecodeNotification() {
							attempts.push(environment);
							if (environment === Environment.PRODUCTION) {
								throw new VerificationException(VerificationStatus.INVALID_ENVIRONMENT);
							}

							return Promise.resolve({
								notificationType: "DID_RENEW",
								notificationUUID: "notification_1",
								data: {
									environment: "Sandbox",
									bundleId: "com.acme.app",
								},
							});
						},
					};
				},
			},
		);

		const result = await client.verifyNotification("signed-notification");

		expect(attempts).toEqual([Environment.PRODUCTION, Environment.SANDBOX]);
		expect(result.environment).toBe("sandbox");
	});

	it("does not retry sandbox notification verification after certificate failures", async () => {
		const attempts: Environment[] = [];
		const client = new AppleStoreKitClient(
			{
				...buildAppleStoreKitConfig(
					appleEnv({ environment: "production", appAppleId: 1234567890 }),
				),
				rootCertificates: [Buffer.from("root")],
			},
			{
				createApiClient() {
					return {
						getTransactionInfo() {
							return Promise.resolve({ signedTransactionInfo: "signed-transaction" });
						},
						getAllSubscriptionStatuses() {
							return Promise.resolve({});
						},
					};
				},
				createVerifier(environment) {
					return {
						verifyAndDecodeTransaction() {
							return Promise.resolve({});
						},
						verifyAndDecodeRenewalInfo() {
							return Promise.resolve({});
						},
						verifyAndDecodeNotification() {
							attempts.push(environment);
							if (environment === Environment.PRODUCTION) {
								throw new VerificationException(VerificationStatus.INVALID_CERTIFICATE);
							}

							return Promise.resolve({
								notificationType: "DID_RENEW",
								notificationUUID: "notification_1",
								data: {
									environment: "Sandbox",
									bundleId: "com.acme.app",
								},
							});
						},
					};
				},
			},
		);

		await expect(client.verifyNotification("signed-notification")).rejects.toMatchObject({
			code: "APPLE_SIGNED_DATA_INVALID",
			status: 400,
		});
		expect(attempts).toEqual([Environment.PRODUCTION]);
	});

	it("answers every non-retryable notification verification failure as invalid signed data", async () => {
		const statuses = [
			VerificationStatus.VERIFICATION_FAILURE,
			VerificationStatus.INVALID_APP_IDENTIFIER,
			VerificationStatus.INVALID_ENVIRONMENT,
			VerificationStatus.INVALID_CHAIN_LENGTH,
			VerificationStatus.INVALID_CERTIFICATE,
			VerificationStatus.FAILURE,
		];
		for (const status of statuses) {
			const client = notificationClient("sandbox", () => {
				throw new VerificationException(status);
			});

			await expect(client.verifyNotification("signed-notification")).rejects.toMatchObject({
				code: "APPLE_SIGNED_DATA_INVALID",
				status: 400,
				message: "Apple signed data failed verification",
			});
		}
	});

	it("keeps a retryable notification verification failure retryable", async () => {
		const client = notificationClient("sandbox", () => {
			throw new VerificationException(VerificationStatus.RETRYABLE_VERIFICATION_FAILURE);
		});

		await expect(client.verifyNotification("signed-notification")).rejects.toMatchObject({
			code: "BILLING_PROVIDER_UNAVAILABLE",
			status: 503,
		});
	});

	it("answers a notification that also fails sandbox verification as invalid signed data", async () => {
		const attempts: Environment[] = [];
		const client = notificationClient("production", (environment) => {
			attempts.push(environment);
			throw new VerificationException(
				environment === Environment.PRODUCTION
					? VerificationStatus.INVALID_ENVIRONMENT
					: VerificationStatus.VERIFICATION_FAILURE,
			);
		});

		await expect(client.verifyNotification("signed-notification")).rejects.toMatchObject({
			code: "APPLE_SIGNED_DATA_INVALID",
			status: 400,
		});
		expect(attempts).toEqual([Environment.PRODUCTION, Environment.SANDBOX]);
	});

	it("rethrows a notification failure that is not a verification rejection unchanged", async () => {
		const failure = new Error("verifier crashed");
		const client = notificationClient("sandbox", () => {
			throw failure;
		});

		await expect(client.verifyNotification("signed-notification")).rejects.toBe(failure);
	});

	it("gets the latest subscription status transaction and renewal info", async () => {
		const client = new AppleStoreKitClient(
			{
				...buildAppleStoreKitConfig(appleEnv()),
				rootCertificates: [Buffer.from("root")],
			},
			{
				createApiClient() {
					return {
						getTransactionInfo() {
							return Promise.resolve({ signedTransactionInfo: "signed-transaction" });
						},
						getAllSubscriptionStatuses(anyTransactionId) {
							expect(anyTransactionId).toBe("100000000000001");
							return Promise.resolve({
								data: [
									{
										subscriptionGroupIdentifier: "group_1",
										lastTransactions: [
											{
												status: 1,
												originalTransactionId: "100000000000001",
												signedTransactionInfo: "signed-status-transaction",
												signedRenewalInfo: "signed-status-renewal",
											},
										],
									},
								],
							});
						},
					};
				},
				createVerifier() {
					return {
						verifyAndDecodeTransaction(signedTransactionInfo) {
							expect(signedTransactionInfo).toBe("signed-status-transaction");
							return Promise.resolve({
								transactionId: "200000000000002",
								originalTransactionId: "100000000000001",
								bundleId: "com.acme.app",
								environment: "Sandbox",
							});
						},
						verifyAndDecodeRenewalInfo(signedRenewalInfo) {
							expect(signedRenewalInfo).toBe("signed-status-renewal");
							return Promise.resolve({ autoRenewStatus: 1 });
						},
						verifyAndDecodeNotification() {
							return Promise.resolve({});
						},
					};
				},
			},
		);

		const result = await client.getLatestSubscriptionStatus("100000000000001");

		expect(result?.environment).toBe("sandbox");
		expect(result?.signedTransactionInfo).toBe("signed-status-transaction");
		expect(result?.storeKitStatus).toBe(1);
		expect(result?.transaction.transactionId).toBe("200000000000002");
		expect(result?.renewalInfo?.autoRenewStatus).toBe(1);
	});

	it("carries selected App Store subscription status values", async () => {
		for (const storeKitStatus of [3, 4, 5]) {
			const client = new AppleStoreKitClient(
				{
					...buildAppleStoreKitConfig(appleEnv()),
					rootCertificates: [Buffer.from("root")],
				},
				{
					createApiClient() {
						return {
							getTransactionInfo() {
								return Promise.resolve({ signedTransactionInfo: "signed-transaction" });
							},
							getAllSubscriptionStatuses() {
								return Promise.resolve({
									data: [
										{
											lastTransactions: [
												{
													status: storeKitStatus,
													signedTransactionInfo: `signed-status-${storeKitStatus}`,
												},
											],
										},
									],
								});
							},
						};
					},
					createVerifier() {
						return {
							verifyAndDecodeTransaction() {
								return Promise.resolve({
									transactionId: "200000000000002",
									originalTransactionId: "100000000000001",
									bundleId: "com.acme.app",
									environment: "Sandbox",
								});
							},
							verifyAndDecodeRenewalInfo() {
								return Promise.resolve({});
							},
							verifyAndDecodeNotification() {
								return Promise.resolve({});
							},
						};
					},
				},
			);

			const result = await client.getLatestSubscriptionStatus("100000000000001");

			expect(result?.storeKitStatus).toBe(storeKitStatus);
		}
	});

	it("filters subscription status candidates by original transaction and chooses the latest decoded transaction", async () => {
		const decodedTransactions: string[] = [];
		const decodedRenewals: string[] = [];
		const client = new AppleStoreKitClient(
			{
				...buildAppleStoreKitConfig(appleEnv()),
				rootCertificates: [Buffer.from("root")],
			},
			{
				createApiClient() {
					return {
						getTransactionInfo() {
							return Promise.resolve({ signedTransactionInfo: "signed-transaction" });
						},
						getAllSubscriptionStatuses(anyTransactionId) {
							expect(anyTransactionId).toBe("100000000000001");
							return Promise.resolve({
								data: [
									{
										subscriptionGroupIdentifier: "group_1",
										lastTransactions: [
											{
												originalTransactionId: "999999999999999",
												signedTransactionInfo: "signed-unrelated",
												signedRenewalInfo: "renewal-unrelated",
											},
											{
												originalTransactionId: "100000000000001",
												signedTransactionInfo: "signed-matching-old",
												signedRenewalInfo: "renewal-old",
											},
											{
												originalTransactionId: "100000000000001",
												signedTransactionInfo: "signed-matching-new",
												signedRenewalInfo: "renewal-new",
											},
										],
									},
								],
							});
						},
					};
				},
				createVerifier() {
					return {
						verifyAndDecodeTransaction(signedTransactionInfo) {
							decodedTransactions.push(signedTransactionInfo);
							const transactions = {
								"signed-unrelated": {
									transactionId: "200000000009999",
									originalTransactionId: "999999999999999",
									bundleId: "com.acme.app",
									environment: "Sandbox",
									purchaseDate: Date.parse("2026-07-01T00:00:00.000Z"),
									expiresDate: Date.parse("2026-08-01T00:00:00.000Z"),
								},
								"signed-matching-old": {
									transactionId: "200000000000001",
									originalTransactionId: "100000000000001",
									bundleId: "com.acme.app",
									environment: "Sandbox",
									purchaseDate: Date.parse("2026-05-31T00:00:00.000Z"),
									expiresDate: Date.parse("2026-06-30T00:00:00.000Z"),
								},
								"signed-matching-new": {
									transactionId: "200000000000002",
									originalTransactionId: "100000000000001",
									bundleId: "com.acme.app",
									environment: "Sandbox",
									purchaseDate: Date.parse("2026-06-30T00:00:00.000Z"),
									expiresDate: Date.parse("2026-07-31T00:00:00.000Z"),
								},
							};
							return Promise.resolve(
								transactions[signedTransactionInfo as keyof typeof transactions],
							);
						},
						verifyAndDecodeRenewalInfo(signedRenewalInfo) {
							decodedRenewals.push(signedRenewalInfo);
							return Promise.resolve({ autoRenewStatus: 1 });
						},
						verifyAndDecodeNotification() {
							return Promise.resolve({});
						},
					};
				},
			},
		);

		const result = await client.getLatestSubscriptionStatus("100000000000001");

		expect(decodedTransactions).toEqual([
			"signed-unrelated",
			"signed-matching-old",
			"signed-matching-new",
		]);
		expect(decodedRenewals).toEqual(["renewal-new"]);
		expect(result?.signedTransactionInfo).toBe("signed-matching-new");
		expect(result?.transaction.transactionId).toBe("200000000000002");
	});

	it("uses deterministic tie breakers when subscription status candidates have equal dates", async () => {
		const client = new AppleStoreKitClient(
			{
				...buildAppleStoreKitConfig(appleEnv()),
				rootCertificates: [Buffer.from("root")],
			},
			{
				createApiClient() {
					return {
						getTransactionInfo() {
							return Promise.resolve({ signedTransactionInfo: "signed-transaction" });
						},
						getAllSubscriptionStatuses() {
							return Promise.resolve({
								data: [
									{
										lastTransactions: [
											{
												signedTransactionInfo: "signed-higher",
											},
											{
												signedTransactionInfo: "signed-lower",
											},
										],
									},
								],
							});
						},
					};
				},
				createVerifier() {
					return {
						verifyAndDecodeTransaction(signedTransactionInfo) {
							const transactions = {
								"signed-lower": {
									transactionId: "90071992547409930001",
									originalTransactionId: "100000000000001",
									webOrderLineItemId: "90071992547409940001",
									bundleId: "com.acme.app",
									environment: "Sandbox",
									purchaseDate: Date.parse("2026-05-31T00:00:00.000Z"),
									expiresDate: Date.parse("2026-06-30T00:00:00.000Z"),
								},
								"signed-higher": {
									transactionId: "90071992547409930002",
									originalTransactionId: "100000000000001",
									webOrderLineItemId: "90071992547409940002",
									bundleId: "com.acme.app",
									environment: "Sandbox",
									purchaseDate: Date.parse("2026-05-31T00:00:00.000Z"),
									expiresDate: Date.parse("2026-06-30T00:00:00.000Z"),
								},
							};
							return Promise.resolve(
								transactions[signedTransactionInfo as keyof typeof transactions],
							);
						},
						verifyAndDecodeRenewalInfo() {
							return Promise.resolve({});
						},
						verifyAndDecodeNotification() {
							return Promise.resolve({});
						},
					};
				},
			},
		);

		const result = await client.getLatestSubscriptionStatus("100000000000001");

		expect(result?.signedTransactionInfo).toBe("signed-higher");
		expect(result?.transaction.transactionId).toBe("90071992547409930002");
	});

	it("uses web order line item as a deterministic tie breaker when transaction ids match", async () => {
		const client = new AppleStoreKitClient(
			{
				...buildAppleStoreKitConfig(appleEnv()),
				rootCertificates: [Buffer.from("root")],
			},
			{
				createApiClient() {
					return {
						getTransactionInfo() {
							return Promise.resolve({ signedTransactionInfo: "signed-transaction" });
						},
						getAllSubscriptionStatuses() {
							return Promise.resolve({
								data: [
									{
										lastTransactions: [
											{
												signedTransactionInfo: "signed-higher-web-order",
											},
											{
												signedTransactionInfo: "signed-lower-web-order",
											},
										],
									},
								],
							});
						},
					};
				},
				createVerifier() {
					return {
						verifyAndDecodeTransaction(signedTransactionInfo) {
							const transactions = {
								"signed-lower-web-order": {
									transactionId: "90071992547409930001",
									originalTransactionId: "100000000000001",
									webOrderLineItemId: "90071992547409940001",
									bundleId: "com.acme.app",
									environment: "Sandbox",
									purchaseDate: Date.parse("2026-05-31T00:00:00.000Z"),
									expiresDate: Date.parse("2026-06-30T00:00:00.000Z"),
								},
								"signed-higher-web-order": {
									transactionId: "90071992547409930001",
									originalTransactionId: "100000000000001",
									webOrderLineItemId: "90071992547409940002",
									bundleId: "com.acme.app",
									environment: "Sandbox",
									purchaseDate: Date.parse("2026-05-31T00:00:00.000Z"),
									expiresDate: Date.parse("2026-06-30T00:00:00.000Z"),
								},
							};
							return Promise.resolve(
								transactions[signedTransactionInfo as keyof typeof transactions],
							);
						},
						verifyAndDecodeRenewalInfo() {
							return Promise.resolve({});
						},
						verifyAndDecodeNotification() {
							return Promise.resolve({});
						},
					};
				},
			},
		);

		const result = await client.getLatestSubscriptionStatus("100000000000001");

		expect(result?.signedTransactionInfo).toBe("signed-higher-web-order");
		expect(result?.transaction.webOrderLineItemId).toBe("90071992547409940002");
	});

	it("returns null when subscription status has no signed transaction for the requested original transaction", async () => {
		const client = new AppleStoreKitClient(
			{
				...buildAppleStoreKitConfig(appleEnv()),
				rootCertificates: [Buffer.from("root")],
			},
			{
				createApiClient() {
					return {
						getTransactionInfo() {
							return Promise.resolve({ signedTransactionInfo: "signed-transaction" });
						},
						getAllSubscriptionStatuses() {
							return Promise.resolve({
								data: [
									{
										lastTransactions: [
											{
												signedTransactionInfo: "signed-unrelated",
											},
										],
									},
								],
							});
						},
					};
				},
				createVerifier() {
					return {
						verifyAndDecodeTransaction() {
							return Promise.resolve({
								transactionId: "200000000009999",
								originalTransactionId: "999999999999999",
								bundleId: "com.acme.app",
								environment: "Sandbox",
							});
						},
						verifyAndDecodeRenewalInfo() {
							return Promise.resolve({});
						},
						verifyAndDecodeNotification() {
							return Promise.resolve({});
						},
					};
				},
			},
		);

		await expect(client.getLatestSubscriptionStatus("100000000000001")).resolves.toBeNull();
	});

	it("returns null when subscription status has no signed transactions", async () => {
		const client = new AppleStoreKitClient(
			{
				...buildAppleStoreKitConfig(appleEnv()),
				rootCertificates: [Buffer.from("root")],
			},
			{
				createApiClient() {
					return {
						getTransactionInfo() {
							return Promise.resolve({ signedTransactionInfo: "signed-transaction" });
						},
						getAllSubscriptionStatuses() {
							return Promise.resolve({
								data: [{ subscriptionGroupIdentifier: "group_1", lastTransactions: [] }],
							});
						},
					};
				},
				createVerifier() {
					return {
						verifyAndDecodeTransaction() {
							return Promise.resolve({});
						},
						verifyAndDecodeRenewalInfo() {
							return Promise.resolve({});
						},
						verifyAndDecodeNotification() {
							return Promise.resolve({});
						},
					};
				},
			},
		);

		await expect(client.getLatestSubscriptionStatus("100000000000001")).resolves.toBeNull();
	});

	it("does not fall back to sandbox subscription status lookup after production API lookup failures", async () => {
		const attempts: Environment[] = [];
		const client = new AppleStoreKitClient(
			{
				...buildAppleStoreKitConfig(
					appleEnv({ environment: "production", appAppleId: 1234567890 }),
				),
				rootCertificates: [Buffer.from("root")],
			},
			{
				createApiClient(environment) {
					return {
						getTransactionInfo() {
							return Promise.resolve({ signedTransactionInfo: "signed-transaction" });
						},
						getAllSubscriptionStatuses() {
							attempts.push(environment);
							if (environment === Environment.PRODUCTION) {
								return Promise.reject({ apiError: 4040005 });
							}
							return Promise.resolve({
								data: [
									{
										lastTransactions: [
											{
												signedTransactionInfo: "sandbox-status-transaction",
											},
										],
									},
								],
							});
						},
					};
				},
				createVerifier(environment) {
					return {
						verifyAndDecodeTransaction() {
							return Promise.resolve({
								transactionId: "200000000000001",
								originalTransactionId: "100000000000001",
								bundleId: "com.acme.app",
								environment,
							});
						},
						verifyAndDecodeRenewalInfo() {
							return Promise.resolve({});
						},
						verifyAndDecodeNotification() {
							return Promise.resolve({});
						},
					};
				},
			},
		);

		await expect(client.getLatestSubscriptionStatus("100000000000001")).rejects.toMatchObject({
			apiError: 4040005,
		});
		expect(attempts).toEqual([Environment.PRODUCTION]);
	});
});
