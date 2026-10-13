import type { PlatformQueryExecutor } from "./persistence/query-executor";

export interface PlatformAuditEvent {
	/** The acting principal; null for actions no principal performed, such as operator commands. */
	principalId: string | null;
	organizationId: string | null;
	action: string;
	target: string | null;
	metadata?: Record<string, unknown>;
}

export async function insertPlatformAuditEvent(
	executor: PlatformQueryExecutor,
	event: PlatformAuditEvent,
): Promise<void> {
	await executor.query({
		text: `
			INSERT INTO platform_audit_events (
				principal_id,
				organization_id,
				action,
				target,
				metadata
			)
			VALUES ($1, $2, $3, $4, $5::text::jsonb)
		`,
		values: [
			event.principalId,
			event.organizationId,
			event.action,
			event.target,
			JSON.stringify(event.metadata ?? {}),
		],
	});
}

export interface PlatformAuditEventFilter {
	/** Only this organization's events; an unknown slug is an error, not an empty page. */
	organizationSlug?: string;
	action?: string;
	/** Inclusive lower bound on the event time, an ISO 8601 timestamp with a zone. */
	since?: string;
	/** Exclusive upper bound on the event time. */
	until?: string;
	/** Only events older than this event, to continue from `nextBefore` of the previous page. */
	before?: string;
	limit: number;
}

export interface PlatformAuditEventRecord {
	id: string;
	/** UTC with microseconds, exactly as stored. */
	createdAt: string;
	/** The organization's slug, or null for an event no organization owns. */
	organization: string | null;
	/** The acting principal; null for operator commands, which name the operator in `metadata`. */
	principalId: string | null;
	action: string;
	target: string | null;
	metadata: Record<string, unknown>;
}

export interface PlatformAuditEventPage {
	events: PlatformAuditEventRecord[];
	/** Pass as `before` for the next page; null when this page reached the oldest event. */
	nextBefore: string | null;
}

/**
 * One page of the audit trail, newest first. Events are ordered by `(created_at, id)`, so a page
 * continues exactly where the previous one ended even when events share a timestamp.
 */
export async function listPlatformAuditEvents(
	executor: PlatformQueryExecutor,
	filter: PlatformAuditEventFilter,
): Promise<PlatformAuditEventPage> {
	let organizationId: string | null = null;
	if (filter.organizationSlug !== undefined) {
		const [organization] = await executor.query<{ id: string }>({
			text: "SELECT id FROM platform_organizations WHERE slug=$1",
			values: [filter.organizationSlug],
		});
		if (!organization) throw new Error(`Organization ${filter.organizationSlug} was not found`);
		organizationId = organization.id;
	}
	if (filter.before !== undefined) {
		const known = await executor.query<{ id: string }>({
			text: "SELECT id FROM platform_audit_events WHERE id=$1::uuid",
			values: [filter.before],
		});
		if (known.length === 0) throw new Error(`Audit event ${filter.before} was not found`);
	}
	const rows = await executor.query<{
		id: string;
		created_at: string;
		organization: string | null;
		principal_id: string | null;
		action: string;
		target: string | null;
		metadata: Record<string, unknown>;
	}>({
		text: `
			SELECT
				e.id,
				to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
				o.slug AS organization,
				e.principal_id,
				e.action,
				e.target,
				e.metadata
			FROM platform_audit_events e
			LEFT JOIN platform_organizations o ON o.id = e.organization_id
			WHERE ($1::uuid IS NULL OR e.organization_id = $1::uuid)
				AND ($2::text IS NULL OR e.action = $2::text)
				AND ($3::timestamptz IS NULL OR e.created_at >= $3::timestamptz)
				AND ($4::timestamptz IS NULL OR e.created_at < $4::timestamptz)
				AND (
					$5::uuid IS NULL
					OR (e.created_at, e.id) < (
						SELECT c.created_at, c.id FROM platform_audit_events c WHERE c.id = $5::uuid
					)
				)
			ORDER BY e.created_at DESC, e.id DESC
			LIMIT $6::int
		`,
		values: [
			organizationId,
			filter.action ?? null,
			filter.since ?? null,
			filter.until ?? null,
			filter.before ?? null,
			filter.limit + 1,
		],
	});
	const page = rows.slice(0, filter.limit);
	return {
		events: page.map((row) => ({
			id: row.id,
			createdAt: row.created_at,
			organization: row.organization,
			principalId: row.principal_id,
			action: row.action,
			target: row.target,
			metadata: row.metadata,
		})),
		nextBefore: rows.length > filter.limit ? (page.at(-1)?.id ?? null) : null,
	};
}
