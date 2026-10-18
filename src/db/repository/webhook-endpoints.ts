import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import { decodeAdminCursor, encodeAdminCursor } from "../../admin/query";
import type { AdjustmentList } from "../../billing/balance-adjustments";
import { PersistenceConflictError } from "../../billing/errors";
import {
	type WebhookDeliveryListOptions,
	type WebhookDeliveryRecord,
	type WebhookDeliveryStatus,
	type WebhookEndpointDisabledReason,
	type WebhookEndpointRecord,
	type WebhookEndpointUpdateInput,
	webhookEndpointLimit,
	webhookError,
	webhookReplayMaxEvents,
} from "../../events/endpoints";
import type { SealedWebhookSecret } from "../../events/secret-sealer";
import { webhookTestEventType } from "../../events/types";
import { RepositoryModule } from "./base";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";
import { formatUtcTimestamp, requirePositiveLimit } from "./validation";

export interface WebhookEndpointInsert {
	id: string;
	url: string;
	description: string | null;
	eventTypes: string[];
	enabled: boolean;
	secretEnvelope: SealedWebhookSecret;
	createdBy: string;
	idempotencyKey: string;
	requestHash: string;
}

export interface WebhookSecretRotation {
	/** Seals the new secret for the generation the rotation moves to. */
	seal(generation: number): SealedWebhookSecret;
	overlapHours: number;
	idempotencyKey: string;
}

export interface WebhookReplayQuery {
	from: Date;
	to: Date;
	eventTypes: string[];
}

interface EndpointRow {
	id: string;
	url: string;
	description: string | null;
	event_types: string[];
	enabled: boolean;
	disabled_reason: WebhookEndpointDisabledReason | null;
	secret_generation: number;
	previous_secret_expires_at: Date | string | null;
	failing_since: Date | string | null;
	created_by: string;
	created_at: Date | string;
	updated_at: Date | string;
}

interface DeliveryRow {
	id: string;
	endpoint_id: string;
	event_id: string;
	type: string;
	billing_account_id: string | null;
	status: WebhookDeliveryStatus;
	attempts: number;
	next_attempt_at: Date | string;
	last_error: string | null;
	last_status_code: number | null;
	last_attempt_at: Date | string | null;
	delivered_at: Date | string | null;
	occurred_at: Date | string;
	created_at: Date | string;
	cursor_created_at: string;
}

const endpointColumns = drizzleSql`
	endpoint.id, endpoint.url, endpoint.description, endpoint.event_types, endpoint.enabled,
	endpoint.disabled_reason, endpoint.secret_generation, endpoint.previous_secret_expires_at,
	endpoint.failing_since, endpoint.created_by, endpoint.created_at, endpoint.updated_at
`;

export class WebhookEndpointRepository extends RepositoryModule {
	/**
	 * Creates an endpoint, or returns the one an earlier request with the same idempotency key
	 * created. The project lock serializes creates, so the endpoint cap holds.
	 */
	async insertEndpoint(
		projectId: string,
		input: WebhookEndpointInsert,
	): Promise<{ duplicate: boolean; endpoint: WebhookEndpointRecord }> {
		return await this.transaction(async (tx) => {
			await lockProjectEndpoints(tx, projectId);
			const replay = await executeOne<{ id: string; request_hash: string }>(
				tx,
				drizzleSql`
					SELECT id, request_hash FROM webhook_endpoints
					WHERE project_id = ${projectId} AND idempotency_key = ${input.idempotencyKey}
				`,
			);
			if (replay !== null) {
				if (replay.request_hash !== input.requestHash) {
					throw new PersistenceConflictError(
						"Idempotency key was reused with a different webhook endpoint",
						"IDEMPOTENCY_CONFLICT",
					);
				}
				return { duplicate: true, endpoint: await requireEndpoint(tx, projectId, replay.id) };
			}
			const count = await executeOne<{ count: number }>(
				tx,
				drizzleSql`SELECT count(*)::int AS count FROM webhook_endpoints WHERE project_id = ${projectId}`,
			);
			if ((count?.count ?? 0) >= webhookEndpointLimit) {
				throw webhookError("WEBHOOK_ENDPOINT_LIMIT_REACHED", { limit: webhookEndpointLimit });
			}
			const row = await executeOne<EndpointRow>(
				tx,
				drizzleSql`
					INSERT INTO webhook_endpoints AS endpoint (
						id, project_id, url, description, event_types, enabled, disabled_reason,
						secret_envelope, created_by, idempotency_key, request_hash
					)
					VALUES (
						${input.id}, ${projectId}, ${input.url}, ${input.description},
						${textArray(input.eventTypes)}, ${input.enabled},
						${input.enabled ? null : "operator"}, ${jsonb(input.secretEnvelope)},
						${input.createdBy}, ${input.idempotencyKey}, ${input.requestHash}
					)
					RETURNING ${endpointColumns}
				`,
			);
			if (row === null) throw new Error("Webhook endpoint could not be created");
			return { duplicate: false, endpoint: toEndpointRecord(row) };
		});
	}

