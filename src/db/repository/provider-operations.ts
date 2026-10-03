import { sql } from "drizzle-orm";
import { z } from "zod";
import { stableJson } from "../../billing/decimal";
import { NotFoundBillingError, PersistenceConflictError } from "../../billing/errors";
import type {
	PrepareProviderOperation,
	ProviderOperation,
	ProviderOperationLease,
	ProviderOperationOutcome,
	ProviderOperationStore,
} from "../../billing/provider-operations";
import type { ProjectInstanceContext } from "../../projects/context";
import { billingProviders } from "../../shared/provider-capabilities";
import { RepositoryModule } from "./base";
import { executeOne, executeRows, jsonb } from "./query";

const intentSchema = z.object({
	billingAccountId: z.string().min(1).max(200),
	provider: z.enum(billingProviders),
	providerAccountId: z.string().min(1).max(200),
	connectionVersionId: z.uuid(),
	idempotencyKey: z.string().min(1).max(200),
	resourceKey: z.string().min(1).max(200),
	operation: z.string().min(1).max(100),
	requestHash: z.string().regex(/^[a-f0-9]{64}$/),
	request: z.record(z.string(), z.unknown()),
});

interface OperationRow {
	id: string;
	billing_account_id: string;
	provider: ProviderOperation["provider"];
	provider_account_id: string;
	connection_version_id: string;
	idempotency_key: string;
	resource_key: string;
	operation: string;
	request_hash: string;
	request: Record<string, unknown>;
	status: ProviderOperation["status"];
	attempts: number;
	result: Record<string, unknown> | null;
	provider_object_id: string | null;
	error_code: string | null;
	created_at: Date | string;
	updated_at: Date | string;
}

