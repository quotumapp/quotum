import { Buffer } from "node:buffer";
import { z } from "zod";
import { BillingError } from "../billing/errors";
import {
	billingChannels,
	billingProviders,
	productTypes,
	projectionSyncReasons,
	projectionSyncStatuses,
	purchaseStatuses,
	storeEventProcessingStatuses,
	subscriptionStatuses,
} from "../billing/types";
import type {
	AdminCatalogProductListInput,
	AdminCatalogStoreProductListInput,
	AdminCommonListInput,
	AdminCursor,
	AdminCustomerSearchInput,
	AdminPagination,
	AdminProjectionJobListInput,
	AdminPurchaseListInput,
	AdminStatsSummaryInput,
	AdminStoreEventListInput,
	AdminSubscriptionListInput,
} from "./types";

const uuidSchema = z.string().trim().uuid();
const customerSearchQueryMaxLength = 128;
const dateSchema = z
	.string()
	.trim()
	.min(1)
	.transform((value, context) => {
		const date = new Date(value);
		if (!Number.isFinite(date.getTime())) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid date" });
			return z.NEVER;
		}
		return date.toISOString();
	});
const cursorDateSchema = z
	.string()
	.trim()
	.min(1)
	.transform((value, context) => {
		const datePrefix = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(value);
		if (datePrefix === null) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid date" });
			return z.NEVER;
		}
		const year = Number(datePrefix[1]);
		const month = Number(datePrefix[2]);
		const day = Number(datePrefix[3]);
		const calendarDate = new Date(Date.UTC(year, month - 1, day));
		if (
			calendarDate.getUTCFullYear() !== year ||
			calendarDate.getUTCMonth() + 1 !== month ||
			calendarDate.getUTCDate() !== day
		) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid date" });
			return z.NEVER;
		}
		const date = new Date(value);
		if (!Number.isFinite(date.getTime())) {
			context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid date" });
			return z.NEVER;
		}
		return value;
	});
export const paginationSchema = z.object({
	limit: z.coerce.number().int().positive().max(100).default(25),
	cursor: z.string().trim().min(1).nullable().optional(),
});
const cursorSchema = z.object({
	createdAt: cursorDateSchema,
	id: uuidSchema,
});
const adminCursorPattern = /^[A-Za-z0-9_-]+$/;
const commonListSchema = paginationSchema.extend({
	provider: z.enum(billingProviders).optional(),
	channel: z.enum(billingChannels).optional(),
	billingAccountId: z.string().trim().min(1).optional(),
	customerId: uuidSchema.optional(),
	productKey: z.string().trim().min(1).optional(),
	entitlementKey: z.string().trim().min(1).optional(),
	from: dateSchema.optional(),
	to: dateSchema.optional(),
});

type ParsedCommonListInput = z.infer<typeof commonListSchema>;

export function parseCustomerIdParam(value: string): string {
	const parsed = uuidSchema.safeParse(value);
	if (!parsed.success) {
		throw invalidRequest("Invalid customer id");
	}
	return parsed.data;
}

export function parseBillingAccountIdParam(value: string): string {
	const parsed = z.string().trim().min(1).safeParse(value);
	if (!parsed.success) {
		throw invalidRequest("Invalid billing account id");
	}
	return parsed.data;
}

export function parseEventIdParam(value: string): string {
	const parsed = uuidSchema.safeParse(value);
	if (!parsed.success) {
		throw invalidRequest("Invalid store event id");
	}
	return parsed.data;
}

export function parseAdminPagination(params: URLSearchParams): AdminPagination {
	const parsed = paginationSchema.safeParse(parseSearchParams(params, "Invalid pagination"));
	if (!parsed.success) {
		throw invalidRequest("Invalid pagination");
	}
	return { limit: parsed.data.limit, cursor: validateAdminCursor(parsed.data.cursor) };
}

export function encodeAdminCursor(cursor: AdminCursor): string {
	return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeAdminCursor(value: string): AdminCursor {
	if (!adminCursorPattern.test(value)) {
		throw invalidRequest("Invalid cursor");
	}
	const decoded = Buffer.from(value, "base64url");
	if (decoded.toString("base64url") !== value) {
		throw invalidRequest("Invalid cursor");
	}
	const decodedText = decoded.toString("utf8");
	if (decodedText.trim() !== decodedText) {
		throw invalidRequest("Invalid cursor");
	}

	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(decodedText);
	} catch {
		throw invalidRequest("Invalid cursor");
	}

	const parsed = cursorSchema.safeParse(parsedJson);
	if (!parsed.success) {
		throw invalidRequest("Invalid cursor");
	}
	return parsed.data;
}

export function parseCustomerSearchQuery(params: URLSearchParams): AdminCustomerSearchInput {
	const parsed = parseCustomerSearchQuerySchema.safeParse(
		parseSearchParams(params, "Customer search query is required"),
	);
	if (!parsed.success) {
		throw invalidRequest(
			parsed.error.issues.some((issue) => issue.code === "too_big")
				? `Customer search query must be ${customerSearchQueryMaxLength} characters or less`
				: "Customer search query is required",
		);
	}
	return {
		query: parsed.data.q,
		limit: parsed.data.limit,
		cursor: validateAdminCursor(parsed.data.cursor),
	};
}

