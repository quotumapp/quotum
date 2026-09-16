import { sql as drizzleSql } from "drizzle-orm";
import {
	databaseDecimal,
	decimalToUnits,
	positiveDecimal,
	signedDecimalToUnits,
	unitsToDecimal,
} from "../../billing/decimal";
import {
	BillingError,
	InvalidRequestError,
	NotFoundBillingError,
	PersistenceConflictError,
} from "../../billing/errors";
import type {
	AllocationDeduction,
	ConfirmReservationInput,
	ConsumeUsageResult,
	CorrectUsageInput,
	FinalizeReservationResult,
	MeteringBalance,
	MeteringDecision,
	MeteringMaintenanceResult,
	MeteringMutationInput,
	MeteringSubjectInput,
	RateCardPath,
	ReleaseReservationInput,
	ReservationResult,
	ReserveUsageInput,
	UsageCorrectionResult,
	WorkerConsumeUsageResult,
	WorkerMeteringMutationInput,
} from "../../billing/metering";
import { calculateTieredUsageCharge, calculateUsageCharge } from "../../billing/pricing";
import type {
	UsageOperationInput,
	UsageOperationKind,
	UsageOperationLookupInput,
	UsageOperationLookupResult,
	UsageOperationResult,
} from "../../billing/usage-operations";
import type { ProjectInstanceContext } from "../../projects/context";
import { toIso } from "../../shared/date";
import { RepositoryModule } from "./base";
import type { ControlDenial, UsageAlertRow } from "./controls-runtime";
import {
	checkControls,
	confirmControlHolds,
	consumeControls,
	correctControlConsumption,
	holdControls,
	queryAutoTopupPolicy,
	queryUsageAlerts,
	recordUsageAlertDelta,
	recordUsageControlEntries,
	scheduleAutoTopupIfNeeded,
} from "./controls-runtime";
import { enqueueUsageProjection } from "./entitlements";
import { ensureCustomer } from "./identities";
import type {
	AllocationRow,
	ConfirmationPlan,
	FeatureRow,
	MeterLimitDecision,
	RateDecision,
} from "./metering-persistence";
import {
	addUtcInterval,
	addUtcMonths,
	applyConfirmation,
	applyDeductions,
	balanceFromRows,
	buildDecision,
	calculateMeteredOverageCharge,
	calculateWalletQuantity,
	canonicalFilterKey,
	checkMeterLimit,
	claimWorkerDelivery,
	confirmMeterLimitReservation,
	consumeMeterLimit,
	controlDeniedDecision,
	deductedRows,
	emptyBalance,
	enqueueMeteringProjection,
	expireSubjectReservations,
	featureId,
	finalizedReservationResult,
	findCustomer,
	incrementRollup,
	insertUsageEvent,
	lockAllAllocationRows,
	lockAllocations,
	lockReservation,
	lockReservationAllocations,
	lockReservationById,
	meterLimitDecision,
	meterLimitSpendDelta,
	planConfirmation,
	planDeductions,
	queryAdditiveRateCard,
	queryMeterLimitConfigured,
	queryMeterLimitRows,
	queryPinnedRateCards,
	queryPurchasedRevision,
	rateDecision,
	rateFromReservation,
	readBalance,
	readMeterLimitBalance,
	releaseReservationHolds,
	requireMeteredFeature,
	reserveMeterLimit,
	resolveEntityId,
	resolveMeterLimit,
	resolveRateDecision,
	toTimestamp,
	validateFilters,
	validateOccurredAt,
} from "./metering-persistence";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";
import {
	expireUsageOperationResults,
	lookupUsageOperation,
	runUsageOperation,
} from "./usage-operations";

interface OriginalUsageRow {
	id: string;
	recorded_at: Date | string;
	recorded_at_exact: string;
	customer_id: string;
	entity_id: string | number | bigint | null;
	meter_feature_id: string | number | bigint;
	meter_feature_key: string;
	wallet_feature_id: string | number | bigint;
	wallet_feature_key: string;
	wallet_unit: string;
	wallet_scale: number;
	reservation_id: string | null;
	quantity: unknown;
	wallet_quantity: unknown;
	occurred_at: Date | string | null;
	effective_at: Date | string;
	rate_card_entry_id: string | number | bigint | null;
	rate_card_revision_id: string | number | bigint | null;
	rate_card_path: RateCardPath;
	rate_inputs: Record<string, unknown>;
	filter_key: string | null;
	deductions: AllocationDeduction[];
	metadata: Record<string, unknown>;
}

export interface GrantAllocationInput {
	billingAccountId: string;
	entityId?: string | null;
	featureKey: string;
	quantity: string;
	/** Rewards are written only by promotion redemptions, which carry their provenance. */
	sourceKind: "subscription" | "purchase" | "credit_grant" | "topup" | "operator";
	sourceKey: string;
	expiresAt?: Date | null;
	periodStartAt?: Date | null;
	periodEndAt?: Date | null;
	subscriptionId?: string | null;
	purchaseId?: string | null;
	creditGrantId?: string | null;
}

export class MeteringBillingRepository extends RepositoryModule {
	/**
	 * Runs a usage operation. The prefetch holds non-blocking reads pipelined with the operation
	 * lock and claim read; the expired-reservation sweep runs with the customer row once the lock
	 * is held, so holds are released before the callback locks balances.
	 */
	private async operationTransaction<
		I extends UsageOperationInput,
		T extends UsageOperationResult,
		P,
	>(
		project: ProjectInstanceContext,
		operation: UsageOperationKind,
		input: I,
		prefetch: (tx: QueryExecutor, input: I) => Promise<P>,
		callback: (
			tx: QueryExecutor,
			input: I,
			customer: { id: string; billingAccountId: string },
			prefetched: P,
		) => Promise<T>,
	): Promise<T> {
		const normalizedInput = { ...input, billingAccountId: input.billingAccountId.trim() };
		return await this.transaction((tx) =>
			runUsageOperation<T, P>(
				tx,
				project,
				operation,
				normalizedInput,
				(customer, prefetched) => callback(tx, normalizedInput, customer, prefetched),
				{
					prefetch: (executor) => prefetch(executor, normalizedInput),
					prepare: (executor) =>
						expireSubjectReservations(
							executor,
							project.projectInstanceId,
							normalizedInput.billingAccountId,
						),
				},
			),
		);
	}

	async getOperation(
		project: ProjectInstanceContext,
		input: UsageOperationLookupInput,
	): Promise<UsageOperationLookupResult> {
		return await this.transaction((tx) => lookupUsageOperation(tx, project, input));
	}

	async getBalance(
		project: ProjectInstanceContext,
		billingAccountId: string,
		featureKey: string,
		entityExternalId?: string | null,
	): Promise<MeteringBalance> {
		const projectId = project.projectInstanceId;
		const feature = await requireMeteredFeature(this.database, projectId, featureKey);
		const customer = await findCustomer(this.database, projectId, billingAccountId);
		const entityId = await resolveEntityId(
			this.database,
			projectId,
			customer?.id ?? null,
			entityExternalId,
		);
		const meterLimit = await resolveMeterLimit(
			this.database,
			projectId,
			customer?.id ?? null,
			feature,
		);
		if (meterLimit !== null) {
			return await readMeterLimitBalance(
				this.database,
				projectId,
				customer?.id ?? null,
				entityId,
				null,
				meterLimit,
			);
		}
		return customer === null
			? emptyBalance(feature)
			: await readBalance(this.database, projectId, customer.id, feature, entityId);
	}

	async check(
		project: ProjectInstanceContext,
		input: MeteringSubjectInput,
	): Promise<MeteringDecision> {
		const projectId = project.projectInstanceId;
		await validateOccurredAt(this.database, projectId, input.occurredAt ?? null);
		const customer = await findCustomer(this.database, projectId, input.billingAccountId);
		const entityId = await resolveEntityId(
			this.database,
			projectId,
			customer?.id ?? null,
			input.entityId,
		);
		const feature = await requireMeteredFeature(this.database, projectId, input.featureKey);
		validateFilters(feature, input.filters);
		const requestedQuantity = positiveDecimal(input.quantity, "quantity", feature.credit_scale);
		const meterLimit = await resolveMeterLimit(
			this.database,
			projectId,
			customer?.id ?? null,
			feature,
		);
		if (meterLimit !== null) {
			const decision = await checkMeterLimit(
				this.database,
				projectId,
				customer?.id ?? null,
				entityId,
				canonicalFilterKey(input.filters),
				meterLimit,
				requestedQuantity,
			);
			if (!decision.allowed || customer === null) return decision;
			const spend = meterLimitSpendDelta(meterLimit, decision.balance, requestedQuantity);
			const denial = await checkControls(this.database, {
				projectId,
				customerId: customer.id,
				entityId,
				featureId: featureId(feature),
				featureKey: feature.key,
				usageDelta: requestedQuantity,
				...spend,
			});
			return denial === null ? decision : controlDeniedDecision(decision, denial);
		}
		const rate = await resolveRateDecision(
			this.database,
			projectId,
			customer?.id ?? null,
			input.featureKey,
		);
		validateFilters(rate.meter, input.filters);
		const walletQuantity = await calculateWalletQuantity(this.database, rate, requestedQuantity);
		const balance =
			customer === null
				? emptyBalance(rate.wallet)
				: await readBalance(this.database, projectId, customer.id, rate.wallet, entityId);
		const decision = await buildDecision(
			this.database,
			projectId,
			rate,
			requestedQuantity,
			walletQuantity,
			balance,
		);
		if (!decision.allowed || customer === null) return decision;
		const denial = await checkControls(this.database, {
			projectId,
			customerId: customer.id,
			entityId,
			featureId: featureId(rate.meter),
			featureKey: rate.meter.key,
			usageDelta: requestedQuantity,
		});
		return denial === null ? decision : controlDeniedDecision(decision, denial);
	}

