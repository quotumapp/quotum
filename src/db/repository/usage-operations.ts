import { sql } from "drizzle-orm";
import { positiveDecimal, sha256Hex, stableJson } from "../../billing/decimal";
import {
	InternalBillingError,
	InvalidRequestError,
	NotFoundBillingError,
	PersistenceConflictError,
} from "../../billing/errors";
import {
	type UsageOperationInput,
	type UsageOperationKind,
	type UsageOperationLookupInput,
	type UsageOperationLookupResult,
	type UsageOperationReceipt,
	type UsageOperationResult,
	usageOperationKinds,
} from "../../billing/usage-operations";
import type { ProjectInstanceContext } from "../../projects/context";
import { ensureCustomer } from "./identities";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";

interface Claim {
	id: string;
	request_fingerprint: string;
	recovery_version: number;
	completed_at: Date | string | null;
	identity_expired: boolean;
	result_expired: boolean;
	outcome: UsageOperationResult | null;
}

export function operationFingerprint(
	operation: UsageOperationKind,
	input: UsageOperationInput,
): string {
	// Include all semantics still accepted by the current wire contract. Dates and numeric strings
	// are normalized; absent/default-empty fields and transport headers do not change the identity.
	return sha256Hex(
		stableJson({
			operation,
			billingAccountId: input.billingAccountId.trim(),
			featureKey: "featureKey" in input ? input.featureKey.trim() : null,
			quantity: "quantity" in input ? positiveDecimal(input.quantity, "quantity") : null,
			entityId: "entityId" in input ? input.entityId?.trim() || null : null,
			filters: "filters" in input ? (input.filters ?? {}) : {},
			occurredAt: "occurredAt" in input ? (input.occurredAt?.toISOString() ?? null) : null,
			metadata: "metadata" in input ? (input.metadata ?? {}) : {},
			expiresInSeconds:
				operation === "reserve"
					? "expiresInSeconds" in input
						? (input.expiresInSeconds ?? 300)
						: 300
					: null,
			reservationId: "reservationId" in input ? input.reservationId : null,
			originalUsageEventId: "originalUsageEventId" in input ? input.originalUsageEventId : null,
			originalRecordedAt:
				"originalRecordedAt" in input ? input.originalRecordedAt.toISOString() : null,
			actor: "actor" in input ? input.actor.trim() : null,
			reason: "reason" in input ? input.reason.trim() : null,
		}),
	);
}

function normalizeScope(input: UsageOperationLookupInput): UsageOperationLookupInput {
	const operationId = input.operationId.trim();
	const billingAccountId = input.billingAccountId.trim();
	if (operationId.length < 1 || operationId.length > 200) {
		throw new InvalidRequestError("Operation ID must contain between 1 and 200 characters");
	}
	if (
		!billingAccountId ||
		billingAccountId.length > 256 ||
		!usageOperationKinds.includes(input.operation)
	) {
		throw new InvalidRequestError("Invalid usage operation scope");
	}
	return { ...input, operationId, billingAccountId };
}

