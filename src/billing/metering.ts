import type { ProjectInstanceContext } from "../projects/context";

export type RateCardPath = "direct" | "pinned" | "additive";
export type ReservationStatus = "active" | "confirmed" | "released" | "expired";

export interface MeteringSubjectInput {
	billingAccountId: string;
	featureKey: string;
	entityId?: string | null;
	quantity: string;
	filters?: Record<string, string | number | boolean>;
	occurredAt?: Date | null;
}

export interface MeteringMutationInput extends MeteringSubjectInput {
	idempotencyKey: string;
	metadata?: Record<string, unknown>;
}

export interface WorkerMeteringMutationInput extends MeteringSubjectInput {
	deliveryId: string;
	requestContextId: string;
	metadata?: Record<string, unknown>;
}

export interface WorkerConsumeUsageResult {
	applied: boolean;
	result: ConsumeUsageResult | null;
}

export interface ReserveUsageInput extends MeteringMutationInput {
	expiresInSeconds: number;
}

export interface ConfirmReservationInput {
	billingAccountId: string;
	reservationId: string;
	quantity: string;
	idempotencyKey: string;
	occurredAt?: Date | null;
	metadata?: Record<string, unknown>;
}

export interface ReleaseReservationInput {
	billingAccountId: string;
	reservationId: string;
	idempotencyKey: string;
}

export interface CorrectUsageInput {
	billingAccountId: string;
	originalUsageEventId: string;
	originalRecordedAt: Date;
	quantity: string;
	idempotencyKey: string;
	actor: string;
	reason: string;
	occurredAt?: Date | null;
	metadata?: Record<string, unknown>;
}

export interface AllocationDeduction {
	allocationId: string;
	quantity: string;
	sourceKind: string;
	sourceKey: string;
	expiresAt: string | null;
}

export interface MeteringBalance {
	featureKey: string;
	unit: string;
	scale: number;
	granted: string;
	consumed: string;
	held: string;
	available: string;
	breakdown: BalanceAllocationBreakdown[];
}

export interface BalanceAllocationBreakdown {
	allocationId: string;
	entityId: string | null;
	sourceKind: string;
	sourceKey: string;
	rolloverOriginAllocationId: string | null;
	rolloverPolicyRevision: number | null;
	quantity: string;
	reversed: string;
	consumed: string;
	held: string;
	available: string;
	periodStartAt: string | null;
	periodEndAt: string | null;
	expiresAt: string | null;
	createdAt: string;
}

export interface RateCardReceipt {
	path: RateCardPath;
	revision: number | null;
	revisionId: string | null;
	entryId: string | null;
	meterFeatureKey: string;
	walletFeatureKey: string;
	pricingModel: "flat" | "graduated";
	ratePerUnit: string;
	tiers: Array<{
		upToQuantity: string | null;
		ratePerUnit: string;
	}>;
}

export interface MeteringDecision {
	allowed: boolean;
	reason: "allowed" | "insufficient_balance" | "control_limit_exceeded" | "configuration_error";
	requestedQuantity: string;
	walletQuantity: string;
	balance: MeteringBalance;
	rateCard: RateCardReceipt;
	eligiblePurchaseActions: Array<{
		provider: "apple" | "google" | "stripe";
		action: "purchase_required" | "provider_action_required";
	}>;
	control: {
		kind: "spend_limit" | "usage_limit";
		source: "plan_default" | "contract" | "account" | "entity";
		revision: number;
		policyId: string;
		limitValue: string;
		currentValue: string;
		requestedValue: string;
		remainingValue: string;
	} | null;
}

export interface ConsumeUsageResult extends MeteringDecision {
	usageEventId: string | null;
	recordedAt: string | null;
	deductions: AllocationDeduction[];
}

export interface ReservationResult extends MeteringDecision {
	reservationId: string | null;
	status: ReservationStatus | null;
	expiresAt: string | null;
	deductions: AllocationDeduction[];
}

export interface FinalizeReservationResult {
	allowed: boolean;
	reason: "allowed" | "insufficient_balance" | "control_limit_exceeded" | "reservation_expired";
	reservationId: string;
	status: ReservationStatus;
	usageEventId: string | null;
	recordedAt: string | null;
	balance: MeteringBalance;
	deductions: AllocationDeduction[];
	control?: MeteringDecision["control"];
}

