import type { ProjectInstanceContext } from "../projects/context";
import type { BillingProvider } from "./types";

export const providerOperationStatuses = [
	"prepared",
	"in_flight",
	"reconciling",
	"requires_review",
	"succeeded",
	"failed",
] as const;
export type ProviderOperationStatus = (typeof providerOperationStatuses)[number];

/** Immutable identity of one remote effect, including the account that must recover it. */
export interface PrepareProviderOperation {
	billingAccountId: string;
	provider: BillingProvider;
	providerAccountId: string;
	connectionVersionId: string;
	idempotencyKey: string;
	resourceKey: string;
	operation: string;
	requestHash: string;
	request: Record<string, unknown>;
}

export interface ProviderOperation extends PrepareProviderOperation {
	id: string;
	status: ProviderOperationStatus;
	attempts: number;
	result: Record<string, unknown> | null;
	providerObjectId: string | null;
	errorCode: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface ProviderOperationLease {
	operation: ProviderOperation;
	token: string;
}

/** Safe for account reads: no request, credential version, idempotency key or authenticated URLs. */
export type ProviderOperationReceipt = Pick<
	ProviderOperation,
	| "id"
	| "provider"
	| "operation"
	| "status"
	| "providerObjectId"
	| "errorCode"
	| "createdAt"
	| "updatedAt"
>;

export function providerOperationReceipt(operation: ProviderOperation): ProviderOperationReceipt {
	return {
		id: operation.id,
		provider: operation.provider,
		operation: operation.operation,
		status: operation.status,
		providerObjectId: operation.providerObjectId,
		errorCode: operation.errorCode,
		createdAt: operation.createdAt,
		updatedAt: operation.updatedAt,
	};
}

export type ProviderOperationOutcome =
	| { status: "succeeded"; result: Record<string, unknown>; providerObjectId: string }
	| { status: "failed"; errorCode: string }
	| { status: "reconciling" | "requires_review"; errorCode: string };

export interface ProviderOperationStore {
	prepare(
		project: ProjectInstanceContext,
		input: PrepareProviderOperation,
	): Promise<ProviderOperation>;
	get(
		project: ProjectInstanceContext,
		billingAccountId: string,
		id: string,
	): Promise<ProviderOperation>;
	claimDispatch(
		project: ProjectInstanceContext,
		billingAccountId: string,
		id: string,
	): Promise<ProviderOperationLease | null>;
	settle(
		project: ProjectInstanceContext,
		lease: ProviderOperationLease,
		outcome: ProviderOperationOutcome,
	): Promise<ProviderOperation>;
}

export interface ProviderOperationRecoveryStore extends ProviderOperationStore {
	renew?(project: ProjectInstanceContext, lease: ProviderOperationLease): Promise<boolean>;
	claimReconciliation(
		project: ProjectInstanceContext,
		billingAccountId: string,
		id: string,
	): Promise<ProviderOperationLease | null>;
}

/** Recovery receives the persisted connection identity and can only observe a remote effect. */
export async function reconcileProviderOperation(input: {
	project: ProjectInstanceContext;
	store: ProviderOperationRecoveryStore;
	billingAccountId: string;
	operationId: string;
	resolve: (operation: ProviderOperation) => Promise<{
		provider: BillingProvider;
		providerAccountId: string;
		observe: (
			operation: ProviderOperation,
		) => Promise<Exclude<ProviderOperationOutcome, { status: "failed" }>>;
	}>;
}): Promise<ProviderOperation> {
	const lease = await input.store.claimReconciliation(
		input.project,
		input.billingAccountId,
		input.operationId,
	);
	if (lease === null)
		return await input.store.get(input.project, input.billingAccountId, input.operationId);
	let outcome: Exclude<ProviderOperationOutcome, { status: "failed" }>;
	let renewal: Promise<unknown> | null = null;
	const timer = input.store.renew
		? setInterval(() => {
				if (renewal !== null) return;
				renewal =
					input.store
						.renew?.(input.project, lease)
						.catch(() => false)
						.finally(() => {
							renewal = null;
						}) ?? null;
			}, 20_000)
		: null;
	try {
		const provider = await input.resolve(lease.operation);
		outcome =
			provider.provider === lease.operation.provider &&
			provider.providerAccountId === lease.operation.providerAccountId
				? await provider.observe(lease.operation)
				: { status: "requires_review", errorCode: "PROVIDER_OPERATION_ACCOUNT_MISMATCH" };
	} catch {
		outcome = { status: "reconciling", errorCode: "PROVIDER_OPERATION_UNCERTAIN" };
	} finally {
		if (timer !== null) clearInterval(timer);
		await renewal;
	}
	return await input.store.settle(input.project, lease, outcome);
}

/** Only a provider's authenticated, explicit rejection may be treated as a failed write. */
export class RejectedProviderWrite extends Error {
	constructor(readonly code: string) {
		super("The provider rejected this operation");
	}
}

/**
 * Performs at most one dispatch. Replays read the durable receipt; they never reclaim in-flight
 * writes. The caller must reconcile even a crash between claiming the lease and sending bytes.
 */
export async function executeProviderOperation(input: {
	project: ProjectInstanceContext;
	store: ProviderOperationStore;
	intent: PrepareProviderOperation;
	/** Verify and bind any longer-lived checkout reservation before claiming a dispatch. */
	beforeDispatch?: (operation: ProviderOperation) => Promise<void>;
	write: (
		operation: ProviderOperation,
	) => Promise<{ providerObjectId: string; result: Record<string, unknown> }>;
}): Promise<ProviderOperation> {
	const operation = await input.store.prepare(input.project, input.intent);
	if (operation.status === "prepared") await input.beforeDispatch?.(operation);
	const lease = await input.store.claimDispatch(
		input.project,
		operation.billingAccountId,
		operation.id,
	);
	if (lease === null)
		return await input.store.get(input.project, operation.billingAccountId, operation.id);
	let outcome: ProviderOperationOutcome;
	try {
		outcome = { status: "succeeded", ...(await input.write(lease.operation)) };
	} catch (error) {
		outcome =
			error instanceof RejectedProviderWrite
				? { status: "failed", errorCode: error.code }
				: { status: "reconciling", errorCode: "PROVIDER_OPERATION_UNCERTAIN" };
	}
	// A failed local commit must not be caught as a provider rejection. The durable in-flight
	// receipt survives and becomes eligible for reconciliation after its lease expires.
	return await input.store.settle(input.project, lease, outcome);
}
