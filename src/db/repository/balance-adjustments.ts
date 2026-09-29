import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import { decodeAdminCursor, encodeAdminCursor } from "../../admin/query";
import {
	type AdjustmentList,
	type AdjustmentListOptions,
	type AdministrativeDebitInput,
	type AdministrativeDebitMutationResult,
	type AdministrativeDebitRecord,
	administrativeDebitRequestHash,
	type BalanceAdjustmentServiceLike,
	balanceAdjustmentError,
	normalizeAdministrativeDebitInput,
	normalizeOperatorGrantInput,
	normalizeOperatorGrantRevokeInput,
	type OperatorGrantInput,
	type OperatorGrantMutationResult,
	type OperatorGrantRecord,
	type OperatorGrantRevokeInput,
	operatorGrantRequestHash,
	operatorGrantRevokeRequestHash,
} from "../../billing/balance-adjustments";
import {
	databaseDecimal,
	decimalToUnits,
	positiveDecimal,
	unitsToDecimal,
} from "../../billing/decimal";
import {
	InvalidRequestError,
	NotFoundBillingError,
	PersistenceConflictError,
} from "../../billing/errors";
import type { ProjectInstanceContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import { enqueueUsageProjection } from "./entitlements";
import { ensureCustomer } from "./identities";
import { requireMeteredFeature, resolveEntityId } from "./metering-persistence";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";
import { formatUtcTimestamp, requirePositiveLimit } from "./validation";

/** Allocation quantities are NUMERIC(28, 9); arithmetic on them uses that scale. */
const allocationScale = 9;

interface OperatorGrantRow {
	id: string;
	billing_account_id: string;
	feature_key: string;
	entity_external_id: string | null;
	allocation_id: string | number;
	quantity: string;
	reversed_quantity: string;
	consumed_quantity: string;
	held_quantity: string;
	expires_at: Date | string | null;
	allocation_reversed: boolean;
	expired: boolean;
	actor: string;
	reason: string;
	request_hash: string;
	revoked_at: Date | string | null;
	revoked_quantity: string | null;
	revocation_actor: string | null;
	revocation_reason: string | null;
	created_at: Date | string;
	cursor_created_at: string;
}

interface DebitTargetRow {
	id: string | number;
	source_kind: string;
	purchase_id: string | null;
	quantity: string;
	reversed_quantity: string;
	consumed_quantity: string;
	held_quantity: string;
	reversed: boolean;
	expired: boolean;
	credit_scale: number;
}

interface DebitRow {
	id: string;
	billing_account_id: string;
	actor: string;
	reason: string;
	request_hash: string;
	created_at: Date | string;
	cursor_created_at: string;
	allocations: Array<{
		allocation_id: string | number;
		feature_key: string;
		entity_external_id: string | null;
		source_kind: string;
		quantity: string;
	}>;
}

/** Provider purchases take credit back through provider refunds, which set the reversal outright. */
const providerPurchaseKinds = new Set(["purchase", "topup"]);

export class BalanceAdjustmentRepository
	extends RepositoryModule
	implements BalanceAdjustmentServiceLike
{
	/** Gives quantity as one `operator` allocation; it never records a payment. */
	async grantOperatorBalance(
		project: ProjectInstanceContext,
		rawInput: OperatorGrantInput,
	): Promise<OperatorGrantMutationResult> {
		const input = normalizeOperatorGrantInput(rawInput);
		const requestHash = operatorGrantRequestHash(input);
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			// The upsert locks the customer, so a concurrent grant with the same key replays.
			const customer = await ensureCustomer(tx, projectId, input.billingAccountId);
			const replay = await readOperatorGrant(
				tx,
				projectId,
				drizzleSql`g.customer_id = ${customer.id} AND g.idempotency_key = ${input.idempotencyKey}`,
			);
			if (replay !== null) {
				if (replay.request_hash !== requestHash) {
					throw new PersistenceConflictError(
						"Idempotency key was reused with a different operator grant",
						"IDEMPOTENCY_CONFLICT",
					);
				}
				return { duplicate: true, grant: toOperatorGrantRecord(replay) };
			}
			const feature = await requireMeteredFeature(tx, projectId, input.featureKey);
			if (feature.meter_kind !== "consumable") {
				throw balanceAdjustmentError("OPERATOR_GRANT_FEATURE_INVALID", {
					featureKey: feature.key,
				});
			}
			const quantity = positiveDecimal(input.quantity, "quantity", feature.credit_scale);
			const entityId = await resolveEntityId(tx, projectId, customer.id, input.entityId);
			const expiresAt = input.expiresAt?.toISOString() ?? null;
			if (expiresAt !== null) {
				const bound = await executeOne<{ future: boolean }>(
					tx,
					drizzleSql`SELECT ${expiresAt}::timestamptz > now() AS future`,
				);
				if (bound?.future !== true) {
					throw new InvalidRequestError("expiresAt must be in the future");
				}
			}
			const grant = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					INSERT INTO operator_grants (
						project_id, customer_id, actor, reason, idempotency_key, request_hash
					)
					VALUES (
						${projectId}, ${customer.id}, ${input.actor}, ${input.reason},
						${input.idempotencyKey}, ${requestHash}
					)
					RETURNING id
				`,
			);
			if (grant === null) throw new Error("Operator grant could not be recorded");
			await executeOne(
				tx,
				drizzleSql`
					INSERT INTO balance_allocations (
						project_id, customer_id, entity_id, feature_id, source_kind, source_key, quantity,
						expires_at, operator_grant_id
					)
					VALUES (
						${projectId}, ${customer.id}, ${entityId}::bigint, ${String(feature.id)}::bigint,
						'operator', ${`operator_grant:${grant.id}`}, ${quantity}::numeric,
						${expiresAt}::timestamptz, ${grant.id}
					)
					RETURNING id
				`,
			);
			await enqueueUsageProjection(tx, { projectId, customerId: customer.id });
			return { duplicate: false, grant: await requireOperatorGrant(tx, projectId, grant.id) };
		});
	}

	/**
	 * Takes back what the grant still gives: unconsumed, unheld quantity of an allocation that has
	 * not expired. Consumed usage stays consumed, and open reservations still settle from their holds.
	 */
	async revokeOperatorGrant(
		project: ProjectInstanceContext,
		rawInput: OperatorGrantRevokeInput,
	): Promise<OperatorGrantMutationResult> {
		const input = normalizeOperatorGrantRevokeInput(rawInput);
		const requestHash = operatorGrantRevokeRequestHash(input);
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await lockCustomer(tx, projectId, input.billingAccountId);
			if (customer === null) throw balanceAdjustmentError("OPERATOR_GRANT_NOT_FOUND");
			const grant = await executeOne<{
				id: string;
				revoked_at: Date | string | null;
				revocation_idempotency_key: string | null;
				revocation_request_hash: string | null;
			}>(
				tx,
				drizzleSql`
					SELECT id, revoked_at, revocation_idempotency_key, revocation_request_hash
					FROM operator_grants
					WHERE project_id = ${projectId}
						AND customer_id = ${customer.id}
						AND id = ${input.grantId}::uuid
					FOR UPDATE
				`,
			);
			if (grant === null) throw balanceAdjustmentError("OPERATOR_GRANT_NOT_FOUND");
			// Revocation keys are scoped to the billing account, like grant keys: a key another grant
			// of this account already used conflicts instead of revoking a second grant.
			const keyHolder = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					SELECT id FROM operator_grants
					WHERE project_id = ${projectId}
						AND customer_id = ${customer.id}
						AND revocation_idempotency_key = ${input.idempotencyKey}
						AND id <> ${grant.id}::uuid
					LIMIT 1
				`,
			);
			if (keyHolder !== null) {
				throw new PersistenceConflictError(
					"Idempotency key was reused with a different revocation",
					"IDEMPOTENCY_CONFLICT",
				);
			}
			if (grant.revoked_at !== null) {
				if (grant.revocation_idempotency_key !== input.idempotencyKey) {
					throw balanceAdjustmentError("OPERATOR_GRANT_ALREADY_REVOKED");
				}
				if (grant.revocation_request_hash !== requestHash) {
					throw new PersistenceConflictError(
						"Idempotency key was reused with a different revocation",
						"IDEMPOTENCY_CONFLICT",
					);
				}
				return { duplicate: true, grant: await requireOperatorGrant(tx, projectId, grant.id) };
			}
			const allocation = await executeOne<{
				id: string | number;
				reversed_quantity: string;
				expired: boolean;
			}>(
				tx,
				drizzleSql`
					SELECT id, reversed_quantity::text,
						(expires_at IS NOT NULL AND expires_at <= now()) AS expired
					FROM balance_allocations
					WHERE project_id = ${projectId} AND operator_grant_id = ${grant.id}
					FOR UPDATE
				`,
			);
			if (allocation === null) throw new Error(`operator grant ${grant.id} has no allocation`);
			let revokedUnits = 0n;
			if (!allocation.expired) {
				// An earlier debit already reversed part of it; only the rest is this revocation's.
				const reversed = await executeOne<{ reversed_quantity: string }>(
					tx,
					drizzleSql`
						UPDATE balance_allocations
						SET reversed_quantity = GREATEST(
								quantity - consumed_quantity - held_quantity, reversed_quantity
							),
							reversed_at = COALESCE(reversed_at, now()),
							updated_at = now()
						WHERE project_id = ${projectId} AND id = ${String(allocation.id)}::bigint
						RETURNING reversed_quantity::text
					`,
				);
				if (reversed === null) throw new Error(`allocation ${allocation.id} was not found`);
				revokedUnits =
					allocationUnits(reversed.reversed_quantity) -
					allocationUnits(allocation.reversed_quantity);
			}
			await executeOne(
				tx,
				drizzleSql`
					UPDATE operator_grants
					SET revoked_at = now(),
						revoked_quantity = ${unitsToDecimal(revokedUnits, allocationScale)}::numeric,
						revocation_actor = ${input.actor},
						revocation_reason = ${input.reason},
						revocation_idempotency_key = ${input.idempotencyKey},
						revocation_request_hash = ${requestHash},
						updated_at = now()
					WHERE project_id = ${projectId} AND id = ${grant.id}
					RETURNING id
				`,
			);
			await enqueueUsageProjection(tx, { projectId, customerId: customer.id });
			return { duplicate: false, grant: await requireOperatorGrant(tx, projectId, grant.id) };
		});
	}

	async listOperatorGrants(
		project: ProjectInstanceContext,
		billingAccountId: string,
		options: AdjustmentListOptions,
	): Promise<AdjustmentList<OperatorGrantRecord>> {
		const limit = requirePositiveLimit(options.limit);
		const rows = await executeRows<OperatorGrantRow>(
			this.database,
			drizzleSql`
				${operatorGrantSelect(
					project.projectInstanceId,
					drizzleSql`c.billing_account_id = ${billingAccountId} AND ${keyset(options.cursor, "g")}`,
				)}
				ORDER BY g.created_at DESC, g.id DESC
				LIMIT ${limit + 1}
			`,
		);
		return page(rows, limit, toOperatorGrantRecord);
	}

	async getOperatorGrant(
		project: ProjectInstanceContext,
		billingAccountId: string,
		grantId: string,
	): Promise<OperatorGrantRecord> {
		const row = await readOperatorGrant(
			this.database,
			project.projectInstanceId,
			drizzleSql`c.billing_account_id = ${billingAccountId} AND g.id = ${grantId}::uuid`,
		);
		if (row === null) throw balanceAdjustmentError("OPERATOR_GRANT_NOT_FOUND");
		return toOperatorGrantRecord(row);
	}

	/**
	 * Takes quantity back from named allocations, all or nothing. It raises each allocation's
	 * reversed quantity and writes no usage event, so it never reads as product usage.
	 */
	async debitAllocations(
		project: ProjectInstanceContext,
		rawInput: AdministrativeDebitInput,
	): Promise<AdministrativeDebitMutationResult> {
		const input = normalizeAdministrativeDebitInput(rawInput);
		const requestHash = administrativeDebitRequestHash(input);
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await lockCustomer(tx, projectId, input.billingAccountId);
			if (customer === null) {
				throw new NotFoundBillingError(
					"Billing account was not found",
					"BILLING_ACCOUNT_NOT_FOUND",
				);
			}
			const replay = await executeOne<{ id: string; request_hash: string }>(
				tx,
				drizzleSql`
					SELECT id, request_hash FROM administrative_debits
					WHERE project_id = ${projectId}
						AND customer_id = ${customer.id}
						AND idempotency_key = ${input.idempotencyKey}
				`,
			);
			if (replay !== null) {
				if (replay.request_hash !== requestHash) {
					throw new PersistenceConflictError(
						"Idempotency key was reused with a different debit",
						"IDEMPOTENCY_CONFLICT",
					);
				}
				return { duplicate: true, debit: await requireDebit(tx, projectId, replay.id) };
			}
			// Locked in spend order, as usage locks them.
			const targets = await executeRows<DebitTargetRow>(
				tx,
				drizzleSql`
					SELECT a.id, a.source_kind, a.purchase_id, a.quantity::text, a.reversed_quantity::text,
						a.consumed_quantity::text, a.held_quantity::text, a.reversed_at IS NOT NULL AS reversed,
						(a.expires_at IS NOT NULL AND a.expires_at <= now()) AS expired, f.credit_scale
					FROM balance_allocations a
					JOIN features f ON f.project_id = a.project_id AND f.id = a.feature_id
					WHERE a.project_id = ${projectId}
						AND a.customer_id = ${customer.id}
						AND a.id IN (
							SELECT jsonb_array_elements_text(
								${jsonb(input.allocations.map((line) => line.allocationId))}
							)::bigint
						)
					ORDER BY a.feature_id, a.expires_at ASC NULLS LAST, a.created_at, a.id
					FOR UPDATE OF a
				`,
			);
			const byId = new Map(targets.map((row) => [String(row.id), row]));
			const lines = input.allocations.map((line) => {
				const target = byId.get(line.allocationId);
				if (target === undefined) {
					throw balanceAdjustmentError("ALLOCATION_NOT_FOUND", {
						allocationId: line.allocationId,
					});
				}
				const refusal = target.reversed
					? "reversed"
					: target.expired
						? "expired"
						: providerPurchaseKinds.has(target.source_kind) || target.purchase_id !== null
							? "provider_purchase"
							: null;
				if (refusal !== null) {
					throw balanceAdjustmentError("ALLOCATION_NOT_DEBITABLE", {
						allocationId: line.allocationId,
						reason: refusal,
					});
				}
				const quantity = positiveDecimal(line.quantity, "quantity", target.credit_scale);
				const available =
					allocationUnits(target.quantity) -
					allocationUnits(target.reversed_quantity) -
					allocationUnits(target.consumed_quantity) -
					allocationUnits(target.held_quantity);
				if (allocationUnits(quantity) > available) {
					throw balanceAdjustmentError("ADMINISTRATIVE_DEBIT_EXCEEDS_AVAILABLE", {
						allocationId: line.allocationId,
						available: unitsToDecimal(available > 0n ? available : 0n, allocationScale),
					});
				}
				return { allocationId: line.allocationId, quantity };
			});
			const debit = await executeOne<{ id: string }>(
				tx,
				drizzleSql`
					INSERT INTO administrative_debits (
						project_id, customer_id, actor, reason, idempotency_key, request_hash
					)
					VALUES (
						${projectId}, ${customer.id}, ${input.actor}, ${input.reason},
						${input.idempotencyKey}, ${requestHash}
					)
					RETURNING id
				`,
			);
			if (debit === null) throw new Error("Administrative debit could not be recorded");
			await executeOne(
				tx,
				drizzleSql`
					INSERT INTO administrative_debit_allocations (project_id, debit_id, allocation_id, quantity)
					SELECT ${projectId}, ${debit.id}, line.allocation_id::bigint, line.quantity::numeric
					FROM jsonb_to_recordset(${jsonb(
						lines.map((line) => ({
							allocation_id: line.allocationId,
							quantity: line.quantity,
						})),
					)}) AS line(allocation_id text, quantity text)
					RETURNING allocation_id
				`,
			);
			// Distinct rows, so the guarded updates are issued together.
			const debited = await Promise.all(
				lines.map((line) =>
					executeOne<{ id: string }>(
						tx,
						drizzleSql`
							UPDATE balance_allocations
							SET reversed_quantity = reversed_quantity + ${line.quantity}::numeric,
								updated_at = now()
							WHERE project_id = ${projectId}
								AND id = ${line.allocationId}::bigint
								AND reversed_at IS NULL
								AND quantity - reversed_quantity - consumed_quantity - held_quantity
									>= ${line.quantity}::numeric
							RETURNING id
						`,
					),
				),
			);
			if (debited.some((row) => row === null)) {
				throw new Error("Administrative debit could not be applied to a locked allocation");
			}
			await enqueueUsageProjection(tx, { projectId, customerId: customer.id });
			return { duplicate: false, debit: await requireDebit(tx, projectId, debit.id) };
		});
	}

	async listAdministrativeDebits(
		project: ProjectInstanceContext,
		billingAccountId: string,
		options: AdjustmentListOptions,
	): Promise<AdjustmentList<AdministrativeDebitRecord>> {
		const limit = requirePositiveLimit(options.limit);
		const rows = await executeRows<DebitRow>(
			this.database,
			drizzleSql`
				${debitSelect(
					project.projectInstanceId,
					drizzleSql`c.billing_account_id = ${billingAccountId} AND ${keyset(options.cursor, "d")}`,
				)}
				ORDER BY d.created_at DESC, d.id DESC
				LIMIT ${limit + 1}
			`,
		);
		return page(rows, limit, toDebitRecord);
	}
}

