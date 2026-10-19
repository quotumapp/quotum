import { sql } from "drizzle-orm";
import { databaseDecimal } from "../../billing/decimal";
import {
	InvalidRequestError,
	NotFoundBillingError,
	PersistenceConflictError,
} from "../../billing/errors";
import type { AllocationDeduction } from "../../billing/metering";
import {
	publicUsageBalance,
	publicUsageValue,
	type UsageApiServiceLike,
	type UsageConfirmResult,
	type UsageMeteredContext,
	type UsageReceipt,
	type UsageReservation,
	type UsageReserveResult,
	usageContext,
	usageVerdict,
} from "../../billing/usage-api";
import type { ProjectInstanceContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import { requireBillingAccount } from "./billing-accounts";
import {
	confirmWithinTransaction,
	releaseWithinTransaction,
	reserveWithinTransaction,
} from "./metering";
import {
	calculateWalletQuantity,
	expireSubjectReservations,
	type FeatureRow,
	lockReservation,
	rateFromReservation,
	requireMeteredFeature,
} from "./metering-persistence";
import { executeOne, jsonb } from "./query";
import type { QueryExecutor } from "./types";
import { runUsageOperation } from "./usage-operations";
import { receiptId } from "./usage-receipts";

function receiptContext(receipt: UsageReceipt): UsageMeteredContext {
	const { featureId, entityId, usage, rated, balance } = receipt;
	return { featureId, entityId, usage, rated, balance };
}

/** This read uses the database clock without performing expiry maintenance or taking row locks. */
async function readReservation(
	executor: QueryExecutor,
	projectId: string,
	input: { billingAccountId: string; reservationId: string },
): Promise<UsageReservation> {
	const row = await executeOne<{
		id: string;
		billing_account_id: string;
		entity_id: string | null;
		feature_key: string;
		unit: string;
		requested_quantity: unknown;
		confirmed_quantity: unknown | null;
		status: UsageReservation["status"];
		created_at: Date | string;
		expires_at: Date | string;
		finalized_at: Date | string | null;
		receipt_id: string | null;
	}>(
		executor,
		sql`
		SELECT r.id, c.billing_account_id, entity.external_id AS entity_id, feature.key AS feature_key,
			feature.unit, r.requested_quantity, r.confirmed_quantity,
			CASE WHEN r.status = 'active' AND r.expires_at <= statement_timestamp() THEN 'expired' ELSE r.status END AS status,
			r.created_at, r.expires_at,
			CASE WHEN r.status = 'active' AND r.expires_at <= statement_timestamp() THEN r.expires_at ELSE r.finalized_at END AS finalized_at,
			(SELECT event.receipt->>'receiptId' FROM usage_events event
			 WHERE event.project_id = r.project_id AND event.customer_id = r.customer_id
			 AND event.reservation_id = r.id AND event.operation = 'confirm' LIMIT 1) AS receipt_id
		FROM reservations r
		JOIN customers c ON c.project_id = r.project_id AND c.id = r.customer_id
		JOIN features feature ON feature.project_id = r.project_id AND feature.id = r.meter_feature_id
		LEFT JOIN entities entity ON entity.project_id = r.project_id AND entity.id = r.entity_id
		WHERE r.project_id = ${projectId} AND c.billing_account_id = ${input.billingAccountId}
		AND r.id = ${input.reservationId}
	`,
	);
	if (row === null)
		throw new NotFoundBillingError("Reservation was not found", "RESERVATION_NOT_FOUND");
	return {
		reservationId: row.id,
		billingAccountId: row.billing_account_id,
		featureId: row.feature_key,
		entityId: row.entity_id,
		usage: {
			featureId: row.feature_key,
			unit: row.unit,
			value: databaseDecimal(row.requested_quantity, "reserved value"),
		},
		confirmedValue:
			row.confirmed_quantity === null
				? null
				: databaseDecimal(row.confirmed_quantity, "confirmed value"),
		status: row.status,
		createdAt: new Date(row.created_at).toISOString(),
		expiresAt: new Date(row.expires_at).toISOString(),
		finalizedAt: row.finalized_at === null ? null : new Date(row.finalized_at).toISOString(),
		receiptId: row.receipt_id,
	};
}

export class UsageReservationRepository extends RepositoryModule {
	get: UsageApiServiceLike["getReservation"] = (project, input) =>
		readReservation(this.database, project.projectInstanceId, input);

	reserve: UsageApiServiceLike["reserve"] = async (project, input) => {
		const expiresInSeconds = input.expiresInSeconds ?? 300;
		if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 86400)
			throw new InvalidRequestError("expiresInSeconds must be an integer between 1 and 86400");
		const projectId = project.projectInstanceId;
		const mutation = {
			billingAccountId: input.billingAccountId,
			entityId: input.entityId,
			featureKey: input.featureId,
			quantity: publicUsageValue(input.value),
			idempotencyKey: input.operationId,
			expiresInSeconds,
		};
		return this.transaction(async (tx) => {
			await requireBillingAccount(tx, projectId, input.billingAccountId);
			return runUsageOperation<UsageReserveResult, FeatureRow>(
				tx,
				project,
				"reserve",
				mutation,
				async (customer, feature) => {
					const result = await reserveWithinTransaction(tx, projectId, customer, {
						...mutation,
						feature,
						occurredAt: null,
						projectionKey: `usage:reserve:${customer.id}:${input.operationId}`,
					});
					const context = usageContext(input, feature.unit, result);
					const verdict = usageVerdict(result);
					const identity = { operation: "reserve" as const, operationId: input.operationId };
					if (!verdict.allowed) return { ...context, ...identity, ...verdict };
					if (result.reservationId === null || result.expiresAt === null)
						throw new Error("Accepted reservation has no hold identity");
					return {
						...context,
						...identity,
						allowed: true as const,
						reservationId: result.reservationId,
						status: "active" as const,
						expiresAt: result.expiresAt,
					};
				},
				{
					recoveryVersion: 2,
					prefetch: (executor) => requireMeteredFeature(executor, projectId, input.featureId),
					prepare: (executor) =>
						expireSubjectReservations(executor, projectId, input.billingAccountId),
				},
			);
		});
	};

	confirm: UsageApiServiceLike["confirm"] = async (project, input) => {
		const projectId = project.projectInstanceId;
		const mutation = {
			billingAccountId: input.billingAccountId,
			reservationId: input.reservationId,
			quantity: publicUsageValue(input.value),
			idempotencyKey: input.operationId,
		};
		return this.transaction((tx) =>
			runUsageOperation<UsageConfirmResult>(
				tx,
				project,
				"confirm",
				mutation,
				async (customer) => {
					const result = await confirmWithinTransaction(tx, projectId, customer, {
						...mutation,
						occurredAt: null,
						metadata: {},
						projectionKey: `usage:confirm:${customer.id}:${input.operationId}`,
					});
					const reservation = await lockReservation(
						tx,
						projectId,
						customer.id,
						input.reservationId,
					);
					const current = await readReservation(tx, projectId, input);
					const identity = {
						operation: "confirm" as const,
						operationId: input.operationId,
						reservationId: input.reservationId,
					};
					const context: UsageMeteredContext = {
						featureId: current.featureId,
						entityId: current.entityId,
						usage: { ...current.usage, value: mutation.quantity },
						rated: {
							featureId: result.balance.featureKey,
							unit: result.balance.unit,
							value: await calculateWalletQuantity(
								tx,
								await rateFromReservation(tx, reservation),
								mutation.quantity,
							),
						},
						balance: publicUsageBalance(result.balance),
					};
					if (!result.allowed) {
						if (result.reason === "reservation_expired")
							return {
								...context,
								...identity,
								allowed: false,
								status: "expired",
								reason: "reservation_expired",
							};
						return {
							...context,
							...identity,
							allowed: false,
							status: "active",
							reason: result.reason === "allowed" ? "insufficient_balance" : result.reason,
							...(result.control == null ? {} : { control: result.control }),
						};
					}
					const event = await executeOne<{
						id: string;
						recorded_at: Date | string;
						recorded_at_exact: string;
						wallet_quantity: unknown;
						deductions: AllocationDeduction[];
						receipt: UsageReceipt | null;
					}>(
						tx,
						sql`
				SELECT id, recorded_at, recorded_at::text AS recorded_at_exact, wallet_quantity, deductions, receipt
				FROM usage_events WHERE project_id = ${projectId} AND customer_id = ${customer.id}
				AND reservation_id = ${input.reservationId} AND id = ${result.usageEventId} AND operation = 'confirm'
			`,
					);
					if (event === null) throw new Error("Confirmed reservation has no usage event");
					let receipt = event.receipt;
					if (receipt === null) {
						receipt = {
							...context,
							...identity,
							billingAccountId: input.billingAccountId,
							rated: {
								...context.rated,
								value: databaseDecimal(event.wallet_quantity, "rated value"),
							},
							receiptId: receiptId(event.id, event.recorded_at_exact),
							usageEventId: event.id,
							recordedAt: new Date(event.recorded_at).toISOString(),
							occurredAt: null,
							rating: { path: reservation.rate_card_path, revision: reservation.revision },
							deductionCount: event.deductions.length,
						};
						await executeOne(
							tx,
							sql`
					UPDATE usage_events SET receipt = ${jsonb(receipt)}
					WHERE project_id = ${projectId} AND id = ${event.id}
					AND recorded_at = ${event.recorded_at_exact}::timestamptz AND receipt IS NULL RETURNING id
				`,
						);
					}
					return {
						...receiptContext(receipt),
						...identity,
						allowed: true,
						status: "confirmed",
						receiptId: receipt.receiptId,
						usageEventId: receipt.usageEventId,
						recordedAt: receipt.recordedAt,
					};
				},
				{
					recoveryVersion: 2,
					prepare: (executor) =>
						expireSubjectReservations(executor, projectId, input.billingAccountId),
				},
			),
		);
	};

	release: UsageApiServiceLike["release"] = async (project: ProjectInstanceContext, input) => {
		const projectId = project.projectInstanceId;
		return this.transaction((tx) =>
			runUsageOperation(
				tx,
				project,
				"release",
				{
					billingAccountId: input.billingAccountId,
					reservationId: input.reservationId,
					idempotencyKey: input.operationId,
				},
				async (customer) => {
					await releaseWithinTransaction(tx, projectId, customer, input.reservationId);
					const current = await readReservation(tx, projectId, input);
					if (current.status === "active" || current.finalizedAt === null)
						throw new PersistenceConflictError(
							"Reservation has not finalized",
							"OPERATION_IN_PROGRESS",
						);
					return {
						operation: "release" as const,
						operationId: input.operationId,
						reservationId: input.reservationId,
						featureId: current.featureId,
						entityId: current.entityId,
						status: current.status,
						finalizedAt: current.finalizedAt,
					};
				},
				{
					recoveryVersion: 2,
					prepare: (executor) =>
						expireSubjectReservations(executor, projectId, input.billingAccountId),
				},
			),
		);
	};
}
