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
import { requireNonBlank } from "./validation";

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