	async consume(
		project: ProjectInstanceContext,
		input: MeteringMutationInput,
	): Promise<ConsumeUsageResult> {
		const projectId = project.projectInstanceId;
		return await this.operationTransaction(
			project,
			"consume",
			input,
			(tx, input) => prefetchMeteringSubject(tx, projectId, input),
			(tx, input, customer, prefetched) =>
				consumeWithinTransaction(tx, projectId, customer, {
					featureKey: input.featureKey,
					quantity: input.quantity,
					entityId: input.entityId,
					filters: input.filters,
					occurredAt: input.occurredAt ?? null,
					metadata: input.metadata ?? {},
					projectionKey: `usage:consume:${customer.id}:${input.idempotencyKey}`,
					feature: prefetched.feature,
				}),
		);
	}

	async consumeWorkerDelivery(
		project: ProjectInstanceContext,
		input: WorkerMeteringMutationInput,
	): Promise<WorkerConsumeUsageResult> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const claimed = await claimWorkerDelivery(
				tx,
				projectId,
				input.deliveryId,
				input.requestContextId,
			);
			if (!claimed) return { applied: false, result: null };
			await expireSubjectReservations(tx, projectId, input.billingAccountId);
			const customer = await ensureCustomer(tx, projectId, input.billingAccountId);
			const result = await consumeWithinTransaction(
				tx,
				projectId,
				{ id: customer.id, billingAccountId: customer.billing_account_id },
				{
					featureKey: input.featureKey,
					quantity: input.quantity,
					entityId: input.entityId,
					filters: input.filters,
					occurredAt: input.occurredAt ?? null,
					metadata: {
						...(input.metadata ?? {}),
						workerDeliveryId: input.deliveryId.trim(),
						requestContextId: input.requestContextId.trim(),
					},
					projectionKey: `usage:worker:${customer.id}:${input.deliveryId}`,
				},
			);
			return { applied: true, result };
		});
	}

	async reserve(
		project: ProjectInstanceContext,
		input: ReserveUsageInput,
	): Promise<ReservationResult> {
		const normalized = { ...input, expiresInSeconds: input.expiresInSeconds ?? 300 };
		if (
			!Number.isInteger(normalized.expiresInSeconds) ||
			normalized.expiresInSeconds < 1 ||
			normalized.expiresInSeconds > 86400
		) {
			throw new InvalidRequestError("expiresInSeconds must be an integer between 1 and 86400");
		}

		const projectId = project.projectInstanceId;
		return await this.operationTransaction(
			project,
			"reserve",
			normalized,
			(tx, input) => prefetchMeteringSubject(tx, projectId, input),
			(tx, input, customer, prefetched) =>
				reserveWithinTransaction(tx, projectId, customer, {
					featureKey: input.featureKey,
					quantity: input.quantity,
					entityId: input.entityId,
					filters: input.filters,
					occurredAt: input.occurredAt ?? null,
					expiresInSeconds: input.expiresInSeconds,
					projectionKey: `usage:reserve:${customer.id}:${input.idempotencyKey}`,
					feature: prefetched.feature,
				}),
		);
	}

	async confirm(
		project: ProjectInstanceContext,
		input: ConfirmReservationInput,
	): Promise<FinalizeReservationResult> {
		const projectId = project.projectInstanceId;
		return await this.operationTransaction(
			project,
			"confirm",
			input,
			(tx, input) => validateOccurredAt(tx, projectId, input.occurredAt ?? null),
			(tx, input, customer) =>
				confirmWithinTransaction(tx, projectId, customer, {
					reservationId: input.reservationId,
					quantity: input.quantity,
					occurredAt: input.occurredAt ?? null,
					metadata: input.metadata ?? {},
					projectionKey: `usage:confirm:${customer.id}:${input.idempotencyKey}`,
				}),
		);
	}

	async release(
		project: ProjectInstanceContext,
		input: ReleaseReservationInput,
	): Promise<FinalizeReservationResult> {
		return await this.operationTransaction(
			project,
			"release",
			input,
			async () => undefined,
			async (tx, input, customer) => {
				const projectId = project.projectInstanceId;
				const reservation = await lockReservation(tx, projectId, customer.id, input.reservationId);

				if (reservation.status === "confirmed")
					return await finalizedReservationResult(tx, reservation);
				if (reservation.status === "active") {
					await releaseReservationHolds(
						tx,
						reservation,
						new Date(reservation.expires_at).getTime() <= Date.now() ? "expired" : "released",
					);
				}
				const current = await lockReservation(tx, projectId, customer.id, input.reservationId);
				if (reservation.status === "active") {
					await enqueueMeteringProjection(
						tx,
						projectId,
						customer.id,
						`usage:release:${customer.id}:${input.idempotencyKey}`,
					);
				}
				return await finalizedReservationResult(tx, current);
			},
		);
	}

	async correct(
		project: ProjectInstanceContext,
		input: CorrectUsageInput,
	): Promise<UsageCorrectionResult> {
		if (Number.isNaN(input.originalRecordedAt.getTime())) {
			throw new InvalidRequestError("originalRecordedAt must be a valid timestamp");
		}
		const actor = requiredAuditText(input.actor, "actor", 200);
		const reason = requiredAuditText(input.reason, "reason", 500);
		const correctionQuantity = positiveDecimal(input.quantity, "quantity");

		return await this.operationTransaction(
			project,
			"correct",
			input,
			(tx, input) => validateOccurredAt(tx, project.projectInstanceId, input.occurredAt ?? null),
			async (tx, input, customer) => {
				const projectId = project.projectInstanceId;
				const original = await lockOriginalUsageEvent(
					tx,
					projectId,
					customer.id,
					input.originalUsageEventId,
					input.originalRecordedAt,
				);
				const originalQuantity = databaseDecimal(original.quantity, "original quantity");
				const originalWalletQuantity = databaseDecimal(
					original.wallet_quantity,
					"original wallet quantity",
					original.wallet_scale,
				);
				const corrected = await readCorrectedQuantity(tx, projectId, original);
				const remainingQuantity =
					decimalToUnits(originalQuantity, 9) - decimalToUnits(corrected.quantity, 9);
				const requestedUnits = decimalToUnits(correctionQuantity, 9);
				if (requestedUnits > remainingQuantity) {
					throw new PersistenceConflictError(
						"Usage correction exceeds the original unreversed quantity",
						"CORRECTION_EXCEEDS_USAGE",
					);
				}
				const remainingWallet =
					decimalToUnits(originalWalletQuantity, original.wallet_scale) -
					decimalToUnits(corrected.walletQuantity, original.wallet_scale);
				const walletQuantity =
					requestedUnits === remainingQuantity
						? unitsToDecimal(remainingWallet, original.wallet_scale)
						: await proportionalCorrectionQuantity(
								tx,
								originalQuantity,
								originalWalletQuantity,
								correctionQuantity,
								remainingWallet,
								original.wallet_scale,
							);
				const deductions = await reverseOriginalDeductions(tx, projectId, original, walletQuantity);
				const meterLimitBalanceAfterCorrection = await reverseMeterLimitUsageIfEligible(
					tx,
					projectId,
					customer.id,
					original,
					walletQuantity,
				);
				const event = await insertCorrectionEvent(tx, {
					projectId,
					customerId: customer.id,
					original,
					quantity: correctionQuantity,
					walletQuantity,
					occurredAt: input.occurredAt ?? null,
					deductions,
					metadata: { ...(input.metadata ?? {}), actor, reason },
				});
				const closedPeriodCorrection = await recordClosedUsageInvoiceAdjustment(tx, {
					projectId,
					original,
					correctionEventId: event.id,
					correctionRecordedAtExact: event.recorded_at_exact,
					quantity: walletQuantity,
				});
				await incrementRollup(tx, {
					projectId,
					customerId: customer.id,
					entityId: original.entity_id === null ? null : String(original.entity_id),
					meterFeatureId: String(original.meter_feature_id),
					quantity: negativeDecimal(correctionQuantity),
					walletQuantity: negativeDecimal(walletQuantity),
					recordedAt: event.recorded_at,
				});
				await correctControlConsumption(tx, {
					projectId,
					originalUsageEventId: original.id,
					originalUsageEventRecordedAt: original.recorded_at,
					correctionUsageEventId: event.id,
					correctionUsageEventRecordedAt: event.recorded_at,
					usageReduction: correctionQuantity,
					spendMinorReduction:
						meterLimitBalanceAfterCorrection?.spendMinorReduction ??
						closedPeriodCorrection?.spendMinorReduction ??
						"0",
					currency:
						meterLimitBalanceAfterCorrection?.currency ?? closedPeriodCorrection?.currency ?? null,
				});
				await recordUsageAlertDelta(tx, {
					projectId,
					customerId: customer.id,
					entityId: original.entity_id === null ? null : String(original.entity_id),
					featureId: String(original.meter_feature_id),
					delta: negativeDecimal(correctionQuantity),
				});
				await enqueueMeteringProjection(
					tx,
					projectId,
					customer.id,
					`usage:correct:${customer.id}:${input.idempotencyKey}`,
				);
				const wallet: FeatureRow = {
					id: original.wallet_feature_id,
					key: original.wallet_feature_key,
					unit: original.wallet_unit,
					credit_scale: original.wallet_scale,
					kind: "metered",
					meter_kind: "consumable",
					filter_dimensions: [],
				};
				return {
					usageEventId: event.id,
					recordedAt: toIso(event.recorded_at),
					originalUsageEventId: original.id,
					originalRecordedAt: toIso(original.recorded_at),
					quantity: negativeDecimal(correctionQuantity),
					walletQuantity: negativeDecimal(walletQuantity),
					balance:
						meterLimitBalanceAfterCorrection?.balance ??
						(await readBalance(
							tx,
							projectId,
							customer.id,
							wallet,
							original.entity_id === null ? null : String(original.entity_id),
						)),
					deductions,
				};
			},
		);
	}

	async grantAllocation(
		project: ProjectInstanceContext,
		input: GrantAllocationInput,
	): Promise<{ allocationId: string; duplicate: boolean; balance: MeteringBalance }> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const customer = await ensureCustomer(tx, projectId, input.billingAccountId);
			const entityId = await resolveEntityId(tx, projectId, customer.id, input.entityId);
			const feature = await requireMeteredFeature(tx, projectId, input.featureKey);
			const quantity = positiveDecimal(input.quantity, "quantity", feature.credit_scale);
			const inserted = await executeOne<{ id: string | number | bigint }>(
				tx,
				drizzleSql`
					INSERT INTO balance_allocations (
						project_id,
						customer_id,
						entity_id,
						feature_id,
						subscription_id,
						purchase_id,
						credit_grant_id,
						source_kind,
						source_key,
						quantity,
						period_start_at,
						period_end_at,
						expires_at
					)
					VALUES (
						${projectId},
						${customer.id},
						${entityId}::bigint,
						${featureId(feature)},
						${input.subscriptionId ?? null},
						${input.purchaseId ?? null},
						${input.creditGrantId ?? null},
						${input.sourceKind},
						${input.sourceKey},
						${quantity}::numeric,
						${input.periodStartAt?.toISOString() ?? null},
						${input.periodEndAt?.toISOString() ?? null},
						${input.expiresAt?.toISOString() ?? null}
					)
					ON CONFLICT (project_id, feature_id, source_kind, source_key) DO NOTHING
					RETURNING id
				`,
			);
			let allocationId: string;
			if (inserted === null) {
				const existing = await executeOne<{
					id: string | number | bigint;
					customer_id: string;
					entity_id: string | number | bigint | null;
					quantity: unknown;
					expires_at: Date | string | null;
				}>(
					tx,
					drizzleSql`
						SELECT id, customer_id, entity_id, quantity, expires_at
						FROM balance_allocations
						WHERE project_id = ${projectId}
							AND feature_id = ${featureId(feature)}
							AND source_kind = ${input.sourceKind}
							AND source_key = ${input.sourceKey}
						FOR UPDATE
					`,
				);
				if (existing === null) {
					throw new Error("Allocation could not be persisted");
				}
				if (
					existing.customer_id !== customer.id ||
					(existing.entity_id === null ? null : String(existing.entity_id)) !== entityId ||
					databaseDecimal(existing.quantity, "allocation quantity", feature.credit_scale) !==
						quantity ||
					toTimestamp(existing.expires_at) !== input.expiresAt?.getTime()
				) {
					throw new PersistenceConflictError(
						"Allocation source identity does not match the existing grant",
						"ALLOCATION_IDENTITY_CONFLICT",
					);
				}
				allocationId = String(existing.id);
			} else {
				allocationId = String(inserted.id);
			}
			return {
				allocationId,
				duplicate: inserted === null,
				balance: await readBalance(tx, projectId, customer.id, feature, entityId),
			};
		});
	}

	async expireReservations(limit: number): Promise<number> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
			throw new InvalidRequestError("Reservation expiry limit must be between 1 and 100");
		}
		return await this.transaction(async (tx) => {
			const rows = await executeRows<{ project_id: string; id: string }>(
				tx,
				drizzleSql`
					SELECT project_id, id
					FROM reservations
					WHERE status = 'active'
						AND expires_at <= now()
					ORDER BY expires_at, id
					LIMIT ${limit}
					FOR UPDATE SKIP LOCKED
				`,
			);
			for (const row of rows) {
				const reservation = await lockReservationById(tx, row.project_id, row.id);
				await releaseReservationHolds(tx, reservation, "expired");
				await enqueueMeteringProjection(
					tx,
					row.project_id,
					reservation.customer_id,
					`usage:reservation:${reservation.id}:expired`,
				);
			}
			return rows.length;
		});
	}

	async runMaintenance(limit: number): Promise<MeteringMaintenanceResult> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
			throw new InvalidRequestError("Metering maintenance limit must be between 1 and 1000");
		}
		return await this.transaction(async (tx) => {
			const reservations = await executeRows<{ project_id: string; id: string }>(
				tx,
				drizzleSql`
					SELECT project_id, id
					FROM reservations
					WHERE status = 'active' AND expires_at <= now()
					ORDER BY expires_at, id
					LIMIT ${limit}
					FOR UPDATE SKIP LOCKED
				`,
			);
			for (const row of reservations) {
				const reservation = await lockReservationById(tx, row.project_id, row.id);
				await releaseReservationHolds(tx, reservation, "expired");
				await enqueueMeteringProjection(
					tx,
					row.project_id,
					reservation.customer_id,
					`usage:reservation:${reservation.id}:expired`,
				);
			}
			const rollovers = await materializeExpiredRollovers(tx, limit);
			for (const rollover of rollovers) {
				await enqueueMeteringProjection(
					tx,
					rollover.projectId,
					rollover.customerId,
					`balance:rollover:${rollover.allocationId}`,
				);
			}

			const closedPeriods = await executeRows<{ id: string | number | bigint }>(
				tx,
				drizzleSql`
					WITH targets AS (
						SELECT id
						FROM usage_event_rollups
						WHERE status = 'open' AND period_end_at <= now()
						ORDER BY period_end_at, id
						LIMIT ${limit}
						FOR UPDATE SKIP LOCKED
					)
					UPDATE usage_event_rollups rollups
					SET status = 'closed', closed_at = now(), updated_at = now()
					FROM targets
					WHERE rollups.id = targets.id
					RETURNING rollups.id
				`,
			);

			await expireUsageOperationResults(tx, limit);
			const deletedClientClaims = await deleteExpiredRows(tx, "client_idempotency_claims", limit);
			const deletedWorkerClaims = await deleteExpiredRows(tx, "worker_delivery_claims", limit);
			const expiredDrafts = await executeRows<{ id: string }>(
				tx,
				drizzleSql`
					WITH targets AS (
						SELECT id
						FROM catalog_drafts
						WHERE status = 'previewed' AND expires_at <= now()
						ORDER BY expires_at, id
						LIMIT ${limit}
						FOR UPDATE SKIP LOCKED
					)
					UPDATE catalog_drafts drafts
					SET status = 'expired', updated_at = now()
					FROM targets
					WHERE drafts.id = targets.id
					RETURNING drafts.id
				`,
			);
			const deletedRawUsage = await executeRows<{ id: string }>(
				tx,
				drizzleSql`
					WITH targets AS (
						SELECT events.recorded_at, events.id
						FROM usage_events events
						LEFT JOIN metering_settings settings ON settings.project_id = events.project_id
						WHERE events.recorded_at < now() - make_interval(
							days => COALESCE(settings.raw_usage_retention_days, 400)
						)
						ORDER BY events.recorded_at, events.id
						LIMIT ${limit}
					)
					DELETE FROM usage_events events
					USING targets
					WHERE events.recorded_at = targets.recorded_at AND events.id = targets.id
					RETURNING events.id
				`,
			);

			return {
				expiredReservations: reservations.length,
				rolledOverAllocations: rollovers.length,
				closedPeriods: closedPeriods.length,
				deletedClientClaims,
				deletedWorkerClaims,
				expiredCatalogDrafts: expiredDrafts.length,
				deletedRawUsageEvents: deletedRawUsage.length,
			};
		});
	}
}

