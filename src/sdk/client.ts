import type {
	AdminCustomerDetail,
	AdminCustomerSearchResult,
	AdminProjectionJob,
	AdminStatsSummary,
	AdminStoreEvent,
} from "../admin/types";
import type { AppleOfferInput, ApplePromotionAction } from "../billing/apple-promotions";
import type {
	AdministrativeDebitMutationResult,
	AdministrativeDebitRecord,
	OperatorGrantMutationResult,
	OperatorGrantRecord,
} from "../billing/balance-adjustments";
import type {
	CommercialActionExecutionResult,
	CommercialActionIntent,
	CommercialActionPreview,
} from "../billing/commercial";
import type { EffectiveControl } from "../billing/controls";
import type { CustomerBillingSummary, UsageEventItem, UsageSeriesPoint } from "../billing/insights";
import type {
	ConfirmReservationInput,
	FinalizeReservationResult,
	MeteringBalance,
	MeteringSubjectInput,
	ReleaseReservationInput,
	ReservationResult,
	ReserveUsageInput,
} from "../billing/metering";
import type { PaymentSetupSession } from "../billing/payment-setup";
import type { TrialEligibility, TrialMutationResult, TrialRecord } from "../billing/plan-grants";
import type {
	CreatePromotionInput,
	PromotionChannel,
	PromotionCodeInput,
	PromotionCodeRecord,
	PromotionRecord,
	PromotionRedeemResult,
	PromotionRedemptionRecord,
	PromotionRedemptionStatus,
	PromotionRevokeResult,
	PromotionTarget,
	PromotionValidation,
} from "../billing/promotions";
import type { ProviderOperationReceipt } from "../billing/provider-operations";
import type {
	BillingChannel,
	BillingProvider,
	EntitlementSnapshot,
	ProjectionSyncReason,
	ProjectionSyncStatus,
	StoreEventProcessingStatus,
} from "../billing/types";
import type {
	UsageCheckInput,
	UsageCheckResult,
	UsageConsumeInput,
	UsageConsumeResult,
} from "../billing/usage-api";
import type {
	UsageOperationLookupInput,
	UsageOperationLookupResult,
} from "../billing/usage-operations";
import type {
	AuthoredCatalogIntent,
	CatalogPreview,
	CatalogPublishResult,
	PublishedCatalog,
} from "../catalog/types";
import type { AppleVerifyPurchaseInput } from "../providers/apple/types";
import type {
	BillingAccountAvailableActions,
	ProviderEnvironmentCapabilities,
} from "../providers/capability-read-types";
import type { GoogleVerifyPurchaseInput } from "../providers/google/types";
import type { StripeCatalog } from "../providers/stripe/types";

export interface BillingClientOptions {
	baseUrl: string;
	apiKey?: string;
	projectKey?: string;
	operatorKey?: string;
	actor?: string;
	fetch?: BillingFetch;
}

export type BillingFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type PurchaseVerificationInput =
	| ({ provider: "apple" } & AppleVerifyPurchaseInput)
	| ({ provider: "google" } & GoogleVerifyPurchaseInput);

export interface CursorPage<T> {
	data: T[];
	nextCursor: string | null;
}

/** Filters shared by the project-wide admin lists, named as they appear in the query string. */
export interface AdminListQuery {
	provider?: BillingProvider;
	channel?: BillingChannel;
	billingAccountId?: string;
	customerId?: string;
	productKey?: string;
	entitlementKey?: string;
	from?: string;
	to?: string;
	limit?: number;
	cursor?: string;
}

export interface AdminStoreEventQuery extends AdminListQuery {
	processingStatus?: StoreEventProcessingStatus;
	eventType?: string;
	externalEventId?: string;
}

export interface AdminProjectionJobQuery extends AdminListQuery {
	status?: ProjectionSyncStatus;
	reason?: ProjectionSyncReason;
}

export interface AdminStatsSummaryQuery {
	provider?: BillingProvider;
	channel?: BillingChannel;
	from?: string;
	to?: string;
}