/**
 * Serializes adjustments of one account. `FOR NO KEY UPDATE` still admits the key-share locks that
 * usage takes through its foreign keys while it holds allocation locks, so the two cannot deadlock.
 */
async function lockCustomer(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
): Promise<{ id: string; billing_account_id: string } | null> {
	return await executeOne<{ id: string; billing_account_id: string }>(
		executor,
		drizzleSql`
			SELECT id, billing_account_id FROM customers
			WHERE project_id = ${projectId} AND billing_account_id = ${billingAccountId}
			FOR NO KEY UPDATE
		`,
	);
}

function allocationUnits(value: string): bigint {
	return decimalToUnits(databaseDecimal(value, "allocation quantity"), allocationScale);
}

function keyset(cursor: string | null, alias: "g" | "d"): DrizzleSQL {
	if (cursor === null) return drizzleSql`true`;
	const position = decodeAdminCursor(cursor);
	const table = drizzleSql.raw(alias);
	return drizzleSql`(${table}.created_at, ${table}.id) < (${position.createdAt}::timestamptz, ${position.id}::uuid)`;
}

function page<Row extends { id: string; cursor_created_at: string }, Item>(
	rows: Row[],
	limit: number,
	toItem: (row: Row) => Item,
): AdjustmentList<Item> {
	const last = rows[limit - 1];
	return {
		items: rows.slice(0, limit).map(toItem),
		nextCursor:
			rows.length > limit && last !== undefined
				? encodeAdminCursor({ createdAt: last.cursor_created_at, id: last.id })
				: null,
	};
}

