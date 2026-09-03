import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AppStoreServerAPIClient,
	Environment,
	type JWSRenewalInfoDecodedPayload,
	type JWSTransactionDecodedPayload,
	type ResponseBodyV2DecodedPayload,
	SignedDataVerifier,
	type StatusResponse,
	type TransactionInfoResponse,
	VerificationException,
	VerificationStatus,
} from "@apple/app-store-server-library";
import type { AppleBillingEnv } from "../../env";
import type {
	AppleDecodedNotificationPayload,
	AppleDecodedRenewalInfoPayload,
	AppleDecodedTransactionPayload,
	AppleEnvironmentName,
} from "./types";

export const appleRootCertificateFilenames = [
	"AppleIncRootCertificate.cer",
	"AppleRootCA-G2.cer",
	"AppleRootCA-G3.cer",
] as const;

export interface AppleStoreKitConfig {
	bundleId: string;
	appAppleId: number | undefined;
	issuerId: string;
	keyId: string;
	privateKey: string;
	environmentName: AppleEnvironmentName;
	enableOnlineChecks: boolean;
	rootCertificates: Buffer[];
}

export interface AppleServerApiClientLike {
	getTransactionInfo(transactionId: string): Promise<TransactionInfoResponse>;
	getAllSubscriptionStatuses(anyTransactionId: string): Promise<StatusResponse>;
}

export interface AppleSignedDataVerifierLike {
	verifyAndDecodeTransaction(
		signedTransactionInfo: string,
	): Promise<JWSTransactionDecodedPayload | AppleDecodedTransactionPayload>;
	verifyAndDecodeRenewalInfo(
		signedRenewalInfo: string,
	): Promise<JWSRenewalInfoDecodedPayload | AppleDecodedRenewalInfoPayload>;
	verifyAndDecodeNotification(
		signedPayload: string,
	): Promise<ResponseBodyV2DecodedPayload | AppleDecodedNotificationPayload>;
}

export interface AppleStoreKitClientFactories {
	createApiClient(environment: Environment): AppleServerApiClientLike;
	createVerifier(environment: Environment): AppleSignedDataVerifierLike;
}

export interface VerifiedStoreKitTransaction {
	environment: AppleEnvironmentName;
	signedTransactionInfo: string;
	transaction: AppleDecodedTransactionPayload;
	renewalInfo: AppleDecodedRenewalInfoPayload | null;
	storeKitStatus: number | null;
}

export interface VerifiedStoreKitNotification {
	environment: AppleEnvironmentName;
	notification: AppleDecodedNotificationPayload;
	transaction: AppleDecodedTransactionPayload | null;
	renewalInfo: AppleDecodedRenewalInfoPayload | null;
}

interface AppleRuntime {
	environmentName: AppleEnvironmentName;
	apiClient: AppleServerApiClientLike;
	verifier: AppleSignedDataVerifierLike;
}

const defaultCertificateDirectory = join(dirname(fileURLToPath(import.meta.url)), "certs");

export function toAppleLibraryEnvironment(environment: AppleEnvironmentName): Environment {
	return environment === "sandbox" ? Environment.SANDBOX : Environment.PRODUCTION;
}

export function buildAppleStoreKitConfig(env: AppleBillingEnv): AppleStoreKitConfig {
	if (env.environment === "production" && env.appAppleId === null) {
		throw new Error("apple.appAppleId is required when apple.environment is production");
	}

	return {
		bundleId: env.bundleId,
		appAppleId: env.appAppleId ?? undefined,
		issuerId: env.issuerId,
		keyId: env.keyId,
		privateKey: env.privateKey,
		environmentName: env.environment,
		enableOnlineChecks: env.enableOnlineChecks,
		rootCertificates: loadAppleRootCertificates(
			env.rootCertificatesDir ?? defaultCertificateDirectory,
		),
	};
}

export function loadAppleRootCertificates(directory: string): Buffer[] {
	if (!existsSync(directory)) {
		throw new Error(`Apple root certificate directory was not found: ${directory}`);
	}

	const configuredCertificates = new Set(appleRootCertificateFilenames);
	const files = readdirSync(directory)
		.filter((file) =>
			configuredCertificates.has(file as (typeof appleRootCertificateFilenames)[number]),
		)
		.sort(
			(left, right) =>
				appleRootCertificateFilenames.indexOf(
					left as (typeof appleRootCertificateFilenames)[number],
				) -
				appleRootCertificateFilenames.indexOf(
					right as (typeof appleRootCertificateFilenames)[number],
				),
		);

	if (files.length !== appleRootCertificateFilenames.length) {
		throw new Error(`Apple root certificate directory is incomplete: ${directory}`);
	}

	return files.map((file) => readFileSync(join(directory, file)));
}

export class AppleStoreKitClient {
	private readonly primaryRuntime: AppleRuntime;
	private readonly sandboxRuntime: AppleRuntime | null;

