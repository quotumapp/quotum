import type { SQL } from "bun";
import { validateDocumentedEvent, validateEvent } from "../../helpers/domain-event-contract";

/**
 * Subscribes a project to every event type, the way an enabled endpoint created through the API
 * would, so facts written afterwards record their events. The envelope is never opened here.
 */
export async function subscribeToEveryEvent(sql: SQL, projectId: string): Promise<void> {
	await sql`
		INSERT INTO webhook_endpoints (
			project_id, url, event_types, secret_envelope, created_by, idempotency_key, request_hash
		) VALUES (
			${projectId}, 'https://hooks.example.com/quotum', '{}',
			'{"keyId":"k1","nonce":"n","tag":"t","ciphertext":"c"}'::jsonb, 'integration-test',
			${`subscribe-all:${projectId}`}, ${"0".repeat(64)}
		)
	`;
}

export interface RecordedEvent {
	type: string;
	data: Record<string, unknown>;
	envelope: Record<string, unknown>;
}

/**
 * The events a project recorded, oldest first, each in the envelope the worker would deliver and
 * checked against the published contract, unknown fields included.
 */
export async function recordedEvents(
	sql: SQL,
	projectId: string,
	type?: string,
): Promise<RecordedEvent[]> {
	const rows = await sql`
		SELECT event.id, event.type, event.data, event.occurred_at, event.created_at,
			customer.billing_account_id, project.key AS project_key
		FROM domain_events event
		JOIN projects project ON project.id = event.project_id
		LEFT JOIN customers customer
			ON customer.project_id = event.project_id AND customer.id = event.customer_id
		WHERE event.project_id = ${projectId}
			AND (${type ?? null}::text IS NULL OR event.type = ${type ?? null})
		ORDER BY event.created_at, event.id
	`;
	return rows.map((row: Record<string, unknown>) => {
		const envelope = {
			id: row.id,
			type: row.type,
			version: 1,
			createdAt: new Date(row.created_at as string).toISOString(),
			occurredAt: new Date(row.occurred_at as string).toISOString(),
			environment: "sandbox",
			projectKey: row.project_key,
			...(row.billing_account_id === null ? {} : { billingAccountId: row.billing_account_id }),
			data: row.data,
		};
		if (!validateEvent(envelope) || !validateDocumentedEvent(envelope)) {
			throw new Error(
				`${String(row.type)} does not match the published contract: ${JSON.stringify(
					validateDocumentedEvent.errors ?? validateEvent.errors,
				)}`,
			);
		}
		return {
			type: String(row.type),
			data: row.data as Record<string, unknown>,
			envelope,
		};
	});
}
