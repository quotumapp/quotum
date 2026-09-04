import { sql as drizzleSql } from "drizzle-orm";
import type { BillingProvider, EntitlementSnapshot } from "../../billing/types";
import type { ProjectContext } from "../../projects/context";
import type { BillingProjectRecord } from "../../projects/types";
import { RepositoryModule } from "./base";
import { materializeTopupAllocation, reversePurchaseAllocations } from "./catalog-allocations";
import {
	enqueueProjectionSyncJob,
	getEntitlementSnapshot,
	recomputeCustomerEntitlements,
} from "./entitlements";
import {
	ensureCustomer,
	getStoreProductById,
	resolveProjectId,
	upsertProviderCustomer,
} from "./identities";
import { upsertPurchase } from "./mutations";
import { executeOne } from "./query";
import { recordStoreEventProcessingResult } from "./store-events";
import type { BillingProjectRow, RecordPurchaseProjectionInput } from "./types";
import { requireNonBlank } from "./validation";

export class CoreBillingRepository extends RepositoryModule {
	async upsertProject(
		project: ProjectContext,
		input: { name: string; active: boolean },
	): Promise<BillingProjectRecord> {
		requireNonBlank(project.projectKey, "p_project_key");
		requireNonBlank(input.name, "p_name");
		const row = await executeOne<BillingProjectRow>(
			this.database,
			drizzleSql`
			INSERT INTO projects (key, name, active)
			VALUES (${project.projectKey}, ${input.name}, ${input.active})
			ON CONFLICT (key) DO UPDATE SET
				name = EXCLUDED.name,
				active = EXCLUDED.active,
				updated_at = now()
			RETURNING id, key, name, active
		`,
		);
		if (row === null) {
			throw new Error(`billing project ${project.projectKey} could not be persisted`);
		}
		return { id: row.id, key: row.key, name: row.name, active: row.active };
	}

	async getEntitlementSnapshot(
		project: ProjectContext,
		billingAccountId: string,
	): Promise<EntitlementSnapshot> {
		return await getEntitlementSnapshot(
			this.database,
			await resolveProjectId(this.database, project),
			billingAccountId,
		);
	}

	async recomputeCustomerEntitlements(
		project: ProjectContext,
		billingAccountId: string,
	): Promise<EntitlementSnapshot> {
		return await this.transaction(async (tx) => {
			const projectId = await resolveProjectId(tx, project);
			return await recomputeCustomerEntitlements(tx, projectId, billingAccountId);
		});
	}

	async recordPurchaseAndEnqueueProjection(
		project: ProjectContext,
		input: RecordPurchaseProjectionInput,
	): Promise<EntitlementSnapshot> {
		return await this.transaction(async (tx) => {
			const projectId = await resolveProjectId(tx, project);
			const customer = await ensureCustomer(tx, projectId, input.billingAccountId);
			const storeProduct = await getStoreProductById(tx, projectId, {
				storeProductId: input.storeProductId,
				provider: input.provider,
				channel: input.channel,
			});

			if (storeProduct.product_type !== input.purchaseKind) {
				throw new Error(
					`purchase kind ${input.purchaseKind} does not match product type ${storeProduct.product_type}`,
				);
			}

			const storeEventResult = await recordStoreEventProcessingResult(tx, projectId, {
				provider: input.provider,
				channel: input.channel,
				externalEventId: input.externalEventId,
				eventType: input.eventType,
				customerId: customer.id,
				storeProductId: input.storeProductId,
				transactionId: input.transactionId,
				purchaseKind: input.purchaseKind,
				processingStatus: "processed",
				processingError: null,
				rawPayload: input.rawPayload,
				raiseIdentityMismatch: true,
				replayStoreEventId: input.replayStoreEventId ?? null,
			});

			if (!storeEventResult.applied) {
				return await getEntitlementSnapshot(tx, projectId, input.billingAccountId);
			}

			const purchaseId = await upsertPurchase(tx, projectId, {
				customerId: customer.id,
				productId: storeProduct.product_id,
				storeProductId: input.storeProductId,
				subscriptionId: null,
				provider: input.provider,
				channel: input.channel,
				purchaseKind: input.purchaseKind,
				transactionId: input.transactionId,
				originalTransactionId: input.originalTransactionId,
				status: input.status,
				purchasedAt: input.purchasedAt,
				invalidatedAt: null,
				invalidationReason: null,
				rawPayload: input.rawPayload,
				identityError: `purchase transaction identity mismatch for provider ${input.provider} transaction ${input.transactionId}`,
			});
			if (input.status === "completed") {
				await materializeTopupAllocation(tx, {
					projectId,
					customerId: customer.id,
					storeProductId: input.storeProductId,
					purchaseId,
					purchasedAt: input.purchasedAt,
				});
			} else {
				await reversePurchaseAllocations(tx, projectId, purchaseId, input.purchasedAt);
			}

			const snapshot = await recomputeCustomerEntitlements(tx, projectId, input.billingAccountId);
			await enqueueProjectionSyncJob(tx, {
				customerId: customer.id,
				idempotencyKey: input.projectionIdempotencyKey,
				reason: input.projectionReason,
				payload: {
					billingAccountId: input.billingAccountId,
					reason: input.projectionReason,
					entitlements: snapshot,
				},
			});
			return snapshot;
		});
	}

	async getOrCreateProviderCustomerToken(
		project: ProjectContext,
		billingAccountId: string,
		provider: BillingProvider,
	): Promise<string> {
		requireNonBlank(billingAccountId, "p_billing_account_id");
		return await this.transaction(async (tx) => {
			const projectId = await resolveProjectId(tx, project);
			const customer = await ensureCustomer(tx, projectId, billingAccountId);
			const existing = await executeOne<{ external_customer_id: string }>(
				tx,
				drizzleSql`
				SELECT pc.external_customer_id
				FROM provider_customers pc
				WHERE pc.project_id = ${projectId}
					AND pc.customer_id = ${customer.id}
					AND pc.provider = ${provider}
				ORDER BY pc.created_at ASC
				LIMIT 1
				FOR UPDATE
			`,
			);
			if (existing !== null) {
				return existing.external_customer_id;
			}

			const externalCustomerId = crypto.randomUUID();
			await upsertProviderCustomer(tx, projectId, {
				customerId: customer.id,
				provider,
				externalCustomerId,
				identityError: `provider customer identity mismatch for provider ${provider} customer ${externalCustomerId}`,
			});
			return externalCustomerId;
		});
	}
}