export class BillingClient {
	readonly catalog;
	readonly accounts;
	readonly commercial;
	readonly usage;
	readonly purchases;
	readonly promotions;
	readonly trials;
	readonly adjustments;
	readonly providers;
	readonly admin;

	private readonly baseUrl: string;
	private readonly requestFetch: BillingFetch;

	constructor(private readonly options: BillingClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.requestFetch = options.fetch ?? globalThis.fetch;
		if (typeof this.requestFetch !== "function")
			throw new Error("A fetch implementation is required");
		this.catalog = {
			/** The purchasable Stripe catalog; `STRIPE_NOT_CONFIGURED` without a Stripe connection. */
			get: () => this.request<StripeCatalog>("/v1/catalog"),
			/** The versioned catalog. Project authentication only; publishing still needs the operator key. */
			status: () => this.request<PublishedCatalog>("/v1/admin/catalog"),
			preview: (input: { expectedRevision: number | null; catalog: AuthoredCatalogIntent }) =>
				this.request<CatalogPreview>("/v1/admin/catalog/preview", {
					method: "POST",
					body: input,
					operator: true,
				}),
			publish: (input: {
				expectedRevision: number | null;
				previewToken: string;
				catalog: AuthoredCatalogIntent;
			}) =>
				this.request<CatalogPublishResult>("/v1/admin/catalog/publish", {
					method: "POST",
					body: input,
					operator: true,
				}),
		};
		this.accounts = {
			controls: (billingAccountId: string, entityId?: string) =>
				this.request<EffectiveControl[]>(
					pathWithQuery(`/v1/billing-accounts/${segment(billingAccountId)}/controls`, {
						entityId,
					}),
				),
		};
		this.commercial = {
			createPaddleCheckout: (
				billingAccountId: string,
				input: { productKey: string; email?: string },
				idempotencyKey: string,
			) =>
				this.request<{ sessionId: string; url: string; duplicate: boolean }>(
					`/v1/billing-accounts/${segment(billingAccountId)}/providers/paddle/checkout-sessions`,
					{ method: "POST", body: input, idempotencyKey },
				),
			reconcileOperation: (billingAccountId: string, operationId: string) =>
				this.request<ProviderOperationReceipt>(
					`/v1/admin/billing-accounts/${segment(billingAccountId)}/provider-operations/${segment(operationId)}/reconcile`,
					{ method: "POST", operator: true },
				),
			getOperation: (billingAccountId: string, operationId: string) =>
				this.request<ProviderOperationReceipt>(
					`/v1/billing-accounts/${segment(billingAccountId)}/provider-operations/${segment(operationId)}`,
				),
			preview: (
				billingAccountId: string,
				intent: CommercialActionIntent,
				provider?: "stripe" | "paddle",
			) =>
				this.request<CommercialActionPreview>(
					`/v1/billing-accounts/${segment(billingAccountId)}/commercial-actions/preview`,
					{ method: "POST", body: { intent, ...(provider === undefined ? {} : { provider }) } },
				),
			execute: (billingAccountId: string, previewToken: string, idempotencyKey: string) =>
				this.request<CommercialActionExecutionResult>(
					`/v1/billing-accounts/${segment(billingAccountId)}/commercial-actions`,
					{ method: "POST", body: { previewToken }, idempotencyKey },
				),
			availableActions: (billingAccountId: string) =>
				this.request<BillingAccountAvailableActions>(
					`/v1/billing-accounts/${segment(billingAccountId)}/available-actions`,
				),
			/**
			 * The persisted state of one hosted payment-method setup. While the setup is open the
			 * response carries its reusable link, so this needs a full project credential.
			 */
			paymentSetupSession: (billingAccountId: string, sessionId: string) =>
				this.request<PaymentSetupSession>(
					`/v1/billing-accounts/${segment(billingAccountId)}/payment-setup-sessions/${segment(sessionId)}`,
				),
		};
		this.usage = {
			balance: (billingAccountId: string, featureKey: string, entityId?: string) =>
				this.request<MeteringBalance>(
					pathWithQuery(
						`/v1/billing-accounts/${segment(billingAccountId)}/balances/${segment(featureKey)}`,
						{ entityId },
					),
				),
			check: (input: UsageCheckInput) =>
				this.request<UsageCheckResult>(
					`/v1/billing-accounts/${segment(input.billingAccountId)}/usage/check`,
					{ method: "POST", body: publicUsageBody(input) },
				),
			getOperation: (input: UsageOperationLookupInput) =>
				this.request<UsageOperationLookupResult>(
					pathWithQuery(
						`/v1/billing-accounts/${segment(input.billingAccountId)}/usage/operations/${segment(input.operation)}/${segment(input.operationId)}`,
						{ entityId: input.entityId },
					),
				),
			consume: (input: Omit<UsageConsumeInput, "operationId">, key: string) =>
				this.request<UsageConsumeResult>(
					`/v1/billing-accounts/${segment(input.billingAccountId)}/usage/consume`,
					{ method: "POST", body: publicUsageBody(input), idempotencyKey: key },
				),
			reserve: (input: Omit<ReserveUsageInput, "idempotencyKey">, key: string) =>
				this.request<ReservationResult>(
					`/v1/billing-accounts/${segment(input.billingAccountId)}/usage/reservations`,
					{
						method: "POST",
						body: { ...meteringBody(input), expiresInSeconds: input.expiresInSeconds },
						idempotencyKey: key,
					},
				),
			confirm: (input: Omit<ConfirmReservationInput, "idempotencyKey">, key: string) =>
				this.request<FinalizeReservationResult>(
					`/v1/billing-accounts/${segment(input.billingAccountId)}/usage/reservations/${segment(input.reservationId)}/confirm`,
					{
						method: "POST",
						body: {
							quantity: input.quantity,
							...(input.occurredAt === undefined
								? {}
								: {
										occurredAt: input.occurredAt === null ? null : input.occurredAt.toISOString(),
									}),
							...(input.metadata === undefined ? {} : { metadata: input.metadata }),
						},
						idempotencyKey: key,
					},
				),
			release: (input: Omit<ReleaseReservationInput, "idempotencyKey">, key: string) =>
				this.request<FinalizeReservationResult>(
					`/v1/billing-accounts/${segment(input.billingAccountId)}/usage/reservations/${segment(input.reservationId)}/release`,
					{ method: "POST", body: {}, idempotencyKey: key },
				),
			events: (
				billingAccountId: string,
				query: {
					featureKey?: string;
					entityId?: string;
					operation?: "consume" | "confirm" | "correction";
					from?: string;
					to?: string;
					limit?: number;
					cursor?: string;
				} = {},
			) =>
				this.requestPage<UsageEventItem>(
					pathWithQuery(`/v1/billing-accounts/${segment(billingAccountId)}/usage/events`, query),
				),
			series: (
				billingAccountId: string,
				query: {
					featureKey?: string;
					from?: string;
					to?: string;
					interval?: "hour" | "day";
				} = {},
			) =>
				this.request<UsageSeriesPoint[]>(
					pathWithQuery(`/v1/billing-accounts/${segment(billingAccountId)}/usage/series`, query),
				),
			summary: (billingAccountId: string) =>
				this.request<CustomerBillingSummary>(
					`/v1/billing-accounts/${segment(billingAccountId)}/billing-summary`,
				),
		};
		this.purchases = {
			verify: (input: PurchaseVerificationInput) =>
				this.request<EntitlementSnapshot>("/v1/purchases/verify", {
					method: "POST",
					body: input,
				}),
		};
		this.trials = {
			/**
			 * Starts a trial Quotum runs itself, with no provider: the plan's entitlements, allowances
			 * and blocked limits until the trial ends or a paid base subscription replaces it.
			 * `durationDays` defaults to the published plan's trial length.
			 */
			start: (
				billingAccountId: string,
				input: { planKey: string; durationDays?: number; metadata?: Record<string, unknown> },
				idempotencyKey: string,
			) =>
				this.request<TrialMutationResult>(
					`/v1/billing-accounts/${segment(billingAccountId)}/trials`,
					{
						method: "POST",
						body: input,
						idempotencyKey,
					},
				),
			list: (billingAccountId: string, query: { limit?: number; cursor?: string } = {}) =>
				this.requestPage<TrialRecord>(
					pathWithQuery(`/v1/billing-accounts/${segment(billingAccountId)}/trials`, query),
				),
			get: (billingAccountId: string, trialId: string) =>
				this.request<TrialRecord>(
					`/v1/billing-accounts/${segment(billingAccountId)}/trials/${segment(trialId)}`,
				),
			end: (
				billingAccountId: string,
				trialId: string,
				input: { reason?: string },
				idempotencyKey: string,
			) =>
				this.request<TrialMutationResult>(
					`/v1/billing-accounts/${segment(billingAccountId)}/trials/${segment(trialId)}/end`,
					{ method: "POST", body: input, idempotencyKey },
				),
			/** Whether the account can trial the plan now; the same checks a start makes. */
			eligibility: (billingAccountId: string, planKey: string) =>
				this.request<TrialEligibility>(
					pathWithQuery(`/v1/billing-accounts/${segment(billingAccountId)}/trial-eligibility`, {
						planKey,
					}),
				),
		};
		this.promotions = {
			linkAppleOffer: (promotionKey: string, input: AppleOfferInput) =>
				this.request<PromotionRecord>(
					`/v1/admin/promotions/${segment(promotionKey)}/apple-offers`,
					{ method: "POST", body: input, operator: true },
				),
			retireAppleOffer: (promotionKey: string, offerId: string) =>
				this.request<PromotionRecord>(
					`/v1/admin/promotions/${segment(promotionKey)}/apple-offers/${segment(offerId)}/retire`,
					{ method: "POST", operator: true },
				),
			refreshAppleSignature: (
				billingAccountId: string,
				redemptionId: string,
				idempotencyKey: string,
			) =>
				this.request<ApplePromotionAction>(
					`/v1/billing-accounts/${segment(billingAccountId)}/promotion-redemptions/${segment(redemptionId)}/apple-signatures`,
					{ method: "POST", idempotencyKey },
				),
			create: (input: Omit<CreatePromotionInput, "actor">) =>
				this.request<PromotionRecord>("/v1/admin/promotions", {
					method: "POST",
					body: input,
					operator: true,
				}),
			list: (query: { status?: "active" | "archived"; limit?: number; cursor?: string } = {}) =>
				this.requestPage<PromotionRecord>(pathWithQuery("/v1/admin/promotions", query), {
					operator: true,
				}),
			get: (promotionKey: string) =>
				this.request<PromotionRecord>(`/v1/admin/promotions/${segment(promotionKey)}`, {
					operator: true,
				}),
			syncProviders: (promotionKey: string) =>
				this.request<PromotionRecord>(
					`/v1/admin/promotions/${segment(promotionKey)}/provider-sync`,
					{ method: "POST", operator: true },
				),
			archive: (promotionKey: string) =>
				this.request<PromotionRecord>(`/v1/admin/promotions/${segment(promotionKey)}/archive`, {
					method: "POST",
					operator: true,
				}),
			addCodes: (promotionKey: string, codes: PromotionCodeInput[]) =>
				this.request<{ codes: PromotionCodeRecord[]; created: number }>(
					`/v1/admin/promotions/${segment(promotionKey)}/codes`,
					{ method: "POST", body: { codes }, operator: true },
				),
			listCodes: (
				promotionKey: string,
				query: { active?: boolean; limit?: number; cursor?: string } = {},
			) =>
				this.requestPage<PromotionCodeRecord>(
					pathWithQuery(`/v1/admin/promotions/${segment(promotionKey)}/codes`, query),
					{ operator: true },
				),
			deactivateCode: (promotionKey: string, codeId: string) =>
				this.request<PromotionCodeRecord>(
					`/v1/admin/promotions/${segment(promotionKey)}/codes/${segment(codeId)}/deactivate`,
					{ method: "POST", operator: true },
				),
			listRedemptions: (
				promotionKey: string,
				query: {
					status?: PromotionRedemptionStatus;
					billingAccountId?: string;
					limit?: number;
					cursor?: string;
				} = {},
			) =>
				this.requestPage<PromotionRedemptionRecord>(
					pathWithQuery(`/v1/admin/promotions/${segment(promotionKey)}/redemptions`, query),
					{ operator: true },
				),
			redeem: (
				billingAccountId: string,
				input: {
					code: string;
					channel: PromotionChannel;
					appleOfferId?: string;
					subscriptionId?: string;
				},
				idempotencyKey: string,
			) =>
				this.request<PromotionRedeemResult>(
					`/v1/billing-accounts/${segment(billingAccountId)}/promotion-redemptions`,
					{ method: "POST", body: input, idempotencyKey },
				),
			accountRedemptions: (
				billingAccountId: string,
				query: { limit?: number; cursor?: string } = {},
			) =>
				this.requestPage<PromotionRedemptionRecord>(
					pathWithQuery(
						`/v1/billing-accounts/${segment(billingAccountId)}/promotion-redemptions`,
						query,
					),
				),
			revokeRedemption: (redemptionId: string, reason: string, idempotencyKey: string) =>
				this.request<PromotionRevokeResult>(
					`/v1/admin/promotion-redemptions/${segment(redemptionId)}/revoke`,
					{ method: "POST", body: { reason }, operator: true, idempotencyKey },
				),
			validate: (
				billingAccountId: string,
				input: { code: string; channel?: PromotionChannel; target?: PromotionTarget },
			) =>
				this.request<PromotionValidation>(
					`/v1/billing-accounts/${segment(billingAccountId)}/promotion-codes/validate`,
					{ method: "POST", body: input },
				),
		};
		// Operator grants and debits send the operator key; the changes also name their actor.
		this.adjustments = {
			/** Gives a goodwill credit of a consumable feature; it never records a payment. */
			grant: (
				billingAccountId: string,
				input: {
					featureKey: string;
					quantity: string;
					entityId?: string | null;
					expiresAt?: string | null;
					reason: string;
				},
				idempotencyKey: string,
			) =>
				this.request<OperatorGrantMutationResult>(
					`/v1/admin/operator-grants/${segment(billingAccountId)}`,
					{ method: "POST", body: input, operator: true, idempotencyKey },
				),
			grants: (billingAccountId: string, query: { limit?: number; cursor?: string } = {}) =>
				this.requestPage<OperatorGrantRecord>(
					pathWithQuery(`/v1/admin/operator-grants/${segment(billingAccountId)}`, query),
					{ operator: true },
				),
			getGrant: (billingAccountId: string, grantId: string) =>
				this.request<OperatorGrantRecord>(
					`/v1/admin/operator-grants/${segment(billingAccountId)}/${segment(grantId)}`,
					{ operator: true },
				),
			/** Takes back only quantity that is unconsumed, unheld and unexpired. */
			revokeGrant: (
				billingAccountId: string,
				grantId: string,
				reason: string,
				idempotencyKey: string,
			) =>
				this.request<OperatorGrantMutationResult>(
					`/v1/admin/operator-grants/${segment(billingAccountId)}/${segment(grantId)}/revoke`,
					{ method: "POST", body: { reason }, operator: true, idempotencyKey },
				),
			/** Takes quantity back from named allocations, all or nothing; it is never usage. */
			debit: (
				billingAccountId: string,
				input: { allocations: Array<{ allocationId: string; quantity: string }>; reason: string },
				idempotencyKey: string,
			) =>
				this.request<AdministrativeDebitMutationResult>(
					`/v1/admin/administrative-debits/${segment(billingAccountId)}`,
					{ method: "POST", body: input, operator: true, idempotencyKey },
				),
			debits: (billingAccountId: string, query: { limit?: number; cursor?: string } = {}) =>
				this.requestPage<AdministrativeDebitRecord>(
					pathWithQuery(`/v1/admin/administrative-debits/${segment(billingAccountId)}`, query),
					{ operator: true },
				),
		};
		this.providers = {
			capabilities: () =>
				this.request<ProviderEnvironmentCapabilities>("/v1/admin/providers/capabilities"),
		};
		// These admin reads need project authentication only, so they never send the operator key.
		this.admin = {
			customer: (billingAccountId: string) =>
				this.request<AdminCustomerDetail>(
					`/v1/admin/customers/by-billing-account/${segment(billingAccountId)}`,
				),
			searchCustomers: (query: string, page: { limit?: number; cursor?: string } = {}) =>
				this.requestPage<AdminCustomerSearchResult>(
					pathWithQuery("/v1/admin/customers/search", { q: query, ...page }),
				),
			storeEvents: (query: AdminStoreEventQuery = {}) =>
				this.requestPage<AdminStoreEvent>(pathWithQuery("/v1/admin/store-events", { ...query })),
			/** Never requests the raw provider payload. */
			storeEvent: (eventId: string) =>
				this.request<AdminStoreEvent>(`/v1/admin/store-events/${segment(eventId)}`),
			projectionJobs: (query: AdminProjectionJobQuery = {}) =>
				this.requestPage<AdminProjectionJob>(
					pathWithQuery("/v1/admin/projection-jobs", { ...query }),
				),
			statsSummary: (query: AdminStatsSummaryQuery = {}) =>
				this.request<AdminStatsSummary>(pathWithQuery("/v1/admin/stats/summary", { ...query })),
		};
	}

