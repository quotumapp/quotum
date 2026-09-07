import { sql as drizzleSql } from "drizzle-orm";
import {
	databaseDecimal,
	decimalToUnits,
	positiveDecimal,
	sha256Hex,
	stableJson,
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
	RateCardReceipt,
	ReleaseReservationInput,
	ReservationResult,
	ReserveUsageInput,
	UsageCorrectionResult,
	WorkerConsumeUsageResult,
	WorkerMeteringMutationInput,
} from "../../billing/metering";
import type { RateCardTier } from "../../billing/pricing";
import {
	calculateRateCardQuantity,
	calculateTieredUsageCharge,
	calculateUsageCharge,
} from "../../billing/pricing";
import type {
	UsageOperationInput,
	UsageOperationKind,
	UsageOperationLookupInput,
	UsageOperationLookupResult,
	UsageOperationResult,
} from "../../billing/usage-operations";
import type { ProjectInstanceContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import type { ControlDenial } from "./controls-runtime";
import {
	checkControls,
	confirmControlHolds,
	consumeControls,
	correctControlConsumption,
	holdControls,
	recordUsageAlertDelta,
	recordUsageControlEntries,
	releaseControlHolds,
	scheduleAutoTopupIfNeeded,
} from "./controls-runtime";
import { enqueueProjectionSyncJob, getEntitlementSnapshot } from "./entitlements";
import { ensureCustomer } from "./identities";
import { executeOne, executeRows, jsonb } from "./query";
import type { QueryExecutor } from "./types";
import {
	expireUsageOperationResults,
	lookupUsageOperation,
	runUsageOperation,
} from "./usage-operations";

interface FeatureRow {
	id: string | number | bigint;
	key: string;
	unit: string;
	credit_scale: number;
	kind: "boolean" | "metered";
	meter_kind: "consumable" | "non_consumable" | null;
	filter_dimensions: string[];
}

interface RateDecision {
	meter: FeatureRow;
	wallet: FeatureRow;
	path: RateCardPath;
	revision: number | null;
	revisionId: string | null;
	entryId: string | null;
	pricingModel: "flat" | "graduated";
	ratePerUnit: string;
	tiers: RateCardTier[];
}

interface MeterLimitDecision {
	feature: FeatureRow;
	subscriptionId: string | null;
	planItemId: string | null;
	limit: string;
	overagePolicy: "blocked" | "allowed";
	overagePrice: MeteredOveragePrice | null;
	windowStartAt: Date;
	windowEndAt: Date;
}

interface MeteredOveragePrice {
	priceComponentId: string;
	pricingModel: "flat" | "graduated" | "volume";
	billingUnits: string;
	unitAmountMinor: bigint;
	currency: string;
	tiers: Array<{
		upToQuantity: string | null;
		unitAmountMinor: bigint;
		flatAmountMinor: bigint;
	}>;
}

interface UsageWindowRow {
	id: string | number | bigint;
	window_start_at: Date | string;
	window_end_at: Date | string;
	usage: unknown;
}

interface AllocationRow {
	id: string | number | bigint;
	quantity: unknown;
	reversed_quantity: unknown;
	consumed_quantity: unknown;
	held_quantity: unknown;
	source_kind: string;
	source_key: string;
	expires_at: Date | string | null;
	created_at: Date | string;
	reversed_at: Date | string | null;
	entity_external_id: string | null;
	rollover_origin_allocation_id: string | number | bigint | null;
	rollover_policy_revision: number | null;
	period_start_at: Date | string | null;
	period_end_at: Date | string | null;
}

interface ReservationRow {
	id: string;
	project_id: string;
	customer_id: string;
	billing_account_id: string;
	entity_id: string | number | bigint | null;
	usage_window_id: string | number | bigint | null;
	usage_window_start_at: Date | string | null;
	usage_window_end_at: Date | string | null;
	meter_feature_id: string | number | bigint;
	wallet_feature_id: string | number | bigint;
	meter_feature_key: string;
	meter_unit: string;
	meter_scale: number;
	wallet_feature_key: string;
	wallet_unit: string;
	wallet_scale: number;
	rate_card_entry_id: string | number | bigint | null;
	rate_card_revision_id: string | number | bigint | null;
	revision: number | null;
	rate_card_path: RateCardPath;
	pricing_model: "flat" | "graduated";
	rate_per_unit: unknown;
	requested_quantity: unknown;
	held_quantity: unknown;
	confirmed_quantity: unknown | null;
	status: "active" | "confirmed" | "released" | "expired";
	expires_at: Date | string;
}

interface ReservationAllocationRow {
	allocation_id: string | number | bigint;
	held_quantity: unknown;
	consumed_quantity: unknown;
}

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
	sourceKind: "subscription" | "purchase" | "credit_grant" | "topup" | "reward" | "operator";
	sourceKey: string;
	expiresAt?: Date | null;
	periodStartAt?: Date | null;
	periodEndAt?: Date | null;
	subscriptionId?: string | null;
	purchaseId?: string | null;
	creditGrantId?: string | null;
}

export class MeteringBillingRepository extends RepositoryModule {
	private async operationTransaction<I extends UsageOperationInput, T extends UsageOperationResult>(
		project: ProjectInstanceContext,
		operation: UsageOperationKind,
		input: I,
		callback: (tx: QueryExecutor, input: I) => Promise<T>,
	): Promise<T> {
		const normalizedInput = { ...input, billingAccountId: input.billingAccountId.trim() };
		return await this.transaction((tx) =>
			runUsageOperation(tx, project, operation, normalizedInput, async () => {
				await expireSubjectReservations(
					tx,
					project.projectInstanceId,
					normalizedInput.billingAccountId,
				);
				return callback(tx, normalizedInput);
			}),
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
		return await this.operationTransaction(project, "consume", input, async (tx, input) => {
			const projectId = project.projectInstanceId;
			await validateOccurredAt(tx, projectId, input.occurredAt ?? null);
			const customer = await ensureCustomer(tx, projectId, input.billingAccountId);
			const entityId = await resolveEntityId(tx, projectId, customer.id, input.entityId);
			const feature = await requireMeteredFeature(tx, projectId, input.featureKey);
			validateFilters(feature, input.filters);
			const requestedQuantity = positiveDecimal(input.quantity, "quantity", feature.credit_scale);
			const meterLimit = await resolveMeterLimit(tx, projectId, customer.id, feature);
			if (meterLimit !== null) {
				const preflight = await checkMeterLimit(
					tx,
					projectId,
					customer.id,
					entityId,
					canonicalFilterKey(input.filters),
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
					filterKey: canonicalFilterKey(input.filters),
					meterLimit,
					quantity: requestedQuantity,
					occurredAt: input.occurredAt ?? null,
					metadata: input.metadata ?? {},
					projectionKey: `usage:consume:${customer.id}:${input.idempotencyKey}`,
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
					});
				}
				return result;
			}
			const rate = await resolveRateDecision(tx, projectId, customer.id, input.featureKey);
			validateFilters(rate.meter, input.filters);
			const walletQuantity = await calculateWalletQuantity(tx, rate, requestedQuantity);
			const rows = await lockAllocations(tx, projectId, customer.id, rate.wallet, entityId);
			const currentBalance = balanceFromRows(rate.wallet, rows);
			const decision = await buildDecision(
				tx,
				projectId,
				rate,
				requestedQuantity,
				walletQuantity,
				currentBalance,
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

			const deductions = await consumeAllocations(
				tx,
				rows,
				rate.wallet.credit_scale,
				walletQuantity,
				"consumed_quantity",
			);
			const event = await insertUsageEvent(tx, {
				projectId,
				customerId: customer.id,
				entityId,
				rate,
				operation: "consume",
				quantity: requestedQuantity,
				walletQuantity,
				occurredAt: input.occurredAt ?? null,
				reservationId: null,
				filterKey: canonicalFilterKey(input.filters),
				deductions,
				metadata: input.metadata ?? {},
			});
			await recordUsageControlEntries(tx, {
				projectId,
				usageEventId: event.id,
				usageEventRecordedAt: event.recorded_at,
				entries: controls.entries,
			});
			await incrementRollup(tx, {
				projectId,
				customerId: customer.id,
				entityId,
				meterFeatureId: featureId(rate.meter),
				quantity: requestedQuantity,
				walletQuantity,
				recordedAt: event.recorded_at,
			});
			await recordUsageAlertDelta(tx, {
				projectId,
				customerId: customer.id,
				entityId,
				featureId: featureId(rate.meter),
				delta: requestedQuantity,
			});
			await enqueueMeteringProjection(
				tx,
				projectId,
				customer.id,
				`usage:consume:${customer.id}:${input.idempotencyKey}`,
			);
			const balance = await readBalance(tx, projectId, customer.id, rate.wallet, entityId);
			await scheduleAutoTopupIfNeeded(tx, {
				projectId,
				customerId: customer.id,
				entityId,
				featureId: featureId(rate.wallet),
				availableQuantity: balance.available,
				triggerKey: `usage:${event.id}`,
			});
			return {
				...decision,
				balance,
				usageEventId: event.id,
				recordedAt: toIso(event.recorded_at),
				deductions,
			};
		});
	}

	async consumeWorkerDelivery(
		project: ProjectInstanceContext,
		input: WorkerMeteringMutationInput,
	): Promise<WorkerConsumeUsageResult> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			await validateOccurredAt(tx, projectId, input.occurredAt ?? null);
			const claimed = await claimWorkerDelivery(
				tx,
				projectId,
				input.deliveryId,
				input.requestContextId,
			);
			if (!claimed) return { applied: false, result: null };
			await expireSubjectReservations(tx, projectId, input.billingAccountId);

