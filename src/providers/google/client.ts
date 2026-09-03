import { androidpublisher, type androidpublisher_v3 } from "@googleapis/androidpublisher";
import { GoogleAuth } from "google-auth-library";
import { BillingError } from "../../billing/errors";

export { buildGooglePlayConfig, type GooglePlayConfig } from "./config";

import type { GooglePlayConfig } from "./config";

export interface GooglePlayPublisherLike {
	purchases: {
		subscriptionsv2?: {
			get(
				args: Record<string, unknown>,
			): Promise<{ data: androidpublisher_v3.Schema$SubscriptionPurchaseV2 }>;
		};
		subscriptions?: {
			acknowledge(args: Record<string, unknown>): Promise<{ data: unknown }>;
		};
		productsv2?: {
			getproductpurchasev2(
				args: Record<string, unknown>,
			): Promise<{ data: androidpublisher_v3.Schema$ProductPurchaseV2 }>;
		};
		products?: {
			acknowledge(args: Record<string, unknown>): Promise<{ data: unknown }>;
			consume(args: Record<string, unknown>): Promise<{ data: unknown }>;
		};
	};
}

export type GooglePlayPublisherFactory = (
	config: GooglePlayConfig,
) => Promise<GooglePlayPublisherLike>;

export class GooglePlayDeveloperClient {
	private publisherPromise: Promise<GooglePlayPublisherLike> | null = null;

	constructor(
		private readonly config: GooglePlayConfig,
		private readonly publisherFactory: GooglePlayPublisherFactory = createDefaultPublisher,
	) {}

	async getSubscriptionPurchase(
		token: string,
	): Promise<androidpublisher_v3.Schema$SubscriptionPurchaseV2> {
		return this.call(
			false,
			async (publisher) =>
				(
					await requireResource(publisher.purchases.subscriptionsv2, "subscriptionsv2").get({
						packageName: this.config.packageName,
						token,
					})
				).data,
		);
	}

	async acknowledgeSubscriptionPurchase(
		subscriptionId: string,
		token: string,
		obfuscatedAccountId: string,
	): Promise<void> {
		await this.call(true, async (publisher) =>
			requireResource(publisher.purchases.subscriptions, "subscriptions").acknowledge({
				packageName: this.config.packageName,
				subscriptionId,
				token,
				requestBody: { developerPayload: obfuscatedAccountId },
			}),
		);
	}

	async getProductPurchase(token: string): Promise<androidpublisher_v3.Schema$ProductPurchaseV2> {
		return this.call(
			false,
			async (publisher) =>
				(
					await requireResource(publisher.purchases.productsv2, "productsv2").getproductpurchasev2({
						packageName: this.config.packageName,
						token,
					})
				).data,
		);
	}

	async acknowledgeProductPurchase(productId: string, token: string): Promise<void> {
		await this.call(true, async (publisher) =>
			requireResource(publisher.purchases.products, "products").acknowledge({
				packageName: this.config.packageName,
				productId,
				token,
				requestBody: {},
			}),
		);
	}

	async consumeProductPurchase(productId: string, token: string): Promise<void> {
		await this.call(true, async (publisher) =>
			requireResource(publisher.purchases.products, "products").consume({
				packageName: this.config.packageName,
				productId,
				token,
			}),
		);
	}

	private async call<T>(
		mutation: boolean,
		run: (publisher: GooglePlayPublisherLike) => Promise<T>,
	): Promise<T> {
		try {
			return await run(await this.publisher());
		} catch (error) {
			throw toGooglePlayError(error, mutation);
		}
	}

	private publisher(): Promise<GooglePlayPublisherLike> {
		this.publisherPromise ??= this.publisherFactory(this.config).catch((error) => {
			this.publisherPromise = null;
			throw error;
		});
		return this.publisherPromise;
	}
}

async function createDefaultPublisher(config: GooglePlayConfig): Promise<GooglePlayPublisherLike> {
	const auth = new GoogleAuth({
		credentials: config.serviceAccountCredentials,
		scopes: ["https://www.googleapis.com/auth/androidpublisher"],
	});

	return androidpublisher({
		version: "v3",
		auth,
	}) as GooglePlayPublisherLike;
}

function requireResource<T>(resource: T | undefined, name: string): T {
	if (resource === undefined) {
		throw new Error(`Google Play publisher resource is missing: ${name}`);
	}

	return resource;
}

function toGooglePlayError(error: unknown, mutation: boolean): Error {
	if (error instanceof BillingError) {
		return error;
	}

	if (isGoogleNotFound(error)) {
		return new BillingError(
			"Google Play purchase was not found",
			"GOOGLE_PLAY_PURCHASE_NOT_FOUND",
			404,
		);
	}

	if (mutation) {
		return new BillingError(
			"Google Play purchase mutation failed",
			"GOOGLE_PLAY_MUTATION_FAILED",
			502,
		);
	}

	return new BillingError(
		"Google Play Developer API is unavailable",
		"GOOGLE_PLAY_API_UNAVAILABLE",
		502,
	);
}

function isGoogleNotFound(error: unknown): boolean {
	if (typeof error !== "object" || error === null) {
		return false;
	}

	const raw = error as { code?: unknown; status?: unknown; response?: { status?: unknown } };
	return raw.code === 404 || raw.status === 404 || raw.response?.status === 404;
}
