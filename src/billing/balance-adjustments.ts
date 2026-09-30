import type { ProjectInstanceContext } from "../projects/context";
import { isBigintId } from "../shared/input-bounds";
import { canonicalDecimal, sha256Hex, stableJson } from "./decimal";
import { BillingError, InvalidRequestError } from "./errors";

/** A revoked grant stays revoked; otherwise it is expired once its allocation's expiry passes. */
export type OperatorGrantStatus = "active" | "expired" | "revoked";

export const adjustmentReasonMaxLength = 500;
export const administrativeDebitMaxAllocations = 20;

export interface OperatorGrantRecord {
	id: string;
	billingAccountId: string;
	featureKey: string;
	entityId: string | null;
	allocationId: string;
	quantity: string;
	expiresAt: string | null;
	status: OperatorGrantStatus;
	consumedQuantity: string;
	heldQuantity: string;
	reversedQuantity: string;
	availableQuantity: string;
	actor: string;
	reason: string;
	createdAt: string;
	revocation: {
		actor: string;
		reason: string;
		revokedAt: string;
		/** Quantity this revocation took back; 0 when nothing was left to take. */
		revokedQuantity: string;
	} | null;
}

export interface OperatorGrantInput {
	billingAccountId: string;
	featureKey: string;
	quantity: string;
	entityId: string | null;
	expiresAt: Date | null;
	reason: string;
	actor: string;
	idempotencyKey: string;
}

export interface OperatorGrantRevokeInput {
	billingAccountId: string;
	grantId: string;
	reason: string;
	actor: string;
	idempotencyKey: string;
}

export interface OperatorGrantMutationResult {
	duplicate: boolean;
	grant: OperatorGrantRecord;
}

export interface AdministrativeDebitInput {
	billingAccountId: string;
	allocations: Array<{ allocationId: string; quantity: string }>;
	reason: string;
	actor: string;
	idempotencyKey: string;
}

export interface AdministrativeDebitRecord {
	id: string;
	billingAccountId: string;
	actor: string;
	reason: string;
	createdAt: string;
	allocations: Array<{
		allocationId: string;
		featureKey: string;
		entityId: string | null;
		sourceKind: string;
		quantity: string;
	}>;
}

export interface AdministrativeDebitMutationResult {
	duplicate: boolean;
	debit: AdministrativeDebitRecord;
}

export interface AdjustmentListOptions {
	limit: number;
	cursor: string | null;
}

export interface AdjustmentList<T> {
	items: T[];
	nextCursor: string | null;
}

export interface BalanceAdjustmentServiceLike {
	grantOperatorBalance(
		project: ProjectInstanceContext,
		input: OperatorGrantInput,
	): Promise<OperatorGrantMutationResult>;
	revokeOperatorGrant(
		project: ProjectInstanceContext,
		input: OperatorGrantRevokeInput,
	): Promise<OperatorGrantMutationResult>;
	listOperatorGrants(
		project: ProjectInstanceContext,
		billingAccountId: string,
		options: AdjustmentListOptions,
	): Promise<AdjustmentList<OperatorGrantRecord>>;
	getOperatorGrant(
		project: ProjectInstanceContext,
		billingAccountId: string,
		grantId: string,
	): Promise<OperatorGrantRecord>;
	debitAllocations(
		project: ProjectInstanceContext,
		input: AdministrativeDebitInput,
	): Promise<AdministrativeDebitMutationResult>;
	listAdministrativeDebits(
		project: ProjectInstanceContext,
		billingAccountId: string,
		options: AdjustmentListOptions,
	): Promise<AdjustmentList<AdministrativeDebitRecord>>;
}

// Each entry declares `code` literally so the wire error registry inventories it.
const balanceAdjustmentErrorDefinitions = [
	{ code: "OPERATOR_GRANT_NOT_FOUND", status: 404, message: "Operator grant was not found" },
	{
		code: "OPERATOR_GRANT_ALREADY_REVOKED",
		status: 409,
		message: "Operator grant has already been revoked",
	},
	{
		code: "OPERATOR_GRANT_FEATURE_INVALID",
		status: 400,
		message: "Operator grants give quantity of a consumable feature that usage spends only",
	},
	{ code: "ALLOCATION_NOT_FOUND", status: 404, message: "Allocation was not found" },
	{
		code: "ALLOCATION_NOT_DEBITABLE",
		status: 409,
		message: "Allocation cannot be debited",
	},
	{
		code: "ADMINISTRATIVE_DEBIT_EXCEEDS_AVAILABLE",
		status: 409,
		message: "Debit exceeds the allocation's available quantity",
	},
] as const;