			const customer = await ensureCustomer(tx, projectId, input.billingAccountId);
			const entityId = await resolveEntityId(tx, projectId, customer.id, input.entityId);
			const feature = await requireMeteredFeature(tx, projectId, input.featureKey);
			validateFilters(feature, input.filters);
			const requestedQuantity = positiveDecimal(input.quantity, "quantity", feature.credit_scale);
			const meterLimit = await resolveMeterLimit(tx, projectId, customer.id, feature);
			if (meterLimit !== null) {
				const preflight = await checkMeterLimit(
					tx,
					projectId,
					customer.id,
					entityId,
					canonicalFilterKey(input.filters),
					meterLimit,
					requestedQuantity,
				);
				if (!preflight.allowed) {
					return {
						applied: true,
						result: { ...preflight, usageEventId: null, recordedAt: null, deductions: [] },
					};
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
						applied: true,
						result: {
							...controlDeniedDecision(preflight, controls.denial),
							usageEventId: null,
							recordedAt: null,
							deductions: [],
						},
					};
				}
				const result = await consumeMeterLimit(tx, {
					projectId,
					customerId: customer.id,
					entityId,
					filterKey: canonicalFilterKey(input.filters),
					meterLimit,
					quantity: requestedQuantity,
					occurredAt: input.occurredAt ?? null,
					metadata: {
						...(input.metadata ?? {}),
						workerDeliveryId: input.deliveryId.trim(),
						requestContextId: input.requestContextId.trim(),
					},
					projectionKey: `usage:worker:${customer.id}:${input.deliveryId}`,
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
					});
				}
				return { applied: true, result };
			}
			const rate = await resolveRateDecision(tx, projectId, customer.id, input.featureKey);
			validateFilters(rate.meter, input.filters);
			const walletQuantity = await calculateWalletQuantity(tx, rate, requestedQuantity);
			const rows = await lockAllocations(tx, projectId, customer.id, rate.wallet, entityId);
			const currentBalance = balanceFromRows(rate.wallet, rows);
			const decision = await buildDecision(
				tx,
				projectId,
				rate,
				requestedQuantity,
				walletQuantity,
				currentBalance,
			);
			if (!decision.allowed) {
				return {
					applied: true,
					result: { ...decision, usageEventId: null, recordedAt: null, deductions: [] },
				};
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
					applied: true,
					result: {
						...controlDeniedDecision(decision, controls.denial),
						usageEventId: null,
						recordedAt: null,
						deductions: [],
					},
				};
			}

			const deductions = await consumeAllocations(
				tx,
				rows,
				rate.wallet.credit_scale,
				walletQuantity,
				"consumed_quantity",
			);
			const event = await insertUsageEvent(tx, {
				projectId,
				customerId: customer.id,
				entityId,
				rate,
				operation: "consume",
				quantity: requestedQuantity,
				walletQuantity,
				occurredAt: input.occurredAt ?? null,
				reservationId: null,
				filterKey: canonicalFilterKey(input.filters),
				deductions,
				metadata: {
					...(input.metadata ?? {}),
					workerDeliveryId: input.deliveryId.trim(),
					requestContextId: input.requestContextId.trim(),
				},
			});
			await recordUsageControlEntries(tx, {
				projectId,
				usageEventId: event.id,
				usageEventRecordedAt: event.recorded_at,
				entries: controls.entries,
			});
			await incrementRollup(tx, {
				projectId,
				customerId: customer.id,
				entityId,
				meterFeatureId: featureId(rate.meter),
				quantity: requestedQuantity,
				walletQuantity,
				recordedAt: event.recorded_at,
			});
			await recordUsageAlertDelta(tx, {
				projectId,
				customerId: customer.id,
				entityId,
				featureId: featureId(rate.meter),
				delta: requestedQuantity,
			});
			await enqueueMeteringProjection(
				tx,
				projectId,
				customer.id,
				`usage:worker:${customer.id}:${input.deliveryId}`,
			);
			const balance = await readBalance(tx, projectId, customer.id, rate.wallet, entityId);
			await scheduleAutoTopupIfNeeded(tx, {
				projectId,
				customerId: customer.id,
				entityId,
				featureId: featureId(rate.wallet),
				availableQuantity: balance.available,
				triggerKey: `usage:${event.id}`,
			});
			return {
				applied: true,
				result: {
					...decision,
					balance,
					usageEventId: event.id,
					recordedAt: toIso(event.recorded_at),
					deductions,
				},
			};
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

		return await this.operationTransaction(project, "reserve", normalized, async (tx, input) => {
			const projectId = project.projectInstanceId;
			await validateOccurredAt(tx, projectId, input.occurredAt ?? null);
			const customer = await ensureCustomer(tx, projectId, input.billingAccountId);
			const entityId = await resolveEntityId(tx, projectId, customer.id, input.entityId);
			const feature = await requireMeteredFeature(tx, projectId, input.featureKey);
			validateFilters(feature, input.filters);
			const requestedQuantity = positiveDecimal(input.quantity, "quantity", feature.credit_scale);
			const meterLimit = await resolveMeterLimit(tx, projectId, customer.id, feature);
			if (meterLimit !== null) {
				return await reserveMeterLimit(tx, {
					projectId,
					customerId: customer.id,
					entityId,
					filterKey: canonicalFilterKey(input.filters),
					meterLimit,
					quantity: requestedQuantity,
					expiresInSeconds: input.expiresInSeconds,
					projectionKey: `usage:reserve:${customer.id}:${input.idempotencyKey}`,
				});
			}
			const rate = await resolveRateDecision(tx, projectId, customer.id, input.featureKey);
			validateFilters(rate.meter, input.filters);
			const walletQuantity = await calculateWalletQuantity(tx, rate, requestedQuantity);
			const rows = await lockAllocations(tx, projectId, customer.id, rate.wallet, entityId);
			const currentBalance = balanceFromRows(rate.wallet, rows);
			const decision = await buildDecision(
				tx,
				projectId,
				rate,
				requestedQuantity,
				walletQuantity,
				currentBalance,
			);
			if (!decision.allowed) {
				return {
					...decision,
					reservationId: null,
					status: null,
					expiresAt: null,
					deductions: [],
				};
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

			const deductions = await holdAllocations(
				tx,
				projectId,
				reservation.id,
				rows,
				rate.wallet.credit_scale,
				walletQuantity,
			);
			await enqueueMeteringProjection(
				tx,
				projectId,
				customer.id,
				`usage:reserve:${customer.id}:${input.idempotencyKey}`,
			);
			return {
				...decision,
				balance: await readBalance(tx, projectId, customer.id, rate.wallet, entityId),
				reservationId: reservation.id,
				status: "active",
				expiresAt: expiresAt.toISOString(),
				deductions,
			};
		});
	}

	async confirm(
		project: ProjectInstanceContext,
		input: ConfirmReservationInput,
	): Promise<FinalizeReservationResult> {
		return await this.operationTransaction(project, "confirm", input, async (tx, input) => {
			const projectId = project.projectInstanceId;
			await validateOccurredAt(tx, projectId, input.occurredAt ?? null);
			const customer = await requireCustomer(tx, projectId, input.billingAccountId);
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
			if (reservation.status === "expired")
				return await finalizedReservationResult(tx, reservation);
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
					databaseDecimal(
						reservation.requested_quantity,
						"reserved quantity",
						reservation.meter_scale,
					),
					reservation.meter_scale,
				)
			) {
				throw new PersistenceConflictError(
					"Confirmed quantity exceeds the reserved authorization",
					"RESERVATION_QUANTITY_EXCEEDED",
				);
			}
			if (reservation.usage_window_id !== null) {
				const result = await confirmMeterLimitReservation(tx, reservation, quantity, {
					occurredAt: input.occurredAt ?? null,
					metadata: input.metadata ?? {},
				});
				if (result.allowed) {
					await recordUsageAlertDelta(tx, {
						projectId,
						customerId: customer.id,
						entityId: reservation.entity_id === null ? null : String(reservation.entity_id),
						featureId: String(reservation.meter_feature_id),
						delta: quantity,
					});
					await enqueueMeteringProjection(
						tx,
						projectId,
						customer.id,
						`usage:confirm:${customer.id}:${input.idempotencyKey}`,
					);
				}
				return result;
			}

			const rate = await rateFromReservation(tx, reservation);
			const walletQuantity = await calculateWalletQuantity(tx, rate, quantity);
			const rows = await lockAllAllocationRows(
				tx,
				projectId,
				customer.id,
				rate.wallet,
				reservation.entity_id === null ? null : String(reservation.entity_id),
			);
			const reservationRows = await lockReservationAllocations(tx, projectId, reservation.id);
			let deductions: AllocationDeduction[];
			let confirmedControlEntries: Array<{ controlWindowId: string; value: string }> = [];
			try {
				await confirmAgainstAllocations(
					tx,
					rows,
					reservationRows,
					rate.wallet.credit_scale,
					walletQuantity,
					false,
				);
				const controls = await confirmControlHolds(tx, {
					projectId,
					customerId: customer.id,
					entityId: reservation.entity_id === null ? null : String(reservation.entity_id),
					featureId: featureId(rate.meter),
					featureKey: rate.meter.key,
					usageDelta: quantity,
					spendMinorDelta: "0",
					currency: null,
					reservationId: reservation.id,
				});
				if (controls.denial !== null) {
					return {
						allowed: false,
						reason: "control_limit_exceeded",
						reservationId: reservation.id,
						status: "active",
						usageEventId: null,
						recordedAt: null,
						balance: await readBalance(
							tx,
							projectId,
							customer.id,
							rate.wallet,
							reservation.entity_id === null ? null : String(reservation.entity_id),
						),
						deductions: [],
						control: controls.denial,
					};
				}
				confirmedControlEntries = controls.entries;
				deductions = await confirmAgainstAllocations(
					tx,
					rows,
					reservationRows,
					rate.wallet.credit_scale,
					walletQuantity,
				);
			} catch (error) {
				if (error instanceof BillingError && error.code === "INSUFFICIENT_BALANCE") {
					return {
						allowed: false,
						reason: "insufficient_balance",
						reservationId: reservation.id,
						status: "active",
						usageEventId: null,
						recordedAt: null,
						balance: await readBalance(
							tx,
							projectId,
							customer.id,
							rate.wallet,
							reservation.entity_id === null ? null : String(reservation.entity_id),
						),
						deductions: [],
					};
				}
				throw error;
			}
			const event = await insertUsageEvent(tx, {
				projectId,
				customerId: customer.id,
				entityId: reservation.entity_id === null ? null : String(reservation.entity_id),
				rate,
				operation: "confirm",
				quantity,
				walletQuantity,
				occurredAt: input.occurredAt ?? null,
				reservationId: reservation.id,
				filterKey: null,
				deductions,
				metadata: input.metadata ?? {},
			});
			await recordUsageControlEntries(tx, {
				projectId,
				usageEventId: event.id,
				usageEventRecordedAt: event.recorded_at,
				entries: confirmedControlEntries,
			});
			await executeOne(
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
			);
			await incrementRollup(tx, {
				projectId,
				customerId: customer.id,
				entityId: reservation.entity_id === null ? null : String(reservation.entity_id),
				meterFeatureId: featureId(rate.meter),
				quantity,
				walletQuantity,
				recordedAt: event.recorded_at,
			});
			await recordUsageAlertDelta(tx, {
				projectId,
				customerId: customer.id,
				entityId: reservation.entity_id === null ? null : String(reservation.entity_id),
				featureId: featureId(rate.meter),
				delta: quantity,
			});
			await enqueueMeteringProjection(
				tx,
				projectId,
				customer.id,
				`usage:confirm:${customer.id}:${input.idempotencyKey}`,
			);
			const balance = await readBalance(
				tx,
				projectId,
				customer.id,
				rate.wallet,
				reservation.entity_id === null ? null : String(reservation.entity_id),
			);
			await scheduleAutoTopupIfNeeded(tx, {
				projectId,
				customerId: customer.id,
				entityId: reservation.entity_id === null ? null : String(reservation.entity_id),
				featureId: featureId(rate.wallet),
				availableQuantity: balance.available,
				triggerKey: `usage:${event.id}`,
			});
			return {
				allowed: true,
				reason: "allowed",
				reservationId: reservation.id,
				status: "confirmed",
				usageEventId: event.id,
				recordedAt: toIso(event.recorded_at),
				balance,
				deductions,
			};
		});
	}

	async release(
		project: ProjectInstanceContext,
		input: ReleaseReservationInput,
	): Promise<FinalizeReservationResult> {
		return await this.operationTransaction(project, "release", input, async (tx, input) => {
			const projectId = project.projectInstanceId;
			const customer = await requireCustomer(tx, projectId, input.billingAccountId);
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
		});
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

		return await this.operationTransaction(project, "correct", input, async (tx, input) => {
			const projectId = project.projectInstanceId;
			await validateOccurredAt(tx, projectId, input.occurredAt ?? null);
			const customer = await requireCustomer(tx, projectId, input.billingAccountId);
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
		});
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

function signedDecimalToUnits(value: string, scale: number): bigint {
	return value.startsWith("-")
		? -decimalToUnits(value.slice(1), scale)
		: decimalToUnits(value, scale);
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

async function requireMeteredFeature(
	executor: QueryExecutor,
	projectId: string,
	key: string,
): Promise<FeatureRow> {
	const normalizedKey = key.trim();
	if (normalizedKey === "") {
		throw new InvalidRequestError("featureKey is required");
	}
	const row = await executeOne<FeatureRow>(
		executor,
		drizzleSql`
			SELECT id, key, unit, credit_scale, kind, meter_kind, filter_dimensions
			FROM features
			WHERE project_id = ${projectId}
				AND key = ${normalizedKey}
				AND active = true
			LIMIT 1
		`,
	);
	if (row === null || row.kind !== "metered") {
		throw new NotFoundBillingError(
			`Metered feature ${normalizedKey} was not found`,
			"FEATURE_NOT_FOUND",
		);
	}
	return row;
}

async function resolveMeterLimit(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
	feature: FeatureRow,
): Promise<MeterLimitDecision | null> {
	const rows =
		customerId === null
			? []
			: await executeRows<{
					plan_item_id: string | number | bigint;
					subscription_id: string;
					quantity: unknown;
					overage_policy: "blocked" | "allowed";
					reset_interval: "month" | "year";
					period_start_at: Date | string;
					period_end_at: Date | string | null;
				}>(
					executor,
					drizzleSql`
						SELECT
							pi.id AS plan_item_id,
							s.id AS subscription_id,
							pi.quantity,
							pi.overage_policy,
							pi.reset_interval,
							COALESCE(s.current_period_start, s.starts_at) AS period_start_at,
							COALESCE(s.current_period_end, s.expires_at) AS period_end_at
						FROM subscriptions s
						JOIN plan_items pi
							ON pi.project_id = s.project_id
							AND pi.plan_version_id = s.plan_version_id
						WHERE s.project_id = ${projectId}
							AND s.customer_id = ${customerId}
							AND s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
							AND (s.expires_at IS NULL OR s.expires_at > now())
							AND pi.feature_id = ${featureId(feature)}
							AND pi.item_kind = 'meter_limit'
						ORDER BY s.created_at, s.id
						LIMIT 2
					`,
				);
	if (rows.length > 1) {
		throw new BillingError(
			`Multiple active meter limits apply to feature ${feature.key}`,
			"METERING_CONFIGURATION_ERROR",
			409,
			{ classification: "persistence_conflict" },
		);
	}
	const active = rows[0];
	if (active !== undefined) {
		const start = new Date(active.period_start_at);
		const end =
			active.period_end_at === null
				? addUtcInterval(start, active.reset_interval)
				: new Date(active.period_end_at);
		const bounds = rollWindowBounds(start, end, active.reset_interval, new Date());
		const overagePrice =
			active.overage_policy === "allowed"
				? await resolveMeteredOveragePrice(executor, projectId, String(active.plan_item_id))
				: null;
		return {
			feature,
			subscriptionId: active.subscription_id,
			planItemId: String(active.plan_item_id),
			limit: databaseDecimal(active.quantity, "meter limit", feature.credit_scale),
			overagePolicy: active.overage_policy,
			overagePrice,
			windowStartAt: bounds.start,
			windowEndAt: bounds.end,
		};
	}

	const configured = await executeOne<{ configured: boolean }>(
		executor,
		drizzleSql`
			SELECT EXISTS (
				SELECT 1
				FROM plan_items pi
				JOIN plan_versions pv
					ON pv.project_id = pi.project_id AND pv.id = pi.plan_version_id
				WHERE pi.project_id = ${projectId}
					AND pi.feature_id = ${featureId(feature)}
					AND pi.item_kind = 'meter_limit'
					AND pv.status = 'published'
			) AS configured
		`,
	);
	if (configured?.configured !== true) return null;
	const start = startOfUtcMonth(new Date());
	return {
		feature,
		subscriptionId: null,
		planItemId: null,
		limit: "0",
		overagePolicy: "blocked",
		overagePrice: null,
		windowStartAt: start,
		windowEndAt: addUtcInterval(start, "month"),
	};
}

async function resolveMeteredOveragePrice(
	executor: QueryExecutor,
	projectId: string,
	planItemId: string,
): Promise<MeteredOveragePrice> {
	const row = await executeOne<{
		id: string | number | bigint;
		pricing_model: "flat" | "graduated" | "volume";
		billing_units: unknown;
		unit_amount_minor: string | number | bigint;
		currency: string;
	}>(
		executor,
		drizzleSql`
			SELECT id, pricing_model, billing_units::text AS billing_units,
				unit_amount_minor, currency
			FROM price_components
			WHERE project_id = ${projectId}
				AND plan_item_id = ${planItemId}::bigint
				AND component_kind = 'metered_overage'
			LIMIT 1
		`,
	);
	if (row === null) {
		throw new BillingError(
			"Allowed overage has no published metered price",
			"METERING_CONFIGURATION_ERROR",
			409,
			{ classification: "persistence_conflict" },
		);
	}
	const priceComponentId = String(row.id);
	return {
		priceComponentId,
		pricingModel: row.pricing_model,
		billingUnits: databaseDecimal(row.billing_units, "overage billing units", 9),
		unitAmountMinor: BigInt(row.unit_amount_minor),
		currency: row.currency.toUpperCase(),
		tiers:
			row.pricing_model === "flat"
				? []
				: await readMeteredPriceTiers(executor, projectId, priceComponentId),
	};
}

async function readMeteredPriceTiers(
	executor: QueryExecutor,
	projectId: string,
	priceComponentId: string,
): Promise<MeteredOveragePrice["tiers"]> {
	const rows = await executeRows<{
		up_to_quantity: unknown;
		unit_amount_minor: string | number | bigint;
		flat_amount_minor: string | number | bigint;
	}>(
		executor,
		drizzleSql`
			SELECT up_to_quantity::text AS up_to_quantity, unit_amount_minor, flat_amount_minor
			FROM price_tiers
			WHERE project_id = ${projectId} AND price_component_id = ${priceComponentId}::bigint
			ORDER BY ordinal
		`,
	);
	return rows.map((tier) => ({
		upToQuantity: tier.up_to_quantity === null ? null : String(tier.up_to_quantity),
		unitAmountMinor: BigInt(tier.unit_amount_minor),
		flatAmountMinor: BigInt(tier.flat_amount_minor),
	}));
}

function meterLimitSpendDelta(
	meterLimit: MeterLimitDecision,
	balance: MeteringBalance,
	quantity: string,
): { spendMinorDelta: string; currency: string | null } {
	if (meterLimit.overagePrice === null) {
		return { spendMinorDelta: "0", currency: null };
	}
	const scale = meterLimit.feature.credit_scale;
	const currentUnits =
		decimalToUnits(balance.consumed, scale) + decimalToUnits(balance.held, scale);
	const nextUnits = currentUnits + decimalToUnits(quantity, scale);
	const current = calculateMeteredOverageCharge(meterLimit, unitsToDecimal(currentUnits, scale));
	const next = calculateMeteredOverageCharge(meterLimit, unitsToDecimal(nextUnits, scale));
	return {
		spendMinorDelta: String(next.amountMinor - current.amountMinor),
		currency: meterLimit.overagePrice.currency,
	};
}

function calculateMeteredOverageCharge(meterLimit: MeterLimitDecision, usageQuantity: string) {
	const price = meterLimit.overagePrice;
	if (price === null) {
		return calculateUsageCharge({
			usageQuantity,
			includedQuantity: meterLimit.limit,
			billingUnits: "1",
			unitAmountMinor: 0n,
			scale: meterLimit.feature.credit_scale,
		});
	}
	return price.pricingModel === "flat"
		? calculateUsageCharge({
				usageQuantity,
				includedQuantity: meterLimit.limit,
				billingUnits: price.billingUnits,
				unitAmountMinor: price.unitAmountMinor,
				scale: meterLimit.feature.credit_scale,
			})
		: calculateTieredUsageCharge({
				usageQuantity,
				includedQuantity: meterLimit.limit,
				billingUnits: price.billingUnits,
				pricingModel: price.pricingModel,
				tiers: price.tiers,
				scale: meterLimit.feature.credit_scale,
			});
}

async function checkMeterLimit(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
	entityId: string | null,
	filterKey: string | null,
	meterLimit: MeterLimitDecision,
	quantity: string,
): Promise<MeteringDecision> {
	const balance = await readMeterLimitBalance(
		executor,
		projectId,
		customerId,
		entityId,
		filterKey,
		meterLimit,
	);
	const allowed =
		meterLimit.overagePolicy === "allowed" ||
		decimalToUnits(balance.available, balance.scale) >= decimalToUnits(quantity, balance.scale);
	return {
		allowed,
		reason: allowed ? "allowed" : "insufficient_balance",
		requestedQuantity: quantity,
		walletQuantity: quantity,
		balance,
		rateCard: rateReceipt(directRate(meterLimit.feature)),
		eligiblePurchaseActions: allowed ? [] : await purchaseActions(executor, projectId),
		control: null,
	};
}

async function consumeMeterLimit(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		entityId: string | null;
		filterKey: string | null;
		meterLimit: MeterLimitDecision;
		quantity: string;
		occurredAt: Date | null;
		metadata: Record<string, unknown>;
		projectionKey: string;
	},
): Promise<ConsumeUsageResult> {
	const window = await upsertUsageWindow(executor, input);
	const currentBalance = meterLimitBalance(input.meterLimit, window.usage);
	const decision = await checkMeterLimitFromBalance(
		executor,
		input.projectId,
		input.meterLimit,
		input.quantity,
		currentBalance,
	);
	if (!decision.allowed) {
		return { ...decision, usageEventId: null, recordedAt: null, deductions: [] };
	}
	const updated = await executeOne<{ usage: unknown }>(
		executor,
		drizzleSql`
			UPDATE usage_windows
			SET usage = usage + ${input.quantity}::numeric, updated_at = now()
			WHERE project_id = ${input.projectId}
				AND id = ${String(window.id)}::bigint
				AND (
					${input.meterLimit.overagePolicy} = 'allowed'
					OR usage + ${input.quantity}::numeric <= ${input.meterLimit.limit}::numeric
				)
			RETURNING usage
		`,
	);
	if (updated === null) {
		throw new Error("Usage-window deduction lost its scope lock");
	}
	const rate = directRate(input.meterLimit.feature);
	const event = await insertUsageEvent(executor, {
		projectId: input.projectId,
		customerId: input.customerId,
		entityId: input.entityId,
		rate,
		operation: "consume",
		quantity: input.quantity,
		walletQuantity: input.quantity,
		occurredAt: input.occurredAt,
		reservationId: null,
		filterKey: input.filterKey,
		deductions: [],
		metadata: {
			...input.metadata,
			usageWindowId: String(window.id),
			usageWindowStartAt: toIso(window.window_start_at),
			usageWindowEndAt: toIso(window.window_end_at),
		},
	});
	await incrementRollup(executor, {
		projectId: input.projectId,
		customerId: input.customerId,
		entityId: input.entityId,
		meterFeatureId: featureId(input.meterLimit.feature),
		quantity: input.quantity,
		walletQuantity: input.quantity,
		recordedAt: event.recorded_at,
	});
	await enqueueMeteringProjection(executor, input.projectId, input.customerId, input.projectionKey);
	return {
		...decision,
		balance: meterLimitBalance(input.meterLimit, updated.usage),
		usageEventId: event.id,
		recordedAt: toIso(event.recorded_at),
		deductions: [],
	};
}

async function reserveMeterLimit(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		entityId: string | null;
		filterKey: string | null;
		meterLimit: MeterLimitDecision;
		quantity: string;
		expiresInSeconds: number;
		projectionKey: string;
	},
): Promise<ReservationResult> {
	const window = await upsertUsageWindow(executor, input);
	const held = await readActiveWindowHolds(executor, input.projectId, String(window.id), null);
	const balance = meterLimitBalance(input.meterLimit, window.usage, held);
	const decision = await checkMeterLimitFromBalance(
		executor,
		input.projectId,
		input.meterLimit,
		input.quantity,
		balance,
	);
	if (!decision.allowed) {
		return {
			...decision,
			reservationId: null,
			status: null,
			expiresAt: null,
			deductions: [],
		};
	}
	const effectiveAt = new Date();
	const expiresAt = new Date(effectiveAt.getTime() + input.expiresInSeconds * 1000);
	const reservation = await executeOne<{ id: string }>(
		executor,
		drizzleSql`
			INSERT INTO reservations (
				project_id,
				customer_id,
				entity_id,
				usage_window_id,
				usage_window_start_at,
				usage_window_end_at,
				meter_feature_id,
				wallet_feature_id,
				rate_card_path,
				requested_quantity,
				held_quantity,
				effective_at,
				expires_at
			)
			VALUES (
				${input.projectId},
				${input.customerId},
				${input.entityId}::bigint,
				${String(window.id)}::bigint,
				${toIso(window.window_start_at)},
				${toIso(window.window_end_at)},
				${featureId(input.meterLimit.feature)},
				${featureId(input.meterLimit.feature)},
				'direct',
				${input.quantity}::numeric,
				${input.quantity}::numeric,
				${effectiveAt.toISOString()},
				${expiresAt.toISOString()}
			)
			RETURNING id
		`,
	);
	if (reservation === null) throw new Error("Meter-limit reservation could not be persisted");
	const spend = meterLimitSpendDelta(input.meterLimit, balance, input.quantity);
	const controlDenial = await holdControls(
		executor,
		{
			projectId: input.projectId,
			customerId: input.customerId,
			entityId: input.entityId,
			featureId: featureId(input.meterLimit.feature),
			featureKey: input.meterLimit.feature.key,
			usageDelta: input.quantity,
			...spend,
		},
		reservation.id,
	);
	if (controlDenial !== null) {
		await executeOne(
			executor,
			drizzleSql`
				DELETE FROM reservations
				WHERE project_id = ${input.projectId} AND id = ${reservation.id}
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
	await enqueueMeteringProjection(executor, input.projectId, input.customerId, input.projectionKey);
	return {
		...decision,
		balance: meterLimitBalance(
			input.meterLimit,
			window.usage,
			unitsToDecimal(
				decimalToUnits(held, input.meterLimit.feature.credit_scale) +
					decimalToUnits(input.quantity, input.meterLimit.feature.credit_scale),
				input.meterLimit.feature.credit_scale,
			),
		),
		reservationId: reservation.id,
		status: "active",
		expiresAt: expiresAt.toISOString(),
		deductions: [],
	};
}

async function checkMeterLimitFromBalance(
	executor: QueryExecutor,
	projectId: string,
	meterLimit: MeterLimitDecision,
	quantity: string,
	balance: MeteringBalance,
): Promise<MeteringDecision> {
	const allowed =
		meterLimit.overagePolicy === "allowed" ||
		decimalToUnits(balance.available, balance.scale) >= decimalToUnits(quantity, balance.scale);
	return {
		allowed,
		reason: allowed ? "allowed" : "insufficient_balance",
		requestedQuantity: quantity,
		walletQuantity: quantity,
		balance,
		rateCard: rateReceipt(directRate(meterLimit.feature)),
		eligiblePurchaseActions: allowed ? [] : await purchaseActions(executor, projectId),
		control: null,
	};
}

async function readMeterLimitBalance(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
	entityId: string | null,
	filterKey: string | null,
	meterLimit: MeterLimitDecision,
): Promise<MeteringBalance> {
	if (customerId === null) return meterLimitBalance(meterLimit, "0");
	const row = await executeOne<{ usage: unknown; held: unknown }>(
		executor,
		drizzleSql`
			SELECT
				windows.usage,
				COALESCE(sum(reservations.held_quantity), 0)::text AS held
			FROM usage_windows windows
			LEFT JOIN reservations
				ON reservations.project_id = windows.project_id
				AND reservations.usage_window_id = windows.id
				AND reservations.status = 'active'
				AND reservations.expires_at > now()
			WHERE windows.project_id = ${projectId}
				AND windows.customer_id = ${customerId}
				AND windows.feature_id = ${featureId(meterLimit.feature)}
				AND windows.entity_id IS NOT DISTINCT FROM ${entityId}::bigint
				AND windows.filter_key IS NOT DISTINCT FROM ${filterKey}
				AND windows.window_start_at <= now()
				AND windows.window_end_at > now()
			GROUP BY windows.id, windows.usage
			LIMIT 1
		`,
	);
	return meterLimitBalance(meterLimit, row?.usage ?? "0", row?.held ?? "0");
}

async function readActiveWindowHolds(
	executor: QueryExecutor,
	projectId: string,
	windowId: string,
	excludeReservationId: string | null,
): Promise<string> {
	const row = await executeOne<{ held: unknown }>(
		executor,
		drizzleSql`
			SELECT COALESCE(sum(held_quantity), 0)::text AS held
			FROM reservations
			WHERE project_id = ${projectId}
				AND usage_window_id = ${windowId}::bigint
				AND status = 'active'
				AND expires_at > now()
				AND (${excludeReservationId}::uuid IS NULL OR id <> ${excludeReservationId}::uuid)
		`,
	);
	return databaseDecimal(row?.held ?? "0", "window holds");
}

async function upsertUsageWindow(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		entityId: string | null;
		filterKey: string | null;
		meterLimit: MeterLimitDecision;
	},
): Promise<UsageWindowRow> {
	const row = await executeOne<UsageWindowRow>(
		executor,
		drizzleSql`
			INSERT INTO usage_windows (
				project_id,
				customer_id,
				entity_id,
				feature_id,
				filter_key,
				subscription_id,
				anchor_plan_item_id,
				window_start_at,
				window_end_at,
				usage
			)
			VALUES (
				${input.projectId},
				${input.customerId},
				${input.entityId}::bigint,
				${featureId(input.meterLimit.feature)},
				${input.filterKey},
				${input.meterLimit.subscriptionId}::uuid,
				${input.meterLimit.planItemId}::bigint,
				${input.meterLimit.windowStartAt.toISOString()},
				${input.meterLimit.windowEndAt.toISOString()},
				0
			)
			ON CONFLICT (
				project_id,
				customer_id,
				feature_id,
				(COALESCE(entity_id, 0::bigint)),
				(COALESCE(filter_key, '' COLLATE "C")),
				window_start_at,
				window_end_at
			)
			DO UPDATE SET updated_at = now()
			RETURNING id, window_start_at, window_end_at, usage
		`,
	);
	if (row === null) throw new Error("Usage window could not be persisted");
	return row;
}

function meterLimitBalance(
	meterLimit: MeterLimitDecision,
	rawUsage: unknown,
	rawHeld: unknown = "0",
): MeteringBalance {
	const scale = meterLimit.feature.credit_scale;
	const limit = decimalToUnits(meterLimit.limit, scale);
	const usage = decimalToUnits(databaseDecimal(rawUsage, "window usage", scale), scale);
	const held = decimalToUnits(databaseDecimal(rawHeld, "window holds", scale), scale);
	return {
		featureKey: meterLimit.feature.key,
		unit: meterLimit.feature.unit,
		scale,
		granted: unitsToDecimal(limit, scale),
		consumed: unitsToDecimal(usage, scale),
		held: unitsToDecimal(held, scale),
		available: unitsToDecimal(limit > usage + held ? limit - usage - held : 0n, scale),
		breakdown: [],
	};
}

function directRate(feature: FeatureRow): RateDecision {
	return {
		meter: feature,
		wallet: feature,
		path: "direct",
		revision: null,
		revisionId: null,
		entryId: null,
		pricingModel: "flat",
		ratePerUnit: "1",
		tiers: [],
	};
}

function rollWindowBounds(
	start: Date,
	end: Date,
	interval: "month" | "year",
	now: Date,
): { start: Date; end: Date } {
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
		throw new BillingError(
			"Meter-limit subscription has invalid period bounds",
			"METERING_CONFIGURATION_ERROR",
			409,
			{ classification: "persistence_conflict" },
		);
	}
	let currentStart = start;
	let currentEnd = end;
	while (currentEnd <= now) {
		currentStart = currentEnd;
		currentEnd = addUtcInterval(currentEnd, interval);
	}
	return { start: currentStart, end: currentEnd };
}

function addUtcInterval(value: Date, interval: "month" | "year"): Date {
	const result = new Date(value);
	if (interval === "month") result.setUTCMonth(result.getUTCMonth() + 1);
	else result.setUTCFullYear(result.getUTCFullYear() + 1);
	return result;
}

function addUtcMonths(value: Date, months: number): Date {
	const result = new Date(value);
	result.setUTCMonth(result.getUTCMonth() + months);
	return result;
}

function startOfUtcMonth(value: Date): Date {
	return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
}

async function resolveRateDecision(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
	featureKey: string,
): Promise<RateDecision> {
	const meter = await requireMeteredFeature(executor, projectId, featureKey);
	const pinned =
		customerId === null
			? []
			: await executeRows<{
					entry_id: string | number | bigint;
					revision_id: string | number | bigint;
					revision: number;
					pricing_model: "flat" | "graduated";
					rate_per_unit: unknown;
					wallet_id: string | number | bigint;
					wallet_key: string;
					wallet_unit: string;
					wallet_scale: number;
				}>(
					executor,
					drizzleSql`
					SELECT DISTINCT
						rce.id AS entry_id,
						cr.id AS revision_id,
						cr.revision,
						rce.pricing_model,
						rce.rate_per_unit,
						wallet.id AS wallet_id,
						wallet.key AS wallet_key,
						wallet.unit AS wallet_unit,
						wallet.credit_scale AS wallet_scale
					FROM subscriptions s
					JOIN catalog_revisions cr
						ON cr.project_id = s.project_id
						AND cr.id = s.catalog_revision_id
					JOIN rate_card_entries rce
						ON rce.project_id = s.project_id
						AND rce.catalog_revision_id = s.catalog_revision_id
						AND rce.meter_feature_id = ${featureId(meter)}
					JOIN features wallet
						ON wallet.project_id = rce.project_id
						AND wallet.id = rce.wallet_feature_id
					WHERE s.project_id = ${projectId}
						AND s.customer_id = ${customerId}
						AND s.status IN ('active', 'grace_period', 'billing_retry', 'cancelled')
						AND (s.expires_at IS NULL OR s.expires_at > now())
					ORDER BY cr.revision DESC
					LIMIT 2
				`,
				);
	if (pinned.length > 1) {
		throw new BillingError(
			`Multiple pinned rate cards price feature ${meter.key}`,
			"METERING_CONFIGURATION_ERROR",
			409,
			{ classification: "persistence_conflict" },
		);
	}
	if (pinned[0] !== undefined) {
		return await rateDecisionFromRow(executor, projectId, meter, pinned[0], "pinned");
	}

	const additive = await executeOne<{
		entry_id: string | number | bigint;
		revision_id: string | number | bigint;
		revision: number;
		pricing_model: "flat" | "graduated";
		rate_per_unit: unknown;
		wallet_id: string | number | bigint;
		wallet_key: string;
		wallet_unit: string;
		wallet_scale: number;
	}>(
		executor,
		drizzleSql`
			SELECT
				rce.id AS entry_id,
				cr.id AS revision_id,
				cr.revision,
				rce.pricing_model,
				rce.rate_per_unit,
				wallet.id AS wallet_id,
				wallet.key AS wallet_key,
				wallet.unit AS wallet_unit,
				wallet.credit_scale AS wallet_scale
			FROM projects p
			JOIN catalog_revisions cr
				ON cr.project_id = p.id
				AND cr.id = p.published_catalog_revision_id
			JOIN rate_card_entries rce
				ON rce.project_id = cr.project_id
				AND rce.catalog_revision_id = cr.id
				AND rce.meter_feature_id = ${featureId(meter)}
			JOIN features wallet
				ON wallet.project_id = rce.project_id
				AND wallet.id = rce.wallet_feature_id
			WHERE p.id = ${projectId}
			LIMIT 1
		`,
	);
	if (additive !== null) {
		const purchased =
			customerId === null
				? null
				: await executeOne<{ id: string }>(
						executor,
						drizzleSql`
            SELECT id FROM subscriptions WHERE project_id=${projectId} AND customer_id=${customerId}
            AND catalog_revision_id IS NOT NULL AND status IN ('active','grace_period','billing_retry','cancelled')
            AND (expires_at IS NULL OR expires_at>clock_timestamp()) LIMIT 1
        `,
					);
		if (purchased)
			throw new BillingError(
				"The purchased revision does not price this meter; activate a fixed rate revision before use",
				"METER_RATE_NOT_ACTIVATED",
				409,
			);
		return await rateDecisionFromRow(executor, projectId, meter, additive, "additive");
	}

	const direct = await executeOne<{ direct: boolean }>(
		executor,
		drizzleSql`
			SELECT EXISTS (
				SELECT 1
				FROM plan_items pi
				WHERE pi.project_id = ${projectId}
					AND pi.feature_id = ${featureId(meter)}
					AND pi.item_kind = 'allocation'
				UNION ALL
				SELECT 1
				FROM rate_card_entries rce
				WHERE rce.project_id = ${projectId}
					AND rce.wallet_feature_id = ${featureId(meter)}
			) AS direct
		`,
	);
	if (direct?.direct !== true) {
		throw new BillingError(
			`No published rate card or wallet allocation prices feature ${meter.key}`,
			"METERING_CONFIGURATION_ERROR",
			409,
			{ classification: "persistence_conflict" },
		);
	}
	return {
		meter,
		wallet: meter,
		path: "direct",
		revision: null,
		revisionId: null,
		entryId: null,
		pricingModel: "flat",
		ratePerUnit: "1",
		tiers: [],
	};
}

async function rateDecisionFromRow(
	executor: QueryExecutor,
	projectId: string,
	meter: FeatureRow,
	row: {
		entry_id: string | number | bigint;
		revision_id: string | number | bigint;
		revision: number;
		pricing_model: "flat" | "graduated";
		rate_per_unit: unknown;
		wallet_id: string | number | bigint;
		wallet_key: string;
		wallet_unit: string;
		wallet_scale: number;
	},
	path: "pinned" | "additive",
): Promise<RateDecision> {
	const entryId = String(row.entry_id);
	return {
		meter,
		wallet: {
			id: row.wallet_id,
			key: row.wallet_key,
			unit: row.wallet_unit,
			credit_scale: row.wallet_scale,
			kind: "metered",
			meter_kind: "consumable",
			filter_dimensions: [],
		},
		path,
		revision: row.revision,
		revisionId: String(row.revision_id),
		entryId,
		pricingModel: row.pricing_model,
		ratePerUnit: databaseDecimal(row.rate_per_unit, "rate per unit", 18),
		tiers:
			row.pricing_model === "graduated"
				? await readRateCardTiers(executor, projectId, entryId)
				: [],
	};
}

async function readRateCardTiers(
	executor: QueryExecutor,
	projectId: string,
	entryId: string,
): Promise<RateCardTier[]> {
	const rows = await executeRows<{ up_to_quantity: unknown; rate_per_unit: unknown }>(
		executor,
		drizzleSql`
			SELECT up_to_quantity::text AS up_to_quantity, rate_per_unit::text AS rate_per_unit
			FROM rate_card_tiers
			WHERE project_id = ${projectId} AND rate_card_entry_id = ${entryId}::bigint
			ORDER BY ordinal
		`,
	);
	return rows.map((row) => ({
		upToQuantity: row.up_to_quantity === null ? null : String(row.up_to_quantity),
		ratePerUnit: databaseDecimal(row.rate_per_unit, "tier rate per unit", 18),
	}));
}

async function calculateWalletQuantity(
	_executor: QueryExecutor,
	rate: RateDecision,
	quantity: string,
): Promise<string> {
	return calculateRateCardQuantity({
		quantity,
		pricingModel: rate.pricingModel,
		ratePerUnit: rate.ratePerUnit,
		tiers: rate.tiers,
		meterScale: rate.meter.credit_scale,
		walletScale: rate.wallet.credit_scale,
	});
}

function validateFilters(
	feature: FeatureRow,
	filters: Record<string, string | number | boolean> | undefined,
): void {
	if (filters === undefined) {
		return;
	}
	const allowed = new Set(feature.filter_dimensions);
	for (const key of Object.keys(filters)) {
		if (!allowed.has(key)) {
			throw new InvalidRequestError(`Filter dimension ${key} is not declared for ${feature.key}`);
		}
	}
}

function canonicalFilterKey(
	filters: Record<string, string | number | boolean> | undefined,
): string | null {
	return filters === undefined || Object.keys(filters).length === 0
		? null
		: sha256Hex(stableJson(filters));
}

async function findCustomer(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
): Promise<{ id: string } | null> {
	const normalized = billingAccountId.trim();
	if (normalized === "") {
		throw new InvalidRequestError("billingAccountId is required");
	}
	return await executeOne<{ id: string }>(
		executor,
		drizzleSql`
			SELECT id
			FROM customers
			WHERE project_id = ${projectId}
				AND billing_account_id = ${normalized}
			LIMIT 1
		`,
	);
}

async function resolveEntityId(
	executor: QueryExecutor,
	projectId: string,
	customerId: string | null,
	externalEntityId: string | null | undefined,
): Promise<string | null> {
	const normalized = externalEntityId?.trim();
	if (normalized === undefined || normalized === "") return null;
	if (customerId === null) {
		throw new NotFoundBillingError(
			`Entity ${normalized} was not found for the billing account`,
			"ENTITY_NOT_FOUND",
		);
	}
	const row = await executeOne<{ id: string | number | bigint }>(
		executor,
		drizzleSql`
			SELECT id
			FROM entities
			WHERE project_id = ${projectId}
				AND customer_id = ${customerId}
				AND external_id = ${normalized}
			LIMIT 1
		`,
	);
	if (row === null) {
		throw new NotFoundBillingError(
			`Entity ${normalized} was not found for the billing account`,
			"ENTITY_NOT_FOUND",
		);
	}
	return String(row.id);
}

async function enqueueMeteringProjection(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	idempotencyKey: string,
): Promise<void> {
	const customer = await executeOne<{ billing_account_id: string }>(
		executor,
		drizzleSql`
			SELECT billing_account_id
			FROM customers
			WHERE project_id = ${projectId} AND id = ${customerId}
		`,
	);
	if (customer === null) throw new Error("Metering projection billing account was not found");
	const entitlements = await getEntitlementSnapshot(
		executor,
		projectId,
		customer.billing_account_id,
	);
	await enqueueProjectionSyncJob(executor, {
		customerId,
		idempotencyKey,
		reason: "usage_changed",
		payload: {
			billingAccountId: customer.billing_account_id,
			reason: "usage_changed",
			entitlements,
		},
	});
}

async function validateOccurredAt(
	executor: QueryExecutor,
	projectId: string,
	occurredAt: Date | null,
): Promise<void> {
	if (occurredAt === null) return;
	if (Number.isNaN(occurredAt.getTime())) {
		throw new InvalidRequestError("occurredAt must be a valid timestamp");
	}
	const row = await executeOne<{ allowed: boolean; max_skew_seconds: number }>(
		executor,
		drizzleSql`
			SELECT
				abs(extract(epoch FROM (${occurredAt.toISOString()}::timestamptz - now())))
					<= COALESCE(settings.occurred_at_max_skew_seconds, 300) AS allowed,
				COALESCE(settings.occurred_at_max_skew_seconds, 300) AS max_skew_seconds
			FROM (SELECT 1) singleton
			LEFT JOIN metering_settings settings ON settings.project_id = ${projectId}
		`,
	);
	if (row?.allowed !== true) {
		throw new InvalidRequestError(
			`occurredAt exceeds the configured ${row?.max_skew_seconds ?? 300} second clock skew`,
		);
	}
}

async function requireCustomer(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
): Promise<{ id: string }> {
	const customer = await findCustomer(executor, projectId, billingAccountId);
	if (customer === null) {
		throw new NotFoundBillingError(
			`Billing account ${billingAccountId} was not found`,
			"BILLING_ACCOUNT_NOT_FOUND",
		);
	}
	return customer;
}

async function readBalance(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	feature: FeatureRow,
	entityId: string | null = null,
): Promise<MeteringBalance> {
	const rows = await executeRows<AllocationRow>(
		executor,
		drizzleSql`
			SELECT allocation.id, allocation.quantity, allocation.reversed_quantity,
				allocation.consumed_quantity,
                COALESCE((SELECT sum(holds.held_quantity - holds.consumed_quantity) FROM reservation_allocations holds JOIN reservations r ON r.project_id=holds.project_id AND r.id=holds.reservation_id WHERE holds.project_id=allocation.project_id AND holds.allocation_id=allocation.id AND r.status='active' AND r.expires_at>clock_timestamp()),0) AS held_quantity,
                allocation.source_kind,
				allocation.source_key, allocation.expires_at, allocation.created_at,
				allocation.reversed_at, entity.external_id AS entity_external_id,
				allocation.rollover_origin_allocation_id, allocation.rollover_policy_revision,
				allocation.period_start_at, allocation.period_end_at
			FROM balance_allocations allocation
			LEFT JOIN entities entity
				ON entity.project_id = allocation.project_id AND entity.id = allocation.entity_id
				WHERE allocation.project_id = ${projectId}
					AND allocation.customer_id = ${customerId}
					AND allocation.feature_id = ${featureId(feature)}
					AND (allocation.entity_id IS NULL OR allocation.entity_id = ${entityId}::bigint)
				AND allocation.reversed_at IS NULL
				AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
			ORDER BY allocation.expires_at ASC NULLS LAST, allocation.created_at, allocation.id
		`,
	);
	return rows.length === 0 ? emptyBalance(feature) : balanceFromRows(feature, rows);
}

function emptyBalance(feature: FeatureRow): MeteringBalance {
	return {
		featureKey: feature.key,
		unit: feature.unit,
		scale: feature.credit_scale,
		granted: "0",
		consumed: "0",
		held: "0",
		available: "0",
		breakdown: [],
	};
}

async function lockAllocations(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	feature: FeatureRow,
	entityId: string | null,
): Promise<AllocationRow[]> {
	return await executeRows<AllocationRow>(
		executor,
		drizzleSql`
			SELECT
					allocation.id,
					allocation.quantity,
					allocation.reversed_quantity,
					allocation.consumed_quantity,
					allocation.held_quantity,
					allocation.source_kind,
					allocation.source_key,
					allocation.expires_at,
					allocation.created_at,
					allocation.reversed_at,
					entity.external_id AS entity_external_id,
					allocation.rollover_origin_allocation_id,
					allocation.rollover_policy_revision,
					allocation.period_start_at,
					allocation.period_end_at
				FROM balance_allocations allocation
				LEFT JOIN entities entity
					ON entity.project_id = allocation.project_id AND entity.id = allocation.entity_id
				WHERE allocation.project_id = ${projectId}
					AND allocation.customer_id = ${customerId}
					AND allocation.feature_id = ${featureId(feature)}
					AND (allocation.entity_id IS NULL OR allocation.entity_id = ${entityId}::bigint)
					AND allocation.reversed_at IS NULL
					AND (allocation.expires_at IS NULL OR allocation.expires_at > now())
				ORDER BY allocation.expires_at ASC NULLS LAST, allocation.created_at ASC, allocation.id ASC
				FOR UPDATE OF allocation
		`,
	);
}

async function lockAllAllocationRows(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	feature: FeatureRow,
	entityId: string | null,
): Promise<AllocationRow[]> {
	return await executeRows<AllocationRow>(
		executor,
		drizzleSql`
			SELECT
					allocation.id,
					allocation.quantity,
					allocation.reversed_quantity,
					allocation.consumed_quantity,
					allocation.held_quantity,
					allocation.source_kind,
					allocation.source_key,
					allocation.expires_at,
					allocation.created_at,
					allocation.reversed_at,
					entity.external_id AS entity_external_id,
					allocation.rollover_origin_allocation_id,
					allocation.rollover_policy_revision,
					allocation.period_start_at,
					allocation.period_end_at
				FROM balance_allocations allocation
				LEFT JOIN entities entity
					ON entity.project_id = allocation.project_id AND entity.id = allocation.entity_id
				WHERE allocation.project_id = ${projectId}
					AND allocation.customer_id = ${customerId}
					AND allocation.feature_id = ${featureId(feature)}
					AND (allocation.entity_id IS NULL OR allocation.entity_id = ${entityId}::bigint)
				ORDER BY allocation.expires_at ASC NULLS LAST, allocation.created_at ASC, allocation.id ASC
				FOR UPDATE OF allocation
		`,
	);
}

function balanceFromRows(feature: FeatureRow, rows: AllocationRow[]): MeteringBalance {
	const scale = feature.credit_scale;
	let granted = 0n;
	let consumed = 0n;
	let held = 0n;
	for (const row of rows) {
		granted +=
			decimalToUnits(databaseDecimal(row.quantity, "allocation quantity", scale), scale) -
			decimalToUnits(databaseDecimal(row.reversed_quantity, "allocation reversed", scale), scale);
		consumed += decimalToUnits(
			databaseDecimal(row.consumed_quantity, "allocation consumed", scale),
			scale,
		);
		held += decimalToUnits(databaseDecimal(row.held_quantity, "allocation held", scale), scale);
	}
	return {
		featureKey: feature.key,
		unit: feature.unit,
		scale,
		granted: unitsToDecimal(granted, scale),
		consumed: unitsToDecimal(consumed, scale),
		held: unitsToDecimal(held, scale),
		available: unitsToDecimal(granted > consumed + held ? granted - consumed - held : 0n, scale),
		breakdown: rows.map((row) => {
			const quantity = decimalToUnits(
				databaseDecimal(row.quantity, "allocation quantity", scale),
				scale,
			);
			const reversed = decimalToUnits(
				databaseDecimal(row.reversed_quantity, "allocation reversed", scale),
				scale,
			);
			const rowConsumed = decimalToUnits(
				databaseDecimal(row.consumed_quantity, "allocation consumed", scale),
				scale,
			);
			const rowHeld = decimalToUnits(
				databaseDecimal(row.held_quantity, "allocation held", scale),
				scale,
			);
			const available = quantity - reversed - rowConsumed - rowHeld;
			return {
				allocationId: String(row.id),
				entityId: row.entity_external_id,
				sourceKind: row.source_kind,
				sourceKey: row.source_key,
				rolloverOriginAllocationId:
					row.rollover_origin_allocation_id === null
						? null
						: String(row.rollover_origin_allocation_id),
				rolloverPolicyRevision: row.rollover_policy_revision,
				quantity: unitsToDecimal(quantity, scale),
				reversed: unitsToDecimal(reversed, scale),
				consumed: unitsToDecimal(rowConsumed, scale),
				held: unitsToDecimal(rowHeld, scale),
				available: unitsToDecimal(available > 0n ? available : 0n, scale),
				periodStartAt: row.period_start_at === null ? null : toIso(row.period_start_at),
				periodEndAt: row.period_end_at === null ? null : toIso(row.period_end_at),
				expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
				createdAt: toIso(row.created_at),
			};
		}),
	};
}

async function consumeAllocations(
	executor: QueryExecutor,
	rows: AllocationRow[],
	scale: number,
	quantity: string,
	column: "consumed_quantity" | "held_quantity",
): Promise<AllocationDeduction[]> {
	let remaining = decimalToUnits(quantity, scale);
	const deductions: AllocationDeduction[] = [];
	for (const row of rows) {
		if (remaining === 0n) break;
		const available =
			decimalToUnits(databaseDecimal(row.quantity, "allocation quantity", scale), scale) -
			decimalToUnits(databaseDecimal(row.reversed_quantity, "allocation reversed", scale), scale) -
			decimalToUnits(databaseDecimal(row.consumed_quantity, "allocation consumed", scale), scale) -
			decimalToUnits(databaseDecimal(row.held_quantity, "allocation held", scale), scale);
		const taken = available < remaining ? available : remaining;
		if (taken <= 0n) continue;
		const rendered = unitsToDecimal(taken, scale);
		await executeOne(
			executor,
			drizzleSql`
				UPDATE balance_allocations
				SET
					${drizzleSql.raw(column)} = ${drizzleSql.raw(column)} + ${rendered}::numeric,
					updated_at = now()
				WHERE id = ${String(row.id)}::bigint
				RETURNING id
			`,
		);
		deductions.push(allocationDeduction(row, rendered));
		remaining -= taken;
	}
	if (remaining !== 0n) {
		throw new Error("Allocation deduction did not cover the approved quantity");
	}
	return deductions;
}

async function holdAllocations(
	executor: QueryExecutor,
	projectId: string,
	reservationId: string,
	rows: AllocationRow[],
	scale: number,
	quantity: string,
): Promise<AllocationDeduction[]> {
	const deductions = await consumeAllocations(executor, rows, scale, quantity, "held_quantity");
	for (const deduction of deductions) {
		await executeOne(
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
		);
	}
	return deductions;
}

function allocationDeduction(row: AllocationRow, quantity: string): AllocationDeduction {
	return {
		allocationId: String(row.id),
		quantity,
		sourceKind: row.source_kind,
		sourceKey: row.source_key,
		expiresAt: row.expires_at === null ? null : toIso(row.expires_at),
	};
}

async function buildDecision(
	executor: QueryExecutor,
	projectId: string,
	rate: RateDecision,
	requestedQuantity: string,
	walletQuantity: string,
	balance: MeteringBalance,
): Promise<MeteringDecision> {
	const allowed =
		decimalToUnits(balance.available, balance.scale) >=
		decimalToUnits(walletQuantity, balance.scale);
	return {
		allowed,
		reason: allowed ? "allowed" : "insufficient_balance",
		requestedQuantity,
		walletQuantity,
		balance,
		rateCard: rateReceipt(rate),
		eligiblePurchaseActions: allowed ? [] : await purchaseActions(executor, projectId),
		control: null,
	};
}

function controlDeniedDecision(
	decision: MeteringDecision,
	denial: ControlDenial,
): MeteringDecision {
	return {
		...decision,
		allowed: false,
		reason: "control_limit_exceeded",
		eligiblePurchaseActions: [],
		control: denial,
	};
}

function rateReceipt(rate: RateDecision): RateCardReceipt {
	return {
		path: rate.path,
		revision: rate.revision,
		revisionId: rate.revisionId,
		entryId: rate.entryId,
		meterFeatureKey: rate.meter.key,
		walletFeatureKey: rate.wallet.key,
		pricingModel: rate.pricingModel,
		ratePerUnit: rate.ratePerUnit,
		tiers: rate.tiers,
	};
}

async function purchaseActions(
	executor: QueryExecutor,
	projectId: string,
): Promise<Array<{ provider: "apple" | "google" | "stripe"; action: "purchase_required" }>> {
	return await executeRows<{
		provider: "apple" | "google" | "stripe";
		action: "purchase_required";
	}>(
		executor,
		drizzleSql`
			SELECT DISTINCT sp.provider, 'purchase_required'::text AS action
			FROM store_products sp
			JOIN products p ON p.project_id = sp.project_id AND p.id = sp.product_id
			WHERE sp.project_id = ${projectId}
				AND sp.active = true
				AND p.active = true
				AND p.credit_amount > 0
			ORDER BY sp.provider
		`,
	);
}

async function claimWorkerDelivery(
	executor: QueryExecutor,
	projectId: string,
	deliveryId: string,
	requestContextId: string,
): Promise<boolean> {
	const delivery = deliveryId.trim();
	const context = requestContextId.trim();
	if (delivery.length < 1 || delivery.length > 200) {
		throw new InvalidRequestError("Worker delivery id must contain between 1 and 200 characters");
	}
	if (context.length < 1 || context.length > 200) {
		throw new InvalidRequestError(
			"Worker request context id must contain between 1 and 200 characters",
		);
	}
	await executeRows(
		executor,
		drizzleSql`
			DELETE FROM worker_delivery_claims
			WHERE project_id = ${projectId}
				AND delivery_id = ${delivery}
				AND expires_at <= now()
		`,
	);
	const row = await executeOne<{ id: string | number | bigint }>(
		executor,
		drizzleSql`
			INSERT INTO worker_delivery_claims (
				project_id,
				delivery_id,
				request_context_id,
				expires_at
			)
			VALUES (
				${projectId},
				${delivery},
				${context},
				now() + make_interval(
					secs => COALESCE(
						(SELECT worker_delivery_ttl_seconds FROM metering_settings WHERE project_id = ${projectId}),
						86400
					)
				)
			)
			ON CONFLICT (project_id, delivery_id) DO NOTHING
			RETURNING id
		`,
	);
	return row !== null;
}

async function insertUsageEvent(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		entityId: string | null;
		rate: RateDecision;
		operation: "consume" | "confirm";
		quantity: string;
		walletQuantity: string;
		occurredAt: Date | null;
		reservationId: string | null;
		filterKey: string | null;
		deductions: AllocationDeduction[];
		metadata: Record<string, unknown>;
	},
): Promise<{ id: string; recorded_at: Date | string }> {
	const recordedAt = new Date();
	const row = await executeOne<{ id: string; recorded_at: Date | string }>(
		executor,
		drizzleSql`
			INSERT INTO usage_events (
				recorded_at,
				project_id,
				customer_id,
				entity_id,
				meter_feature_id,
				wallet_feature_id,
				reservation_id,
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
				${input.entityId},
				${featureId(input.rate.meter)},
				${featureId(input.rate.wallet)},
				${input.reservationId},
				${input.operation},
				${input.quantity}::numeric,
				${input.walletQuantity}::numeric,
				${input.occurredAt?.toISOString() ?? null},
				${recordedAt.toISOString()},
				${input.rate.entryId},
				${input.rate.revisionId},
				${input.rate.path},
					${jsonb({
						quantity: input.quantity,
						pricingModel: input.rate.pricingModel,
						ratePerUnit: input.rate.ratePerUnit,
						tiers: input.rate.tiers,
						walletQuantity: input.walletQuantity,
						walletScale: input.rate.wallet.credit_scale,
					})},
				${input.filterKey},
				${jsonb(input.deductions)},
				${jsonb(input.metadata)}
			)
			RETURNING id, recorded_at
		`,
	);
	if (row === null) {
		throw new Error("Usage event could not be persisted");
	}
	return row;
}

async function incrementRollup(
	executor: QueryExecutor,
	input: {
		projectId: string;
		customerId: string;
		entityId: string | null;
		meterFeatureId: string;
		quantity: string;
		walletQuantity: string;
		recordedAt: Date | string;
	},
): Promise<void> {
	await executeOne(
		executor,
		drizzleSql`
			INSERT INTO usage_event_rollups (
				project_id,
				customer_id,
				entity_id,
				meter_feature_id,
				period_start_at,
				period_end_at,
				quantity,
				wallet_quantity,
				event_count
			)
			VALUES (
				${input.projectId},
				${input.customerId},
				${input.entityId},
				${input.meterFeatureId},
				date_trunc('month', ${toIso(input.recordedAt)}::timestamptz),
				date_trunc('month', ${toIso(input.recordedAt)}::timestamptz) + interval '1 month',
				${input.quantity}::numeric,
				${input.walletQuantity}::numeric,
				1
			)
			ON CONFLICT (
				project_id,
				customer_id,
				meter_feature_id,
				(COALESCE(entity_id, 0::bigint)),
				period_start_at
			)
			DO UPDATE SET
				quantity = usage_event_rollups.quantity + EXCLUDED.quantity,
				wallet_quantity = usage_event_rollups.wallet_quantity + EXCLUDED.wallet_quantity,
				event_count = usage_event_rollups.event_count + 1,
				updated_at = now()
			WHERE usage_event_rollups.status = 'open'
			RETURNING id
		`,
	);
}

async function lockReservation(
	executor: QueryExecutor,
	projectId: string,
	customerId: string,
	reservationId: string,
): Promise<ReservationRow> {
	const row = await executeOne<ReservationRow>(
		executor,
		drizzleSql`
			SELECT
				r.*,
				c.billing_account_id,
				meter.key AS meter_feature_key,
				meter.unit AS meter_unit,
				meter.credit_scale AS meter_scale,
				wallet.key AS wallet_feature_key,
				wallet.unit AS wallet_unit,
				wallet.credit_scale AS wallet_scale,
				cr.revision,
				COALESCE(rce.pricing_model, 'flat') AS pricing_model,
				COALESCE(rce.rate_per_unit, 1)::text AS rate_per_unit
			FROM reservations r
			JOIN customers c ON c.project_id = r.project_id AND c.id = r.customer_id
			JOIN features meter ON meter.project_id = r.project_id AND meter.id = r.meter_feature_id
			JOIN features wallet ON wallet.project_id = r.project_id AND wallet.id = r.wallet_feature_id
			LEFT JOIN rate_card_entries rce
				ON rce.project_id = r.project_id AND rce.id = r.rate_card_entry_id
			LEFT JOIN catalog_revisions cr
				ON cr.project_id = r.project_id AND cr.id = r.rate_card_revision_id
			WHERE r.project_id = ${projectId}
				AND r.customer_id = ${customerId}
				AND r.id = ${reservationId}
			FOR UPDATE OF r
		`,
	);
	if (row === null) {
		throw new NotFoundBillingError(
			`Reservation ${reservationId} was not found`,
			"RESERVATION_NOT_FOUND",
		);
	}
	return row;
}

async function lockReservationById(
	executor: QueryExecutor,
	projectId: string,
	reservationId: string,
): Promise<ReservationRow> {
	const owner = await executeOne<{ customer_id: string }>(
		executor,
		drizzleSql`
			SELECT customer_id FROM reservations
			WHERE project_id = ${projectId} AND id = ${reservationId}
		`,
	);
	if (owner === null) {
		throw new NotFoundBillingError(
			`Reservation ${reservationId} was not found`,
			"RESERVATION_NOT_FOUND",
		);
	}
	return await lockReservation(executor, projectId, owner.customer_id, reservationId);
}

async function rateFromReservation(
	executor: QueryExecutor,
	reservation: ReservationRow,
): Promise<RateDecision> {
	const entryId =
		reservation.rate_card_entry_id === null ? null : String(reservation.rate_card_entry_id);
	return {
		meter: {
			id: reservation.meter_feature_id,
			key: reservation.meter_feature_key,
			unit: reservation.meter_unit,
			credit_scale: reservation.meter_scale,
			kind: "metered",
			meter_kind: "consumable",
			filter_dimensions: [],
		},
		wallet: {
			id: reservation.wallet_feature_id,
			key: reservation.wallet_feature_key,
			unit: reservation.wallet_unit,
			credit_scale: reservation.wallet_scale,
			kind: "metered",
			meter_kind: "consumable",
			filter_dimensions: [],
		},
		path: reservation.rate_card_path,
		revision: reservation.revision,
		revisionId:
			reservation.rate_card_revision_id === null ? null : String(reservation.rate_card_revision_id),
		entryId,
		pricingModel: reservation.pricing_model,
		ratePerUnit: databaseDecimal(reservation.rate_per_unit, "reservation rate", 18),
		tiers:
			entryId !== null && reservation.pricing_model === "graduated"
				? await readRateCardTiers(executor, reservation.project_id, entryId)
				: [],
	};
}

async function lockReservationAllocations(
	executor: QueryExecutor,
	projectId: string,
	reservationId: string,
): Promise<ReservationAllocationRow[]> {
	return await executeRows<ReservationAllocationRow>(
		executor,
		drizzleSql`
			SELECT allocation_id, held_quantity, consumed_quantity
			FROM reservation_allocations
			WHERE project_id = ${projectId}
				AND reservation_id = ${reservationId}
			ORDER BY allocation_id
			FOR UPDATE
		`,
	);
}

async function confirmAgainstAllocations(
	executor: QueryExecutor,
	allocations: AllocationRow[],
	reservationAllocations: ReservationAllocationRow[],
	scale: number,
	walletQuantity: string,
	apply = true,
): Promise<AllocationDeduction[]> {
	const holds = new Map(
		reservationAllocations.map((row) => [
			String(row.allocation_id),
			decimalToUnits(databaseDecimal(row.held_quantity, "reservation hold", scale), scale),
		]),
	);
	let remaining = decimalToUnits(walletQuantity, scale);
	const changes = new Map<string, { consume: bigint; release: bigint; row: AllocationRow }>();

	for (const row of allocations) {
		const held = holds.get(String(row.id)) ?? 0n;
		const consumed = held < remaining ? held : remaining;
		changes.set(String(row.id), { consume: consumed, release: held, row });
		remaining -= consumed;
	}

	if (remaining > 0n) {
		const now = Date.now();
		for (const row of allocations) {
			if (remaining === 0n) break;
			if (
				row.reversed_at !== null ||
				(row.expires_at !== null && new Date(row.expires_at).getTime() <= now)
			) {
				continue;
			}
			const free =
				decimalToUnits(databaseDecimal(row.quantity, "allocation quantity", scale), scale) -
				decimalToUnits(
					databaseDecimal(row.consumed_quantity, "allocation consumed", scale),
					scale,
				) -
				decimalToUnits(databaseDecimal(row.held_quantity, "allocation held", scale), scale);
			const extra = free < remaining ? free : remaining;
			if (extra <= 0n) continue;
			const change = changes.get(String(row.id)) ?? { consume: 0n, release: 0n, row };
			change.consume += extra;
			changes.set(String(row.id), change);
			remaining -= extra;
		}
	}

	if (remaining > 0n) {
		throw new BillingError(
			"Insufficient balance to confirm reservation",
			"INSUFFICIENT_BALANCE",
			409,
			{
				classification: "persistence_conflict",
			},
		);
	}

	const deductions: AllocationDeduction[] = [];
	for (const { consume, release, row } of changes.values()) {
		if (consume === 0n && release === 0n) continue;
		const consumed = unitsToDecimal(consume, scale);
		const released = unitsToDecimal(release, scale);
		if (!apply) {
			if (consume > 0n) deductions.push(allocationDeduction(row, consumed));
			continue;
		}
		await executeOne(
			executor,
			drizzleSql`
				UPDATE balance_allocations
				SET
					consumed_quantity = consumed_quantity + ${consumed}::numeric,
					held_quantity = held_quantity - ${released}::numeric,
					updated_at = now()
				WHERE id = ${String(row.id)}::bigint
				RETURNING id
			`,
		);
		if (holds.has(String(row.id))) {
			await executeOne(
				executor,
				drizzleSql`
					UPDATE reservation_allocations
					SET consumed_quantity = ${unitsToDecimal(consume > release ? release : consume, scale)}::numeric
					WHERE allocation_id = ${String(row.id)}::bigint
					RETURNING allocation_id
				`,
			);
		}
		if (consume > 0n) deductions.push(allocationDeduction(row, consumed));
	}
	return deductions;
}

async function confirmMeterLimitReservation(
	executor: QueryExecutor,
	reservation: ReservationRow,
	quantity: string,
	context: { occurredAt: Date | null; metadata: Record<string, unknown> },
): Promise<FinalizeReservationResult> {
	if (
		reservation.usage_window_id === null ||
		reservation.usage_window_start_at === null ||
		reservation.usage_window_end_at === null
	) {
		throw new Error("Meter-limit reservation lost its window identity");
	}
	const window = await executeOne<UsageWindowRow & { filter_key: string | null }>(
		executor,
		drizzleSql`
			SELECT id, window_start_at, window_end_at, usage, filter_key
			FROM usage_windows
			WHERE project_id = ${reservation.project_id}
				AND id = ${String(reservation.usage_window_id)}::bigint
			FOR UPDATE
		`,
	);
	if (window === null) throw new Error("Meter-limit reservation window was not found");
	const feature: FeatureRow = {
		id: reservation.meter_feature_id,
		key: reservation.meter_feature_key,
		unit: reservation.meter_unit,
		credit_scale: reservation.meter_scale,
		kind: "metered",
		meter_kind: "consumable",
		filter_dimensions: [],
	};
	const meterLimit = (await resolveMeterLimit(
		executor,
		reservation.project_id,
		reservation.customer_id,
		feature,
	)) ?? {
		feature,
		subscriptionId: null,
		planItemId: null,
		limit: "0",
		overagePolicy: "blocked" as const,
		overagePrice: null,
		windowStartAt: new Date(window.window_start_at),
		windowEndAt: new Date(window.window_end_at),
	};
	const scale = feature.credit_scale;
	const reserved = decimalToUnits(
		databaseDecimal(reservation.held_quantity, "reservation held", scale),
		scale,
	);
	const confirmed = decimalToUnits(quantity, scale);
	const sameWindow =
		toIso(window.window_start_at) === toIso(reservation.usage_window_start_at) &&
		toIso(window.window_end_at) === toIso(reservation.usage_window_end_at);
	const otherHolds = await readActiveWindowHolds(
		executor,
		reservation.project_id,
		String(window.id),
		reservation.id,
	);
	if (confirmed > reserved) {
		if (!sameWindow) {
			return await insufficientMeterLimitConfirmation(
				executor,
				reservation,
				meterLimit,
				window.filter_key,
			);
		}
		const used = decimalToUnits(databaseDecimal(window.usage, "window usage", scale), scale);
		const held = decimalToUnits(otherHolds, scale);
		const limit = decimalToUnits(meterLimit.limit, scale);
		if (meterLimit.overagePolicy === "blocked" && used + held + confirmed > limit) {
			return await insufficientMeterLimitConfirmation(
				executor,
				reservation,
				meterLimit,
				window.filter_key,
			);
		}
	}
	const spend = meterLimitSpendDelta(
		meterLimit,
		meterLimitBalance(meterLimit, window.usage, otherHolds),
		quantity,
	);
	const controls = await confirmControlHolds(executor, {
		projectId: reservation.project_id,
		customerId: reservation.customer_id,
		entityId: reservation.entity_id === null ? null : String(reservation.entity_id),
		featureId: featureId(feature),
		featureKey: feature.key,
		usageDelta: quantity,
		...spend,
		reservationId: reservation.id,
	});
	if (controls.denial !== null) {
		return {
			allowed: false,
			reason: "control_limit_exceeded",
			reservationId: reservation.id,
			status: "active",
			usageEventId: null,
			recordedAt: null,
			balance: await readMeterLimitBalance(
				executor,
				reservation.project_id,
				reservation.customer_id,
				reservation.entity_id === null ? null : String(reservation.entity_id),
				window.filter_key,
				meterLimit,
			),
			deductions: [],
			control: controls.denial,
		};
	}
	if (sameWindow) {
		await executeOne(
			executor,
			drizzleSql`
				UPDATE usage_windows
				SET usage = usage + ${quantity}::numeric, updated_at = now()
				WHERE project_id = ${reservation.project_id}
					AND id = ${String(window.id)}::bigint
				RETURNING id
			`,
		);
	}
	const rate = directRate(feature);
	const event = await insertUsageEvent(executor, {
		projectId: reservation.project_id,
		customerId: reservation.customer_id,
		entityId: reservation.entity_id === null ? null : String(reservation.entity_id),
		rate,
		operation: "confirm",
		quantity,
		walletQuantity: quantity,
		occurredAt: context.occurredAt,
		reservationId: reservation.id,
		filterKey: window.filter_key,
		deductions: [],
		metadata: {
			...context.metadata,
			usageWindowId: String(window.id),
			usageWindowStartAt: toIso(reservation.usage_window_start_at),
			usageWindowEndAt: toIso(reservation.usage_window_end_at),
			lateAdjustment: !sameWindow,
		},
	});
	await recordUsageControlEntries(executor, {
		projectId: reservation.project_id,
		usageEventId: event.id,
		usageEventRecordedAt: event.recorded_at,
		entries: controls.entries,
	});
	await executeOne(
		executor,
		drizzleSql`
			UPDATE reservations
			SET
				status = 'confirmed',
				confirmed_quantity = ${quantity}::numeric,
				finalized_at = now(),
				updated_at = now()
			WHERE project_id = ${reservation.project_id}
				AND id = ${reservation.id}
				AND status = 'active'
			RETURNING id
		`,
	);
	await incrementRollup(executor, {
		projectId: reservation.project_id,
		customerId: reservation.customer_id,
		entityId: reservation.entity_id === null ? null : String(reservation.entity_id),
		meterFeatureId: featureId(feature),
		quantity,
		walletQuantity: quantity,
		recordedAt: event.recorded_at,
	});
	return {
		allowed: true,
		reason: "allowed",
		reservationId: reservation.id,
		status: "confirmed",
		usageEventId: event.id,
		recordedAt: toIso(event.recorded_at),
		balance: await readMeterLimitBalance(
			executor,
			reservation.project_id,
			reservation.customer_id,
			reservation.entity_id === null ? null : String(reservation.entity_id),
			window.filter_key,
			meterLimit,
		),
		deductions: [],
	};
}

async function insufficientMeterLimitConfirmation(
	executor: QueryExecutor,
	reservation: ReservationRow,
	meterLimit: MeterLimitDecision,
	filterKey: string | null,
): Promise<FinalizeReservationResult> {
	return {
		allowed: false,
		reason: "insufficient_balance",
		reservationId: reservation.id,
		status: "active",
		usageEventId: null,
		recordedAt: null,
		balance: await readMeterLimitBalance(
			executor,
			reservation.project_id,
			reservation.customer_id,
			reservation.entity_id === null ? null : String(reservation.entity_id),
			filterKey,
			meterLimit,
		),
		deductions: [],
	};
}

/** Reclaim a subject's expired holds before authorization, independent of worker timing. */
async function expireSubjectReservations(
	executor: QueryExecutor,
	projectId: string,
	billingAccountId: string,
): Promise<void> {
	const rows = await executeRows<{ id: string; customer_id: string }>(
		executor,
		drizzleSql`
  SELECT r.id,r.customer_id FROM reservations r JOIN customers c ON c.project_id=r.project_id AND c.id=r.customer_id
  WHERE r.project_id=${projectId} AND c.billing_account_id=${billingAccountId} AND r.status='active' AND r.expires_at<=clock_timestamp()
  ORDER BY r.id FOR UPDATE OF r
 `,
	);
	for (const row of rows) {
		const reservation = await lockReservation(executor, projectId, row.customer_id, row.id);
		if (reservation.status === "active")
			await releaseReservationHolds(executor, reservation, "expired");
	}
}

async function releaseReservationHolds(
	executor: QueryExecutor,
	reservation: ReservationRow,
	status: "released" | "expired",
): Promise<void> {
	await releaseControlHolds(executor, reservation.project_id, reservation.id);
	const reservationRows = await lockReservationAllocations(
		executor,
		reservation.project_id,
		reservation.id,
	);
	for (const row of reservationRows) {
		const remaining =
			decimalToUnits(
				databaseDecimal(row.held_quantity, "reservation held", reservation.wallet_scale),
				reservation.wallet_scale,
			) -
			decimalToUnits(
				databaseDecimal(row.consumed_quantity, "reservation consumed", reservation.wallet_scale),
				reservation.wallet_scale,
			);
		if (remaining <= 0n) continue;
		await executeOne(
			executor,
			drizzleSql`
				UPDATE balance_allocations
				SET
					held_quantity = held_quantity - ${unitsToDecimal(remaining, reservation.wallet_scale)}::numeric,
					updated_at = now()
				WHERE project_id = ${reservation.project_id}
					AND id = ${String(row.allocation_id)}::bigint
				RETURNING id
			`,
		);
	}
	await executeOne(
		executor,
		drizzleSql`
			UPDATE reservations
			SET status = ${status}, finalized_at = CASE WHEN ${status}='expired' THEN expires_at ELSE clock_timestamp() END, updated_at = now()
			WHERE project_id = ${reservation.project_id}
				AND id = ${reservation.id}
				AND status = 'active'
			RETURNING id
		`,
	);
}

async function finalizedReservationResult(
	executor: QueryExecutor,
	reservation: ReservationRow,
): Promise<FinalizeReservationResult> {
	const wallet: FeatureRow = {
		id: reservation.wallet_feature_id,
		key: reservation.wallet_feature_key,
		unit: reservation.wallet_unit,
		credit_scale: reservation.wallet_scale,
		kind: "metered",
		meter_kind: "consumable",
		filter_dimensions: [],
	};
	const event =
		reservation.status === "confirmed"
			? await executeOne<{
					id: string;
					recorded_at: Date | string;
					deductions: AllocationDeduction[];
				}>(
					executor,
					drizzleSql`
					SELECT id, recorded_at, deductions
					FROM usage_events
					WHERE project_id = ${reservation.project_id}
						AND reservation_id = ${reservation.id}
						AND operation = 'confirm'
					ORDER BY recorded_at DESC
					LIMIT 1
				`,
				)
			: null;
	let balance: MeteringBalance;
	if (reservation.usage_window_id !== null) {
		const window = await executeOne<{ filter_key: string | null }>(
			executor,
			drizzleSql`
				SELECT filter_key
				FROM usage_windows
				WHERE project_id = ${reservation.project_id}
					AND id = ${String(reservation.usage_window_id)}::bigint
			`,
		);
		const feature: FeatureRow = {
			id: reservation.meter_feature_id,
			key: reservation.meter_feature_key,
			unit: reservation.meter_unit,
			credit_scale: reservation.meter_scale,
			kind: "metered",
			meter_kind: "consumable",
			filter_dimensions: [],
		};
		const meterLimit = (await resolveMeterLimit(
			executor,
			reservation.project_id,
			reservation.customer_id,
			feature,
		)) ?? {
			feature,
			subscriptionId: null,
			planItemId: null,
			limit: "0",
			overagePolicy: "blocked" as const,
			overagePrice: null,
			windowStartAt: new Date(reservation.usage_window_start_at ?? reservation.expires_at),
			windowEndAt: new Date(reservation.usage_window_end_at ?? reservation.expires_at),
		};
		balance = await readMeterLimitBalance(
			executor,
			reservation.project_id,
			reservation.customer_id,
			reservation.entity_id === null ? null : String(reservation.entity_id),
			window?.filter_key ?? null,
			meterLimit,
		);
	} else {
		balance = await readBalance(
			executor,
			reservation.project_id,
			reservation.customer_id,
			wallet,
			reservation.entity_id === null ? null : String(reservation.entity_id),
		);
	}
	return {
		allowed: reservation.status !== "expired",
		reason: reservation.status === "expired" ? "reservation_expired" : "allowed",
		reservationId: reservation.id,
		status: reservation.status,
		usageEventId: event?.id ?? null,
		recordedAt: event === null ? null : toIso(event.recorded_at),
		balance,
		deductions: event?.deductions ?? [],
	};
}

function featureId(feature: FeatureRow): string {
	return String(feature.id);
}

function toIso(value: Date | string): string {
	return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toTimestamp(value: Date | string | null): number | undefined {
	return value === null ? undefined : new Date(value).getTime();
}
