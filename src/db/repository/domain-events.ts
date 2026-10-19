import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import { webhookFailingDisableAfterHours } from "../../events/endpoints";
import {
	isSealedWebhookSecret,
	type SealedWebhookSecret,
	type WebhookSecretSealer,
} from "../../events/secret-sealer";
import { RepositoryModule } from "./base";
import { assertUpdated, executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";
import { requireNonBlank, requirePositiveLimit } from "./validation";

export interface DomainEventInput {
	type: string;
	/** Names the fact, so recording it again (a redelivered webhook, a retried job) is a no-op. */
	sourceKey: string;
	customerId: string | null;
	occurredAt: Date;
	data: Record<string, unknown>;
}

/**
 * Records a billing fact as an outbound event, inside the fact's own transaction. It writes only
 * while an enabled endpoint of the project subscribes to the type, and never for an erased
 * account, so a project without webhooks pays one indexed existence check. Returns the event id,
 * or null when nothing was recorded.
 */
export async function recordDomainEvent(
	executor: QueryExecutor,
	projectId: string,
	input: DomainEventInput,
): Promise<string | null> {
	requireNonBlank(input.sourceKey, "p_source_key");
	const row = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
			INSERT INTO domain_events (project_id, customer_id, type, source_key, data, occurred_at)
			SELECT ${projectId}, ${input.customerId}::uuid, ${input.type}, ${input.sourceKey},
				${jsonb(input.data)}, ${input.occurredAt.toISOString()}::timestamptz
			WHERE EXISTS (
					SELECT 1 FROM webhook_endpoints endpoint
					WHERE endpoint.project_id = ${projectId}
						AND endpoint.enabled
						AND (
							cardinality(endpoint.event_types) = 0
							OR ${input.type} = ANY(endpoint.event_types)
						)
				)
				AND NOT EXISTS (
					SELECT 1 FROM customers customer
					WHERE customer.project_id = ${projectId}
						AND customer.id = ${input.customerId}::uuid
						AND customer.erased_at IS NOT NULL
				)
			ON CONFLICT (project_id, source_key) DO NOTHING
			RETURNING id
		`,
	);
	return row?.id ?? null;
}

/** A claimed delivery with what the worker needs to build, sign and send it. */
export interface ClaimedWebhookDelivery {
	id: string;
	projectId: string;
	projectKey: string;
	eventId: string;
	endpointId: string;
	attempts: number;
	type: string;
	data: Record<string, unknown>;
	occurredAt: string;
	createdAt: string;
	/** The account the event is about; the worker checks it is not being erased before sending. */
	customerId: string | null;
	billingAccountId: string | null;
	url: string;
	secretGeneration: number;
	secretEnvelope: SealedWebhookSecret;
	/** Present while a rotation's overlap lasts. */
	previousSecretEnvelope: SealedWebhookSecret | null;
}

interface ClaimedDeliveryRow {
	id: string;
	project_id: string;
	project_key: string;
	event_id: string;
	endpoint_id: string;
	attempts: number;
	type: string;
	data: Record<string, unknown>;
	occurred_at: Date | string;
	event_created_at: Date | string;
	customer_id: string | null;
	billing_account_id: string | null;
	url: string;
	secret_generation: number;
	secret_envelope: unknown;
	previous_secret_envelope: unknown;
}

export interface WebhookDeliveryFailure {
	error: string;
	statusCode: number | null;
	/** Null when the delivery has used its attempts and fails for good. */
	nextAttemptAt: Date | null;
}

/**
 * A delivery the worker may claim: its endpoint is enabled and its event is not about an account
 * whose erasure was requested. Used inside statements that name the delivery `delivery`.
 */
const claimable = drizzleSql`
	EXISTS (
		SELECT 1 FROM webhook_endpoints endpoint
		WHERE endpoint.project_id = delivery.project_id
			AND endpoint.id = delivery.endpoint_id
			AND endpoint.enabled
	)
	AND NOT EXISTS (
		SELECT 1 FROM domain_events event
		JOIN customers customer
			ON customer.project_id = event.project_id AND customer.id = event.customer_id
		WHERE event.project_id = delivery.project_id
			AND event.id = delivery.event_id
			AND customer.erased_at IS NOT NULL
	)
`;

/**
 * Moves an endpoint's pending deliveries out of the due range while it is disabled, or back into
 * it when it is enabled again, so a disabled endpoint's backlog never sits at the head of the
 * claim's index scan.
 */
export async function parkEndpointDeliveries(
	executor: QueryExecutor,
	projectId: string,
	endpointId: string,
	enabled: boolean,
): Promise<void> {
	await executeRows(
		executor,
		enabled
			? drizzleSql`
				UPDATE webhook_deliveries SET next_attempt_at = now(), updated_at = now()
				WHERE project_id = ${projectId} AND endpoint_id = ${endpointId}
					AND status = 'pending' AND next_attempt_at = 'infinity'
			`
			: drizzleSql`
				UPDATE webhook_deliveries SET next_attempt_at = 'infinity', updated_at = now()
				WHERE project_id = ${projectId} AND endpoint_id = ${endpointId}
					AND status = 'pending' AND next_attempt_at <> 'infinity'
			`,
	);
}

export class DomainEventDeliveryRepository extends RepositoryModule {
	/**
	 * Fans recorded events out to one delivery per endpoint that is enabled, subscribes to the
	 * type and existed when the event was recorded. An endpoint disabled at this moment gets no
	 * delivery; a replay can queue one later.
	 */
	async dispatchEvents(limit: number): Promise<number> {
		const cappedLimit = requirePositiveLimit(limit);
		const rows = await executeRows<{ id: string }>(
			this.database,
			drizzleSql`
				WITH claimed AS (
					SELECT event.id, event.project_id, event.type, event.created_at
					FROM domain_events event
					WHERE event.dispatched_at IS NULL
					ORDER BY event.created_at ASC
					LIMIT ${cappedLimit}
					FOR UPDATE SKIP LOCKED
				),
				fanned_out AS (
					INSERT INTO webhook_deliveries (project_id, event_id, endpoint_id)
					SELECT claimed.project_id, claimed.id, endpoint.id
					FROM claimed
					JOIN webhook_endpoints endpoint
						ON endpoint.project_id = claimed.project_id
						AND endpoint.enabled
						AND endpoint.created_at <= claimed.created_at
						AND (
							cardinality(endpoint.event_types) = 0
							OR claimed.type = ANY(endpoint.event_types)
						)
					ON CONFLICT (project_id, event_id, endpoint_id) DO NOTHING
					RETURNING 1
				)
				UPDATE domain_events event
				SET dispatched_at = now()
				FROM claimed
				WHERE event.project_id = claimed.project_id AND event.id = claimed.id
				RETURNING event.id
			`,
		);
		return rows.length;
	}

	async claimDeliveries(workerId: string, limit: number): Promise<ClaimedWebhookDelivery[]> {
		requireNonBlank(workerId, "p_worker_id");
		const cappedLimit = requirePositiveLimit(limit);
		// The same bounded, per-project fair claim as projection jobs. A delivery waits while its
		// endpoint is disabled and resumes when it is enabled again; disabling parks its deliveries
		// out of the due range, and the candidate scan skips any that are not claimable, so one
		// tenant's disabled endpoint can never fill the candidate set of every tenant.
		const candidateLimit = cappedLimit * 10;
		const claimed = await executeRows<{ id: string; project_id: string }>(
			this.database,
			drizzleSql`
			WITH candidates AS (
				(
					SELECT delivery.id, delivery.project_id, delivery.next_attempt_at AS due_at, delivery.created_at
					FROM webhook_deliveries delivery
					WHERE delivery.status = 'pending' AND delivery.next_attempt_at <= now()
						AND ${claimable}
					ORDER BY delivery.next_attempt_at ASC, delivery.created_at ASC
					LIMIT ${candidateLimit}
				)
				UNION ALL
				(
					SELECT delivery.id, delivery.project_id, delivery.locked_at AS due_at, delivery.created_at
					FROM webhook_deliveries delivery
					WHERE delivery.status = 'processing' AND delivery.locked_at <= now() - INTERVAL '5 minutes'
						AND ${claimable}
					ORDER BY delivery.locked_at ASC, delivery.created_at ASC
					LIMIT ${candidateLimit}
				)
			),
			ranked AS (
				SELECT
					candidates.id,
					ROW_NUMBER() OVER (
						PARTITION BY candidates.project_id
						ORDER BY candidates.due_at ASC, candidates.created_at ASC
					) AS project_rank,
					candidates.due_at,
					candidates.created_at
				FROM candidates
			),
			due AS (
				SELECT delivery.id
				FROM webhook_deliveries delivery
				JOIN ranked ON ranked.id = delivery.id
				WHERE (
						(delivery.status = 'pending' AND delivery.next_attempt_at <= now())
						OR (delivery.status = 'processing' AND delivery.locked_at <= now() - INTERVAL '5 minutes')
					)
					AND ${claimable}
				ORDER BY ranked.project_rank ASC, ranked.due_at ASC, ranked.created_at ASC
				LIMIT ${cappedLimit}
				FOR UPDATE OF delivery SKIP LOCKED
			)
			UPDATE webhook_deliveries delivery
			SET status = 'processing', locked_at = now(), locked_by = ${workerId}, updated_at = now()
			FROM due
			WHERE delivery.id = due.id
				AND (
					(delivery.status = 'pending' AND delivery.next_attempt_at <= now())
					OR (delivery.status = 'processing' AND delivery.locked_at <= now() - INTERVAL '5 minutes')
				)
			RETURNING delivery.id, delivery.project_id
		`,
		);
		if (claimed.length === 0) return [];
		const ids = claimed.map((row) => row.id);
		const rows = await executeRows<ClaimedDeliveryRow>(
			this.database,
			drizzleSql`
				SELECT
					delivery.id, delivery.project_id, project.key AS project_key, delivery.event_id,
					delivery.endpoint_id, delivery.attempts, event.type, event.data, event.occurred_at,
					event.created_at AS event_created_at, event.customer_id, customer.billing_account_id,
					endpoint.url,
					endpoint.secret_generation, endpoint.secret_envelope,
					CASE
						WHEN endpoint.previous_secret_expires_at > now() THEN endpoint.previous_secret_envelope
						ELSE NULL
					END AS previous_secret_envelope
				FROM webhook_deliveries delivery
				JOIN projects project ON project.id = delivery.project_id
				JOIN domain_events event
					ON event.project_id = delivery.project_id AND event.id = delivery.event_id
				JOIN webhook_endpoints endpoint
					ON endpoint.project_id = delivery.project_id AND endpoint.id = delivery.endpoint_id
				LEFT JOIN customers customer
					ON customer.project_id = event.project_id AND customer.id = event.customer_id
				WHERE delivery.id = ANY(${uuidArray(ids)})
					AND delivery.project_id = ANY(${uuidArray(claimed.map((row) => row.project_id))})
					AND delivery.locked_by = ${workerId}
				ORDER BY delivery.created_at ASC
			`,
		);
		return rows.map(toClaimedDelivery);
	}

	async markDeliverySucceeded(
		projectId: string,
		deliveryId: string,
		workerId: string,
		statusCode: number,
	): Promise<void> {
		await this.transaction(async (tx) => {
			const delivery = await executeOne<{ endpoint_id: string }>(
				tx,
				drizzleSql`
					UPDATE webhook_deliveries delivery
					SET status = 'succeeded', attempts = LEAST(delivery.attempts::bigint + 1, 2147483647)::integer,
						last_error = NULL, last_status_code = ${statusCode}, last_attempt_at = now(),
						delivered_at = now(), locked_at = NULL, locked_by = NULL, updated_at = now()
					WHERE delivery.project_id = ${projectId} AND delivery.id = ${deliveryId}
						AND delivery.status = 'processing' AND delivery.locked_by = ${workerId}
					RETURNING delivery.endpoint_id
				`,
			);
			if (delivery === null) {
				throw new Error(`webhook delivery ${deliveryId} is not locked by worker ${workerId}`);
			}
			await executeRows(
				tx,
				drizzleSql`
					UPDATE webhook_endpoints SET failing_since = NULL, updated_at = now()
					WHERE project_id = ${projectId} AND id = ${delivery.endpoint_id}
						AND failing_since IS NOT NULL
				`,
			);
		});
	}

	/**
	 * Holds back a claimed delivery whose account is being erased. The shared lock on the account
	 * serializes this with an erasure request, which locks the account before it checks for
	 * deliveries in flight: a request that came first is seen here, and one that comes later sees
	 * this delivery as in flight and waits. A held delivery is parked, never sent, and the erasure
	 * deletes it with its event.
	 */
	async holdIfAccountErased(
		projectId: string,
		deliveryId: string,
		workerId: string,
	): Promise<boolean> {
		return await this.transaction(async (tx) => {
			const account = await executeOne<{ erased: boolean }>(
				tx,
				drizzleSql`
					SELECT customer.erased_at IS NOT NULL AS erased
					FROM webhook_deliveries delivery
					JOIN domain_events event
						ON event.project_id = delivery.project_id AND event.id = delivery.event_id
					JOIN customers customer
						ON customer.project_id = event.project_id AND customer.id = event.customer_id
					WHERE delivery.project_id = ${projectId} AND delivery.id = ${deliveryId}
					FOR SHARE OF customer
				`,
			);
			if (account === null || !account.erased) return false;
			await assertUpdated(
				tx,
				drizzleSql`
					UPDATE webhook_deliveries
					SET status = 'pending', next_attempt_at = 'infinity', locked_at = NULL,
						locked_by = NULL, updated_at = now()
					WHERE project_id = ${projectId} AND id = ${deliveryId}
						AND status = 'processing' AND locked_by = ${workerId}
					RETURNING id
				`,
				`webhook delivery ${deliveryId} is not locked by worker ${workerId}`,
			);
			return true;
		});
	}

	/**
	 * Records a failed attempt. The endpoint starts failing at its first failure after a success,
	 * and is disabled once every delivery has failed for long enough: a dead receiver must not
	 * keep a worker busy for every event the project records.
	 */
	async markDeliveryFailed(
		projectId: string,
		deliveryId: string,
		workerId: string,
		failure: WebhookDeliveryFailure,
	): Promise<{ endpointDisabled: boolean }> {
		const nextAttemptAt = failure.nextAttemptAt?.toISOString() ?? null;
		return await this.transaction(async (tx) => {
			const delivery = await executeOne<{ endpoint_id: string }>(
				tx,
				drizzleSql`
					UPDATE webhook_deliveries delivery
					SET status = CASE WHEN ${nextAttemptAt}::timestamptz IS NULL THEN 'failed' ELSE 'pending' END,
						attempts = LEAST(delivery.attempts::bigint + 1, 2147483647)::integer,
						last_error = left(${failure.error}, 1000),
						last_status_code = ${failure.statusCode},
						last_attempt_at = now(),
						next_attempt_at = COALESCE(${nextAttemptAt}::timestamptz, delivery.next_attempt_at),
						locked_at = NULL, locked_by = NULL, updated_at = now()
					WHERE delivery.project_id = ${projectId} AND delivery.id = ${deliveryId}
						AND delivery.status = 'processing' AND delivery.locked_by = ${workerId}
					RETURNING delivery.endpoint_id
				`,
			);
			if (delivery === null) {
				throw new Error(`webhook delivery ${deliveryId} is not locked by worker ${workerId}`);
			}
			const endpoint = await executeOne<{ enabled: boolean }>(
				tx,
				drizzleSql`
					UPDATE webhook_endpoints endpoint
					SET failing_since = COALESCE(endpoint.failing_since, now()),
						enabled = endpoint.enabled AND NOT (
							endpoint.failing_since IS NOT NULL
							AND endpoint.failing_since <= now() - make_interval(hours => ${webhookFailingDisableAfterHours})
						),
						disabled_reason = CASE
							WHEN endpoint.enabled AND endpoint.failing_since IS NOT NULL
								AND endpoint.failing_since <= now() - make_interval(hours => ${webhookFailingDisableAfterHours})
								THEN 'failing'
							ELSE endpoint.disabled_reason
						END,
						updated_at = now()
					WHERE endpoint.project_id = ${projectId} AND endpoint.id = ${delivery.endpoint_id}
					RETURNING endpoint.enabled
				`,
			);
			const endpointDisabled = endpoint !== null && !endpoint.enabled;
			if (endpointDisabled) {
				await parkEndpointDeliveries(tx, projectId, delivery.endpoint_id, false);
			}
			return { endpointDisabled };
		});
	}

	/**
	 * Deletes events past retention, with their deliveries, except while a delivery is in flight;
	 * a delivery still pending after the retention period is dropped with its event. Also forgets
	 * replaced secrets whose overlap has ended.
	 */
	async deleteExpiredEvents(retentionDays: number, limit: number): Promise<number> {
		const cappedLimit = Math.max(1, Math.min(limit, 1000));
		await executeRows(
			this.database,
			drizzleSql`
				UPDATE webhook_endpoints
				SET previous_secret_envelope = NULL, previous_secret_expires_at = NULL, updated_at = now()
				WHERE previous_secret_expires_at <= now()
			`,
		);
		const rows = await executeRows<{ id: string }>(
			this.database,
			drizzleSql`
				DELETE FROM domain_events event
				USING (
					SELECT expired.project_id, expired.id
					FROM domain_events expired
					WHERE expired.created_at < now() - make_interval(days => ${retentionDays})
						AND NOT EXISTS (
							SELECT 1 FROM webhook_deliveries delivery
							WHERE delivery.project_id = expired.project_id
								AND delivery.event_id = expired.id
								AND delivery.status = 'processing'
						)
					ORDER BY expired.created_at ASC
					LIMIT ${cappedLimit}
					FOR UPDATE SKIP LOCKED
				) doomed
				WHERE event.project_id = doomed.project_id AND event.id = doomed.id
				RETURNING event.id
			`,
		);
		return rows.length;
	}

	/** How many endpoints still hold an envelope sealed with another key than `keyId`. */
	async countEndpointSecretsSealedWithOtherKeys(keyId: string): Promise<number> {
		const row = await executeOne<{ count: number }>(
			this.database,
			drizzleSql`
				SELECT count(*)::int AS count FROM webhook_endpoints
				WHERE secret_envelope->>'keyId' <> ${keyId}
					OR (previous_secret_envelope IS NOT NULL AND previous_secret_envelope->>'keyId' <> ${keyId})
			`,
		);
		return Number(row?.count ?? 0);
	}

	/**
	 * Re-seals endpoint secrets that are sealed with another key than the sealer's active one, a
	 * batch at a time. Returns how many endpoints changed; zero means the rotation is complete.
	 */
	async resealEndpointSecrets(sealer: WebhookSecretSealer, limit = 100): Promise<number> {
		const keyId = sealer.activeKeyId;
		return await this.transaction(async (tx) => {
			const rows = await executeRows<{
				id: string;
				project_id: string;
				secret_generation: number;
				secret_envelope: unknown;
				previous_secret_envelope: unknown;
			}>(
				tx,
				drizzleSql`
					SELECT id, project_id, secret_generation, secret_envelope, previous_secret_envelope
					FROM webhook_endpoints
					WHERE (
							secret_envelope->>'keyId' <> ${keyId}
							OR (previous_secret_envelope IS NOT NULL AND previous_secret_envelope->>'keyId' <> ${keyId})
						)
					ORDER BY id
					LIMIT ${limit}
					FOR UPDATE SKIP LOCKED
				`,
			);
			for (const row of rows) {
				const reseal = (envelope: unknown, generation: number) => {
					const sealed = sealedSecret(envelope);
					if (sealed.keyId === keyId) return sealed;
					const scope = { projectId: row.project_id, endpointId: row.id, generation };
					return sealer.seal(sealer.open(sealed, scope), scope);
				};
				const current = reseal(row.secret_envelope, row.secret_generation);
				const previous =
					row.previous_secret_envelope === null
						? null
						: reseal(row.previous_secret_envelope, row.secret_generation - 1);
				await assertUpdated(
					tx,
					drizzleSql`
						UPDATE webhook_endpoints
						SET secret_envelope = ${jsonb(current)},
							previous_secret_envelope = ${previous === null ? null : jsonb(previous)},
							updated_at = now()
						WHERE project_id = ${row.project_id} AND id = ${row.id}
						RETURNING id
					`,
					`webhook endpoint ${row.id} could not be re-sealed`,
				);
			}
			return rows.length;
		});
	}
}

function uuidArray(values: readonly string[]): DrizzleSQL {
	return drizzleSql`ARRAY[${drizzleSql.join(
		values.map((value) => drizzleSql`${value}`),
		drizzleSql`, `,
	)}]::uuid[]`;
}

function sealedSecret(value: unknown): SealedWebhookSecret {
	if (!isSealedWebhookSecret(value)) throw new Error("Webhook endpoint secret envelope is invalid");
	return value;
}

function toClaimedDelivery(row: ClaimedDeliveryRow): ClaimedWebhookDelivery {
	return {
		id: row.id,
		projectId: row.project_id,
		projectKey: row.project_key,
		eventId: row.event_id,
		endpointId: row.endpoint_id,
		attempts: Number(row.attempts),
		type: row.type,
		data: row.data,
		occurredAt: new Date(row.occurred_at).toISOString(),
		createdAt: new Date(row.event_created_at).toISOString(),
		customerId: row.customer_id,
		billingAccountId: row.billing_account_id,
		url: row.url,
		secretGeneration: Number(row.secret_generation),
		secretEnvelope: sealedSecret(row.secret_envelope),
		previousSecretEnvelope:
			row.previous_secret_envelope === null ? null : sealedSecret(row.previous_secret_envelope),
	};
}