export interface UsageCorrectionResult {
	usageEventId: string;
	recordedAt: string;
	originalUsageEventId: string;
	originalRecordedAt: string;
	quantity: string;
	walletQuantity: string;
	balance: MeteringBalance;
	deductions: AllocationDeduction[];
}

export interface MeteringMaintenanceResult {
	expiredReservations: number;
	rolledOverAllocations: number;
	closedPeriods: number;
	deletedClientClaims: number;
	deletedWorkerClaims: number;
	expiredCatalogDrafts: number;
	deletedRawUsageEvents: number;
}

export interface MeteringServiceLike {
	getBalance(
		project: ProjectInstanceContext,
		billingAccountId: string,
		featureKey: string,
		entityId?: string | null,
	): Promise<MeteringBalance>;
	check(project: ProjectInstanceContext, input: MeteringSubjectInput): Promise<MeteringDecision>;
	consume(
		project: ProjectInstanceContext,
		input: MeteringMutationInput,
	): Promise<ConsumeUsageResult>;
	reserve(project: ProjectInstanceContext, input: ReserveUsageInput): Promise<ReservationResult>;
	confirm(
		project: ProjectInstanceContext,
		input: ConfirmReservationInput,
	): Promise<FinalizeReservationResult>;
	release(
		project: ProjectInstanceContext,
		input: ReleaseReservationInput,
	): Promise<FinalizeReservationResult>;
	correct(
		project: ProjectInstanceContext,
		input: CorrectUsageInput,
	): Promise<UsageCorrectionResult>;
}

interface MeteringRepositoryLike {
	getMeteringBalance(
		project: ProjectInstanceContext,
		billingAccountId: string,
		featureKey: string,
		entityId?: string | null,
	): Promise<MeteringBalance>;
	checkUsage(
		project: ProjectInstanceContext,
		input: MeteringSubjectInput,
	): Promise<MeteringDecision>;
	consumeUsage(
		project: ProjectInstanceContext,
		input: MeteringMutationInput,
	): Promise<ConsumeUsageResult>;
	reserveUsage(
		project: ProjectInstanceContext,
		input: ReserveUsageInput,
	): Promise<ReservationResult>;
	confirmUsageReservation(
		project: ProjectInstanceContext,
		input: ConfirmReservationInput,
	): Promise<FinalizeReservationResult>;
	releaseUsageReservation(
		project: ProjectInstanceContext,
		input: ReleaseReservationInput,
	): Promise<FinalizeReservationResult>;
	correctUsage(
		project: ProjectInstanceContext,
		input: CorrectUsageInput,
	): Promise<UsageCorrectionResult>;
}

export class MeteringService implements MeteringServiceLike {
	constructor(private readonly repository: MeteringRepositoryLike) {}

	async getBalance(
		project: ProjectInstanceContext,
		billingAccountId: string,
		featureKey: string,
		entityId?: string | null,
	): Promise<MeteringBalance> {
		return await this.repository.getMeteringBalance(
			project,
			billingAccountId,
			featureKey,
			entityId,
		);
	}

	async check(
		project: ProjectInstanceContext,
		input: MeteringSubjectInput,
	): Promise<MeteringDecision> {
		return await this.repository.checkUsage(project, input);
	}

	async consume(
		project: ProjectInstanceContext,
		input: MeteringMutationInput,
	): Promise<ConsumeUsageResult> {
		return await this.repository.consumeUsage(project, input);
	}

	async reserve(
		project: ProjectInstanceContext,
		input: ReserveUsageInput,
	): Promise<ReservationResult> {
		return await this.repository.reserveUsage(project, input);
	}

	async confirm(
		project: ProjectInstanceContext,
		input: ConfirmReservationInput,
	): Promise<FinalizeReservationResult> {
		return await this.repository.confirmUsageReservation(project, input);
	}

	async release(
		project: ProjectInstanceContext,
		input: ReleaseReservationInput,
	): Promise<FinalizeReservationResult> {
		return await this.repository.releaseUsageReservation(project, input);
	}

	async correct(
		project: ProjectInstanceContext,
		input: CorrectUsageInput,
	): Promise<UsageCorrectionResult> {
		return await this.repository.correctUsage(project, input);
	}
}
