import { sql as drizzleSql } from "drizzle-orm";
import { NotFoundBillingError } from "../../billing/errors";
import type { ProjectionPayload, PurchaseKind, PurchaseStatus } from "../../billing/types";
import type { ProjectContext } from "../../projects/context";
import { RepositoryModule } from "./base";
import {
	materializeSubscriptionAllocations,
	materializeTopupAllocation,
	reversePurchaseAllocations,
	setPurchaseAllocationReversal,
} from "./catalog-allocations";
import {
	enqueueProjectionSyncJob,
	getEntitlementSnapshot,
	recomputeCustomerEntitlements,
} from "./entitlements";
import {
	ensureCustomer,
	findCustomerByProviderCustomer,
	findGoogleCustomerByPurchaseTokens,
	findGoogleCustomerBySubscriptionTokens,
	getGoogleStoreProduct,
	resolveProjectId,
	upsertProviderCustomer,
} from "./identities";
import {
	findGooglePurchaseInvalidationTarget,
	findGoogleVoidedTarget,
	maxBigInt,
	minBigInt,
	parseStripeAmountForComparison,
} from "./invalidations";
import { upsertPurchase, upsertSubscription } from "./mutations";
import { parseNullableNonnegativeInteger } from "./parsers";
import { executeOne, executeRows, jsonb } from "./query";
import { processedGooglePlayRecordingResult, skippedGooglePlayRecordingResult } from "./results";
import { recordStoreEventProcessingResult } from "./store-events";
import type {
	CustomerIdentityRow,
	GooglePlayRecordingResult,
	RecordGooglePurchaseProjectionInput,
	RecordGoogleVoidedPurchaseProjectionInput,
	StoreProductIdentityRow,
} from "./types";
import { isInvalidatedStatus, requireNonBlank, stripNulls } from "./validation";

export class GoogleBillingRepository extends RepositoryModule {
	async getOrCreateGoogleProviderCustomer(
		project: ProjectContext,
		billingAccountId: string,
		obfuscatedAccountId: string,
	): Promise<string> {
		requireNonBlank(billingAccountId, "p_billing_account_id");
		requireNonBlank(obfuscatedAccountId, "p_obfuscated_account_id");
		return await this.transaction(async (tx) => {
			const projectId = await resolveProjectId(tx, project);
			const customer = await ensureCustomer(tx, projectId, billingAccountId);
			await upsertProviderCustomer(tx, projectId, {
				customerId: customer.id,
				provider: "google",
				externalCustomerId: obfuscatedAccountId,
				identityError: `provider customer identity mismatch for Google Play obfuscated account id ${obfuscatedAccountId}`,
			});
			return obfuscatedAccountId;
		});
	}

	async getGoogleAndroidProductKind(
		project: ProjectContext,
		externalProductId: string,
	): Promise<"consumable" | "non_consumable"> {
		requireNonBlank(externalProductId, "p_external_product_id");
		return await this.transaction(async (tx) => {
			const projectId = await resolveProjectId(tx, project);
			const row = await executeOne<{ product_type: PurchaseKind }>(
				tx,
				drizzleSql`
				SELECT p.type AS product_type
				FROM store_products sp
				JOIN products p ON p.id = sp.product_id AND p.project_id = sp.project_id
				WHERE sp.project_id = ${projectId}
					AND sp.provider = 'google'
					AND sp.channel = 'android'
					AND sp.external_product_id = ${externalProductId}
					AND p.type IN ('consumable', 'non_consumable')
					AND sp.active = true
					AND p.active = true
				ORDER BY sp.external_price_id NULLS FIRST
				LIMIT 1
			`,
			);
			if (row === null) {
				throw new NotFoundBillingError(
					`Active Google Play one-time product ${externalProductId} was not found`,
					"BILLING_PRODUCT_NOT_FOUND",
				);
			}
			return row.product_type as "consumable" | "non_consumable";
		});
	}

