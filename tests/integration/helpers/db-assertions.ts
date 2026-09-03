import { expect } from "bun:test";
import type { SQL } from "bun";
import type {
	BillingProvider,
	ProjectionPayload,
	ProjectionSyncReason,
	ProjectionSyncStatus,
	StoreEventProcessingStatus,
} from "../../../src/billing/types";

interface CustomerAssertionRow {
	id: string;
	billing_account_id: string;
	project_key: string;
}

interface ProjectionJobAssertionRow {
	id: string;
	project_key: string;
	idempotency_key: string;
	reason: ProjectionSyncReason;
	status: ProjectionSyncStatus;
	attempts: number;
	last_error: string | null;
	next_attempt_at: string | null;
	locked_at: string | null;
	locked_by: string | null;
	payload: ProjectionPayload;
}

interface StoreEventAssertionRow {
	id: string;
	provider: BillingProvider;
	external_event_id: string | null;
	event_type: string;
	processing_status: StoreEventProcessingStatus;
	processing_error: string | null;
	attempts: number;
	next_attempt_at: string | null;
	processed_at: string | null;
	locked_at: string | null;
	locked_by: string | null;
}

export async function projectId(sql: SQL, key = "voysee"): Promise<string> {
	const rows = await sql<{ id: string }[]>`
		SELECT id
		FROM projects
		WHERE key = ${key}
	`;

	expect(rows).toHaveLength(1);
	return rows[0].id;
}

export async function tableCount(sql: SQL, tableName: string): Promise<number> {
	if (!/^[a-z_][a-z0-9_]*$/.test(tableName)) {
		throw new Error(`invalid public table name ${tableName}`);
	}

	const rows = await sql.unsafe<{ count: string }[]>(
		`SELECT count(*)::text AS count FROM ${tableName}`,
	);
	return Number(rows[0]?.count ?? "0");
}

export async function expectTableCounts(
	sql: SQL,
	expected: Partial<Record<string, number>>,
): Promise<void> {
	for (const [tableName, count] of Object.entries(expected)) {
		if (count === undefined) {
			continue;
		}

		expect(await tableCount(sql, tableName)).toBe(count);
	}
}

export async function expectCustomer(
	sql: SQL,
	billingAccountId: string,
	projectKey = "voysee",
): Promise<CustomerAssertionRow> {
	const rows = await sql<CustomerAssertionRow[]>`
		SELECT customers.id, customers.billing_account_id, projects.key AS project_key
		FROM customers
		JOIN projects ON projects.id = customers.project_id
		WHERE customers.billing_account_id = ${billingAccountId}
			AND projects.key = ${projectKey}
	`;

	expect(rows).toHaveLength(1);
	return rows[0];
}

export async function expectProjectionJob(
	sql: SQL,
	match: {
		projectKey?: string;
		billingAccountId: string;
		reason: ProjectionSyncReason;
		status?: ProjectionSyncStatus;
	},
): Promise<ProjectionJobAssertionRow> {
	const projectKey = match.projectKey ?? "voysee";
	const rows =
		match.status === undefined
			? await sql<ProjectionJobAssertionRow[]>`
					SELECT jobs.id, projects.key AS project_key, jobs.idempotency_key, jobs.reason,
						jobs.status, jobs.attempts, jobs.last_error,
						jobs.next_attempt_at::text AS next_attempt_at,
						jobs.locked_at::text AS locked_at, jobs.locked_by, jobs.payload
					FROM projection_sync_jobs jobs
					JOIN projects ON projects.id = jobs.project_id
					WHERE projects.key = ${projectKey}
						AND jobs.payload->>'billingAccountId' = ${match.billingAccountId}
						AND jobs.reason = ${match.reason}
					ORDER BY jobs.created_at DESC, jobs.id DESC
					LIMIT 1
				`
			: await sql<ProjectionJobAssertionRow[]>`
					SELECT jobs.id, projects.key AS project_key, jobs.idempotency_key, jobs.reason,
						jobs.status, jobs.attempts, jobs.last_error,
						jobs.next_attempt_at::text AS next_attempt_at,
						jobs.locked_at::text AS locked_at, jobs.locked_by, jobs.payload
					FROM projection_sync_jobs jobs
					JOIN projects ON projects.id = jobs.project_id
					WHERE projects.key = ${projectKey}
						AND jobs.payload->>'billingAccountId' = ${match.billingAccountId}
						AND jobs.reason = ${match.reason}
						AND jobs.status = ${match.status}
					ORDER BY jobs.created_at DESC, jobs.id DESC
					LIMIT 1
				`;

	expect(rows.length).toBeGreaterThan(0);
	return rows[0];
}

export async function expectStoreEvent(
	sql: SQL,
	match: {
		provider: BillingProvider;
		eventType: string;
		status: StoreEventProcessingStatus;
		projectKey?: string;
	},
): Promise<StoreEventAssertionRow> {
	const rows = await sql<StoreEventAssertionRow[]>`
		SELECT events.id, events.provider, events.external_event_id,
			events.event_type, events.processing_status,
			events.processing_error, events.attempts, events.next_attempt_at::text AS next_attempt_at,
			events.processed_at::text AS processed_at, events.locked_at::text AS locked_at,
			events.locked_by
		FROM store_events events
		JOIN projects ON projects.id = events.project_id
		WHERE projects.key = ${match.projectKey ?? "voysee"}
			AND events.provider = ${match.provider}
			AND events.event_type = ${match.eventType}
			AND events.processing_status = ${match.status}
		ORDER BY events.created_at DESC, events.id DESC
		LIMIT 1
	`;

	expect(rows.length).toBeGreaterThan(0);
	return rows[0];
}