async function materializeExpiredRollovers(
	executor: QueryExecutor,
	limit: number,
): Promise<Array<{ projectId: string; customerId: string; allocationId: string }>> {
	const origins = await executeRows<{
		id: string | number | bigint;
		project_id: string;
		customer_id: string;
		entity_id: string | number | bigint | null;
		feature_id: string | number | bigint;
		plan_item_id: string | number | bigint;
		subscription_id: string;
		quantity: unknown;
		reversed_quantity: unknown;
		consumed_quantity: unknown;
		rollover_max_quantity: unknown;
		rollover_expiry_mode: "forever" | "months";
		rollover_expiry_months: number | null;
		reset_interval: "month" | "year";
		period_end_at: Date | string | null;
		expires_at: Date | string;
		policy_revision: number;
		credit_scale: number;
	}>(
		executor,
		drizzleSql`
		SELECT allocation.id, allocation.project_id, allocation.customer_id, allocation.entity_id,
			allocation.feature_id, allocation.plan_item_id, allocation.subscription_id,
			allocation.quantity::text AS quantity,
			allocation.reversed_quantity::text AS reversed_quantity,
			allocation.consumed_quantity::text AS consumed_quantity,
			item.rollover_max_quantity::text AS rollover_max_quantity,
			item.rollover_expiry_mode, item.rollover_expiry_months, item.reset_interval,
			allocation.period_end_at, allocation.expires_at, revision.revision AS policy_revision,
			feature.credit_scale
		FROM balance_allocations allocation
		JOIN plan_items item
			ON item.project_id = allocation.project_id AND item.id = allocation.plan_item_id
		JOIN plan_versions plan_version
			ON plan_version.project_id = item.project_id AND plan_version.id = item.plan_version_id
		JOIN catalog_revisions revision
			ON revision.project_id = plan_version.project_id
			AND revision.id = plan_version.catalog_revision_id
		JOIN features feature
			ON feature.project_id = allocation.project_id AND feature.id = allocation.feature_id
		WHERE allocation.source_kind = 'subscription'
			AND allocation.subscription_id IS NOT NULL
			AND allocation.reversed_at IS NULL
			AND allocation.expires_at IS NOT NULL
			AND allocation.expires_at <= now()
			AND allocation.held_quantity = 0
			AND allocation.rollover_processed_at IS NULL
			AND item.rollover_enabled = true
			AND item.reset_interval IS NOT NULL
		ORDER BY allocation.expires_at, allocation.id
		LIMIT ${limit}
		FOR UPDATE OF allocation SKIP LOCKED
	`,
	);
	const created: Array<{ projectId: string; customerId: string; allocationId: string }> = [];
	for (const origin of origins) {
		await executeOne(
			executor,
			drizzleSql`
			SELECT id FROM subscriptions
			WHERE project_id = ${origin.project_id} AND id = ${origin.subscription_id}
			FOR UPDATE
		`,
		);
		const scale = origin.credit_scale;
		const availableUnits =
			decimalToUnits(databaseDecimal(origin.quantity, "rollover origin quantity", scale), scale) -
			decimalToUnits(
				databaseDecimal(origin.reversed_quantity, "rollover origin reversed", scale),
				scale,
			) -
			decimalToUnits(
				databaseDecimal(origin.consumed_quantity, "rollover origin consumed", scale),
				scale,
			);
		let rolloverUnits = availableUnits > 0n ? availableUnits : 0n;
		if (origin.rollover_max_quantity !== null) {
			const active = await executeOne<{ available: unknown }>(
				executor,
				drizzleSql`
				SELECT COALESCE(sum(
					quantity - reversed_quantity - consumed_quantity - held_quantity
				), 0)::text AS available
				FROM balance_allocations
				WHERE project_id = ${origin.project_id}
					AND customer_id = ${origin.customer_id}
					AND subscription_id = ${origin.subscription_id}
					AND plan_item_id = ${String(origin.plan_item_id)}::bigint
					AND entity_id IS NOT DISTINCT FROM ${origin.entity_id === null ? null : String(origin.entity_id)}::bigint
					AND source_kind = 'rollover'
					AND reversed_at IS NULL
					AND (expires_at IS NULL OR expires_at > now())
			`,
			);
			const capUnits = decimalToUnits(
				databaseDecimal(origin.rollover_max_quantity, "rollover maximum", scale),
				scale,
			);
			const activeUnits = decimalToUnits(
				databaseDecimal(active?.available ?? "0", "active rollover balance", scale),
				scale,
			);
			const remainingCap = capUnits > activeUnits ? capUnits - activeUnits : 0n;
			if (rolloverUnits > remainingCap) rolloverUnits = remainingCap;
		}
		if (rolloverUnits > 0n) {
			const rolloverStart = new Date(origin.period_end_at ?? origin.expires_at);
			const rolloverEnd = addUtcInterval(rolloverStart, origin.reset_interval);
			const expiresAt =
				origin.rollover_expiry_mode === "forever"
					? null
					: addUtcMonths(rolloverStart, origin.rollover_expiry_months ?? 1).toISOString();
			const inserted = await executeOne<{ id: string | number | bigint }>(
				executor,
				drizzleSql`
				INSERT INTO balance_allocations (
					project_id, customer_id, entity_id, feature_id, plan_item_id, subscription_id,
					source_kind, source_key, quantity, period_start_at, period_end_at, expires_at,
					rollover_origin_allocation_id, rollover_policy_revision
				) VALUES (
					${origin.project_id}, ${origin.customer_id},
					${origin.entity_id === null ? null : String(origin.entity_id)}::bigint,
					${String(origin.feature_id)}::bigint, ${String(origin.plan_item_id)}::bigint,
					${origin.subscription_id}, 'rollover',
					${`rollover:${String(origin.id)}:revision:${origin.policy_revision}`},
					${unitsToDecimal(rolloverUnits, scale)}::numeric,
					${rolloverStart.toISOString()}, ${rolloverEnd.toISOString()}, ${expiresAt},
					${String(origin.id)}::bigint, ${origin.policy_revision}
				) ON CONFLICT (project_id, rollover_origin_allocation_id)
				WHERE rollover_origin_allocation_id IS NOT NULL DO NOTHING
				RETURNING id
			`,
			);
			if (inserted !== null) {
				created.push({
					projectId: origin.project_id,
					customerId: origin.customer_id,
					allocationId: String(inserted.id),
				});
			}
		}
		await executeOne(
			executor,
			drizzleSql`
			UPDATE balance_allocations SET rollover_processed_at = now(), updated_at = now()
			WHERE project_id = ${origin.project_id} AND id = ${String(origin.id)}::bigint
			RETURNING id
		`,
		);
	}
	return created;
}

