import type { SQL } from "bun";
import type {
	BillingChannel,
	BillingProvider,
	StoreEventProcessingStatus,
} from "../../../src/billing/types";

export async function makeProjectionJobDue(sql: SQL, jobId: string): Promise<void> {
	await sql`
		UPDATE projection_sync_jobs
		SET next_attempt_at = now() - INTERVAL '1 second'
		WHERE id = ${jobId}
	`;
}

export async function expireProjectionJobLock(sql: SQL, jobId: string): Promise<void> {
	await sql`
		UPDATE projection_sync_jobs
		SET locked_at = now() - INTERVAL '6 minutes'
		WHERE id = ${jobId}
			AND status = 'processing'
	`;
}

export async function setProjectionJobAttempts(
	sql: SQL,
	jobId: string,
	attempts: number,
): Promise<void> {
	await sql`
		UPDATE projection_sync_jobs
		SET attempts = ${attempts}
		WHERE id = ${jobId}
	`;
}

export async function makeStoreEventDue(sql: SQL, eventId: string): Promise<void> {
	await sql`
		UPDATE store_events
		SET next_attempt_at = now() - INTERVAL '1 second'
		WHERE id = ${eventId}
	`;
}

export async function expireStoreEventLock(sql: SQL, eventId: string): Promise<void> {
	await sql`
		UPDATE store_events
		SET locked_at = now() - INTERVAL '6 minutes'
		WHERE id = ${eventId}
			AND processing_status = 'processing'
	`;
}

export async function seedReplayEvent(
	sql: SQL,
	input: {
		projectKey: "voysee" | "wiseley";
		provider: Extract<BillingProvider, "google" | "stripe">;
		channel: Extract<BillingChannel, "android" | "web">;
		status: Extract<StoreEventProcessingStatus, "pending" | "skipped" | "failed">;
		eventType: string;
		externalEventId: string;
	},
): Promise<string> {
	const rows = await sql<{ id: string }[]>`
		INSERT INTO store_events (
			project_id,
			provider,
			channel,
			external_event_id,
			event_type,
			processing_status,
			processing_error,
			raw_payload,
			next_attempt_at
		)
		SELECT projects.id, ${input.provider}, ${input.channel}, ${input.externalEventId},
			${input.eventType}, ${input.status}, 'integration replay seed',
			${JSON.stringify({ projectKey: input.projectKey, provider: input.provider })}::jsonb,
			now() - INTERVAL '1 second'
		FROM projects
		WHERE projects.key = ${input.projectKey}
		RETURNING id
	`;

	if (rows.length !== 1) {
		throw new Error(`Expected one replay event seed row for ${input.externalEventId}`);
	}
	return rows[0].id;
}

export async function makeSubscriptionExpired(
	sql: SQL,
	projectKey: "voysee" | "wiseley",
	externalSubscriptionId: string,
): Promise<void> {
	await sql`
		UPDATE subscriptions
		SET
			expires_at = now() - INTERVAL '1 hour',
			provider_reconciled_at = now(),
			provider_reconciliation_next_attempt_at = now() - INTERVAL '1 hour'
		FROM projects
		WHERE projects.id = subscriptions.project_id
			AND projects.key = ${projectKey}
			AND subscriptions.external_subscription_id = ${externalSubscriptionId}
	`;
}
