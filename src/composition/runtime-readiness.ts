import type { SQL } from "bun";
import { sql } from "../db/client";

/** Customer setup and provider outages must never remove unrelated tenants from service. */
export function createBillingReadinessCheck(client: SQL = sql): () => Promise<boolean> {
	return async () => {
		try {
			const [row] = await client<
				{ ready: boolean }[]
			>`SELECT to_regclass('platform_connection_secrets') IS NOT NULL AND to_regclass('platform_connection_operations') IS NOT NULL AND to_regclass('platform_merchant_sessions') IS NOT NULL AS ready`;
			return row?.ready === true;
		} catch {
			return false;
		}
	};
}