async function deleteExpiredRows(
	executor: QueryExecutor,
	table: "client_idempotency_claims" | "worker_delivery_claims",
	limit: number,
): Promise<number> {
	const rows = await executeRows<{ id: string | number | bigint }>(
		executor,
		drizzleSql`
			WITH targets AS (
				SELECT id
				FROM ${drizzleSql.raw(table)}
				WHERE expires_at <= now()
					${table === "client_idempotency_claims" ? drizzleSql`AND completed_at IS NOT NULL` : drizzleSql``}
				ORDER BY expires_at, id
				LIMIT ${limit}
				FOR UPDATE SKIP LOCKED
			)
			DELETE FROM ${drizzleSql.raw(table)} expired
			USING targets
			WHERE expired.id = targets.id
			RETURNING expired.id
		`,
	);
	return rows.length;
}

async function lockOriginalUsageEvent(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	eventId: string,
	recordedAt: Date,
): Promise<OriginalUsageRow> {
	const row = await executeOne<OriginalUsageRow>(
		executor,
		drizzleSql`
			SELECT
				ue.id,
				ue.recorded_at,
				ue.recorded_at::text AS recorded_at_exact,
				ue.customer_id,
				ue.entity_id,
				ue.meter_feature_id,
				meter.key AS meter_feature_key,
				ue.wallet_feature_id,
				wallet.key AS wallet_feature_key,
				wallet.unit AS wallet_unit,
				wallet.credit_scale AS wallet_scale,
				ue.reservation_id,
				ue.quantity,
				ue.wallet_quantity,
				ue.occurred_at,
				ue.effective_at,
				ue.rate_card_entry_id,
				ue.rate_card_revision_id,
				ue.rate_card_path,
				ue.rate_inputs,
				ue.filter_key,
				ue.deductions,
				ue.metadata
			FROM usage_events ue
			JOIN features wallet
				ON wallet.project_id = ue.project_id
				AND wallet.id = ue.wallet_feature_id
			JOIN features meter
				ON meter.project_id = ue.project_id
				AND meter.id = ue.meter_feature_id
			WHERE ue.project_id = ${projectId}
				AND ue.customer_id = ${customerId}
				AND ue.id = ${eventId}
				AND ue.recorded_at >= ${recordedAt.toISOString()}::timestamptz
				AND ue.recorded_at < ${recordedAt.toISOString()}::timestamptz + interval '1 millisecond'
				AND ue.operation IN ('consume', 'confirm')
			FOR UPDATE OF ue
		`,
	);
	if (row === null) {
		throw new NotFoundBillingError(`Usage event ${eventId} was not found`, "USAGE_EVENT_NOT_FOUND");
	}
	return row;
}

async function readCorrectedQuantity(
	executor: QueryExecutor,
	projectId: string,
	original: OriginalUsageRow,
): Promise<{ quantity: string; walletQuantity: string }> {
	const row = await executeOne<{ quantity: unknown; wallet_quantity: unknown }>(
		executor,
		drizzleSql`
			SELECT
				COALESCE(-sum(quantity), 0)::text AS quantity,
				COALESCE(-sum(wallet_quantity), 0)::text AS wallet_quantity
			FROM usage_events
			WHERE project_id = ${projectId}
				AND original_event_id = ${original.id}
				AND original_event_recorded_at = ${original.recorded_at_exact}::timestamptz
				AND operation = 'correction'
		`,
	);
	return {
		quantity: databaseDecimal(row?.quantity ?? "0", "corrected quantity"),
		walletQuantity: databaseDecimal(
			row?.wallet_quantity ?? "0",
			"corrected wallet quantity",
			original.wallet_scale,
		),
	};
}

async function proportionalCorrectionQuantity(
	executor: QueryExecutor,
	originalQuantity: string,
	originalWalletQuantity: string,
	correctionQuantity: string,
	remainingWalletUnits: bigint,
	walletScale: number,
): Promise<string> {
	const row = await executeOne<{ quantity: unknown }>(
		executor,
		drizzleSql`
			SELECT round(
				${originalWalletQuantity}::numeric * ${correctionQuantity}::numeric
					/ ${originalQuantity}::numeric,
				${walletScale}
			)::text AS quantity
		`,
	);
	if (row === null) throw new Error("Correction quantity could not be evaluated");
	const proportional = databaseDecimal(row.quantity, "correction wallet quantity", walletScale);
	const proportionalUnits = decimalToUnits(proportional, walletScale);
	return unitsToDecimal(
		proportionalUnits > remainingWalletUnits ? remainingWalletUnits : proportionalUnits,
		walletScale,
	);
}

