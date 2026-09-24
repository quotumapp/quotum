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
