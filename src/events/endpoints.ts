import type { AdjustmentList, AdjustmentListOptions } from "../billing/balance-adjustments";
import { sha256Hex, stableJson } from "../billing/decimal";
import { BillingError, InvalidRequestError } from "../billing/errors";
import type { ProjectInstanceContext } from "../projects/context";
import { isSubscribableEventType, subscribableEventTypes } from "./types";

/** Bounds the fan-out of one event and the deliveries one fact can cause. */
export const webhookEndpointLimit = 20;
export const webhookUrlMaxLength = 2048;
export const webhookDescriptionMaxLength = 500;
export const webhookEventTypesMax = 64;
/** How long a replaced secret keeps signing deliveries by default, and at most. */
export const webhookSecretOverlapHoursDefault = 24;
export const webhookSecretOverlapHoursMax = 168;
/** The most events one replay may queue. */
export const webhookReplayMaxEvents = 10_000;
/** An endpoint whose every delivery has failed for this long is disabled. */
export const webhookFailingDisableAfterHours = 72;

export type WebhookEndpointDisabledReason = "operator" | "failing";
export const webhookDeliveryStatuses = ["pending", "processing", "succeeded", "failed"] as const;
export type WebhookDeliveryStatus = (typeof webhookDeliveryStatuses)[number];

export interface WebhookEndpointRecord {
	id: string;
	url: string;
	description: string | null;
	/** Empty means every event type. */
	eventTypes: string[];
	enabled: boolean;
	disabledReason: WebhookEndpointDisabledReason | null;
	secretGeneration: number;
	/** Until when the secret a rotation replaced still signs deliveries. */
	previousSecretExpiresAt: string | null;
	/** Since when every delivery to the endpoint has failed. */
	failingSince: string | null;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
}

export interface WebhookEndpointCreateInput {
	url: string;
	description: string | null;
	eventTypes: string[];
	enabled: boolean;
	actor: string;
	idempotencyKey: string;
}

/**
 * The secret is disclosed once, when the endpoint is created. A replay of the same request returns
 * the endpoint without it: the secret is sealed at rest and never stored in a replayable response.
 */
export interface WebhookEndpointCreateResult {
	duplicate: boolean;
	endpoint: WebhookEndpointRecord;
	secret: string | null;
	secretDisclosed: boolean;
}

export interface WebhookEndpointUpdateInput {
	url?: string;
	description?: string | null;
	eventTypes?: string[];
	enabled?: boolean;
}

export interface WebhookSecretRotationInput {
	overlapHours: number;
	idempotencyKey: string;
}

export interface WebhookSecretRotationResult {
	duplicate: boolean;
	endpoint: WebhookEndpointRecord;
	secret: string | null;
	secretDisclosed: boolean;
}

export interface WebhookTestEventResult {
	eventId: string;
	deliveryId: string;
}

export interface WebhookReplayInput {
	from: Date;
	to: Date;
	/** Narrows the replay; the endpoint's own subscription always applies. */
	eventTypes: string[];
}

export interface WebhookDeliveryRecord {
	id: string;
	endpointId: string;
	eventId: string;
	eventType: string;
	billingAccountId: string | null;
	status: WebhookDeliveryStatus;
	attempts: number;
	/** When the next attempt is due; null once the delivery has succeeded or failed for good. */
	nextAttemptAt: string | null;
	lastError: string | null;
	lastStatusCode: number | null;
	lastAttemptAt: string | null;
	deliveredAt: string | null;
	occurredAt: string;
	createdAt: string;
}

export interface WebhookDeliveryListOptions extends AdjustmentListOptions {
	endpointId: string | null;
	status: WebhookDeliveryStatus | null;
	eventType: string | null;
	billingAccountId: string | null;
}

export interface WebhookEndpointServiceLike {
	createEndpoint(
		project: ProjectInstanceContext,
		input: WebhookEndpointCreateInput,
	): Promise<WebhookEndpointCreateResult>;
	listEndpoints(project: ProjectInstanceContext): Promise<WebhookEndpointRecord[]>;
	getEndpoint(project: ProjectInstanceContext, endpointId: string): Promise<WebhookEndpointRecord>;
	updateEndpoint(
		project: ProjectInstanceContext,
		endpointId: string,
		input: WebhookEndpointUpdateInput,
	): Promise<WebhookEndpointRecord>;
	deleteEndpoint(project: ProjectInstanceContext, endpointId: string): Promise<{ id: string }>;
	rotateSecret(
		project: ProjectInstanceContext,
		endpointId: string,
		input: WebhookSecretRotationInput,
	): Promise<WebhookSecretRotationResult>;
	sendTestEvent(
		project: ProjectInstanceContext,
		endpointId: string,
	): Promise<WebhookTestEventResult>;
	replay(
		project: ProjectInstanceContext,
		endpointId: string,
		input: WebhookReplayInput,
	): Promise<{ queued: number }>;
	listDeliveries(
		project: ProjectInstanceContext,
		options: WebhookDeliveryListOptions,
	): Promise<AdjustmentList<WebhookDeliveryRecord>>;
	retryDelivery(
		project: ProjectInstanceContext,
		deliveryId: string,
	): Promise<{ deliveryId: string; status: "pending" }>;
}

