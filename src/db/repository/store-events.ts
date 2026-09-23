import { createHash } from "node:crypto";
import { sql as drizzleSql } from "drizzle-orm";
import type {
	BillingChannel,
	BillingProvider,
	PurchaseKind,
	StoreEventProcessingStatus,
} from "../../billing/types";
import { canonicalJson } from "../../shared/canonical-json";
import { executeOne, jsonb } from "./query";
import type {
	QueryExecutor,
	RecordStripeSkippedEventInput,
	StoreEventProcessingResult,
} from "./types";
import { isUuid, requireNonBlank } from "./validation";

export async function recordStoreEventProcessingResult(
	executor: QueryExecutor,
	projectId: string,
	input: {
		provider: BillingProvider;
		channel: BillingChannel;
		externalEventId: string | null;
		eventType: string;
		customerId: string | null;
		storeProductId: string | null;
		transactionId: string | null;
		purchaseKind: PurchaseKind | null;
		processingStatus: Extract<StoreEventProcessingStatus, "processed" | "skipped">;
		processingError: string | null;
		rawPayload: Record<string, unknown>;
		raiseIdentityMismatch: boolean;
		replayStoreEventId?: string | null;
	},
): Promise<StoreEventProcessingResult> {
	const eventFingerprint = storeEventFingerprint(input);
	const replayStoreEventId = input.replayStoreEventId ?? null;
	if (input.externalEventId === null) {
		const row = await executeOne<{ id: string }>(
			executor,
			drizzleSql`
			INSERT INTO store_events (
				project_id,
				provider,
				channel,
				external_event_id,
				event_fingerprint,
				event_type,
				customer_id,
				store_product_id,
				transaction_id,
				purchase_kind,
				processing_status,
				processing_error,
				raw_payload,
				processed_at,
				locked_at,
				locked_by
			)
			VALUES (
				${projectId},
				${input.provider},
				${input.channel},
				NULL,
				${eventFingerprint},
				${input.eventType},
				${input.customerId},
				${input.storeProductId},
				${input.transactionId},
				${input.purchaseKind},
				${input.processingStatus},
				${input.processingError},
				${jsonb(input.rawPayload)},
				now(),
				NULL,
				NULL
			)
			ON CONFLICT (project_id, provider, event_fingerprint) WHERE external_event_id IS NULL AND event_fingerprint IS NOT NULL DO UPDATE SET
				customer_id = EXCLUDED.customer_id,
				store_product_id = EXCLUDED.store_product_id,
				transaction_id = EXCLUDED.transaction_id,
				purchase_kind = EXCLUDED.purchase_kind,
				processing_status = CASE
					WHEN store_events.processing_status = 'processing' THEN store_events.processing_status
					ELSE EXCLUDED.processing_status
				END,
				processing_error = EXCLUDED.processing_error,
				raw_payload = EXCLUDED.raw_payload,
				processed_at = now(),
				locked_at = CASE
					WHEN store_events.processing_status = 'processing' THEN store_events.locked_at
					ELSE NULL
				END,
				locked_by = CASE
					WHEN store_events.processing_status = 'processing' THEN store_events.locked_by
					ELSE NULL
				END,
				updated_at = now()
			WHERE (
					store_events.processing_status IN ('pending', 'skipped', 'failed')
					OR (
						${replayStoreEventId}::uuid IS NOT NULL
						AND store_events.id = ${replayStoreEventId}::uuid
					)
				)
				AND (store_events.customer_id IS NULL OR store_events.customer_id = EXCLUDED.customer_id)
				AND (store_events.store_product_id IS NULL OR store_events.store_product_id = EXCLUDED.store_product_id)
				AND (store_events.transaction_id IS NULL OR store_events.transaction_id = EXCLUDED.transaction_id)
				AND store_events.channel = EXCLUDED.channel
				AND store_events.event_type = EXCLUDED.event_type
				AND (store_events.purchase_kind IS NULL OR store_events.purchase_kind = EXCLUDED.purchase_kind)
			RETURNING id
		`,
		);
		if (row !== null) {
			return { storeEventId: row.id, applied: true };
		}

		const existing = await executeOne<{ id: string }>(
			executor,
			drizzleSql`
			SELECT events.id
			FROM store_events events
				WHERE events.project_id = ${projectId}
					AND events.provider = ${input.provider}
					AND events.external_event_id IS NULL
					AND events.event_fingerprint = ${eventFingerprint}
					AND (events.customer_id IS NULL OR events.customer_id = ${input.customerId})
					AND (events.store_product_id IS NULL OR events.store_product_id = ${input.storeProductId})
					AND (events.transaction_id IS NULL OR events.transaction_id = ${input.transactionId})
					AND events.channel = ${input.channel}
					AND events.event_type = ${input.eventType}
					AND (events.purchase_kind IS NULL OR events.purchase_kind = ${input.purchaseKind})
				LIMIT 1
			`,
		);
		if (existing === null && input.raiseIdentityMismatch) {
			throw new Error(
				`store event identity mismatch for provider ${input.provider} null external event fingerprint ${eventFingerprint}`,
			);
		}
		return { storeEventId: existing?.id ?? null, applied: false };
	}

	const row = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
		INSERT INTO store_events (
			project_id,
			provider,
			channel,
			external_event_id,
			event_fingerprint,
			event_type,
			customer_id,
			store_product_id,
			transaction_id,
			purchase_kind,
			processing_status,
			processing_error,
			raw_payload,
			processed_at,
			locked_at,
			locked_by
		)
		VALUES (
			${projectId},
			${input.provider},
			${input.channel},
			${input.externalEventId},
			${eventFingerprint},
			${input.eventType},
			${input.customerId},
			${input.storeProductId},
			${input.transactionId},
			${input.purchaseKind},
			${input.processingStatus},
			${input.processingError},
			${jsonb(input.rawPayload)},
			now(),
			NULL,
			NULL
		)
		ON CONFLICT (project_id, provider, external_event_id) WHERE external_event_id IS NOT NULL DO UPDATE SET
			customer_id = EXCLUDED.customer_id,
			store_product_id = EXCLUDED.store_product_id,
			transaction_id = EXCLUDED.transaction_id,
			purchase_kind = EXCLUDED.purchase_kind,
			processing_status = CASE
				WHEN store_events.processing_status = 'processing' THEN store_events.processing_status
				ELSE EXCLUDED.processing_status
			END,
			processing_error = EXCLUDED.processing_error,
			raw_payload = EXCLUDED.raw_payload,
			processed_at = now(),
			locked_at = CASE
				WHEN store_events.processing_status = 'processing' THEN store_events.locked_at
				ELSE NULL
			END,
			locked_by = CASE
				WHEN store_events.processing_status = 'processing' THEN store_events.locked_by
				ELSE NULL
			END,
			updated_at = now()
		WHERE (
				store_events.processing_status IN ('pending', 'skipped', 'failed')
				OR (
					${replayStoreEventId}::uuid IS NOT NULL
					AND store_events.id = ${replayStoreEventId}::uuid
				)
			)
			AND (store_events.customer_id IS NULL OR store_events.customer_id = EXCLUDED.customer_id)
			AND (store_events.store_product_id IS NULL OR store_events.store_product_id = EXCLUDED.store_product_id)
			AND (store_events.transaction_id IS NULL OR store_events.transaction_id = EXCLUDED.transaction_id)
			AND store_events.channel = EXCLUDED.channel
			AND store_events.event_type = EXCLUDED.event_type
			AND (store_events.purchase_kind IS NULL OR store_events.purchase_kind = EXCLUDED.purchase_kind)
		RETURNING id
	`,
	);

	if (row !== null) {
		return { storeEventId: row.id, applied: true };
	}

	const existing = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
		SELECT events.id
		FROM store_events events
			WHERE events.project_id = ${projectId}
				AND events.provider = ${input.provider}
				AND events.external_event_id = ${input.externalEventId}
				AND (events.customer_id IS NULL OR events.customer_id = ${input.customerId})
				AND (events.store_product_id IS NULL OR events.store_product_id = ${input.storeProductId})
				AND (events.transaction_id IS NULL OR events.transaction_id = ${input.transactionId})
				AND events.channel = ${input.channel}
				AND events.event_type = ${input.eventType}
				AND (events.purchase_kind IS NULL OR events.purchase_kind = ${input.purchaseKind})
			LIMIT 1
	`,
	);
	if (existing === null && input.raiseIdentityMismatch) {
		throw new Error(
			`store event identity mismatch for provider ${input.provider} external event ${input.externalEventId}`,
		);
	}
	return { storeEventId: existing?.id ?? null, applied: false };
}