export function parsePurchaseListQuery(params: URLSearchParams): AdminPurchaseListInput {
	const parsed = parsePurchaseListQuerySchema.safeParse(
		parseSearchParams(params, "Invalid purchase filters"),
	);
	if (!parsed.success) {
		throw invalidRequest("Invalid purchase filters");
	}

	const input: AdminPurchaseListInput = commonListInput(parsed.data);
	if (parsed.data.purchaseKind !== undefined) {
		input.purchaseKind = parsed.data.purchaseKind;
	}
	if (parsed.data.status !== undefined) {
		input.status = parsed.data.status;
	}
	if (parsed.data.transactionId !== undefined) {
		input.transactionId = parsed.data.transactionId;
	}
	if (parsed.data.orderId !== undefined) {
		input.orderId = parsed.data.orderId;
	}
	return input;
}

export function parseCustomerPurchaseListQuery(
	customerId: string,
	params: URLSearchParams,
): AdminPurchaseListInput {
	const parsedCustomerId = parseCustomerIdParam(customerId);
	return { ...parsePurchaseListQuery(params), customerId: parsedCustomerId };
}

export function parseSubscriptionListQuery(
	params: URLSearchParams,
	staleBefore: string = new Date().toISOString(),
): AdminSubscriptionListInput {
	const parsed = parseSubscriptionListQuerySchema.safeParse(
		parseSearchParams(params, "Invalid subscription filters"),
	);
	if (!parsed.success) {
		throw invalidRequest("Invalid subscription filters");
	}

	const input: AdminSubscriptionListInput = { ...commonListInput(parsed.data), staleBefore };
	if (parsed.data.status !== undefined) {
		input.status = parsed.data.status;
	}
	if (parsed.data.needsAttention !== undefined) {
		input.needsAttention = parsed.data.needsAttention === "true";
	}
	return input;
}

export function parseCustomerSubscriptionListQuery(
	customerId: string,
	params: URLSearchParams,
	staleBefore?: string,
): AdminSubscriptionListInput {
	const parsedCustomerId = parseCustomerIdParam(customerId);
	return { ...parseSubscriptionListQuery(params, staleBefore), customerId: parsedCustomerId };
}

export function parseStoreEventListQuery(params: URLSearchParams): AdminStoreEventListInput {
	const parsed = parseStoreEventListQuerySchema.safeParse(
		parseSearchParams(params, "Invalid store event filters"),
	);
	if (!parsed.success) {
		throw invalidRequest("Invalid store event filters");
	}

	const input: AdminStoreEventListInput = commonListInput(parsed.data);
	if (parsed.data.processingStatus !== undefined) {
		input.processingStatus = parsed.data.processingStatus;
	}
	if (parsed.data.eventType !== undefined) {
		input.eventType = parsed.data.eventType;
	}
	if (parsed.data.externalEventId !== undefined) {
		input.externalEventId = parsed.data.externalEventId;
	}
	return input;
}

export function parseCustomerStoreEventListQuery(
	customerId: string,
	params: URLSearchParams,
): AdminStoreEventListInput {
	const parsedCustomerId = parseCustomerIdParam(customerId);
	return { ...parseStoreEventListQuery(params), customerId: parsedCustomerId };
}

export function parseStoreEventDetailQuery(params: URLSearchParams): {
	includeRawPayload: boolean;
} {
	const parsed = parseStoreEventDetailQuerySchema.safeParse(
		parseSearchParams(params, "Invalid store event detail query"),
	);
	if (!parsed.success) {
		throw invalidRequest("Invalid store event detail query");
	}
	return { includeRawPayload: parsed.data.includeRawPayload === "true" };
}

export function parseProjectionJobListQuery(params: URLSearchParams): AdminProjectionJobListInput {
	const parsed = parseProjectionJobListQuerySchema.safeParse(
		parseSearchParams(params, "Invalid projection job filters"),
	);
	if (!parsed.success) {
		throw invalidRequest("Invalid projection job filters");
	}

	const input: AdminProjectionJobListInput = commonListInput(parsed.data);
	if (parsed.data.status !== undefined) {
		input.status = parsed.data.status;
	}
	if (parsed.data.reason !== undefined) {
		input.reason = parsed.data.reason;
	}
	return input;
}

export function parseCustomerProjectionJobListQuery(
	customerId: string,
	params: URLSearchParams,
): AdminProjectionJobListInput {
	const parsedCustomerId = parseCustomerIdParam(customerId);
	return { ...parseProjectionJobListQuery(params), customerId: parsedCustomerId };
}

export function parseCatalogProductListQuery(
	params: URLSearchParams,
): AdminCatalogProductListInput {
	return parseAdminPagination(params);
}