	async listEndpoints(projectId: string): Promise<WebhookEndpointRecord[]> {
		const rows = await executeRows<EndpointRow>(
			this.database,
			drizzleSql`
				SELECT ${endpointColumns} FROM webhook_endpoints endpoint
				WHERE endpoint.project_id = ${projectId}
				ORDER BY endpoint.created_at ASC, endpoint.id ASC
			`,
		);
		return rows.map(toEndpointRecord);
	}

	async getEndpoint(projectId: string, endpointId: string): Promise<WebhookEndpointRecord> {
		return await requireEndpoint(this.database, projectId, endpointId);
	}

	/**
	 * Changes what an endpoint receives. Enabling clears the failure state; disabling records that
	 * an operator disabled it. Deliveries of a disabled endpoint wait until it is enabled again.
	 */
	async updateEndpoint(
		projectId: string,
		endpointId: string,
		input: WebhookEndpointUpdateInput,
	): Promise<WebhookEndpointRecord> {
		const enabled = input.enabled ?? null;
		const row = await executeOne<EndpointRow>(
			this.database,
			drizzleSql`
				UPDATE webhook_endpoints AS endpoint
				SET
					url = COALESCE(${input.url ?? null}, endpoint.url),
					description = CASE
						WHEN ${input.description !== undefined} THEN ${input.description ?? null}
						ELSE endpoint.description
					END,
					event_types = COALESCE(${input.eventTypes === undefined ? drizzleSql`NULL::text[]` : textArray(input.eventTypes)}, endpoint.event_types),
					enabled = COALESCE(${enabled}::boolean, endpoint.enabled),
					disabled_reason = CASE
						WHEN ${enabled}::boolean IS NULL THEN endpoint.disabled_reason
						WHEN ${enabled}::boolean THEN NULL
						WHEN endpoint.enabled THEN 'operator'
						ELSE endpoint.disabled_reason
					END,
					failing_since = CASE
						WHEN ${enabled}::boolean AND NOT endpoint.enabled THEN NULL
						ELSE endpoint.failing_since
					END,
					updated_at = now()
				WHERE endpoint.project_id = ${projectId} AND endpoint.id = ${endpointId}
				RETURNING ${endpointColumns}
			`,
		);
		if (row === null) throw webhookError("WEBHOOK_ENDPOINT_NOT_FOUND");
		return toEndpointRecord(row);
	}

	/** Deletes an endpoint and its deliveries; recorded events stay until retention. */
	async deleteEndpoint(projectId: string, endpointId: string): Promise<{ id: string }> {
		const row = await executeOne<{ id: string }>(
			this.database,
			drizzleSql`
				DELETE FROM webhook_endpoints
				WHERE project_id = ${projectId} AND id = ${endpointId}
				RETURNING id
			`,
		);
		if (row === null) throw webhookError("WEBHOOK_ENDPOINT_NOT_FOUND");
		return { id: row.id };
	}