export function storeEventFingerprint(input: {
	provider: BillingProvider;
	channel: BillingChannel;
	externalEventId: string | null;
	eventType: string;
	transactionId: string | null;
	purchaseKind: PurchaseKind | null;
	rawPayload: Record<string, unknown>;
}): string | null {
	if (input.externalEventId !== null) {
		return null;
	}

	return createHash("sha256")
		.update(
			canonicalJson({
				provider: input.provider,
				channel: input.channel,
				eventType: input.eventType,
				transactionId: input.transactionId,
				purchaseKind: input.purchaseKind,
				rawPayload: input.rawPayload,
			}),
		)
		.digest("hex");
}

export async function recordStripeSkippedEventInTransaction(
	executor: QueryExecutor,
	projectId: string,
	input: RecordStripeSkippedEventInput,
): Promise<void> {
	requireNonBlank(input.eventType, "p_event_type");
	requireNonBlank(input.processingError, "p_processing_error");
	await recordStoreEventProcessingResult(executor, projectId, {
		provider: "stripe",
		channel: "web",
		externalEventId: input.externalEventId,
		eventType: input.eventType,
		customerId: null,
		storeProductId: null,
		transactionId: input.transactionId,
		purchaseKind: input.purchaseKind,
		processingStatus: "skipped",
		processingError: input.processingError,
		rawPayload: input.rawPayload,
		raiseIdentityMismatch: false,
		replayStoreEventId: input.replayStoreEventId ?? null,
	});
}