	constructor(config: AppleStoreKitConfig, factories?: AppleStoreKitClientFactories) {
		const clientFactories = factories ?? createDefaultFactories(config);
		this.primaryRuntime = createRuntime(config.environmentName, clientFactories);
		this.sandboxRuntime =
			config.environmentName === "production" ? createRuntime("sandbox", clientFactories) : null;
	}

	async verifyTransaction(transactionId: string): Promise<VerifiedStoreKitTransaction> {
		try {
			return await this.verifyTransactionWithRuntime(this.primaryRuntime, transactionId);
		} catch (error) {
			if (this.sandboxRuntime && isSandboxFallbackError(error)) {
				return this.verifyTransactionWithRuntime(this.sandboxRuntime, transactionId);
			}

			throw error;
		}
	}

	async getLatestSubscriptionStatus(
		originalTransactionId: string,
	): Promise<VerifiedStoreKitTransaction | null> {
		try {
			return await this.getLatestSubscriptionStatusWithRuntime(
				this.primaryRuntime,
				originalTransactionId,
			);
		} catch (error) {
			if (this.sandboxRuntime && isSandboxFallbackError(error)) {
				return this.getLatestSubscriptionStatusWithRuntime(
					this.sandboxRuntime,
					originalTransactionId,
				);
			}

			throw error;
		}
	}

	async verifyNotification(signedPayload: string): Promise<VerifiedStoreKitNotification> {
		try {
			return await this.verifyNotificationWithRuntime(this.primaryRuntime, signedPayload);
		} catch (error) {
			if (this.sandboxRuntime && isSandboxFallbackError(error)) {
				return this.verifyNotificationWithRuntime(this.sandboxRuntime, signedPayload);
			}

			throw error;
		}
	}

	private async verifyTransactionWithRuntime(
		runtime: AppleRuntime,
		transactionId: string,
	): Promise<VerifiedStoreKitTransaction> {
		const response = await runtime.apiClient.getTransactionInfo(transactionId);
		const signedTransactionInfo = response.signedTransactionInfo;

		if (!signedTransactionInfo) {
			throw new Error("Apple transaction response did not include signedTransactionInfo");
		}

		const transaction = await runtime.verifier.verifyAndDecodeTransaction(signedTransactionInfo);

		return {
			environment: runtime.environmentName,
			signedTransactionInfo,
			transaction: transaction as AppleDecodedTransactionPayload,
			renewalInfo: null,
			storeKitStatus: null,
		};
	}

	private async getLatestSubscriptionStatusWithRuntime(
		runtime: AppleRuntime,
		originalTransactionId: string,
	): Promise<VerifiedStoreKitTransaction | null> {
		const response = await runtime.apiClient.getAllSubscriptionStatuses(originalTransactionId);
		const statusTransaction = await latestAppleStatusTransaction(
			response,
			originalTransactionId,
			runtime.verifier,
		);

		if (statusTransaction === null) {
			return null;
		}

		const renewalInfo = statusTransaction.signedRenewalInfo
			? await runtime.verifier.verifyAndDecodeRenewalInfo(statusTransaction.signedRenewalInfo)
			: null;

		return {
			environment: runtime.environmentName,
			signedTransactionInfo: statusTransaction.signedTransactionInfo,
			transaction: statusTransaction.transaction,
			renewalInfo: renewalInfo as AppleDecodedRenewalInfoPayload | null,
			storeKitStatus: statusTransaction.storeKitStatus,
		};
	}

	private async verifyNotificationWithRuntime(
		runtime: AppleRuntime,
		signedPayload: string,
	): Promise<VerifiedStoreKitNotification> {
		const notification = (await runtime.verifier.verifyAndDecodeNotification(
			signedPayload,
		)) as ResponseBodyV2DecodedPayload;
		const signedTransactionInfo = notification.data?.signedTransactionInfo;
		const signedRenewalInfo = notification.data?.signedRenewalInfo;
		const transaction = signedTransactionInfo
			? await runtime.verifier.verifyAndDecodeTransaction(signedTransactionInfo)
			: null;
		const renewalInfo = signedRenewalInfo
			? await runtime.verifier.verifyAndDecodeRenewalInfo(signedRenewalInfo)
			: null;

		return {
			environment: runtime.environmentName,
			notification: toDecodedNotification(notification),
			transaction: transaction as AppleDecodedTransactionPayload | null,
			renewalInfo: renewalInfo as AppleDecodedRenewalInfoPayload | null,
		};
	}
}

interface AppleStatusTransactionCandidate {
	signedTransactionInfo: string;
	signedRenewalInfo: string | undefined;
	transaction: AppleDecodedTransactionPayload;
	storeKitStatus: number | null;
}

