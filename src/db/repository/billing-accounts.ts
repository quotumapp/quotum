import { sql } from "drizzle-orm";
import { InvalidRequestError, NotFoundBillingError } from "../../billing/errors";
import type { BillingAccountRecord } from "../../billing/usage-api";
import type { ProjectInstanceContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import { applyDefaultPlan } from "./identities";
import { executeOne } from "./query";
import type { QueryExecutor } from "./types";

export function requireAccountId(id: string): void {
	if (!id || id.length > 200 || id !== id.trim()) {
		throw new InvalidRequestError(
			"billingAccountId must contain 1–200 characters without surrounding whitespace",
		);
	}
}

export async function requireBillingAccount(
	executor: QueryExecutor,
	projectId: string,
	id: string,
) {
	requireAccountId(id);
	const row = await executeOne<{
		id: string;
		billing_account_id: string;
		created_at: Date | string;
	}>(
		executor,
		sql`SELECT id, billing_account_id, created_at FROM customers
		WHERE project_id = ${projectId} AND billing_account_id = ${id}`,
	);
	if (row === null)
		throw new NotFoundBillingError("Billing account was not found", "BILLING_ACCOUNT_NOT_FOUND");
	return row;
}

export class BillingAccountRepository extends RepositoryModule {
	async create(project: ProjectInstanceContext, id: string): Promise<BillingAccountRecord> {
		requireAccountId(id);
		return this.transaction(async (tx) => {
			const created = await executeOne<{ id: string; billing_account_id: string }>(
				tx,
				sql`
				INSERT INTO customers (project_id, billing_account_id)
				VALUES (${project.projectInstanceId}, ${id})
				ON CONFLICT (project_id, billing_account_id) DO NOTHING
				RETURNING id, billing_account_id
			`,
			);
			if (created !== null) await applyDefaultPlan(tx, project.projectInstanceId, created);
			const row = await requireBillingAccount(tx, project.projectInstanceId, id);
			return { id: row.billing_account_id, createdAt: new Date(row.created_at).toISOString() };
		});
	}

	async get(project: ProjectInstanceContext, id: string): Promise<BillingAccountRecord> {
		const row = await requireBillingAccount(this.database, project.projectInstanceId, id);
		return { id: row.billing_account_id, createdAt: new Date(row.created_at).toISOString() };
	}
}