/** Database leases fence local completion; an expired dispatch can only be reconciled. */
export class ProviderOperationRepository
	extends RepositoryModule
	implements ProviderOperationStore
{
	/** Append-only operator requests; a request never resets the dispatch count or marks success. */
	async requestReview(
		project: ProjectInstanceContext,
		billingAccountId: string,
		id: string,
		actor: string,
	): Promise<void> {
		const row = await executeOne(
			this.database,
			sql`
			UPDATE provider_operations SET review_requests = review_requests || jsonb_build_array(jsonb_build_object(
				'actor', ${z.string().trim().min(1).max(200).parse(actor)}::text, 'requestedAt', clock_timestamp(), 'status', status))
			WHERE project_id = ${project.projectInstanceId} AND billing_account_id = ${billingAccountId} AND id = ${id}
			RETURNING id
		`,
		);
		if (!row) throw new NotFoundBillingError("Provider operation was not found");
	}
	/** Avoid starving eligible projects when a suspended or unavailable project owns old work. */
	async deferRecovery(projectId: string, id: string): Promise<void> {
		await this.database.execute(sql`
            UPDATE provider_operations SET next_attempt_at = clock_timestamp() + interval '60 seconds'
            WHERE project_id = ${projectId} AND id = ${id}
                AND status IN ('in_flight', 'reconciling')
                AND (lease_until IS NULL OR lease_until <= clock_timestamp())
        `);
	}
	/** Selection never authorizes a write; individual claims fence competing recovery workers. */
	async due(
		limit: number,
	): Promise<{ project_id: string; billing_account_id: string; id: string }[]> {
		return executeRows(
			this.database,
			sql`
			SELECT project_id, billing_account_id, id FROM provider_operations
			WHERE status IN ('in_flight', 'reconciling')
				AND (lease_until IS NULL OR lease_until <= clock_timestamp())
				AND next_attempt_at <= clock_timestamp()
			ORDER BY next_attempt_at, id LIMIT ${z.number().int().min(1).max(100).parse(limit)}
		`,
		);
	}
	async prepare(
		project: ProjectInstanceContext,
		raw: PrepareProviderOperation,
	): Promise<ProviderOperation> {
		const input = intentSchema.parse(raw);
		return await this.transaction(async (tx) => {
			await executeOne(
				tx,
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-operation-key:${project.projectInstanceId}:${input.provider}:${input.billingAccountId}:${input.idempotencyKey}`}, 0))`,
			);
			// One short local transaction serializes reservation, including two different operation
			// keys for the same resource. Provider I/O never runs while this lock is held.
			await executeOne(
				tx,
				sql`SELECT pg_advisory_xact_lock(hashtextextended(${`provider-operation:${project.projectInstanceId}:${input.provider}:${input.providerAccountId}`}, 0))`,
			);
			const existing = await executeOne<OperationRow>(
				tx,
				sql`
				SELECT * FROM provider_operations
				WHERE project_id = ${project.projectInstanceId} AND billing_account_id = ${input.billingAccountId}
					AND provider = ${input.provider} AND idempotency_key = ${input.idempotencyKey}
			`,
			);
			if (existing) {
				if (
					existing.request_hash !== input.requestHash ||
					stableJson(existing.request) !== stableJson(input.request) ||
					existing.provider_account_id !== input.providerAccountId ||
					existing.operation !== input.operation ||
					existing.resource_key !== input.resourceKey
				) {
					throw new PersistenceConflictError(
						"This idempotency key belongs to a different provider operation",
						"IDEMPOTENCY_CONFLICT",
					);
				}
				return fromRow(existing);
			}
			const active = await executeOne(
				tx,
				sql`
				SELECT id FROM provider_operations
				WHERE project_id = ${project.projectInstanceId} AND provider = ${input.provider}
					AND provider_account_id = ${input.providerAccountId} AND resource_key = ${input.resourceKey}
					AND status IN ('prepared', 'in_flight', 'reconciling', 'requires_review')
			`,
			);
			if (active)
				throw new PersistenceConflictError(
					"A provider operation for this resource is unresolved",
					"PROVIDER_OPERATION_PENDING",
				);
			const created = await executeOne<OperationRow>(
				tx,
				sql`
				INSERT INTO provider_operations (project_id, billing_account_id, provider, provider_account_id,
					connection_version_id, idempotency_key, resource_key, operation, request_hash, request)
				VALUES (${project.projectInstanceId}, ${input.billingAccountId}, ${input.provider}, ${input.providerAccountId},
					${input.connectionVersionId}, ${input.idempotencyKey}, ${input.resourceKey}, ${input.operation},
					${input.requestHash}, ${jsonb(input.request)}) RETURNING *
			`,
			);
			if (!created) throw new Error("Provider operation was not created");
			return fromRow(created);
		});
	}

	async get(
		project: ProjectInstanceContext,
		billingAccountId: string,
		id: string,
	): Promise<ProviderOperation> {
		const row = await executeOne<OperationRow>(
			this.database,
			sql`
			SELECT * FROM provider_operations WHERE project_id = ${project.projectInstanceId}
				AND billing_account_id = ${billingAccountId} AND id = ${id}
		`,
		);
		if (!row) throw new NotFoundBillingError("Provider operation was not found");
		return fromRow(row);
	}

	async claimDispatch(
		project: ProjectInstanceContext,
		billingAccountId: string,
		id: string,
	): Promise<ProviderOperationLease | null> {
		const token = crypto.randomUUID();
		const row = await executeOne<OperationRow>(
			this.database,
			sql`
			UPDATE provider_operations SET status = 'in_flight', lease_token = ${token},
				lease_until = clock_timestamp() + interval '60 seconds', attempts = attempts + 1, updated_at = clock_timestamp()
			WHERE project_id = ${project.projectInstanceId} AND billing_account_id = ${billingAccountId}
				AND id = ${id} AND status = 'prepared' RETURNING *
		`,
		);
		return row ? { operation: fromRow(row), token } : null;
	}

	async claimReconciliation(
		project: ProjectInstanceContext,
		billingAccountId: string,
		id: string,
	): Promise<ProviderOperationLease | null> {
		const token = crypto.randomUUID();
		const row = await executeOne<OperationRow>(
			this.database,
			sql`
			UPDATE provider_operations SET status = 'reconciling', lease_token = ${token}, recovery_attempts = recovery_attempts + 1,
				lease_until = clock_timestamp() + interval '60 seconds', updated_at = clock_timestamp()
			WHERE project_id = ${project.projectInstanceId} AND billing_account_id = ${billingAccountId}
				AND id = ${id} AND status IN ('in_flight', 'reconciling', 'requires_review')
				AND (lease_until IS NULL OR lease_until <= clock_timestamp()) RETURNING *
		`,
		);
		return row ? { operation: fromRow(row), token } : null;
	}

	async renew(project: ProjectInstanceContext, lease: ProviderOperationLease): Promise<boolean> {
		return (
			(await executeOne(
				this.database,
				sql`
			UPDATE provider_operations SET lease_until = clock_timestamp() + interval '60 seconds'
			WHERE project_id = ${project.projectInstanceId} AND id = ${lease.operation.id}
				AND lease_token = ${lease.token} AND lease_until > clock_timestamp()
				AND status IN ('in_flight', 'reconciling') RETURNING id
		`,
			)) !== null
		);
	}

	async settle(
		project: ProjectInstanceContext,
		lease: ProviderOperationLease,
		outcome: ProviderOperationOutcome,
	): Promise<ProviderOperation> {
		const result = outcome.status === "succeeded" ? outcome.result : null;
		const providerObjectId = outcome.status === "succeeded" ? outcome.providerObjectId : null;
		const errorCode = outcome.status === "succeeded" ? null : outcome.errorCode;
		const row = await executeOne<OperationRow>(
			this.database,
			sql`
			UPDATE provider_operations SET status = CASE WHEN ${outcome.status} = 'reconciling' AND recovery_attempts >= 10 THEN 'requires_review' ELSE ${outcome.status} END, result = ${result === null ? null : jsonb(result)},
				provider_object_id = ${providerObjectId}, error_code = ${errorCode},
				next_attempt_at = clock_timestamp() + LEAST(3600, 10 * power(2, LEAST(recovery_attempts, 9))) * interval '1 second',
				lease_token = NULL, lease_until = NULL, updated_at = clock_timestamp()
			WHERE project_id = ${project.projectInstanceId} AND id = ${lease.operation.id}
				AND lease_token = ${lease.token} AND lease_until > clock_timestamp()
				AND status IN ('in_flight', 'reconciling') RETURNING *
		`,
		);
		if (!row)
			throw new PersistenceConflictError(
				"Provider operation lease expired or changed",
				"PROVIDER_OPERATION_LEASE_LOST",
			);
		return fromRow(row);
	}
}

function fromRow(row: OperationRow): ProviderOperation {
	return {
		id: row.id,
		billingAccountId: row.billing_account_id,
		provider: row.provider,
		providerAccountId: row.provider_account_id,
		connectionVersionId: row.connection_version_id,
		idempotencyKey: row.idempotency_key,
		resourceKey: row.resource_key,
		operation: row.operation,
		requestHash: row.request_hash,
		request: row.request,
		status: row.status,
		attempts: row.attempts,
		result: row.result,
		providerObjectId: row.provider_object_id,
		errorCode: row.error_code,
		createdAt: new Date(row.created_at).toISOString(),
		updatedAt: new Date(row.updated_at).toISOString(),
	};
}