function operatorGrantSelect(projectId: string, condition: DrizzleSQL): DrizzleSQL {
	return drizzleSql`
		SELECT
			g.id,
			c.billing_account_id,
			f.key AS feature_key,
			e.external_id AS entity_external_id,
			a.id AS allocation_id,
			a.quantity::text,
			a.reversed_quantity::text,
			a.consumed_quantity::text,
			a.held_quantity::text,
			a.expires_at,
			a.reversed_at IS NOT NULL AS allocation_reversed,
			(a.expires_at IS NOT NULL AND a.expires_at <= now()) AS expired,
			g.actor,
			g.reason,
			g.request_hash,
			g.revoked_at,
			g.revoked_quantity::text,
			g.revocation_actor,
			g.revocation_reason,
			g.created_at,
			to_char(g.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
		FROM operator_grants g
		JOIN customers c ON c.project_id = g.project_id AND c.id = g.customer_id
		JOIN balance_allocations a ON a.project_id = g.project_id AND a.operator_grant_id = g.id
		JOIN features f ON f.project_id = a.project_id AND f.id = a.feature_id
		LEFT JOIN entities e ON e.project_id = a.project_id AND e.id = a.entity_id
		WHERE g.project_id = ${projectId} AND ${condition}
	`;
}

async function readOperatorGrant(
	executor: QueryExecutor,
	projectId: string,
	condition: DrizzleSQL,
): Promise<OperatorGrantRow | null> {
	return await executeOne<OperatorGrantRow>(
		executor,
		drizzleSql`${operatorGrantSelect(projectId, condition)} LIMIT 1`,
	);
}