	private async request<T>(
		path: string,
		options: {
			method?: "GET" | "POST" | "PUT" | "DELETE";
			body?: unknown;
			operator?: boolean;
			idempotencyKey?: string;
		} = {},
	): Promise<T> {
		const method = options.method ?? "GET";
		const response = await this.requestFetch(`${this.baseUrl}${path}`, {
			method,
			headers: this.headers({
				...options,
				change: method !== "GET",
				hasBody: options.body !== undefined,
			}),
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
		const payload = await readEnvelope<ApiEnvelope<T>>(response);
		if (!response.ok || payload === null || payload.success === false) {
			const error = payload?.success === false ? payload.error : null;
			throw new BillingApiError(
				error?.message ?? `Billing request failed with ${response.status}`,
				error?.code ?? "HTTP_ERROR",
				response.status,
				envelopeDetails(error?.details),
				rateLimitReset(response),
				retryAfter(response),
			);
		}
		return payload.data;
	}

	private async requestPage<T>(
		path: string,
		options: { operator?: boolean } = {},
	): Promise<CursorPage<T>> {
		const response = await this.requestFetch(`${this.baseUrl}${path}`, {
			headers: this.headers(options),
		});
		const payload = await readEnvelope<PagedEnvelope<T> | ApiFailure>(response);
		if (!response.ok || payload === null || payload.success === false) {
			const error = payload?.success === false ? payload.error : null;
			throw new BillingApiError(
				error?.message ?? `Billing request failed with ${response.status}`,
				error?.code ?? "HTTP_ERROR",
				response.status,
				envelopeDetails(error?.details),
				rateLimitReset(response),
				retryAfter(response),
			);
		}
		return { data: payload.data, nextCursor: payload.pagination.nextCursor };
	}

	private headers(options: {
		operator?: boolean;
		/** An operator change is audited, so it names its actor; an operator read does not. */
		change?: boolean;
		idempotencyKey?: string;
		hasBody?: boolean;
	}): Headers {
		const headers = new Headers({ accept: "application/json" });
		if (this.options.apiKey !== undefined) {
			headers.set("authorization", `Bearer ${this.options.apiKey}`);
		}
		if (this.options.projectKey !== undefined) {
			headers.set("x-billing-project-key", this.options.projectKey);
		}
		if (options.operator) {
			if (
				options.change &&
				(this.options.operatorKey === undefined || this.options.actor === undefined)
			) {
				throw new Error("operatorKey and actor are required for operator changes");
			}
			if (this.options.operatorKey === undefined) {
				throw new Error("operatorKey is required for operator requests");
			}
			headers.set("x-billing-operator-key", this.options.operatorKey);
			if (this.options.actor !== undefined) {
				headers.set("x-billing-actor", this.options.actor);
			}
		}
		if (options.idempotencyKey !== undefined) {
			headers.set("idempotency-key", options.idempotencyKey);
		}
		if (options.hasBody || options.idempotencyKey !== undefined) {
			headers.set("content-type", "application/json");
		}
		return headers;
	}
}

export class BillingApiError extends Error {
	/** Structured context from the error envelope; absent when the response carried none. */
	declare readonly details?: Record<string, unknown>;
	/** ISO timestamp from `ratelimit-reset` on a 429. */
	declare readonly rateLimitResetAt?: string;
	/** Whole seconds from `retry-after` on a 429: how long to wait before retrying. */
	declare readonly retryAfterSeconds?: number;

	constructor(
		message: string,
		readonly code: string,
		readonly status: number,
		details?: Record<string, unknown>,
		rateLimitResetAt?: string,
		retryAfterSeconds?: number,
	) {
		super(message);
		this.name = "BillingApiError";
		if (details !== undefined) {
			this.details = details;
		}
		if (rateLimitResetAt !== undefined) {
			this.rateLimitResetAt = rateLimitResetAt;
		}
		if (retryAfterSeconds !== undefined) {
			this.retryAfterSeconds = retryAfterSeconds;
		}
	}
}

function rateLimitReset(response: Response): string | undefined {
	return response.status === 429
		? (response.headers.get("ratelimit-reset") ?? undefined)
		: undefined;
}

function retryAfter(response: Response): number | undefined {
	const value = response.status === 429 ? response.headers.get("retry-after")?.trim() : undefined;
	return value !== undefined && /^\d{1,9}$/.test(value) ? Number(value) : undefined;
}

function envelopeDetails(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

type ApiEnvelope<T> = { success: true; data: T } | ApiFailure;
type ApiFailure = {
	success: false;
	error: { code: string; message: string; details?: Record<string, unknown> };
};
type PagedEnvelope<T> = {
	success: true;
	data: T[];
	pagination: { nextCursor: string | null };
};

function segment(value: string): string {
	return encodeURIComponent(value);
}

function pathWithQuery(path: string, query: Record<string, unknown>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
	}
	const rendered = params.toString();
	return rendered === "" ? path : `${path}?${rendered}`;
}

function meteringBody(input: MeteringSubjectInput & { metadata?: Record<string, unknown> }) {
	return {
		featureKey: input.featureKey,
		quantity: input.quantity,
		...(input.entityId === undefined ? {} : { entityId: input.entityId }),
		...(input.filters === undefined ? {} : { filters: input.filters }),
		...(input.occurredAt === undefined
			? {}
			: { occurredAt: input.occurredAt === null ? null : input.occurredAt.toISOString() }),
		...(input.metadata === undefined ? {} : { metadata: input.metadata }),
	};
}

/**
 * The response's JSON envelope, or null when the body is empty or not JSON, such as a proxy's
 * text or HTML 502, so the caller still gets a typed error with the HTTP status.
 */
async function readEnvelope<T>(response: Response): Promise<T | null> {
	const text = await response.text();
	if (text.trim() === "") return null;
	try {
		return JSON.parse(text) as T;
	} catch {
		return null;
	}
}

function publicUsageBody(input: UsageCheckInput) {
	return {
		featureId: input.featureId,
		value: input.value,
		entityId: input.entityId,
		occurredAt: input.occurredAt?.toISOString(),
	};
}