	async recordGooglePurchaseAndEnqueueProjection(
		project: ProjectContext,
		input: RecordGooglePurchaseProjectionInput,
	): Promise<GooglePlayRecordingResult> {
		return await this.transaction(async (tx) => {
			const projectId = await resolveProjectId(tx, project);
			const quantity = input.quantity ?? 1;
			if (quantity <= 0) {
				throw new Error("p_quantity must be greater than zero");
			}
			if (input.refundableQuantity !== null && input.refundableQuantity < 0) {
				throw new Error("p_refundable_quantity must not be negative");
			}

			let customer: CustomerIdentityRow | null = null;
			let storeProduct: StoreProductIdentityRow | null = null;
			let subscriptionId: string | null = null;

			if (input.billingAccountId !== null) {
				customer = await ensureCustomer(tx, projectId, input.billingAccountId);
			}
			if (customer === null && input.obfuscatedAccountId !== null) {
				customer = await findCustomerByProviderCustomer(
					tx,
					projectId,
					"google",
					input.obfuscatedAccountId,
				);
			}
			if (customer === null) {
				customer = await findGoogleCustomerBySubscriptionTokens(tx, projectId, [
					input.purchaseToken,
					input.linkedPurchaseToken,
				]);
			}
			if (customer === null) {
				customer = await findGoogleCustomerByPurchaseTokens(tx, projectId, [
					input.purchaseToken,
					input.linkedPurchaseToken,
				]);
			}

			if (input.externalProductId === "unknown") {
				const target = await findGooglePurchaseInvalidationTarget(tx, projectId, input);
				if (target === null) {
					throw new Error(
						`Google Play store product could not be resolved for voided purchase token ${input.purchaseToken}`,
					);
				}
				customer = { id: target.customer_id, billing_account_id: target.billing_account_id };
				storeProduct = {
					id: target.store_product_id,
					product_id: target.product_id,
					product_key: target.product_key,
					product_type: target.product_type,
					credit_amount: target.credit_amount,
				};
				subscriptionId = target.subscription_id;
			}

			if (isInvalidatedStatus(input.purchaseStatus) && storeProduct === null) {
				const target = await findGooglePurchaseInvalidationTarget(tx, projectId, input);
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
						provider: "google",
						channel: "android",
						externalEventId: input.externalEventId,
						eventType: input.eventType,
						customerId: null,
						storeProductId: null,
						transactionId: input.purchaseToken,
						purchaseKind: input.purchaseKind,
						processingStatus: "skipped",
						processingError: "Google Play invalidation target could not be resolved",
						rawPayload: input.rawPayload,
						raiseIdentityMismatch: false,
						replayStoreEventId: input.replayStoreEventId ?? null,
					});
					return skippedGooglePlayRecordingResult();
				}
			}

			if (customer === null) {
				await recordStoreEventProcessingResult(tx, projectId, {
					provider: "google",
					channel: "android",
					externalEventId: input.externalEventId,
					eventType: input.eventType,
					customerId: null,
					storeProductId: null,
					transactionId: input.purchaseToken,
					purchaseKind: input.purchaseKind,
					processingStatus: "skipped",
					processingError: "Google Play customer could not be resolved",
					rawPayload: input.rawPayload,
					raiseIdentityMismatch: false,
					replayStoreEventId: input.replayStoreEventId ?? null,
				});
				return skippedGooglePlayRecordingResult();
			}

			if (input.obfuscatedAccountId !== null) {
				await upsertProviderCustomer(tx, projectId, {
					customerId: customer.id,
					provider: "google",
					externalCustomerId: input.obfuscatedAccountId,
					identityError: `provider customer identity mismatch for Google Play obfuscated account id ${input.obfuscatedAccountId}`,
				});
			}

			if (!isInvalidatedStatus(input.purchaseStatus) && input.externalProductId !== "unknown") {
				storeProduct = await getGoogleStoreProduct(tx, projectId, {
					externalProductId: input.externalProductId,
					externalPriceId: input.externalPriceId,
				});
				if (storeProduct === null) {
					throw new NotFoundBillingError(
						`active Google Play store product ${input.externalProductId} price ${input.externalPriceId} was not found`,
						"BILLING_PRODUCT_NOT_FOUND",
					);
				}
			}

			if (storeProduct === null) {
				throw new Error("Google Play store product could not be resolved");
			}
			if (storeProduct.product_type !== input.purchaseKind) {
				throw new Error(
					`purchase kind ${input.purchaseKind} does not match product type ${storeProduct.product_type}`,
				);
			}