async function requireOperatorGrant(
	executor: QueryExecutor,
	projectId: string,
	grantId: string,
): Promise<OperatorGrantRecord> {
	const row = await readOperatorGrant(executor, projectId, drizzleSql`g.id = ${grantId}::uuid`);
	if (row === null) throw new Error(`operator grant ${grantId} was not found`);
	return toOperatorGrantRecord(row);
}

function toOperatorGrantRecord(row: OperatorGrantRow): OperatorGrantRecord {
	const quantity = allocationUnits(row.quantity);
	const reversed = allocationUnits(row.reversed_quantity);
	const consumed = allocationUnits(row.consumed_quantity);
	const held = allocationUnits(row.held_quantity);
	const spendable = quantity - reversed - consumed - held;
	const closed = row.revoked_at !== null || row.allocation_reversed || row.expired;
	const available = closed || spendable < 0n ? 0n : spendable;
	return {
		id: row.id,
		billingAccountId: row.billing_account_id,
		featureKey: row.feature_key,
		entityId: row.entity_external_id,
		allocationId: String(row.allocation_id),
		quantity: unitsToDecimal(quantity, allocationScale),
		expiresAt: row.expires_at === null ? null : formatUtcTimestamp(row.expires_at),
		status: row.revoked_at !== null ? "revoked" : row.expired ? "expired" : "active",
		consumedQuantity: unitsToDecimal(consumed, allocationScale),
		heldQuantity: unitsToDecimal(held, allocationScale),
		reversedQuantity: unitsToDecimal(reversed, allocationScale),
		availableQuantity: unitsToDecimal(available, allocationScale),
		actor: row.actor,
		reason: row.reason,
		createdAt: formatUtcTimestamp(row.created_at),
		revocation:
			row.revoked_at === null ||
			row.revocation_actor === null ||
			row.revocation_reason === null ||
			row.revoked_quantity === null
				? null
				: {
						actor: row.revocation_actor,
						reason: row.revocation_reason,
						revokedAt: formatUtcTimestamp(row.revoked_at),
						revokedQuantity: unitsToDecimal(allocationUnits(row.revoked_quantity), allocationScale),
					},
	};
}

