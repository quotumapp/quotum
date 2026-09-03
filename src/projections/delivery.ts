import type {
	EntitlementSnapshot,
	ProjectionPayload,
	ProjectionSyncReason,
} from "../billing/types";

export interface BillingProjectionInput {
	schemaVersion: 1;
	projectKey: string;
	jobId: string;
	idempotencyKey: string;
	billingAccountId: string;
	generatedAt: string;
	entitlements: EntitlementSnapshot;
	balances: ProjectionPayload["balances"];
	reason: ProjectionSyncReason;
	purchase?: ProjectionPayload["purchase"];
	reversal?: ProjectionPayload["reversal"];
}

export interface ProjectionDelivery {
	deliver(input: BillingProjectionInput): Promise<void>;
}