			const storeEvent = await recordStoreEventProcessingResult(tx, projectId, {
				provider: "google",
				channel: "android",
				externalEventId: input.externalEventId,
				eventType: input.eventType,
				customerId: customer.id,
				storeProductId: storeProduct.id,
				transactionId: input.purchaseToken,
				purchaseKind: input.purchaseKind,
				processingStatus: "processed",
				processingError: null,
				rawPayload: input.rawPayload,
				raiseIdentityMismatch: true,
				replayStoreEventId: input.replayStoreEventId ?? null,
			});
			if (!storeEvent.applied) {
				return processedGooglePlayRecordingResult(
					customer.billing_account_id,
					await getEntitlementSnapshot(tx, projectId, customer.billing_account_id),
				);
			}

			if (input.linkedPurchaseToken !== null) {
				await executeRows(
					tx,
					drizzleSql`
					UPDATE subscriptions linked
					SET
						status = 'expired',
						expires_at = LEAST(COALESCE(linked.expires_at, now()), now()),
						auto_renew = false,
						updated_at = now()
					WHERE linked.project_id = ${projectId}
						AND linked.provider = 'google'
						AND linked.external_subscription_id = ${input.linkedPurchaseToken}
						AND linked.customer_id = ${customer.id}
				`,
				);
			}

			if (input.purchaseKind === "subscription") {
				subscriptionId = await upsertSubscription(tx, projectId, {
					customerId: customer.id,
					productId: storeProduct.product_id,
					storeProductId: storeProduct.id,
					provider: "google",
					channel: "android",
					externalSubscriptionId: input.purchaseToken,
					externalProductId: input.externalProductId,
					externalPriceId: input.externalPriceId,
					status: input.subscriptionStatus ?? "expired",
					startsAt: input.purchasedAt,
					expiresAt: input.expiresAt,
					autoRenew: input.autoRenew ?? false,
					latestTransactionId: input.orderId,
					rawState: stripNulls({
						purchaseToken: input.purchaseToken,
						linkedPurchaseToken: input.linkedPurchaseToken,
						orderId: input.orderId,
						acknowledgementState: input.acknowledgementState,
						payload: input.rawPayload,
					}),
					updateProduct: false,
					identityError: `subscription identity mismatch for provider google purchase token ${input.purchaseToken}`,
				});
				await materializeSubscriptionAllocations(tx, {
					projectId,
					customerId: customer.id,
					storeProductId: storeProduct.id,
					subscriptionId,
					status: input.subscriptionStatus ?? "expired",
					periodStartAt: input.purchasedAt,
					periodEndAt: input.expiresAt,
				});
			}

