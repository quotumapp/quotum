import type { ProjectInstanceContext } from "../projects/context";
import { positiveDecimal } from "./decimal";
import { InvalidRequestError, NotConfiguredError, PersistenceConflictError } from "./errors";
import type { MeteringDecision } from "./metering";
import type { UsageOperationLookupResult } from "./usage-operations";

export interface BillingAccountRecord {
	id: string;
	createdAt: string;
}

/** Public values normalize redundant zeroes before the operation fingerprint is computed. */
export function publicUsageValue(value: string): string {
	if (value.length > 80 || !/^\d+(?:\.\d+)?$/u.test(value)) {
		throw new InvalidRequestError("value must be a positive plain decimal string");
	}
	return positiveDecimal(value.replace(/^0+(?=\d)/u, ""), "value");
}

export function publicOperationLookup(
	result: UsageOperationLookupResult,
): UsageOperationLookupResult {
	if (
		result.operation === "consume" &&
		result.status === "completed" &&
		!("operationId" in result.outcome)
	) {
		throw new PersistenceConflictError(
			"This retained consume predates the public receipt contract; reconcile it without reusing its identity",
			"OPERATION_RESULT_EXPIRED",
		);
	}
	return result;
}

export interface UsageScope {
	billingAccountId: string;
	entityId?: string;
}

export interface UsageCheckInput extends UsageScope {
	featureId: string;
	value?: string;
	occurredAt?: Date;
}

export interface UsageConsumeInput extends UsageCheckInput {
	value: string;
	operationId: string;
}

export interface UsageQuantity {
	featureId: string;
	unit: string;
	value: string;
}

export interface UsageBalance {
	featureId: string;
	unit: string;
	/** Null for an unlimited quota, which grants no finite amount. */
	granted: string | null;
	consumed: string;
	held: string;
	/** Null for an unlimited quota. */
	available: string | null;
	unlimited?: true;
	/** A meter limit's scope and current window (PC-12); absent on wallet balances. */
	scope?: "account" | "entity";
	windowStartAt?: string;
	windowEndAt?: string;
}

export type UsageDenialReason = "not_entitled" | "insufficient_balance" | "control_limit_exceeded";
export type UsageVerdict =
	| { allowed: true }
	| {
			allowed: false;
			reason: UsageDenialReason;
			control?: NonNullable<MeteringDecision["control"]>;
	  };

export interface UsageMeteredContext {
	featureId: string;
	entityId: string | null;
	usage: UsageQuantity;
	rated: UsageQuantity;
	balance: UsageBalance;
}

export type UsageCheckResult = UsageVerdict & {
	featureId: string;
	entityId: string | null;
	checkedAt: string;
} & ({ kind: "boolean" } | ({ kind: "metered" } & UsageMeteredContext));

export type UsageConsumeResult = UsageMeteredContext & {
	operation: "consume";
	operationId: string;
} & (
		| { allowed: true; receiptId: string; usageEventId: string; recordedAt: string }
		| {
				allowed: false;
				reason: UsageDenialReason;
				control?: NonNullable<MeteringDecision["control"]>;
		  }
	);

export interface UsageReceipt extends UsageMeteredContext {
	receiptId: string;
	/** The usage event a correction names, with `recordedAt` as its `originalRecordedAt`. */
	usageEventId: string;
	operation: "consume";
	operationId: string;
	billingAccountId: string;
	occurredAt: string | null;
	recordedAt: string;
	rating: { path: "direct" | "pinned" | "additive"; revision: number | null };
	deductionCount: number;
}

export interface UsageDeductionPage {
	items: Array<{ sourceKind: string; sourceKey: string; value: string; expiresAt: string | null }>;
	nextCursor: string | null;
}

export interface UsageReceiptInput extends UsageScope {
	receiptId: string;
}

export interface UsageApiServiceLike {
	createAccount(project: ProjectInstanceContext, id: string): Promise<BillingAccountRecord>;
	getAccount(project: ProjectInstanceContext, id: string): Promise<BillingAccountRecord>;
	check(project: ProjectInstanceContext, input: UsageCheckInput): Promise<UsageCheckResult>;
	consume(project: ProjectInstanceContext, input: UsageConsumeInput): Promise<UsageConsumeResult>;
	getReceipt(project: ProjectInstanceContext, input: UsageReceiptInput): Promise<UsageReceipt>;
	listReceiptDeductions(
		project: ProjectInstanceContext,
		input: UsageReceiptInput & { cursor?: string; limit?: number },
	): Promise<UsageDeductionPage>;
}

export function usageVerdict(decision: MeteringDecision): UsageVerdict {
	if (decision.reason === "configuration_error") {
		throw new NotConfiguredError("Usage rating is not configured", "USAGE_NOT_CONFIGURED", 409);
	}
	return decision.allowed
		? { allowed: true }
		: {
				allowed: false,
				reason: decision.reason === "allowed" ? "insufficient_balance" : decision.reason,
				...(decision.control === null ? {} : { control: decision.control }),
			};
}

export function usageContext(
	input: UsageCheckInput,
	unit: string,
	decision: MeteringDecision,
): UsageMeteredContext {
	const { balance } = decision;
	return {
		featureId: input.featureId,
		entityId: input.entityId ?? null,
		usage: { featureId: input.featureId, unit, value: decision.requestedQuantity },
		rated: { featureId: balance.featureKey, unit: balance.unit, value: decision.walletQuantity },
		balance: {
			featureId: balance.featureKey,
			unit: balance.unit,
			granted: balance.granted,
			consumed: balance.consumed,
			held: balance.held,
			available: balance.available,
			...(balance.unlimited === true ? { unlimited: true as const } : {}),
			...(balance.scope === undefined ? {} : { scope: balance.scope }),
			...(balance.windowStartAt === undefined ? {} : { windowStartAt: balance.windowStartAt }),
			...(balance.windowEndAt === undefined ? {} : { windowEndAt: balance.windowEndAt }),
		},
	};
}