	/**
	 * Replaces the signing secret. The replaced one keeps signing beside the new one until the
	 * overlap ends, so receivers can switch without losing deliveries. A retried rotation with the
	 * same idempotency key changes nothing: rotating again would retire a secret nobody received.
	 */
	async rotateSecret(
		projectId: string,
		endpointId: string,
		rotation: WebhookSecretRotation,
	): Promise<{ duplicate: boolean; endpoint: WebhookEndpointRecord }> {
		return await this.transaction(async (tx) => {
			const current = await executeOne<{ secret_generation: number; rotation_key: string | null }>(
				tx,
				drizzleSql`
					SELECT secret_generation, rotation_key FROM webhook_endpoints
					WHERE project_id = ${projectId} AND id = ${endpointId}
					FOR UPDATE
				`,
			);
			if (current === null) throw webhookError("WEBHOOK_ENDPOINT_NOT_FOUND");
			if (current.rotation_key === rotation.idempotencyKey) {
				return { duplicate: true, endpoint: await requireEndpoint(tx, projectId, endpointId) };
			}
			const generation = Number(current.secret_generation) + 1;
			const overlap = rotation.overlapHours > 0;
			const row = await executeOne<EndpointRow>(
				tx,
				drizzleSql`
					UPDATE webhook_endpoints AS endpoint
					SET
						previous_secret_envelope = CASE WHEN ${overlap} THEN endpoint.secret_envelope ELSE NULL END,
						previous_secret_expires_at = CASE
							WHEN ${overlap} THEN now() + make_interval(hours => ${rotation.overlapHours})
							ELSE NULL
						END,
						secret_envelope = ${jsonb(rotation.seal(generation))},
						secret_generation = ${generation},
						rotation_key = ${rotation.idempotencyKey},
						updated_at = now()
					WHERE endpoint.project_id = ${projectId} AND endpoint.id = ${endpointId}
					RETURNING ${endpointColumns}
				`,
			);
			if (row === null) throw new Error("Locked webhook endpoint could not be rotated");
			return { duplicate: false, endpoint: toEndpointRecord(row) };
		});
	}