async function reverseOriginalDeductions(
	executor: QueryExecutor,
	projectId: string,
	original: OriginalUsageRow,
	walletQuantity: string,
): Promise<AllocationDeduction[]> {
	const scale = original.wallet_scale;
	let remaining = decimalToUnits(walletQuantity, scale);
	if (remaining === 0n) return [];
	if (typeof original.metadata.usageWindowId === "string" && original.deductions.length === 0) {
		return [];
	}
	const priorCorrections = await executeRows<{ deductions: AllocationDeduction[] }>(
		executor,
		drizzleSql`
			SELECT deductions
			FROM usage_events
			WHERE project_id = ${projectId}
				AND original_event_id = ${original.id}
				AND original_event_recorded_at = ${original.recorded_at_exact}::timestamptz
				AND operation = 'correction'
			ORDER BY recorded_at, id
		`,
	);
	const restoredByAllocation = new Map<string, bigint>();
	for (const correction of priorCorrections) {
		for (const deduction of correction.deductions) {
			const units = signedDecimalToUnits(deduction.quantity, scale);
			if (units < 0n) {
				restoredByAllocation.set(
					deduction.allocationId,
					(restoredByAllocation.get(deduction.allocationId) ?? 0n) - units,
				);
			}
		}
	}

	const receipt: AllocationDeduction[] = [];
	for (const deduction of original.deductions) {
		if (remaining === 0n) break;
		const originallyDeducted = decimalToUnits(deduction.quantity, scale);
		const unrestored =
			originallyDeducted - (restoredByAllocation.get(deduction.allocationId) ?? 0n);
		if (unrestored <= 0n) continue;
		const restored = unrestored < remaining ? unrestored : remaining;
		const rendered = unitsToDecimal(restored, scale);
		const allocation = await executeOne<{
			consumed_quantity: unknown;
			expires_at: Date | string | null;
			reversed_at: Date | string | null;
		}>(
			executor,
			drizzleSql`
				SELECT consumed_quantity, expires_at, reversed_at
				FROM balance_allocations
				WHERE project_id = ${projectId}
					AND id = ${deduction.allocationId}::bigint
				FOR UPDATE
			`,
		);
		const eligible =
			allocation !== null &&
			allocation.reversed_at === null &&
			(allocation.expires_at === null || new Date(allocation.expires_at).getTime() > Date.now());
		if (eligible) {
			const updated = await executeOne(
				executor,
				drizzleSql`
					UPDATE balance_allocations
					SET consumed_quantity = consumed_quantity - ${rendered}::numeric, updated_at = now()
					WHERE project_id = ${projectId}
						AND id = ${deduction.allocationId}::bigint
						AND consumed_quantity >= ${rendered}::numeric
					RETURNING id
				`,
			);
			if (updated === null) {
				throw new Error("Correction receipt exceeds the allocation's consumed quantity");
			}
		}
		receipt.push({ ...deduction, quantity: negativeDecimal(rendered) });
		remaining -= restored;
	}
	if (remaining !== 0n) {
		throw new Error("Original deduction receipt does not cover the correction quantity");
	}
	return receipt;
}

async function reverseMeterLimitUsageIfEligible(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	original: OriginalUsageRow,
	walletQuantity: string,
): Promise<{
	balance: MeteringBalance;
	spendMinorReduction: string;
	currency: string | null;
} | null> {
	const windowId = original.metadata.usageWindowId;
	const expectedStart = original.metadata.usageWindowStartAt;
	const expectedEnd = original.metadata.usageWindowEndAt;
	if (
		typeof windowId !== "string" ||
		typeof expectedStart !== "string" ||
		typeof expectedEnd !== "string"
	) {
		return null;
	}
	const feature: FeatureRow = {
		id: original.meter_feature_id,
		key: original.wallet_feature_key,
		unit: original.wallet_unit,
		credit_scale: original.wallet_scale,
		kind: "metered",
		meter_kind: "consumable",
		filter_dimensions: [],
	};
	const meterLimit = await resolveMeterLimit(executor, projectId, customerId, feature);
	if (meterLimit === null) return null;
	const window = await executeOne<{ usage: unknown }>(
		executor,
		drizzleSql`
			SELECT usage::text AS usage FROM usage_windows
			WHERE project_id = ${projectId}
				AND id = ${windowId}::bigint
				AND window_start_at = ${expectedStart}::timestamptz
				AND window_end_at = ${expectedEnd}::timestamptz
				AND window_end_at > now()
				AND usage >= ${walletQuantity}::numeric
			FOR UPDATE
		`,
	);
	if (window === null) return null;
	const usage = databaseDecimal(window.usage, "open window usage", feature.credit_scale);
	const correctedUsage = unitsToDecimal(
		decimalToUnits(usage, feature.credit_scale) -
			decimalToUnits(walletQuantity, feature.credit_scale),
		feature.credit_scale,
	);
	const before = calculateMeteredOverageCharge(meterLimit, usage);
	const after = calculateMeteredOverageCharge(meterLimit, correctedUsage);
	await executeOne(
		executor,
		drizzleSql`
		UPDATE usage_windows SET usage = ${correctedUsage}::numeric, updated_at = now()
		WHERE project_id = ${projectId} AND id = ${windowId}::bigint
		RETURNING id
	`,
	);
	return {
		balance: await readMeterLimitBalance(
			executor,
			projectId,
			customerId,
			original.entity_id === null ? null : String(original.entity_id),
			original.filter_key,
			meterLimit,
		),
		spendMinorReduction: (before.amountMinor - after.amountMinor).toString(),
		currency: meterLimit.overagePrice?.currency ?? null,
	};
}

async function insertCorrectionEvent(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		original: OriginalUsageRow;
		quantity: string;
		walletQuantity: string;
		occurredAt: Date | null;
		deductions: AllocationDeduction[];
		metadata: Record<string, unknown>;
	},
): Promise<{ id: string; recorded_at: Date | string; recorded_at_exact: string }> {
	const recordedAt = new Date();
	const row = await executeOne<{
		id: string;
		recorded_at: Date | string;
		recorded_at_exact: string;
	}>(
		executor,
		drizzleSql`
			INSERT INTO usage_events (
				recorded_at,
				project_id,
				customer_id,
				entity_id,
				meter_feature_id,
				wallet_feature_id,
				original_event_id,
				original_event_recorded_at,
				operation,
				quantity,
				wallet_quantity,
				occurred_at,
				effective_at,
				rate_card_entry_id,
				rate_card_revision_id,
				rate_card_path,
				rate_inputs,
				filter_key,
				deductions,
				metadata
			)
			VALUES (
				${recordedAt.toISOString()},
				${input.projectId},
				${input.customerId},
				${input.original.entity_id},
				${String(input.original.meter_feature_id)}::bigint,
				${String(input.original.wallet_feature_id)}::bigint,
				${input.original.id},
				${input.original.recorded_at_exact}::timestamptz,
				'correction',
				${negativeDecimal(input.quantity)}::numeric,
				${negativeDecimal(input.walletQuantity)}::numeric,
				${input.occurredAt?.toISOString() ?? null},
				${recordedAt.toISOString()},
				${input.original.rate_card_entry_id},
				${input.original.rate_card_revision_id},
				${input.original.rate_card_path},
				${jsonb({ ...input.original.rate_inputs, correctionOf: input.original.id })},
				${input.original.filter_key},
				${jsonb(input.deductions)},
				${jsonb(input.metadata)}
			)
			RETURNING id, recorded_at, recorded_at::text AS recorded_at_exact
		`,
	);
	if (row === null) throw new Error("Usage correction could not be persisted");
	return row;
}