async function latestAppleStatusTransaction(
	response: StatusResponse,
	originalTransactionId: string,
	verifier: AppleSignedDataVerifierLike,
): Promise<AppleStatusTransactionCandidate | null> {
	const candidates: AppleStatusTransactionCandidate[] = [];

	for (const subscriptionGroup of response.data ?? []) {
		for (const statusTransaction of subscriptionGroup.lastTransactions ?? []) {
			if (!statusTransaction.signedTransactionInfo) {
				continue;
			}

			const transaction = (await verifier.verifyAndDecodeTransaction(
				statusTransaction.signedTransactionInfo,
			)) as AppleDecodedTransactionPayload;
			if (transaction.originalTransactionId !== originalTransactionId) {
				continue;
			}

			candidates.push({
				signedTransactionInfo: statusTransaction.signedTransactionInfo,
				signedRenewalInfo: statusTransaction.signedRenewalInfo,
				transaction,
				storeKitStatus: normalizeStoreKitStatus(statusTransaction.status),
			});
		}
	}

	const sortedCandidates = [...candidates].sort(compareAppleStatusCandidates);
	return sortedCandidates[sortedCandidates.length - 1] ?? null;
}

function compareAppleStatusCandidates(
	left: AppleStatusTransactionCandidate,
	right: AppleStatusTransactionCandidate,
): number {
	const expiresDiff = (left.transaction.expiresDate ?? 0) - (right.transaction.expiresDate ?? 0);
	if (expiresDiff !== 0) {
		return expiresDiff;
	}

	const purchaseDiff = (left.transaction.purchaseDate ?? 0) - (right.transaction.purchaseDate ?? 0);
	if (purchaseDiff !== 0) {
		return purchaseDiff;
	}

	const transactionIdDiff = compareAppleNumericIdentifier(
		left.transaction.transactionId,
		right.transaction.transactionId,
	);
	if (transactionIdDiff !== 0) {
		return transactionIdDiff;
	}

	const webOrderDiff = compareAppleNumericIdentifier(
		left.transaction.webOrderLineItemId,
		right.transaction.webOrderLineItemId,
	);
	if (webOrderDiff !== 0) {
		return webOrderDiff;
	}

	return left.signedTransactionInfo.localeCompare(right.signedTransactionInfo);
}

function compareAppleNumericIdentifier(
	left: string | undefined,
	right: string | undefined,
): number {
	if (left === undefined && right === undefined) {
		return 0;
	}

	if (left === undefined) {
		return -1;
	}

	if (right === undefined) {
		return 1;
	}

	const leftNormalized = normalizeAppleNumericIdentifier(left);
	const rightNormalized = normalizeAppleNumericIdentifier(right);
	if (leftNormalized.length !== rightNormalized.length) {
		return leftNormalized.length - rightNormalized.length;
	}

	return leftNormalized.localeCompare(rightNormalized);
}

function normalizeAppleNumericIdentifier(value: string): string {
	const trimmed = value.trim();
	const normalized = trimmed.replace(/^0+/, "");
	return normalized === "" ? "0" : normalized;
}

function normalizeStoreKitStatus(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}

	return null;
}

function createDefaultFactories(config: AppleStoreKitConfig): AppleStoreKitClientFactories {
	return {
		createApiClient(environment) {
			return new AppStoreServerAPIClient(
				config.privateKey,
				config.keyId,
				config.issuerId,
				config.bundleId,
				environment,
			);
		},
		createVerifier(environment) {
			return new SignedDataVerifier(
				config.rootCertificates,
				config.enableOnlineChecks,
				environment,
				config.bundleId,
				environment === Environment.PRODUCTION ? config.appAppleId : undefined,
			);
		},
	};
}

function createRuntime(
	environmentName: AppleEnvironmentName,
	factories: AppleStoreKitClientFactories,
): AppleRuntime {
	const environment = toAppleLibraryEnvironment(environmentName);

	return {
		environmentName,
		apiClient: factories.createApiClient(environment),
		verifier: factories.createVerifier(environment),
	};
}

function toDecodedNotification(
	notification: ResponseBodyV2DecodedPayload,
): AppleDecodedNotificationPayload {
	if (!notification.notificationType || !notification.notificationUUID) {
		throw new Error("Apple notification payload is missing required fields");
	}

	return {
		notificationType: String(notification.notificationType),
		subtype: notification.subtype === undefined ? undefined : String(notification.subtype),
		notificationUUID: notification.notificationUUID,
		data:
			notification.data === undefined
				? undefined
				: {
						bundleId: notification.data.bundleId,
						environment: notification.data
							.environment as AppleDecodedNotificationPayload["data"] extends {
							environment?: infer EnvironmentValue;
						}
							? EnvironmentValue
							: never,
						status:
							typeof notification.data.status === "number" ? notification.data.status : undefined,
					},
	};
}

function isSandboxFallbackError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}

	if (
		error instanceof VerificationException &&
		error.status === VerificationStatus.INVALID_ENVIRONMENT
	) {
		return true;
	}

	return false;
}