	/** Queues a `webhook.test` event for one endpoint, bypassing its subscription. */
	async insertTestEvent(
		projectId: string,
		endpointId: string,
	): Promise<{ eventId: string; deliveryId: string }> {
		return await this.transaction(async (tx) => {
			const endpoint = await executeOne<{ enabled: boolean }>(
				tx,
				drizzleSql`
					SELECT enabled FROM webhook_endpoints
					WHERE project_id = ${projectId} AND id = ${endpointId}
					FOR SHARE
				`,
			);
			if (endpoint === null) throw webhookError("WEBHOOK_ENDPOINT_NOT_FOUND");
			if (!endpoint.enabled) throw webhookError("WEBHOOK_ENDPOINT_DISABLED");
			const event = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					INSERT INTO domain_events (project_id, type, source_key, data, occurred_at, dispatched_at)
					VALUES (
						${projectId}, ${webhookTestEventType},
						${`${webhookTestEventType}:${crypto.randomUUID()}`},
						${jsonb({ endpointId, message: "A test delivery from Quotum" })}, now(), now()
					)
					RETURNING id
				`,
			);
			if (event === null) throw new Error("Webhook test event could not be recorded");
			const delivery = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					INSERT INTO webhook_deliveries (project_id, event_id, endpoint_id)
					VALUES (${projectId}, ${event.id}, ${endpointId})
					RETURNING id
				`,
			);
			if (delivery === null) throw new Error("Webhook test delivery could not be queued");
			return { eventId: event.id, deliveryId: delivery.id };
		});
	}

	/**
	 * Queues the events recorded in `[from, to)` that the endpoint subscribes to, narrowed to
	 * `eventTypes` when given. A delivery that already exists is queued again from its first
	 * attempt; one in flight is left alone. Test events are never replayed.
	 */
	async replay(projectId: string, endpointId: string, query: WebhookReplayQuery): Promise<number> {
		return await this.transaction(async (tx) => {
			const endpoint = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					SELECT id FROM webhook_endpoints
					WHERE project_id = ${projectId} AND id = ${endpointId}
					FOR SHARE
				`,
			);
			if (endpoint === null) throw webhookError("WEBHOOK_ENDPOINT_NOT_FOUND");
			const matching = replayEvents(projectId, endpointId, query);
			const count = await executeOne<{ count: number }>(
				tx,
				drizzleSql`
					SELECT count(*)::int AS count
					FROM (SELECT event.id FROM ${matching} LIMIT ${webhookReplayMaxEvents + 1}) bounded
				`,
			);
			if ((count?.count ?? 0) > webhookReplayMaxEvents) {
				throw webhookError("WEBHOOK_REPLAY_TOO_LARGE", { limit: webhookReplayMaxEvents });
			}
			const rows = await executeRows<{ id: string }>(
				tx,
				drizzleSql`
					INSERT INTO webhook_deliveries AS delivery (project_id, event_id, endpoint_id)
					SELECT event.project_id, event.id, ${endpointId}::uuid FROM ${matching}
					ON CONFLICT (project_id, event_id, endpoint_id) DO UPDATE
					SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL,
						locked_at = NULL, locked_by = NULL, updated_at = now()
					WHERE delivery.status <> 'processing'
					RETURNING delivery.id
				`,
			);
			return rows.length;
		});
	}

	async listDeliveries(
		projectId: string,
		options: WebhookDeliveryListOptions,
	): Promise<AdjustmentList<WebhookDeliveryRecord>> {
		const limit = requirePositiveLimit(options.limit);
		const filters = [drizzleSql`delivery.project_id = ${projectId}`];
		if (options.endpointId !== null)
			filters.push(drizzleSql`delivery.endpoint_id = ${options.endpointId}::uuid`);
		if (options.status !== null) filters.push(drizzleSql`delivery.status = ${options.status}`);
		if (options.eventType !== null) filters.push(drizzleSql`event.type = ${options.eventType}`);
		if (options.billingAccountId !== null)
			filters.push(drizzleSql`customer.billing_account_id = ${options.billingAccountId}`);
		if (options.cursor !== null) {
			const position = decodeAdminCursor(options.cursor);
			filters.push(
				drizzleSql`(delivery.created_at, delivery.id) < (${position.createdAt}::timestamptz, ${position.id}::uuid)`,
			);
		}
		const rows = await executeRows<DeliveryRow>(
			this.database,
			drizzleSql`
				${deliverySelect(drizzleSql.join(filters, drizzleSql` AND `))}
				ORDER BY delivery.created_at DESC, delivery.id DESC
				LIMIT ${limit + 1}
			`,
		);
		const last = rows[limit - 1];
		return {
			items: rows.slice(0, limit).map(toDeliveryRecord),
			nextCursor:
				rows.length > limit && last !== undefined
					? encodeAdminCursor({ createdAt: last.cursor_created_at, id: last.id })
					: null,
		};
	}

	/** Queues a delivery that failed for good again, from its first attempt. */
	async retryDelivery(
		projectId: string,
		deliveryId: string,
	): Promise<{ deliveryId: string; status: "pending" }> {
		const retried = await executeOne<{ id: string }>(
			this.database,
			drizzleSql`
				UPDATE webhook_deliveries
				SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL,
					locked_at = NULL, locked_by = NULL, updated_at = now()
				WHERE project_id = ${projectId} AND id = ${deliveryId}::uuid AND status = 'failed'
				RETURNING id
			`,
		);
		if (retried !== null) return { deliveryId: retried.id, status: "pending" };
		const existing = await executeOne<{ status: WebhookDeliveryStatus }>(
			this.database,
			drizzleSql`
				SELECT status FROM webhook_deliveries
				WHERE project_id = ${projectId} AND id = ${deliveryId}::uuid
			`,
		);
		if (existing === null) throw webhookError("WEBHOOK_DELIVERY_NOT_FOUND");
		throw webhookError("WEBHOOK_DELIVERY_NOT_FAILED", { status: existing.status });
	}
}

function textArray(values: readonly string[]): DrizzleSQL {
	return drizzleSql`ARRAY[${drizzleSql.join(
		values.map((value) => drizzleSql`${value}`),
		drizzleSql`, `,
	)}]::text[]`;
}

/** Serializes endpoint creation per project, so the cap cannot be passed by concurrent creates. */
async function lockProjectEndpoints(executor: QueryExecutor, projectId: string): Promise<void> {
	await executeRows(
		executor,
		drizzleSql`SELECT pg_advisory_xact_lock(hashtextextended(${`webhook-endpoints:${projectId}`}, 0))`,
	);
}

function replayEvents(
	projectId: string,
	endpointId: string,
	query: WebhookReplayQuery,
): DrizzleSQL {
	const narrowed =
		query.eventTypes.length === 0
			? drizzleSql`true`
			: drizzleSql`event.type = ANY(${textArray(query.eventTypes)})`;
	return drizzleSql`
		domain_events event
		JOIN webhook_endpoints endpoint
			ON endpoint.project_id = event.project_id AND endpoint.id = ${endpointId}::uuid
		WHERE event.project_id = ${projectId}
			AND event.created_at >= ${query.from.toISOString()}::timestamptz
			AND event.created_at < ${query.to.toISOString()}::timestamptz
			AND event.type <> ${webhookTestEventType}
			AND (cardinality(endpoint.event_types) = 0 OR event.type = ANY(endpoint.event_types))
			AND ${narrowed}
	`;
}

function deliverySelect(condition: DrizzleSQL): DrizzleSQL {
	return drizzleSql`
		SELECT
			delivery.id, delivery.endpoint_id, delivery.event_id, event.type, customer.billing_account_id,
			delivery.status, delivery.attempts, delivery.next_attempt_at, delivery.last_error,
			delivery.last_status_code, delivery.last_attempt_at, delivery.delivered_at,
			event.occurred_at, delivery.created_at,
			to_char(delivery.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
		FROM webhook_deliveries delivery
		JOIN domain_events event
			ON event.project_id = delivery.project_id AND event.id = delivery.event_id
		LEFT JOIN customers customer
			ON customer.project_id = event.project_id AND customer.id = event.customer_id
		WHERE ${condition}
	`;
}

async function requireEndpoint(
	executor: QueryExecutor,
	projectId: string,
	endpointId: string,
): Promise<WebhookEndpointRecord> {
	const row = await executeOne<EndpointRow>(
		executor,
		drizzleSql`
			SELECT ${endpointColumns} FROM webhook_endpoints endpoint
			WHERE endpoint.project_id = ${projectId} AND endpoint.id = ${endpointId}::uuid
		`,
	);
	if (row === null) throw webhookError("WEBHOOK_ENDPOINT_NOT_FOUND");
	return toEndpointRecord(row);
}

function toEndpointRecord(row: EndpointRow): WebhookEndpointRecord {
	return {
		id: row.id,
		url: row.url,
		description: row.description,
		eventTypes: [...row.event_types],
		enabled: row.enabled,
		disabledReason: row.disabled_reason,
		secretGeneration: Number(row.secret_generation),
		previousSecretExpiresAt:
			row.previous_secret_expires_at === null
				? null
				: formatUtcTimestamp(row.previous_secret_expires_at),
		failingSince: row.failing_since === null ? null : formatUtcTimestamp(row.failing_since),
		createdBy: row.created_by,
		createdAt: formatUtcTimestamp(row.created_at),
		updatedAt: formatUtcTimestamp(row.updated_at),
	};
}

function toDeliveryRecord(row: DeliveryRow): WebhookDeliveryRecord {
	const terminal = row.status === "succeeded" || row.status === "failed";
	return {
		id: row.id,
		endpointId: row.endpoint_id,
		eventId: row.event_id,
		eventType: row.type,
		billingAccountId: row.billing_account_id,
		status: row.status,
		attempts: Number(row.attempts),
		nextAttemptAt: terminal ? null : formatUtcTimestamp(row.next_attempt_at),
		lastError: row.last_error,
		lastStatusCode: row.last_status_code === null ? null : Number(row.last_status_code),
		lastAttemptAt: row.last_attempt_at === null ? null : formatUtcTimestamp(row.last_attempt_at),
		deliveredAt: row.delivered_at === null ? null : formatUtcTimestamp(row.delivered_at),
		occurredAt: formatUtcTimestamp(row.occurred_at),
		createdAt: formatUtcTimestamp(row.created_at),
	};
}