// Each entry declares `code` literally so the wire error registry inventories it.
const webhookErrorDefinitions = [
	{ code: "WEBHOOK_ENDPOINT_NOT_FOUND", status: 404, message: "Webhook endpoint was not found" },
	{
		code: "WEBHOOK_ENDPOINT_LIMIT_REACHED",
		status: 409,
		message: `A project has at most ${webhookEndpointLimit} webhook endpoints`,
	},
	{ code: "WEBHOOK_EVENT_TYPE_UNKNOWN", status: 400, message: "Unknown webhook event type" },
	{ code: "WEBHOOK_ENDPOINT_DISABLED", status: 409, message: "Webhook endpoint is disabled" },
	{ code: "WEBHOOK_DELIVERY_NOT_FOUND", status: 404, message: "Webhook delivery was not found" },
	{
		code: "WEBHOOK_DELIVERY_NOT_FAILED",
		status: 409,
		message: "Only a failed webhook delivery can be retried",
	},
	{
		code: "WEBHOOK_REPLAY_TOO_LARGE",
		status: 409,
		message: `A replay may queue at most ${webhookReplayMaxEvents} events`,
	},
] as const;

export type WebhookErrorCode = (typeof webhookErrorDefinitions)[number]["code"];

export function webhookError(
	code: WebhookErrorCode,
	details?: Record<string, unknown>,
): BillingError {
	const definition = webhookErrorDefinitions.find((candidate) => candidate.code === code);
	return new BillingError(
		definition?.message ?? "Webhook request failed",
		code,
		definition?.status ?? 400,
		details === undefined ? {} : { details },
	);
}

/**
 * An endpoint URL: https, or http only where the deployment approved private receivers. DNS and
 * address checks happen at each delivery, where the address is pinned.
 */
export function normalizeWebhookUrl(
	value: string,
	options: { allowInsecureHttp: boolean },
): string {
	const trimmed = value.trim();
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new InvalidRequestError("url must be an absolute URL");
	}
	const scheme =
		url.protocol === "https:" || (options.allowInsecureHttp && url.protocol === "http:");
	if (!scheme || url.username || url.password || url.hash || trimmed.includes("#")) {
		throw new InvalidRequestError(
			options.allowInsecureHttp
				? "url must be an http or https URL without credentials or a fragment"
				: "url must be an https URL without credentials or a fragment",
		);
	}
	const normalized = url.toString();
	if (normalized.length > webhookUrlMaxLength) {
		throw new InvalidRequestError(`url must be at most ${webhookUrlMaxLength} characters`);
	}
	return normalized;
}

export function normalizeWebhookDescription(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const description = value.trim();
	if (description === "") return null;
	if ([...description].length > webhookDescriptionMaxLength) {
		throw new InvalidRequestError(
			`description must be at most ${webhookDescriptionMaxLength} characters`,
		);
	}
	return description;
}

/** Sorted and deduplicated, so equal subscriptions compare and hash equally. */
export function normalizeWebhookEventTypes(values: readonly string[]): string[] {
	const types = [...new Set(values.map((value) => value.trim()))].sort();
	const unknown = types.filter((type) => !isSubscribableEventType(type));
	if (unknown.length > 0) {
		throw webhookError("WEBHOOK_EVENT_TYPE_UNKNOWN", {
			unknown,
			available: subscribableEventTypes(),
		});
	}
	if (types.length > webhookEventTypesMax) {
		throw new InvalidRequestError(`eventTypes may list at most ${webhookEventTypesMax} types`);
	}
	return types;
}

/** Identifies what a create asks for, so a reused idempotency key with other terms conflicts. */
export function webhookEndpointRequestHash(
	input: Pick<WebhookEndpointCreateInput, "url" | "description" | "eventTypes" | "enabled">,
): string {
	return sha256Hex(
		stableJson({
			url: input.url,
			description: input.description,
			eventTypes: input.eventTypes,
			enabled: input.enabled,
		}),
	);
}