export function parseStatsSummaryQuery(params: URLSearchParams): AdminStatsSummaryInput {
	const parsed = parseStatsSummaryQuerySchema.safeParse(
		parseSearchParams(params, "Invalid stats summary filters"),
	);
	if (!parsed.success) {
		throw invalidRequest("Invalid stats summary filters");
	}

	const input: AdminStatsSummaryInput = {};
	if (parsed.data.provider !== undefined) {
		input.provider = parsed.data.provider;
	}
	if (parsed.data.channel !== undefined) {
		input.channel = parsed.data.channel;
	}
	if (parsed.data.from !== undefined) {
		input.from = parsed.data.from;
	}
	if (parsed.data.to !== undefined) {
		input.to = parsed.data.to;
	}
	return input;
}

export function parseCatalogStoreProductListQuery(
	params: URLSearchParams,
): AdminCatalogStoreProductListInput {
	const parsed = parseCatalogStoreProductListQuerySchema.safeParse(
		parseSearchParams(params, "Invalid store product filters"),
	);
	if (!parsed.success) {
		throw invalidRequest("Invalid store product filters");
	}

	const input: AdminCatalogStoreProductListInput = {
		limit: parsed.data.limit,
		cursor: validateAdminCursor(parsed.data.cursor),
	};
	if (parsed.data.provider !== undefined) {
		input.provider = parsed.data.provider;
	}
	if (parsed.data.channel !== undefined) {
		input.channel = parsed.data.channel;
	}
	if (parsed.data.productKey !== undefined) {
		input.productKey = parsed.data.productKey;
	}
	return input;
}

function invalidRequest(message: string): BillingError {
	return new BillingError(message, "INVALID_REQUEST", 400);
}

function parseSearchParams(params: URLSearchParams, message: string): Record<string, string> {
	const input: Record<string, string> = Object.create(null);
	const seen = new Set<string>();
	for (const [key, value] of params) {
		if (seen.has(key)) {
			throw invalidRequest(message);
		}
		seen.add(key);
		input[key] = value;
	}
	return input;
}

function validateAdminCursor(value: string | null | undefined): string | null {
	if (value === undefined || value === null) {
		return null;
	}
	decodeAdminCursor(value);
	return value;
}

function commonListInput(value: ParsedCommonListInput): AdminCommonListInput {
	const input: AdminCommonListInput = {
		limit: value.limit,
		cursor: validateAdminCursor(value.cursor),
	};
	if (value.provider !== undefined) {
		input.provider = value.provider;
	}
	if (value.channel !== undefined) {
		input.channel = value.channel;
	}
	if (value.billingAccountId !== undefined) {
		input.billingAccountId = value.billingAccountId;
	}
	if (value.customerId !== undefined) {
		input.customerId = value.customerId;
	}
	if (value.productKey !== undefined) {
		input.productKey = value.productKey;
	}
	if (value.entitlementKey !== undefined) {
		input.entitlementKey = value.entitlementKey;
	}
	if (value.from !== undefined) {
		input.from = value.from;
	}
	if (value.to !== undefined) {
		input.to = value.to;
	}
	return input;
}

export const parseCustomerSearchQuerySchema = paginationSchema.extend({
	q: z
		.string()
		.trim()
		.min(1)
		.max(
			customerSearchQueryMaxLength,
			`Customer search query must be ${customerSearchQueryMaxLength} characters or less`,
		),
});
export const parsePurchaseListQuerySchema = commonListSchema.extend({
	purchaseKind: z.enum(productTypes).optional(),
	status: z.enum(purchaseStatuses).optional(),
	transactionId: z.string().trim().min(1).optional(),
	orderId: z.string().trim().min(1).optional(),
});
export const parseSubscriptionListQuerySchema = commonListSchema.extend({
	status: z.enum(subscriptionStatuses).optional(),
	needsAttention: z.enum(["true", "false"]).optional(),
});
export const parseStoreEventListQuerySchema = commonListSchema.extend({
	processingStatus: z.enum(storeEventProcessingStatuses).optional(),
	eventType: z.string().trim().min(1).optional(),
	externalEventId: z.string().trim().min(1).optional(),
});
export const parseStoreEventDetailQuerySchema = z.object({
	includeRawPayload: z.enum(["true", "false"]).optional(),
});
export const parseProjectionJobListQuerySchema = commonListSchema.extend({
	status: z.enum(projectionSyncStatuses).optional(),
	reason: z.enum(projectionSyncReasons).optional(),
});
export const parseStatsSummaryQuerySchema = z.object({
	provider: z.enum(billingProviders).optional(),
	channel: z.enum(billingChannels).optional(),
	from: dateSchema.optional(),
	to: dateSchema.optional(),
});
export const parseCatalogStoreProductListQuerySchema = paginationSchema.extend({
	provider: z.enum(billingProviders).optional(),
	channel: z.enum(billingChannels).optional(),
	productKey: z.string().trim().min(1).optional(),
});
