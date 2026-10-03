import { type SQL, sql } from "drizzle-orm";
import { jsonb } from "./query";
import type { QueryExecutor } from "./types";

/** Fixed target reads supplement list previews; no caller-controlled SQL identifiers. */
export async function administrationTarget(
	database: QueryExecutor,
	projectId: string,
	action: string,
	parameters: string[],
	body: unknown,
): Promise<unknown> {
	const [account = "", id = ""] = parameters;
	const customer = sql`SELECT id FROM customers WHERE project_id=${projectId} AND billing_account_id=${account}`;
	let query: SQL;
	switch (action) {
		case "debits.create": {
			const ids = (body as { allocations: { allocationId: string }[] }).allocations.map(
				(a) => a.allocationId,
			);
			query = sql`SELECT to_jsonb(a) - 'metadata' AS target FROM balance_allocations a WHERE a.project_id=${projectId} AND a.customer_id IN (${customer}) AND a.id IN (SELECT value::bigint FROM jsonb_array_elements_text(${jsonb(ids)})) ORDER BY a.id`;
			break;
		}
		case "topups.reset":
			query = sql`SELECT to_jsonb(p) - 'metadata' AS target FROM auto_topup_policies p WHERE p.project_id=${projectId} AND p.customer_id IN (${customer}) AND p.id=${id}::bigint`;
			break;
		case "licenses.release":
			query = sql`SELECT to_jsonb(a) AS target FROM license_assignments a JOIN license_pools p ON p.project_id=a.project_id AND p.id=a.license_pool_id WHERE a.project_id=${projectId} AND p.customer_id IN (${customer}) AND a.id=${id}::bigint`;
			break;
		case "promotions.redemptions.revoke":
			query = sql`SELECT to_jsonb(r) - 'metadata' AS target FROM promotion_redemptions r WHERE r.project_id=${projectId} AND r.id=${account}::uuid`;
			break;
		case "promotions.codes.deactivate":
			query = sql`SELECT to_jsonb(c) - 'code' - 'code_hash' AS target FROM promotion_codes c WHERE c.project_id=${projectId} AND c.id=${id}::uuid`;
			break;
		case "usage.correct":
			query = sql`SELECT to_jsonb(e) - 'metadata' AS target FROM usage_events e WHERE e.project_id=${projectId} AND e.customer_id IN (${customer}) AND (e.id=${id}::uuid OR e.original_event_id=${id}::uuid) ORDER BY e.recorded_at,e.id`;
			break;
		case "projections.retry":
			query = sql`SELECT to_jsonb(j) - 'payload' AS target FROM projection_sync_jobs j WHERE j.project_id=${projectId} AND j.id=${account}::uuid`;
			break;
		default:
			return null;
	}
	return Array.from(await database.execute<{ target: unknown }>(query), (row) => row.target);
}