function debitSelect(projectId: string, condition: DrizzleSQL): DrizzleSQL {
	return drizzleSql`
		SELECT
			d.id,
			c.billing_account_id,
			d.actor,
			d.reason,
			d.request_hash,
			d.created_at,
			to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
			COALESCE(
				(
					SELECT jsonb_agg(
						jsonb_build_object(
							'allocation_id', line.allocation_id::text,
							'feature_key', f.key,
							'entity_external_id', e.external_id,
							'source_kind', a.source_kind,
							'quantity', line.quantity::text
						)
						ORDER BY line.allocation_id
					)
					FROM administrative_debit_allocations line
					JOIN balance_allocations a
						ON a.project_id = line.project_id AND a.id = line.allocation_id
					JOIN features f ON f.project_id = a.project_id AND f.id = a.feature_id
					LEFT JOIN entities e ON e.project_id = a.project_id AND e.id = a.entity_id
					WHERE line.project_id = d.project_id AND line.debit_id = d.id
				),
				'[]'::jsonb
			) AS allocations
		FROM administrative_debits d
		JOIN customers c ON c.project_id = d.project_id AND c.id = d.customer_id
		WHERE d.project_id = ${projectId} AND ${condition}
	`;
}

async function requireDebit(
	executor: QueryExecutor,
	projectId: string,
	debitId: string,
): Promise<AdministrativeDebitRecord> {
	const row = await executeOne<DebitRow>(
		executor,
		drizzleSql`${debitSelect(projectId, drizzleSql`d.id = ${debitId}::uuid`)} LIMIT 1`,
	);
	if (row === null) throw new Error(`administrative debit ${debitId} was not found`);
	return toDebitRecord(row);
}

function toDebitRecord(row: DebitRow): AdministrativeDebitRecord {
	return {
		id: row.id,
		billingAccountId: row.billing_account_id,
		actor: row.actor,
		reason: row.reason,
		createdAt: formatUtcTimestamp(row.created_at),
		allocations: row.allocations.map((line) => ({
			allocationId: String(line.allocation_id),
			featureKey: line.feature_key,
			entityId: line.entity_external_id,
			sourceKind: line.source_kind,
			quantity: unitsToDecimal(allocationUnits(line.quantity), allocationScale),
		})),
	};
}