async function recordClosedUsageInvoiceAdjustment(
	executor: QueryExecutor,
	input: {
		projectId: string;
		original: OriginalUsageRow;
		correctionEventId: string;
		correctionRecordedAtExact: string;
		quantity: string;
	},
): Promise<{ spendMinorReduction: string; currency: string } | null> {
	const windowId = input.original.metadata.usageWindowId;
	const expectedStart = input.original.metadata.usageWindowStartAt;
	const expectedEnd = input.original.metadata.usageWindowEndAt;
	if (
		typeof windowId !== "string" ||
		typeof expectedStart !== "string" ||
		typeof expectedEnd !== "string"
	) {
		return null;
	}
	const window = await executeOne<{
		customer_id: string;
		subscription_id: string;
		plan_item_id: string | number | bigint;
		price_component_id: string | number | bigint;
		period_start_at: Date | string;
		period_end_at: Date | string;
		usage_quantity: unknown;
		included_quantity: unknown;
		billing_units: unknown;
		unit_amount_minor: string | number;
		currency: string;
		pricing_model: "flat" | "graduated" | "volume";
	}>(
		executor,
		drizzleSql`
			SELECT
				uw.customer_id, uw.subscription_id,
				uw.anchor_plan_item_id AS plan_item_id, price.id AS price_component_id,
				uw.window_start_at AS period_start_at, uw.window_end_at AS period_end_at,
				uw.usage::text AS usage_quantity, item.quantity::text AS included_quantity,
				price.billing_units::text AS billing_units, price.unit_amount_minor, price.currency,
				price.pricing_model
			FROM usage_windows uw
			JOIN plan_items item
				ON item.project_id = uw.project_id AND item.id = uw.anchor_plan_item_id
			JOIN price_components price
				ON price.project_id = item.project_id AND price.plan_item_id = item.id
				AND price.component_kind = 'metered_overage'
			WHERE uw.project_id = ${input.projectId}
				AND uw.id = ${windowId}::bigint
				AND uw.window_start_at = ${expectedStart}::timestamptz
				AND uw.window_end_at = ${expectedEnd}::timestamptz
				AND uw.window_end_at <= now()
				AND uw.subscription_id IS NOT NULL
				AND item.overage_policy = 'allowed'
			FOR UPDATE OF uw
		`,
	);
	if (window === null) return null;
	const originalCharge = await calculatePersistedPriceCharge(executor, {
		projectId: input.projectId,
		priceComponentId: String(window.price_component_id),
		pricingModel: window.pricing_model,
		usageQuantity: String(window.usage_quantity),
		includedQuantity: String(window.included_quantity),
		billingUnits: String(window.billing_units),
		unitAmountMinor: BigInt(window.unit_amount_minor),
	});
	await executeRows(
		executor,
		drizzleSql`
			INSERT INTO usage_invoice_periods (
				project_id, customer_id, subscription_id, plan_item_id, price_component_id,
				period_start_at, period_end_at, usage_quantity, included_quantity,
				billable_quantity, billing_units, unit_amount_minor, amount_minor, currency,
				status, invoiced_at
			)
			VALUES (
				${input.projectId}, ${window.customer_id}, ${window.subscription_id},
				${String(window.plan_item_id)}::bigint, ${String(window.price_component_id)}::bigint,
				${new Date(window.period_start_at).toISOString()},
				${new Date(window.period_end_at).toISOString()}, ${originalCharge.usageQuantity}::numeric,
				${originalCharge.includedQuantity}::numeric, ${originalCharge.billableQuantity}::numeric,
				${String(window.billing_units)}::numeric, ${window.unit_amount_minor},
				${originalCharge.amountMinor.toString()}, ${window.currency},
				${originalCharge.amountMinor === 0n ? "credited" : "pending"},
				${originalCharge.amountMinor === 0n ? new Date().toISOString() : null}
			)
			ON CONFLICT (project_id, subscription_id, plan_item_id, period_start_at, period_end_at)
			DO NOTHING
		`,
	);
	const period = await executeOne<{
		id: string;
		usage_quantity: unknown;
		included_quantity: unknown;
		billing_units: unknown;
		unit_amount_minor: string | number;
		currency: string;
	}>(
		executor,
		drizzleSql`
			SELECT id, usage_quantity, included_quantity, billing_units, unit_amount_minor, currency
			FROM usage_invoice_periods
			WHERE project_id = ${input.projectId}
				AND subscription_id = ${window.subscription_id}
				AND plan_item_id = ${String(window.plan_item_id)}::bigint
				AND period_start_at = ${new Date(window.period_start_at).toISOString()}
				AND period_end_at = ${new Date(window.period_end_at).toISOString()}
			FOR UPDATE
		`,
	);
	if (period === null) throw new Error("Closed usage period could not be materialized");
	const prior = await executeOne<{ quantity: unknown }>(
		executor,
		drizzleSql`
			SELECT COALESCE(sum(quantity), 0)::text AS quantity
			FROM usage_invoice_adjustments
			WHERE project_id = ${input.projectId} AND closed_period_id = ${period.id}
		`,
	);
	const effectiveUsageUnits =
		decimalToUnits(databaseDecimal(period.usage_quantity, "closed period usage", 9), 9) +
		signedDecimalToUnits(String(prior?.quantity ?? "0"), 9);
	const correctedUsageUnits = effectiveUsageUnits - decimalToUnits(input.quantity, 9);
	if (correctedUsageUnits < 0n) {
		throw new Error("Closed-period correction exceeds invoiceable usage");
	}
	const commonPrice = {
		includedQuantity: String(period.included_quantity),
		billingUnits: String(period.billing_units),
		unitAmountMinor: BigInt(period.unit_amount_minor),
	};
	const before = await calculatePersistedPriceCharge(executor, {
		projectId: input.projectId,
		priceComponentId: String(window.price_component_id),
		pricingModel: window.pricing_model,
		...commonPrice,
		usageQuantity: unitsToDecimal(effectiveUsageUnits, 9),
	});
	const after = await calculatePersistedPriceCharge(executor, {
		projectId: input.projectId,
		priceComponentId: String(window.price_component_id),
		pricingModel: window.pricing_model,
		...commonPrice,
		usageQuantity: unitsToDecimal(correctedUsageUnits, 9),
	});
	const amountDelta = after.amountMinor - before.amountMinor;
	await executeRows(
		executor,
		drizzleSql`
			INSERT INTO usage_invoice_adjustments (
				project_id, closed_period_id, usage_event_id, usage_event_recorded_at,
				quantity, amount_minor, currency, status, invoiced_at
			)
			VALUES (
				${input.projectId}, ${period.id}, ${input.correctionEventId},
				${input.correctionRecordedAtExact}::timestamptz,
				${negativeDecimal(input.quantity)}::numeric, ${amountDelta.toString()},
				${period.currency}, ${amountDelta === 0n ? "credited" : "pending"},
				${amountDelta === 0n ? new Date().toISOString() : null}
			)
			ON CONFLICT (project_id, usage_event_recorded_at, usage_event_id) DO NOTHING
		`,
	);
	return {
		spendMinorReduction: (before.amountMinor - after.amountMinor).toString(),
		currency: period.currency.toUpperCase(),
	};
}

async function calculatePersistedPriceCharge(
	executor: QueryExecutor,
	input: {
		projectId: string;
		priceComponentId: string;
		pricingModel: "flat" | "graduated" | "volume";
		usageQuantity: string;
		includedQuantity: string;
		billingUnits: string;
		unitAmountMinor: bigint;
	},
) {
	if (input.pricingModel === "flat") return calculateUsageCharge(input);
	const tiers = await executeRows<{
		up_to_quantity: unknown;
		unit_amount_minor: string | number;
		flat_amount_minor: string | number;
	}>(
		executor,
		drizzleSql`
			SELECT up_to_quantity::text AS up_to_quantity, unit_amount_minor, flat_amount_minor
			FROM price_tiers
			WHERE project_id = ${input.projectId}
				AND price_component_id = ${input.priceComponentId}::bigint
			ORDER BY ordinal
		`,
	);
	return calculateTieredUsageCharge({
		usageQuantity: input.usageQuantity,
		includedQuantity: input.includedQuantity,
		billingUnits: input.billingUnits,
		pricingModel: input.pricingModel,
		tiers: tiers.map((tier) => ({
			upToQuantity: tier.up_to_quantity === null ? null : String(tier.up_to_quantity),
			unitAmountMinor: BigInt(tier.unit_amount_minor),
			flatAmountMinor: BigInt(tier.flat_amount_minor),
		})),
	});
}

function negativeDecimal(value: string): string {
	return decimalToUnits(value, 9) === 0n ? "0" : `-${value}`;
}

function requiredAuditText(value: string, field: string, maxLength: number): string {
	const normalized = value.trim();
	if (normalized === "" || normalized.length > maxLength) {
		throw new InvalidRequestError(`${field} must contain between 1 and ${maxLength} characters`);
	}
	return normalized;
}

interface ConsumeWithinTransactionInput extends MeteringSubjectInputFields {
	metadata: Record<string, unknown>;
	projectionKey: string;
}

/**
 * The metering hot path. Statements that depend only on identifiers already in hand are issued
 * together so the driver pipelines them in one round trip. Issue order is execution order on the
 * transaction's connection, so the writes in a batch precede the reads that must observe them.
 */
