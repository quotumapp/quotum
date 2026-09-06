import type { AdminCustomerDetail, AdminCustomerSearchResult } from "../admin/types";
import type {
	CommercialActionExecutionResult,
	CommercialActionIntent,
	CommercialActionPreview,
} from "../billing/commercial";
import type { CustomerBillingSummary, UsageEventItem, UsageSeriesPoint } from "../billing/insights";
import type {
	ConfirmReservationInput,
	ConsumeUsageResult,
	FinalizeReservationResult,
	MeteringBalance,
	MeteringDecision,
	MeteringSubjectInput,
	ReleaseReservationInput,
	ReservationResult,
	ReserveUsageInput,
} from "../billing/metering";
import type { EntitlementSnapshot } from "../billing/types";
import type {
	UsageOperationLookupInput,
	UsageOperationLookupResult,
} from "../billing/usage-operations";
import type {
	CatalogIntent,
	CatalogPreview,
	CatalogPublishResult,
	PublishedCatalog,
} from "../catalog/types";
import type { AppleVerifyPurchaseInput } from "../providers/apple/types";
import type { GoogleVerifyPurchaseInput } from "../providers/google/types";

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

export class BillingClient {
	readonly catalog;
	readonly commercial;
	readonly usage;
	readonly purchases;
	readonly admin;

	private readonly baseUrl: string;
	private readonly requestFetch: BillingFetch;

	constructor(private readonly options: BillingClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.requestFetch = options.fetch ?? globalThis.fetch;
		if (typeof this.requestFetch !== "function")
			throw new Error("A fetch implementation is required");
		this.catalog = {
			status: () => this.request<PublishedCatalog>("/v1/admin/catalog", { operator: true }),
			preview: (input: { expectedRevision: number | null; catalog: CatalogIntent }) =>
				this.request<CatalogPreview>("/v1/admin/catalog/preview", {
					method: "POST",
					body: input,
					operator: true,
				}),
			publish: (input: {
				expectedRevision: number | null;
				previewToken: string;
				catalog: CatalogIntent;
			}) =>
				this.request<CatalogPublishResult>("/v1/admin/catalog/publish", {
					method: "POST",
					body: input,
					operator: true,
				}),
		};
		this.commercial = {
			preview: (billingAccountId: string, intent: CommercialActionIntent) =>
				this.request<CommercialActionPreview>(
					`/v1/billing-accounts/${segment(billingAccountId)}/commercial-actions/preview`,
					{ method: "POST", body: { intent } },
				),
			execute: (billingAccountId: string, previewToken: string, idempotencyKey: string) =>
				this.request<CommercialActionExecutionResult>(
					`/v1/billing-accounts/${segment(billingAccountId)}/commercial-actions`,
					{ method: "POST", body: { previewToken }, idempotencyKey },
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
			check: (input: MeteringSubjectInput) =>
				this.request<MeteringDecision>(
					`/v1/billing-accounts/${segment(input.billingAccountId)}/usage/check`,
					{ method: "POST", body: meteringBody(input) },
				),
			getOperation: (input: UsageOperationLookupInput) =>
				this.request<UsageOperationLookupResult>(
					`/v1/billing-accounts/${segment(input.billingAccountId)}/usage/operations/${segment(input.operation)}/${segment(input.operationId)}`,
				),
			consume: (
				input: MeteringSubjectInput & { metadata?: Record<string, unknown> },
				key: string,
			) =>
				this.request<ConsumeUsageResult>(
					`/v1/billing-accounts/${segment(input.billingAccountId)}/usage/consume`,
					{ method: "POST", body: meteringBody(input), idempotencyKey: key },
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
		this.admin = {
			customer: (billingAccountId: string) =>
				this.request<AdminCustomerDetail>(
					`/v1/admin/customers/by-billing-account/${segment(billingAccountId)}`,
					{ operator: true },
				),
			searchCustomers: (query: string) =>
				this.requestPage<AdminCustomerSearchResult>(
					pathWithQuery("/v1/admin/customers/search", { q: query }),
					{ operator: true },
				),
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
		const response = await this.requestFetch(`${this.baseUrl}${path}`, {
			method: options.method ?? "GET",
			headers: this.headers({ ...options, hasBody: options.body !== undefined }),
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
		});
		const payload = (await response.json()) as ApiEnvelope<T>;
		if (!response.ok || payload.success === false) {
			const error = payload.success === false ? payload.error : null;
			throw new BillingApiError(
				error?.message ?? `Billing request failed with ${response.status}`,
				error?.code ?? "HTTP_ERROR",
				response.status,
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
		const payload = (await response.json()) as PagedEnvelope<T> | ApiFailure;
		if (!response.ok || payload.success === false) {
			const error = payload.success === false ? payload.error : null;
			throw new BillingApiError(
				error?.message ?? `Billing request failed with ${response.status}`,
				error?.code ?? "HTTP_ERROR",
				response.status,
			);
		}
		return { data: payload.data, nextCursor: payload.pagination.nextCursor };
	}

	private headers(options: {
		operator?: boolean;
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
			if (this.options.operatorKey === undefined || this.options.actor === undefined) {
				throw new Error("operatorKey and actor are required for operator requests");
			}
			headers.set("x-billing-operator-key", this.options.operatorKey);
			headers.set("x-billing-actor", this.options.actor);
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
	constructor(
		message: string,
		readonly code: string,
		readonly status: number,
	) {
		super(message);
		this.name = "BillingApiError";
	}
}

type ApiEnvelope<T> = { success: true; data: T } | ApiFailure;
type ApiFailure = { success: false; error: { code: string; message: string } };
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