export type BalanceAdjustmentErrorCode = (typeof balanceAdjustmentErrorDefinitions)[number]["code"];

export function balanceAdjustmentError(
	code: BalanceAdjustmentErrorCode,
	details?: Record<string, unknown>,
): BillingError {
	const definition = balanceAdjustmentErrorDefinitions.find((candidate) => candidate.code === code);
	return new BillingError(
		definition?.message ?? "Balance adjustment failed",
		code,
		definition?.status ?? 400,
		details === undefined ? {} : { details },
	);
}

function requireReason(value: string): string {
	const reason = value.trim();
	// Characters, as the reason column's `char_length` counts them, not UTF-16 units.
	if (reason === "" || [...reason].length > adjustmentReasonMaxLength) {
		throw new InvalidRequestError(
			`reason must contain between 1 and ${adjustmentReasonMaxLength} characters`,
		);
	}
	return reason;
}

/** Trims text and canonicalizes the quantity, so equal requests hash equally. */
export function normalizeOperatorGrantInput(input: OperatorGrantInput): OperatorGrantInput {
	const featureKey = input.featureKey.trim();
	if (featureKey === "") throw new InvalidRequestError("featureKey is required");
	const entityId = input.entityId?.trim() ?? "";
	return {
		...input,
		featureKey,
		quantity: canonicalDecimal(input.quantity, "quantity"),
		entityId: entityId === "" ? null : entityId,
		reason: requireReason(input.reason),
	};
}

export function normalizeOperatorGrantRevokeInput(
	input: OperatorGrantRevokeInput,
): OperatorGrantRevokeInput {
	return { ...input, reason: requireReason(input.reason) };
}

/** Orders the lines by allocation, so the same debit written in another order hashes equally. */
export function normalizeAdministrativeDebitInput(
	input: AdministrativeDebitInput,
): AdministrativeDebitInput {
	if (
		input.allocations.length === 0 ||
		input.allocations.length > administrativeDebitMaxAllocations
	) {
		throw new InvalidRequestError(
			`allocations must name between 1 and ${administrativeDebitMaxAllocations} allocations`,
		);
	}
	const allocations = input.allocations
		.map((line) => ({
			allocationId: line.allocationId.trim(),
			quantity: canonicalDecimal(line.quantity, "quantity"),
		}))
		.sort((left, right) => compareAllocationIds(left.allocationId, right.allocationId));
	for (const [index, line] of allocations.entries()) {
		if (!/^[1-9]\d{0,18}$/.test(line.allocationId) || !isBigintId(line.allocationId)) {
			throw new InvalidRequestError("allocationId must be a positive integer string");
		}
		if (index > 0 && allocations[index - 1]?.allocationId === line.allocationId) {
			throw new InvalidRequestError(`allocation ${line.allocationId} is named more than once`);
		}
	}
	return { ...input, allocations, reason: requireReason(input.reason) };
}

function compareAllocationIds(left: string, right: string): number {
	return left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
}

/** Identifies what a grant asks for, so a reused idempotency key with other terms conflicts. */
export function operatorGrantRequestHash(input: OperatorGrantInput): string {
	return sha256Hex(
		stableJson({
			featureKey: input.featureKey,
			quantity: input.quantity,
			entityId: input.entityId,
			expiresAt: input.expiresAt?.toISOString() ?? null,
			reason: input.reason,
		}),
	);
}

export function operatorGrantRevokeRequestHash(input: OperatorGrantRevokeInput): string {
	return sha256Hex(stableJson({ grantId: input.grantId, reason: input.reason }));
}

export function administrativeDebitRequestHash(input: AdministrativeDebitInput): string {
	return sha256Hex(stableJson({ allocations: input.allocations, reason: input.reason }));
}
