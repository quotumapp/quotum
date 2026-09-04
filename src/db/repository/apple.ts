import { NotFoundBillingError } from "../../billing/errors";
import type { ProjectionPayload } from "../../billing/types";
import type { ProjectInstanceContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import {
	materializeSubscriptionAllocations,
	materializeTopupAllocation,
	reversePurchaseAllocations,
} from "./catalog-allocations";
import {
	enqueueProjectionSyncJob,
	getEntitlementSnapshot,
	recomputeCustomerEntitlements,
} from "./entitlements";
import {
	ensureCustomer,
	findCustomerByProviderCustomer,
	findCustomerBySubscription,
	getAppleStoreProduct,
	upsertProviderCustomer,
} from "./identities";
import { findAppleInvalidationTarget } from "./invalidations";
import { upsertPurchase, upsertSubscription } from "./mutations";
import { processedStoreKitRecordingResult, skippedStoreKitRecordingResult } from "./results";
import { recordStoreEventProcessingResult } from "./store-events";
import type {
	CustomerIdentityRow,
	RecordStoreKitTransactionProjectionInput,
	StoreKitRecordingResult,
	StoreProductIdentityRow,
} from "./types";
import { isInvalidatedStatus } from "./validation";

export class AppleBillingRepository extends RepositoryModule {
	async recordStoreKitTransactionAndEnqueueProjection(
		project: ProjectInstanceContext,
		input: RecordStoreKitTransactionProjectionInput,
	): Promise<StoreKitRecordingResult> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const isRefundReversal = input.eventType === "REFUND_REVERSED";
			let customer: CustomerIdentityRow | null = null;
			let storeProduct: StoreProductIdentityRow | null = null;
			let subscriptionId: string | null = null;

			if (input.billingAccountId !== null) {
				customer = await ensureCustomer(tx, projectId, input.billingAccountId);
			} else if (input.appAccountToken !== null) {
				customer = await findCustomerByProviderCustomer(
					tx,
					projectId,
					"apple",
					input.appAccountToken,
				);
			}

			if (customer === null && input.originalTransactionId !== null) {
				customer = await findCustomerBySubscription(
					tx,
					projectId,
					"apple",
					input.originalTransactionId,
				);
			}

			if (isInvalidatedStatus(input.purchaseStatus) || isRefundReversal) {
				const target = await findAppleInvalidationTarget(tx, projectId, input);
				if (target !== null) {
					customer = { id: target.customer_id, billing_account_id: target.billing_account_id };
					storeProduct = {
						id: target.store_product_id,
						product_id: target.product_id,
						product_key: target.product_key,
						product_type: target.product_type,
						credit_amount: target.credit_amount,
					};
					subscriptionId = target.subscription_id;
				} else {
					await recordStoreEventProcessingResult(tx, projectId, {
						provider: "apple",
						channel: input.channel,
						externalEventId: input.externalEventId,
						eventType: input.eventType,
						customerId: null,
						storeProductId: null,
						transactionId: input.transactionId,
						purchaseKind: input.purchaseKind,
						processingStatus: "skipped",
						processingError: "StoreKit invalidation target could not be resolved",
						rawPayload: input.rawPayload,
						raiseIdentityMismatch: false,
						replayStoreEventId: input.replayStoreEventId ?? null,
					});
					return skippedStoreKitRecordingResult();
				}
			}

			if (customer === null) {
				await recordStoreEventProcessingResult(tx, projectId, {
					provider: "apple",
					channel: input.channel,
					externalEventId: input.externalEventId,
					eventType: input.eventType,
					customerId: null,
					storeProductId: null,
					transactionId: input.transactionId,
					purchaseKind: input.purchaseKind,
					processingStatus: "skipped",
					processingError: "StoreKit customer could not be resolved",
					rawPayload: input.rawPayload,
					raiseIdentityMismatch: false,
					replayStoreEventId: input.replayStoreEventId ?? null,
				});
				return skippedStoreKitRecordingResult();
			}

			if (input.appAccountToken !== null) {
				await upsertProviderCustomer(tx, projectId, {
					customerId: customer.id,
					provider: "apple",
					externalCustomerId: input.appAccountToken,
					identityError: "Apple app account token identity mismatch",
				});
			}

			if (!isInvalidatedStatus(input.purchaseStatus) && storeProduct === null) {
				storeProduct = await getAppleStoreProduct(
					tx,
					projectId,
					input.channel,
					input.externalProductId,
				);
			}

			if (storeProduct === null) {
				throw new NotFoundBillingError(
					`Active Apple store product ${input.externalProductId} was not found`,
					"BILLING_PRODUCT_NOT_FOUND",
				);
			}
			if (storeProduct.product_type !== input.purchaseKind) {
				throw new Error(
					`purchase kind ${input.purchaseKind} does not match product type ${storeProduct.product_type}`,
				);
			}

			const storeEvent = await recordStoreEventProcessingResult(tx, projectId, {
				provider: "apple",
				channel: input.channel,
				externalEventId: input.externalEventId,
				eventType: input.eventType,
				customerId: customer.id,
				storeProductId: storeProduct.id,
				transactionId: input.transactionId,
				purchaseKind: input.purchaseKind,
				processingStatus: "processed",
				processingError: null,
				rawPayload: input.rawPayload,
				raiseIdentityMismatch: true,
				replayStoreEventId: input.replayStoreEventId ?? null,
			});
			if (!storeEvent.applied) {
				return processedStoreKitRecordingResult(
					customer.billing_account_id,
					await getEntitlementSnapshot(tx, projectId, customer.billing_account_id),
				);
			}

			if (input.purchaseKind === "subscription") {
				if (input.originalTransactionId === null) {
					throw new Error("p_original_transaction_id is required for StoreKit subscriptions");
				}
				subscriptionId = await upsertSubscription(tx, projectId, {
					customerId: customer.id,
					productId: storeProduct.product_id,
					storeProductId: storeProduct.id,
					provider: "apple",
					channel: input.channel,
					externalSubscriptionId: input.originalTransactionId,
					externalProductId: input.externalProductId,
					externalPriceId: input.webOrderLineItemId,
					status: input.subscriptionStatus ?? "refunded",
					startsAt: input.purchasedAt,
					expiresAt: input.expiresAt,
					autoRenew: input.autoRenew ?? false,
					latestTransactionId: input.transactionId,
					rawState: input.rawPayload,
					updateProduct: false,
					allowRestoration: isRefundReversal,
					identityError: `subscription identity mismatch for provider apple original transaction ${input.originalTransactionId}`,
				});
				await materializeSubscriptionAllocations(tx, {
					projectId,
					customerId: customer.id,
					storeProductId: storeProduct.id,
					subscriptionId,
					status: input.subscriptionStatus ?? "refunded",
					periodStartAt: input.purchasedAt,
					periodEndAt: input.expiresAt,
				});
			}

			const purchaseId = await upsertPurchase(tx, projectId, {
				customerId: customer.id,
				productId: storeProduct.product_id,
				storeProductId: storeProduct.id,
				subscriptionId,
				provider: "apple",
				channel: input.channel,
				purchaseKind: input.purchaseKind,
				transactionId: input.transactionId,
				originalTransactionId: input.originalTransactionId,
				status: input.purchaseStatus,
				purchasedAt: input.purchasedAt,
				invalidatedAt: input.invalidatedAt,
				invalidationReason: input.invalidationReason,
				rawPayload: input.rawPayload,
				allowRestoration: isRefundReversal,
				identityError: `purchase transaction identity mismatch for provider apple transaction ${input.transactionId}`,
			});
			if (input.purchaseKind === "consumable") {
				if (input.purchaseStatus === "completed") {
					await materializeTopupAllocation(tx, {
						projectId,
						customerId: customer.id,
						storeProductId: storeProduct.id,
						purchaseId,
						purchasedAt: input.purchasedAt,
					});
				} else {
					await reversePurchaseAllocations(
						tx,
						projectId,
						purchaseId,
						input.invalidatedAt ?? input.purchasedAt,
					);
				}
			}

			const snapshot = await recomputeCustomerEntitlements(
				tx,
				projectId,
				customer.billing_account_id,
			);
			const payload: Omit<ProjectionPayload, "generatedAt" | "balances"> = {
				billingAccountId: customer.billing_account_id,
				reason: input.projectionReason,
				entitlements: snapshot,
			};
			if (input.purchaseKind === "consumable" && isInvalidatedStatus(input.purchaseStatus)) {
				payload.reversal = {
					provider: "apple",
					channel: input.channel,
					reason: "refund",
					transactionId: input.transactionId,
					originalTransactionId: input.originalTransactionId ?? input.transactionId,
					productKey: storeProduct.product_key,
					creditAmount: storeProduct.credit_amount,
					totalCreditAmount: storeProduct.credit_amount,
					quantity: 1,
					reversedAt: (input.invalidatedAt ?? input.purchasedAt).toISOString(),
				};
			} else if (input.purchaseKind === "consumable") {
				payload.purchase = {
					provider: "apple",
					channel: input.channel,
					purchaseKind: input.purchaseKind,
					transactionId: input.transactionId,
					productKey: storeProduct.product_key,
					creditAmount: storeProduct.credit_amount,
					purchasedAt: input.purchasedAt.toISOString(),
				};
			}

			await enqueueProjectionSyncJob(tx, {
				customerId: customer.id,
				idempotencyKey: input.projectionIdempotencyKey,
				reason: input.projectionReason,
				payload,
			});

			return processedStoreKitRecordingResult(customer.billing_account_id, snapshot);
		});
	}
}