/** The internal store event type that carries one setup's reconciliation task. */
export const paymentSetupReconcileEventType = "quotum.payment_setup.reconcile";

/**
 * Durably queues a provider event for the replay worker without applying it. The webhook route uses
 * this so a setup completion or expiry is safe on disk before the provider is acknowledged; the
 * work itself happens under a worker lease, outside the request.
 *
 * A second delivery of the same event is a no-op: the row is inserted once and never moved back to
 * `pending` after it has been processed.
 */
export async function enqueueStoreEventForReplay(
	executor: QueryExecutor,
	projectId: string,
	input: {
		provider: BillingProvider;
		channel: BillingChannel;
		externalEventId: string | null;
		eventType: string;
		transactionId: string | null;
		rawPayload: Record<string, unknown>;
		nextAttemptAt?: Date | null;
	},
): Promise<{ storeEventId: string; enqueued: boolean }> {
	requireNonBlank(input.eventType, "p_event_type");
	const eventFingerprint = storeEventFingerprint({
		provider: input.provider,
		channel: input.channel,
		externalEventId: input.externalEventId,
		eventType: input.eventType,
		transactionId: input.transactionId,
		purchaseKind: null,
		rawPayload: input.rawPayload,
	});
	const nextAttemptAt = input.nextAttemptAt?.toISOString() ?? null;
	const conflictTarget =
		input.externalEventId === null
			? drizzleSql`(project_id, provider, event_fingerprint) WHERE external_event_id IS NULL AND event_fingerprint IS NOT NULL`
			: drizzleSql`(project_id, provider, external_event_id) WHERE external_event_id IS NOT NULL`;
	// Link only a persisted setup in this project. Metadata from another environment must
	// never attach its event to a same-named local billing account; malformed IDs are harmless.
	const eventData = input.rawPayload.data as {
		object?: { metadata?: { quotumPaymentSetupId?: unknown } };
	} | null;
	const setupId =
		input.eventType === paymentSetupReconcileEventType
			? input.rawPayload.quotumPaymentSetupId
			: ["checkout.session.completed", "checkout.session.expired"].includes(input.eventType)
				? eventData?.object?.metadata?.quotumPaymentSetupId
				: null;
	const setupCustomer =
		input.provider === "stripe" && typeof setupId === "string" && isUuid(setupId)
			? drizzleSql`(SELECT customer_id FROM payment_setup_sessions WHERE project_id = ${projectId} AND id = ${setupId}::uuid)`
			: drizzleSql`NULL`;
	const inserted = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
			INSERT INTO store_events (
				project_id, provider, channel, external_event_id, event_fingerprint, event_type,
				transaction_id, processing_status, raw_payload, next_attempt_at, customer_id
			)
			VALUES (
				${projectId}, ${input.provider}, ${input.channel}, ${input.externalEventId},
				${eventFingerprint}, ${input.eventType}, ${input.transactionId}, 'pending',
				${jsonb(input.rawPayload)}, COALESCE(${nextAttemptAt}::timestamptz, now()), ${setupCustomer}
			)
			ON CONFLICT ${conflictTarget} DO NOTHING
			RETURNING id
		`,
	);
	if (inserted !== null) return { storeEventId: inserted.id, enqueued: true };

	const existing = await executeOne<{ id: string }>(
		executor,
		input.externalEventId === null
			? drizzleSql`
				SELECT id FROM store_events
				WHERE project_id = ${projectId} AND provider = ${input.provider}
					AND external_event_id IS NULL AND event_fingerprint = ${eventFingerprint}
				LIMIT 1
			`
			: drizzleSql`
				SELECT id FROM store_events
				WHERE project_id = ${projectId} AND provider = ${input.provider}
					AND external_event_id = ${input.externalEventId}
				LIMIT 1
			`,
	);
	if (existing === null) {
		throw new Error(`store event ${input.eventType} could not be queued for replay`);
	}
	return { storeEventId: existing.id, enqueued: false };
}

/**
 * Queues, or brings forward, the one reconciliation task that watches a setup. An unresolved task
 * is rescheduled rather than duplicated, and a task that already finished is left alone.
 */
export async function schedulePaymentSetupReconciliation(
	executor: QueryExecutor,
	projectId: string,
	input: { setupId: string; nextAttemptAt: Date },
): Promise<string> {
	const payload = { quotumPaymentSetupId: input.setupId };
	const queued = await enqueueStoreEventForReplay(executor, projectId, {
		provider: "stripe",
		channel: "web",
		externalEventId: null,
		eventType: paymentSetupReconcileEventType,
		transactionId: input.setupId,
		rawPayload: payload,
		nextAttemptAt: input.nextAttemptAt,
	});
	if (!queued.enqueued) {
		await executeOne(
			executor,
			drizzleSql`
				UPDATE store_events
				SET next_attempt_at = LEAST(next_attempt_at, ${input.nextAttemptAt.toISOString()}::timestamptz),
					processing_status = CASE
						WHEN processing_status IN ('failed', 'skipped') THEN 'pending'
						ELSE processing_status
					END,
					updated_at = now()
				WHERE project_id = ${projectId} AND id = ${queued.storeEventId}
					AND processing_status <> 'processed'
				RETURNING id
			`,
		);
	}
	return queued.storeEventId;
}