			const purchaseId = await upsertPurchase(tx, projectId, {
				customerId: customer.id,
				productId: storeProduct.product_id,
				storeProductId: storeProduct.id,
				subscriptionId,
				provider: "google",
				channel: "android",
				purchaseKind: input.purchaseKind,
				transactionId: input.purchaseToken,
				originalTransactionId: input.linkedPurchaseToken,
				status: input.purchaseStatus,
				purchasedAt: input.purchasedAt,
				invalidatedAt: input.invalidatedAt,
				invalidationReason: input.invalidationReason,
				rawPayload: input.rawPayload,
				identityError: `purchase token identity mismatch for provider google token ${input.purchaseToken}`,
			});
			if (input.purchaseKind === "consumable") {
				if (input.purchaseStatus === "completed") {
					await materializeTopupAllocation(tx, {
						projectId,
						customerId: customer.id,
						storeProductId: storeProduct.id,
						purchaseId,
						purchasedAt: input.purchasedAt,
						quantityMultiplier: quantity,
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
			if (input.purchaseKind === "consumable" && input.purchaseStatus === "completed") {
				payload.purchase = stripNulls({
					provider: "google",
					channel: "android",
					purchaseKind: input.purchaseKind,
					transactionId: input.purchaseToken,
					productKey: storeProduct.product_key,
					creditAmount: storeProduct.credit_amount,
					totalCreditAmount: storeProduct.credit_amount * quantity,
					quantity,
					refundableQuantity: input.refundableQuantity,
					purchasedAt: input.purchasedAt.toISOString(),
				}) as ProjectionPayload["purchase"];
			}

			await enqueueProjectionSyncJob(tx, {
				customerId: customer.id,
				idempotencyKey: input.projectionIdempotencyKey,
				reason: input.projectionReason,
				payload,
			});

			return processedGooglePlayRecordingResult(customer.billing_account_id, snapshot);
		});
	}

	async recordGoogleVoidedPurchaseAndEnqueueProjection(
		project: ProjectContext,
		input: RecordGoogleVoidedPurchaseProjectionInput,
	): Promise<GooglePlayRecordingResult> {
		return await this.transaction(async (tx) => {
			const projectId = await resolveProjectId(tx, project);
			const target = await findGoogleVoidedTarget(tx, projectId, input.purchaseToken);

			if (target === null) {
				await recordStoreEventProcessingResult(tx, projectId, {
					provider: "google",
					channel: "android",
					externalEventId: input.externalEventId,
					eventType: input.eventType,
					customerId: null,
					storeProductId: null,
					transactionId: input.purchaseToken,
					purchaseKind: null,
					processingStatus: "skipped",
					processingError: "Google Play voided purchase target could not be resolved",
					rawPayload: input.rawPayload,
					raiseIdentityMismatch: false,
					replayStoreEventId: input.replayStoreEventId ?? null,
				});
				return skippedGooglePlayRecordingResult();
			}
			if (target.purchase_id !== null) {
				const lockedPurchase = await executeOne<{
					purchase_status: PurchaseStatus;
					reversed_amount: number | string | null;
					reversed_credit_amount: number | string | null;
				}>(
					tx,
					drizzleSql`
						SELECT
							pu.status AS purchase_status,
							pu.reversed_amount,
							pu.reversed_credit_amount
						FROM purchases pu
						WHERE pu.id = ${target.purchase_id}
							AND pu.project_id = ${projectId}
							AND pu.customer_id = ${target.customer_id}
						FOR UPDATE
					`,
				);
				if (lockedPurchase === null) {
					throw new Error(`Google purchase ${target.purchase_id} disappeared while locking`);
				}
				target.purchase_status = lockedPurchase.purchase_status;
				target.reversed_amount = lockedPurchase.reversed_amount;
				target.reversed_credit_amount = lockedPurchase.reversed_credit_amount;
			}
			if (target.purchase_kind === "subscription" && input.refundType !== 1) {
				throw new Error(
					"Google quantity-based partial refunds are only valid for one-time purchases",
				);
			}
			if (
				target.purchase_kind === "consumable" &&
				(input.quantity === null ||
					input.quantity <= 0 ||
					!Number.isInteger(input.quantity) ||
					(input.refundType === 2 && input.refundableQuantity === null))
			) {
				throw new Error("Google consumable refund quantity state is required");
			}

			const storeEvent = await recordStoreEventProcessingResult(tx, projectId, {
				provider: "google",
				channel: "android",
				externalEventId: input.externalEventId,
				eventType: input.eventType,
				customerId: target.customer_id,
				storeProductId: target.store_product_id,
				transactionId: input.purchaseToken,
				purchaseKind: target.purchase_kind,
				processingStatus: "processed",
				processingError: null,
				rawPayload: input.rawPayload,
				raiseIdentityMismatch: true,
				replayStoreEventId: input.replayStoreEventId ?? null,
			});
			if (!storeEvent.applied) {
				return processedGooglePlayRecordingResult(
					target.billing_account_id,
					await getEntitlementSnapshot(tx, projectId, target.billing_account_id),
				);
			}

			if (target.subscription_id !== null && input.refundType === 1) {
				await executeRows(
					tx,
					drizzleSql`
					UPDATE subscriptions s
					SET
						status = 'expired',
						expires_at = LEAST(COALESCE(s.expires_at, ${input.eventTime.toISOString()}), ${input.eventTime.toISOString()}),
						auto_renew = false,
						raw_state = ${jsonb(input.rawPayload)},
						updated_at = now()
					WHERE s.id = ${target.subscription_id}
						AND s.project_id = ${projectId}
				`,
				);
			}

			let reversal: ProjectionPayload["reversal"];
			let shouldEnqueueProjection = target.purchase_kind !== "consumable";
			if (target.purchase_kind === "consumable") {
				const quantity = input.quantity as number;
				const refundableQuantity = input.refundableQuantity;
				if (
					refundableQuantity !== null &&
					(!Number.isInteger(refundableQuantity) ||
						refundableQuantity < 0 ||
						refundableQuantity > quantity)
				) {
					throw new Error("Google consumable refundable quantity is invalid");
				}

				const previousReversedQuantity = parseStripeAmountForComparison(
					target.reversed_amount ?? 0,
				);
				const previousReversedCreditAmount = parseNullableNonnegativeInteger(
					target.reversed_credit_amount,
					"Google prior reversed credit amount is invalid",
				);
				if (previousReversedQuantity === null || previousReversedCreditAmount === null) {
					throw new Error("Google prior consumable reversal state is invalid");
				}

				const purchaseWasGranted =
					target.purchase_status === "completed" || previousReversedQuantity > 0n;
				const authoritativeReversedQuantity =
					input.refundType === 1 ? quantity : quantity - (refundableQuantity as number);
				const nextReversedQuantity = purchaseWasGranted
					? minBigInt(
							BigInt(quantity),
							maxBigInt(previousReversedQuantity, BigInt(authoritativeReversedQuantity)),
						)
					: previousReversedQuantity;
				const nextReversedCreditAmount = Number(nextReversedQuantity) * target.credit_amount;
				const reversalQuantity = Number(nextReversedQuantity - previousReversedQuantity);
				const reversalCreditAmount = Math.max(
					0,
					nextReversedCreditAmount - previousReversedCreditAmount,
				);
				const fullyReversed = nextReversedQuantity >= BigInt(quantity);

				await executeRows(
					tx,
					drizzleSql`
						UPDATE purchases pu
						SET
							status = CASE WHEN ${fullyReversed} THEN 'voided' ELSE pu.status END,
							invalidated_at = CASE WHEN ${fullyReversed} THEN ${input.eventTime.toISOString()} ELSE pu.invalidated_at END,
							invalidation_reason = CASE WHEN ${fullyReversed} THEN 'voided_purchase' ELSE pu.invalidation_reason END,
							reversed_amount = ${nextReversedQuantity.toString()}::bigint,
							reversed_credit_amount = ${nextReversedCreditAmount},
							raw_payload = jsonb_set(
								jsonb_set(pu.raw_payload, '{googleVoidedPurchase}', ${jsonb(input.rawPayload)}, true),
								'{googleReversalState}',
								${jsonb({
									quantity,
									refundableQuantity,
									reversedQuantity: nextReversedQuantity.toString(),
									reversedCreditAmount: nextReversedCreditAmount,
								})},
								true
							),
							updated_at = now()
						WHERE pu.id = ${target.purchase_id}
							AND pu.project_id = ${projectId}
					`,
				);
				if (target.purchase_id !== null) {
					await setPurchaseAllocationReversal(tx, {
						projectId,
						purchaseId: target.purchase_id,
						reversedCreditAmount: nextReversedCreditAmount,
						totalCreditAmount: quantity * target.credit_amount,
						reversedAt: input.eventTime,
					});
				}

				if (reversalQuantity > 0 && reversalCreditAmount > 0) {
					shouldEnqueueProjection = true;
					reversal = {
						provider: "google",
						channel: "android",
						reason: "refund",
						transactionId: input.externalEventId,
						originalTransactionId: input.purchaseToken,
						productKey: target.product_key,
						creditAmount: reversalCreditAmount,
						totalCreditAmount: quantity * target.credit_amount,
						quantity: reversalQuantity,
						reversedAt: input.eventTime.toISOString(),
					};
				}
			} else if (input.refundType === 1) {
				await executeRows(
					tx,
					drizzleSql`
						UPDATE purchases pu
						SET
							status = 'voided',
							invalidated_at = ${input.eventTime.toISOString()},
							invalidation_reason = 'voided_purchase',
							raw_payload = jsonb_set(pu.raw_payload, '{googleVoidedPurchase}', ${jsonb(input.rawPayload)}, true),
							updated_at = now()
						WHERE pu.project_id = ${projectId}
							AND pu.provider = 'google'
							AND (
								pu.id = ${target.purchase_id}
								OR pu.transaction_id = ${input.purchaseToken}
							)
					`,
				);
			}

			const snapshot = await recomputeCustomerEntitlements(
				tx,
				projectId,
				target.billing_account_id,
			);
			if (shouldEnqueueProjection) {
				await enqueueProjectionSyncJob(tx, {
					customerId: target.customer_id,
					idempotencyKey: input.projectionIdempotencyKey,
					reason: input.projectionReason,
					payload: {
						billingAccountId: target.billing_account_id,
						reason: input.projectionReason,
						entitlements: snapshot,
						...(reversal === undefined ? {} : { reversal }),
					},
				});
			}

			return processedGooglePlayRecordingResult(target.billing_account_id, snapshot);
		});
	}
}