async function consumeWithinTransaction(
	tx: QueryExecutor,
	projectId: string,
	customer: { id: string; billingAccountId: string },
	input: ConsumeWithinTransactionInput,
): Promise<ConsumeUsageResult> {
	const subject = await resolveMeteringSubject(tx, projectId, customer.id, input, { alerts: true });
	const { feature, entityId, requestedQuantity, filterKey, alerts } = subject;
	if (subject.meterLimit !== null) {
		const meterLimit = subject.meterLimit;
		const preflight = await checkMeterLimit(
			tx,
			projectId,
			customer.id,
			entityId,
			filterKey,
			meterLimit,
			requestedQuantity,
		);
		if (!preflight.allowed) {
			return { ...preflight, usageEventId: null, recordedAt: null, deductions: [] };
		}
		const spend = meterLimitSpendDelta(meterLimit, preflight.balance, requestedQuantity);
		const controls = await consumeControls(tx, {
			projectId,
			customerId: customer.id,
			entityId,
			featureId: featureId(feature),
			featureKey: feature.key,
			usageDelta: requestedQuantity,
			...spend,
		});
		if (controls.denial !== null) {
			return {
				...controlDeniedDecision(preflight, controls.denial),
				usageEventId: null,
				recordedAt: null,
				deductions: [],
			};
		}
		const result = await consumeMeterLimit(tx, {
			projectId,
			customerId: customer.id,
			entityId,
			filterKey,
			meterLimit,
			quantity: requestedQuantity,
			occurredAt: input.occurredAt,
			metadata: input.metadata,
			projectionKey: input.projectionKey,
		});
		if (result.allowed && result.usageEventId !== null) {
			await recordUsageControlEntries(tx, {
				projectId,
				usageEventId: result.usageEventId,
				usageEventRecordedAt: result.recordedAt ?? new Date(),
				entries: controls.entries,
			});
			await recordUsageAlertDelta(tx, {
				projectId,
				customerId: customer.id,
				entityId,
				featureId: featureId(feature),
				delta: requestedQuantity,
				alerts,
			});
		}
		return result;
	}
	const rate = await subject.rate();
	validateFilters(rate.meter, input.filters);
	const walletQuantity = await calculateWalletQuantity(tx, rate, requestedQuantity);
	const rows = await lockAllocations(tx, projectId, customer.id, rate.wallet, entityId);
	const decision = await buildDecision(
		tx,
		projectId,
		rate,
		requestedQuantity,
		walletQuantity,
		balanceFromRows(rate.wallet, rows),
	);
	if (!decision.allowed) {
		return { ...decision, usageEventId: null, recordedAt: null, deductions: [] };
	}
	const controls = await consumeControls(tx, {
		projectId,
		customerId: customer.id,
		entityId,
		featureId: featureId(rate.meter),
		featureKey: rate.meter.key,
		usageDelta: requestedQuantity,
	});
	if (controls.denial !== null) {
		return {
			...controlDeniedDecision(decision, controls.denial),
			usageEventId: null,
			recordedAt: null,
			deductions: [],
		};
	}
	const scale = rate.wallet.credit_scale;
	const deductions = planDeductions(rows, scale, walletQuantity);
	const recordedAt = new Date();
	// Deductions are issued first; the reads behind them observe the deduction.
	const [, event, , topupPolicy] = await Promise.all([
		applyDeductions(tx, deductions, "consumed_quantity"),
		insertUsageEvent(tx, {
			projectId,
			customerId: customer.id,
			entityId,
			rate,
			operation: "consume",
			quantity: requestedQuantity,
			walletQuantity,
			occurredAt: input.occurredAt,
			reservationId: null,
			filterKey,
			deductions,
			metadata: input.metadata,
			recordedAt,
		}),
		incrementRollup(tx, {
			projectId,
			customerId: customer.id,
			entityId,
			meterFeatureId: featureId(rate.meter),
			quantity: requestedQuantity,
			walletQuantity,
			recordedAt,
		}),
		queryAutoTopupPolicy(tx, {
			projectId,
			customerId: customer.id,
			entityId,
			featureId: featureId(rate.wallet),
		}),
	]);
	if (controls.entries.length > 0) {
		await recordUsageControlEntries(tx, {
			projectId,
			usageEventId: event.id,
			usageEventRecordedAt: event.recorded_at,
			entries: controls.entries,
		});
	}
	if (alerts.length > 0) {
		await recordUsageAlertDelta(tx, {
			projectId,
			customerId: customer.id,
			entityId,
			featureId: featureId(rate.meter),
			delta: requestedQuantity,
			alerts,
		});
	}
	const balance = balanceFromRows(
		rate.wallet,
		deductedRows(rows, deductions, scale, "consumed_quantity"),
	);
	await Promise.all([
		enqueueUsageProjection(tx, { projectId, customerId: customer.id }),
		scheduleAutoTopupIfNeeded(tx, {
			projectId,
			customerId: customer.id,
			entityId,
			featureId: featureId(rate.wallet),
			availableQuantity: balance.available,
			triggerKey: `usage:${event.id}`,
			policy: topupPolicy,
		}),
	]);
	return {
		...decision,
		balance,
		usageEventId: event.id,
		recordedAt: toIso(event.recorded_at),
		deductions,
	};
}

interface MeteringSubjectInputFields {
	featureKey: string;
	quantity: string;
	entityId?: string | null;
	filters?: Record<string, string | number | boolean>;
	occurredAt: Date | null;
	/** Feature already read, with `occurredAt` already validated, by the operation prefetch. */
	feature?: FeatureRow;
}

/** Non-blocking reads pipelined with the operation's lock: timestamp check and feature read. */
async function prefetchMeteringSubject(
	tx: QueryExecutor,
	projectId: string,
	input: { featureKey: string; occurredAt?: Date | null },
): Promise<{ feature: FeatureRow }> {
	const [, feature] = await Promise.all([
		validateOccurredAt(tx, projectId, input.occurredAt ?? null),
		requireMeteredFeature(tx, projectId, input.featureKey),
	]);
	return { feature };
}

interface MeteringSubject {
	feature: FeatureRow;
	entityId: string | null;
	requestedQuantity: string;
	filterKey: string | null;
	meterLimit: MeterLimitDecision | null;
	alerts: UsageAlertRow[];
	rate(): Promise<RateDecision>;
}

/**
 * Resolves what a usage mutation needs before it locks balances: the feature, the entity, the
 * meter-limit or rate-card decision and, when asked, the alert list. Reads that depend only on
 * the customer and feature identifiers are issued together.
 */
async function resolveMeteringSubject(
	tx: QueryExecutor,
	projectId: string,
	customerId: string,
	input: MeteringSubjectInputFields,
	options: { alerts: boolean },
): Promise<MeteringSubject> {
	const feature =
		input.feature ??
		(
			await Promise.all([
				validateOccurredAt(tx, projectId, input.occurredAt),
				requireMeteredFeature(tx, projectId, input.featureKey),
			])
		)[1];
	const entityId = await resolveEntityId(tx, projectId, customerId, input.entityId);
	validateFilters(feature, input.filters);
	const requestedQuantity = positiveDecimal(input.quantity, "quantity", feature.credit_scale);
	const [
		meterLimitRows,
		meterLimitConfigured,
		pinnedRates,
		additiveRate,
		purchasedRevision,
		alerts,
	] = await Promise.all([
		queryMeterLimitRows(tx, projectId, customerId, feature),
		queryMeterLimitConfigured(tx, projectId, feature),
		queryPinnedRateCards(tx, projectId, customerId, feature),
		queryAdditiveRateCard(tx, projectId, feature),
		queryPurchasedRevision(tx, projectId, customerId),
		options.alerts
			? queryUsageAlerts(tx, { projectId, customerId, entityId, featureId: featureId(feature) })
			: Promise.resolve<UsageAlertRow[]>([]),
	]);
	const meterLimit = await meterLimitDecision(
		tx,
		projectId,
		feature,
		meterLimitRows,
		meterLimitConfigured,
	);
	return {
		feature,
		entityId,
		requestedQuantity,
		filterKey: canonicalFilterKey(input.filters),
		meterLimit,
		alerts,
		rate: () =>
			rateDecision(tx, projectId, feature, {
				pinned: pinnedRates,
				additive: additiveRate,
				purchased: purchasedRevision,
			}),
	};
}

interface ReserveWithinTransactionInput extends MeteringSubjectInputFields {
	expiresInSeconds: number;
	projectionKey: string;
}

async function reserveWithinTransaction(
	tx: QueryExecutor,
	projectId: string,
	customer: { id: string; billingAccountId: string },
	input: ReserveWithinTransactionInput,
): Promise<ReservationResult> {
	const subject = await resolveMeteringSubject(tx, projectId, customer.id, input, {
		alerts: false,
	});
	const { entityId, requestedQuantity, filterKey } = subject;
	if (subject.meterLimit !== null) {
		return await reserveMeterLimit(tx, {
			projectId,
			customerId: customer.id,
			entityId,
			filterKey,
			meterLimit: subject.meterLimit,
			quantity: requestedQuantity,
			expiresInSeconds: input.expiresInSeconds,
			projectionKey: input.projectionKey,
		});
	}
	const rate = await subject.rate();
	validateFilters(rate.meter, input.filters);
	const walletQuantity = await calculateWalletQuantity(tx, rate, requestedQuantity);
	const rows = await lockAllocations(tx, projectId, customer.id, rate.wallet, entityId);
	const decision = await buildDecision(
		tx,
		projectId,
		rate,
		requestedQuantity,
		walletQuantity,
		balanceFromRows(rate.wallet, rows),
	);
	if (!decision.allowed) {
		return { ...decision, reservationId: null, status: null, expiresAt: null, deductions: [] };
	}

	const effectiveAt = new Date();
	const expiresAt = new Date(effectiveAt.getTime() + input.expiresInSeconds * 1000);
	const reservation = await executeOne<{ id: string }>(
		tx,
		drizzleSql`
			INSERT INTO reservations (
				project_id,
				customer_id,
				entity_id,
				meter_feature_id,
				wallet_feature_id,
				rate_card_entry_id,
				rate_card_revision_id,
				rate_card_path,
				requested_quantity,
				held_quantity,
				effective_at,
				expires_at
			)
			VALUES (
				${projectId},
				${customer.id},
				${entityId},
				${featureId(rate.meter)},
				${featureId(rate.wallet)},
				${rate.entryId},
				${rate.revisionId},
				${rate.path},
				${requestedQuantity}::numeric,
				${walletQuantity}::numeric,
				${effectiveAt.toISOString()},
				${expiresAt.toISOString()}
			)
			RETURNING id
		`,
	);
	if (reservation === null) {
		throw new Error("Reservation could not be persisted");
	}
	const controlDenial = await holdControls(
		tx,
		{
			projectId,
			customerId: customer.id,
			entityId,
			featureId: featureId(rate.meter),
			featureKey: rate.meter.key,
			usageDelta: requestedQuantity,
		},
		reservation.id,
	);
	if (controlDenial !== null) {
		await executeOne(
			tx,
			drizzleSql`
				DELETE FROM reservations
				WHERE project_id = ${projectId} AND id = ${reservation.id}
				RETURNING id
			`,
		);
		return {
			...controlDeniedDecision(decision, controlDenial),
			reservationId: null,
			status: null,
			expiresAt: null,
			deductions: [],
		};
	}
	const scale = rate.wallet.credit_scale;
	const deductions = planDeductions(rows, scale, walletQuantity);
	// The holds and the reservation's hold rows are written together.
	await Promise.all([
		applyDeductions(tx, deductions, "held_quantity"),
		insertReservationAllocations(tx, projectId, reservation.id, deductions),
	]);
	await enqueueUsageProjection(tx, { projectId, customerId: customer.id });
	return {
		...decision,
		balance: balanceFromRows(rate.wallet, deductedRows(rows, deductions, scale, "held_quantity")),
		reservationId: reservation.id,
		status: "active",
		expiresAt: expiresAt.toISOString(),
		deductions,
	};
}