async function tryLock(
	executor: QueryExecutor,
	projectId: string,
	scope: UsageOperationLookupInput,
	shared = false,
): Promise<boolean> {
	const identity = stableJson([
		"client-usage-v1",
		projectId,
		scope.billingAccountId,
		scope.operation,
		scope.operationId,
	]);
	// Transaction scoped and non-blocking, including when no claim/customer row is visible yet.
	const lock = await executeOne<{ acquired: boolean }>(
		executor,
		shared
			? sql`SELECT pg_try_advisory_xact_lock_shared(hashtextextended(${identity}, 0)) AS acquired`
			: sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${identity}, 0)) AS acquired`,
	);
	return lock?.acquired === true;
}

async function readClaim(
	executor: QueryExecutor,
	projectId: string,
	scope: UsageOperationLookupInput,
): Promise<Claim | null> {
	return await executeOne<Claim>(
		executor,
		sql`
  SELECT claim.id::text, claim.request_fingerprint, claim.recovery_version, claim.completed_at,
   claim.completed_at IS NOT NULL AND claim.expires_at <= clock_timestamp() AS identity_expired,
   claim.result_expires_at <= clock_timestamp() AS result_expired, claim.outcome
  FROM client_idempotency_claims claim
  JOIN customers customer ON customer.project_id = claim.project_id AND customer.id = claim.customer_id
  WHERE claim.project_id = ${projectId} AND customer.billing_account_id = ${scope.billingAccountId}
   AND claim.operation = ${scope.operation} AND claim.idempotency_key = ${scope.operationId}
 `,
	);
}

function retainedResult(claim: Claim): UsageOperationResult {
	if (claim.completed_at === null) {
		throw new PersistenceConflictError(
			"Usage operation is still unresolved",
			"OPERATION_IN_PROGRESS",
		);
	}
	if (claim.result_expired || claim.outcome === null || claim.recovery_version !== 1) {
		throw new PersistenceConflictError(
			"Usage operation result has expired; do not reuse its identity",
			"OPERATION_RESULT_EXPIRED",
		);
	}
	return claim.outcome;
}

export async function runUsageOperation<T extends UsageOperationResult>(
	executor: QueryExecutor,
	project: ProjectInstanceContext,
	operation: UsageOperationKind,
	input: UsageOperationInput,
	mutation: () => Promise<T>,
): Promise<T> {
	const scope = normalizeScope({
		billingAccountId: input.billingAccountId,
		operation,
		operationId: input.idempotencyKey,
	});
	const fingerprint = operationFingerprint(operation, input);
	const projectId = project.projectInstanceId;
	if (!(await tryLock(executor, projectId, scope))) {
		throw new PersistenceConflictError(
			"Usage operation is in progress; recover by operation lookup",
			"OPERATION_IN_PROGRESS",
		);
	}
	const existing = await readClaim(executor, projectId, scope);
	if (existing !== null && !existing.identity_expired) {
		// Legacy fingerprints did not bind all semantics, and cannot safely reconstruct an outcome.
		if (existing.recovery_version === 1 && existing.request_fingerprint !== fingerprint) {
			throw new PersistenceConflictError(
				"Operation identity is bound to different input",
				"IDEMPOTENCY_CONFLICT",
			);
		}
		return retainedResult(existing) as T;
	}
	if (existing !== null) {
		await executeRows(
			executor,
			sql`DELETE FROM client_idempotency_claims WHERE id = ${existing.id} AND completed_at IS NOT NULL`,
		);
	}
	const customer =
		operation === "consume" || operation === "reserve"
			? await ensureCustomer(executor, projectId, scope.billingAccountId)
			: await executeOne<{ id: string }>(
					executor,
					sql`SELECT id FROM customers WHERE project_id = ${projectId} AND billing_account_id = ${scope.billingAccountId}`,
				);
	if (customer === null) {
		throw new NotFoundBillingError(
			`Billing account ${scope.billingAccountId} was not found`,
			"BILLING_ACCOUNT_NOT_FOUND",
		);
	}
	const claim = await executeOne<{ id: string }>(
		executor,
		sql`
  INSERT INTO client_idempotency_claims
   (project_id, customer_id, operation, idempotency_key, request_fingerprint, expires_at, recovery_version)
  VALUES (${projectId}, ${customer.id}, ${operation}, ${scope.operationId}, ${fingerprint},
   clock_timestamp() + INTERVAL '168 hours', 1)
  RETURNING id::text
 `,
	);
	if (claim === null) throw new Error("Usage operation claim was not persisted");
	// Every accounting write, projection intent and terminal domain result share this transaction.
	// No catch-and-delete: an uncertain commit is recovered from this same identity on a new connection.
	const result = await mutation();
	const completed = await executeOne<{ id: string }>(
		executor,
		sql`
  UPDATE client_idempotency_claims SET outcome = ${jsonb(result)},
   completed_at = statement_timestamp(),
   result_expires_at = statement_timestamp() + make_interval(secs => GREATEST(86400,
    COALESCE((SELECT client_idempotency_ttl_seconds FROM metering_settings WHERE project_id = ${projectId}), 86400))),
   expires_at = statement_timestamp() + make_interval(secs => GREATEST(604800,
    COALESCE((SELECT client_idempotency_ttl_seconds FROM metering_settings WHERE project_id = ${projectId}), 86400)))
  WHERE id = ${claim.id} AND octet_length((${jsonb(result)})::text) <= 65536
   RETURNING id::text
 `,
	);
	if (completed === null) {
		throw new InternalBillingError(
			"Usage outcome exceeds the bounded recovery snapshot",
			"OPERATION_OUTCOME_TOO_LARGE",
		);
	}

	return result;
}

export async function lookupUsageOperation(
	executor: QueryExecutor,
	project: ProjectInstanceContext,
	input: UsageOperationLookupInput,
): Promise<UsageOperationLookupResult> {
	const scope = normalizeScope(input);
	const projectId = project.projectInstanceId;
	const identity = { operation: scope.operation, operationId: scope.operationId };
	// A visible terminal claim is already committed and immutable within its retention window.
	// Read it without locking so completed lookups cannot manufacture in-progress responses.
	let claim = await readClaim(executor, projectId, scope);
	if (claim === null || claim.identity_expired) {
		if (!(await tryLock(executor, projectId, scope, true))) {
			return { ...identity, status: "processing", outcome: null, completedAt: null };
		}
		// Re-read after acquiring the shared lock: a writer may have committed since the first read.
		claim = await readClaim(executor, projectId, scope);
	}
	if (claim === null || claim.identity_expired) {
		throw new NotFoundBillingError(
			"Usage operation was not found in its retention window",
			"OPERATION_NOT_FOUND",
		);
	}
	if (claim.completed_at === null)
		return { ...identity, status: "processing", outcome: null, completedAt: null };
	return {
		...identity,
		status: "completed",
		outcome: compactReceipt(retainedResult(claim)),
		completedAt: new Date(claim.completed_at).toISOString(),
	};
}

function compactReceipt(result: UsageOperationResult): UsageOperationReceipt {
	return {
		allowed: "allowed" in result ? result.allowed : true,
		reason: "reason" in result ? result.reason : "allowed",
		usageEventId: "usageEventId" in result ? result.usageEventId : null,
		recordedAt: "recordedAt" in result ? result.recordedAt : null,
		reservationId: "reservationId" in result ? result.reservationId : null,
		reservationStatus: "status" in result ? result.status : null,
		expiresAt: "expiresAt" in result ? result.expiresAt : null,
		quantity:
			"quantity" in result
				? result.quantity
				: "requestedQuantity" in result
					? result.requestedQuantity
					: null,
		walletQuantity: "walletQuantity" in result ? result.walletQuantity : null,
		originalUsageEventId: "originalUsageEventId" in result ? result.originalUsageEventId : null,
		originalRecordedAt: "originalRecordedAt" in result ? result.originalRecordedAt : null,
		balance: {
			featureKey: result.balance.featureKey,
			available: result.balance.available,
			consumed: result.balance.consumed,
			held: result.balance.held,
		},
	};
}

export async function expireUsageOperationResults(
	executor: QueryExecutor,
	limit: number,
): Promise<void> {
	await executeRows(
		executor,
		sql`
  WITH targets AS (
   SELECT id FROM client_idempotency_claims
   WHERE completed_at IS NOT NULL AND outcome IS NOT NULL AND result_expires_at <= now()
   ORDER BY result_expires_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED
  )
  UPDATE client_idempotency_claims claim SET outcome = NULL
  FROM targets WHERE claim.id = targets.id
 `,
	);
}
