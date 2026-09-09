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
	/** Per-account order of state snapshots; receivers may ignore a lower value. */
	sequence?: number;
}

export type UsageDeliveryMode = "coalesced" | "off";

export interface ProjectionDelivery {
	deliver(input: BillingProjectionInput): Promise<void>;
	/** How the receiver wants usage-driven snapshots; absent means coalesced. */
	usageDeliveryMode?(projectKey: string): Promise<UsageDeliveryMode>;
}