interface ConfirmWithinTransactionInput {
	reservationId: string;
	quantity: string;
	occurredAt: Date | null;
	metadata: Record<string, unknown>;
	projectionKey: string;
}

async function confirmWithinTransaction(
	tx: QueryExecutor,
	projectId: string,
	customer: { id: string; billingAccountId: string },
	input: ConfirmWithinTransactionInput,
): Promise<FinalizeReservationResult> {
	const reservation = await lockReservation(tx, projectId, customer.id, input.reservationId);
	const quantity = positiveDecimal(input.quantity, "quantity", reservation.meter_scale);

	if (reservation.status === "confirmed") {
		if (databaseDecimal(reservation.confirmed_quantity, "confirmed quantity") !== quantity) {
			throw new PersistenceConflictError(
				"Reservation was confirmed with different usage facts",
				"RESERVATION_ALREADY_CONFIRMED",
			);
		}
		return await finalizedReservationResult(tx, reservation);
	}
	if (reservation.status === "expired") return await finalizedReservationResult(tx, reservation);
	if (reservation.status === "released")
		throw new PersistenceConflictError("Reservation has been released", "RESERVATION_RELEASED");
	if (new Date(reservation.expires_at).getTime() <= Date.now()) {
		await releaseReservationHolds(tx, reservation, "expired");
		return await finalizedReservationResult(
			tx,
			await lockReservation(tx, projectId, customer.id, input.reservationId),
		);
	}
	if (
		decimalToUnits(quantity, reservation.meter_scale) >
		decimalToUnits(
			databaseDecimal(reservation.requested_quantity, "reserved quantity", reservation.meter_scale),
			reservation.meter_scale,
		)
	) {
		throw new PersistenceConflictError(
			"Confirmed quantity exceeds the reserved authorization",
			"RESERVATION_QUANTITY_EXCEEDED",
		);
	}
	const entityId = reservation.entity_id === null ? null : String(reservation.entity_id);
	if (reservation.usage_window_id !== null) {
		const result = await confirmMeterLimitReservation(tx, reservation, quantity, {
			occurredAt: input.occurredAt,
			metadata: input.metadata,
		});
		if (result.allowed) {
			await recordUsageAlertDelta(tx, {
				projectId,
				customerId: customer.id,
				entityId,
				featureId: String(reservation.meter_feature_id),
				delta: quantity,
			});
			await enqueueMeteringProjection(tx, projectId, customer.id, input.projectionKey);
		}
		return result;
	}

	const rate = await rateFromReservation(tx, reservation);
	const walletQuantity = await calculateWalletQuantity(tx, rate, quantity);
	const scale = rate.wallet.credit_scale;
	// Allocation rows are locked first, then the reservation's holds; the config reads follow.
	const [rows, reservationRows, alerts, topupPolicy] = await Promise.all([
		lockAllAllocationRows(tx, projectId, customer.id, rate.wallet, entityId),
		lockReservationAllocations(tx, projectId, reservation.id),
		queryUsageAlerts(tx, {
			projectId,
			customerId: customer.id,
			entityId,
			featureId: featureId(rate.meter),
		}),
		queryAutoTopupPolicy(tx, {
			projectId,
			customerId: customer.id,
			entityId,
			featureId: featureId(rate.wallet),
		}),
	]);
	const denied = async (
		reason: "insufficient_balance" | "control_limit_exceeded",
		control: ControlDenial | null,
	): Promise<FinalizeReservationResult> => ({
		allowed: false,
		reason,
		reservationId: reservation.id,
		status: "active",
		usageEventId: null,
		recordedAt: null,
		balance: await readBalance(tx, projectId, customer.id, rate.wallet, entityId),
		deductions: [],
		...(control === null ? {} : { control }),
	});
	let plan: ConfirmationPlan;
	try {
		plan = planConfirmation(rows, reservationRows, scale, walletQuantity);
	} catch (error) {
		if (error instanceof BillingError && error.code === "INSUFFICIENT_BALANCE") {
			return await denied("insufficient_balance", null);
		}
		throw error;
	}
	const controls = await confirmControlHolds(tx, {
		projectId,
		customerId: customer.id,
		entityId,
		featureId: featureId(rate.meter),
		featureKey: rate.meter.key,
		usageDelta: quantity,
		spendMinorDelta: "0",
		currency: null,
		now: new Date(),
		reservationId: reservation.id,
	});
	if (controls.denial !== null) {
		return await denied("control_limit_exceeded", controls.denial);
	}
	const recordedAt = new Date();
	// Allocation and reservation writes are issued first; the reads behind them observe them.
	const [, , event] = await Promise.all([
		applyConfirmation(tx, projectId, reservation.id, plan, scale),
		executeOne(
			tx,
			drizzleSql`
				UPDATE reservations
				SET
					status = 'confirmed',
					confirmed_quantity = ${quantity}::numeric,
					finalized_at = now(),
					updated_at = now()
				WHERE project_id = ${projectId}
					AND id = ${reservation.id}
				RETURNING id
			`,
		),
		insertUsageEvent(tx, {
			projectId,
			customerId: customer.id,
			entityId,
			rate,
			operation: "confirm",
			quantity,
			walletQuantity,
			occurredAt: input.occurredAt,
			reservationId: reservation.id,
			filterKey: null,
			deductions: plan.deductions,
			metadata: input.metadata,
			recordedAt,
		}),
		incrementRollup(tx, {
			projectId,
			customerId: customer.id,
			entityId,
			meterFeatureId: featureId(rate.meter),
			quantity,
			walletQuantity,
			recordedAt,
		}),
	]);
	if (controls.entries.length > 0) {
		await recordUsageControlEntries(tx, {
			projectId,
			usageEventId: event.id,
			usageEventRecordedAt: event.recorded_at,
			entries: controls.entries,
		});
	}
	if (alerts.length > 0) {
		await recordUsageAlertDelta(tx, {
			projectId,
			customerId: customer.id,
			entityId,
			featureId: featureId(rate.meter),
			delta: quantity,
			alerts,
		});
	}
	const balance = balanceFromRows(rate.wallet, confirmedRows(rows, plan, scale));
	await Promise.all([
		enqueueUsageProjection(tx, { projectId, customerId: customer.id }),
		scheduleAutoTopupIfNeeded(tx, {
			projectId,
			customerId: customer.id,
			entityId,
			featureId: featureId(rate.wallet),
			availableQuantity: balance.available,
			triggerKey: `usage:${event.id}`,
			policy: topupPolicy,
		}),
	]);
	return {
		allowed: true,
		reason: "allowed",
		reservationId: reservation.id,
		status: "confirmed",
		usageEventId: event.id,
		recordedAt: toIso(event.recorded_at),
		balance,
		deductions: plan.deductions,
	};
}

/** The reservation's hold rows; the reservation row is already locked, so these are issued together. */
async function insertReservationAllocations(
	executor: QueryExecutor,
	projectId: string,
	reservationId: string,
	deductions: readonly AllocationDeduction[],
): Promise<void> {
	await Promise.all(
		deductions.map((deduction) =>
			executeOne(
				executor,
				drizzleSql`
				INSERT INTO reservation_allocations (
					project_id,
					reservation_id,
					allocation_id,
					held_quantity
				)
				VALUES (
					${projectId},
					${reservationId},
					${deduction.allocationId}::bigint,
					${deduction.quantity}::numeric
				)
				RETURNING allocation_id
			`,
			),
		),
	);
}

/** Live allocation rows as they stand after a confirmation, for an exact post-write balance. */
function confirmedRows(
	rows: readonly AllocationRow[],
	plan: ConfirmationPlan,
	scale: number,
): AllocationRow[] {
	const now = Date.now();
	const changes = new Map(plan.changes.map((change) => [change.allocationId, change]));
	const live = rows.filter(
		(row) =>
			row.reversed_at === null &&
			(row.expires_at === null || new Date(row.expires_at).getTime() > now),
	);
	return live.map((row) => {
		const change = changes.get(String(row.id));
		if (change === undefined) return row;
		const consumed = decimalToUnits(
			databaseDecimal(row.consumed_quantity, "allocation consumed", scale),
			scale,
		);
		const held = decimalToUnits(
			databaseDecimal(row.held_quantity, "allocation held", scale),
			scale,
		);
		return {
			...row,
			consumed_quantity: unitsToDecimal(consumed + change.consume, scale),
			held_quantity: unitsToDecimal(held - change.release, scale),
		};
	});
}
