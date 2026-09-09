import { z } from "@hono/zod-openapi";

/** Authored HTTP wire schemas. Update these with the handlers; OpenAPI is generated from them. */
export const getV1AdminCustomersSearchResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				customer: z.object({
					id: z.string(),
					projectKey: z.string(),
					billingAccountId: z.string(),
					email: z.union([z.null(), z.string()]),
					metadata: z.record(z.string(), z.unknown()),
					createdAt: z.string(),
					updatedAt: z.string(),
				}),
				matchType: z.enum([
					"billing_account_id",
					"customer_id",
					"provider_customer",
					"transaction_id",
					"original_transaction_id",
					"order_id",
					"entitlement_key",
				]),
				matchedValue: z.string(),
			}),
		),
		pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
	})
	.openapi("getV1AdminCustomersSearchResponse200");

export const getV1AdminCustomersByBillingAccountByBillingAccountIdResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			customer: z.object({
				id: z.string(),
				projectKey: z.string(),
				billingAccountId: z.string(),
				email: z.union([z.null(), z.string()]),
				metadata: z.record(z.string(), z.unknown()),
				createdAt: z.string(),
				updatedAt: z.string(),
			}),
			entitlementSnapshot: z.object({
				billingAccountId: z.string(),
				entitlements: z.array(
					z.object({
						key: z.string(),
						active: z.boolean(),
						expiresAt: z.union([z.null(), z.string()]),
						metadata: z.record(z.string(), z.unknown()),
					}),
				),
				generatedAt: z.string(),
			}),
			providerCustomers: z.array(
				z.object({
					provider: z.enum(["google", "apple", "stripe"]),
					externalCustomerId: z.string(),
					createdAt: z.string(),
				}),
			),
			activeSubscriptions: z.array(
				z.object({
					id: z.string(),
					customerId: z.string(),
					billingAccountId: z.string(),
					provider: z.enum(["google", "apple", "stripe"]),
					channel: z.enum(["ios", "android", "web"]),
					status: z.enum([
						"active",
						"expired",
						"revoked",
						"grace_period",
						"billing_retry",
						"cancelled",
						"refunded",
					]),
					externalSubscriptionId: z.string(),
					externalProductId: z.string(),
					externalPriceId: z.union([z.null(), z.string()]),
					productKey: z.string(),
					entitlementKey: z.string(),
					startsAt: z.string(),
					expiresAt: z.union([z.null(), z.string()]),
					autoRenew: z.boolean(),
					latestTransactionId: z.union([z.null(), z.string()]),
					providerReconciliationAttempts: z.number(),
					providerReconciliationError: z.union([z.null(), z.string()]),
					providerReconciliationNextAttemptAt: z.union([z.null(), z.string()]),
					providerReconciledAt: z.union([z.null(), z.string()]),
					needsAttention: z.boolean(),
					createdAt: z.string(),
					updatedAt: z.string(),
				}),
			),
			recentPurchases: z.array(
				z.object({
					id: z.string(),
					customerId: z.string(),
					billingAccountId: z.string(),
					provider: z.enum(["google", "apple", "stripe"]),
					channel: z.enum(["ios", "android", "web"]),
					purchaseKind: z.enum(["subscription", "consumable", "non_consumable"]),
					status: z.enum(["revoked", "refunded", "completed", "voided"]),
					transactionId: z.string(),
					originalTransactionId: z.union([z.null(), z.string()]),
					productKey: z.string(),
					entitlementKey: z.string(),
					externalProductId: z.string(),
					externalPriceId: z.union([z.null(), z.string()]),
					purchasedAt: z.string(),
					invalidatedAt: z.union([z.null(), z.string()]),
					invalidationReason: z.union([z.null(), z.string()]),
					createdAt: z.string(),
				}),
			),
			recentStoreEvents: z.array(
				z.object({
					id: z.string(),
					provider: z.enum(["google", "apple", "stripe"]),
					channel: z.enum(["ios", "android", "web"]),
					externalEventId: z.union([z.null(), z.string()]),
					eventType: z.string(),
					customerId: z.union([z.null(), z.string()]),
					billingAccountId: z.union([z.null(), z.string()]),
					storeProductId: z.union([z.null(), z.string()]),
					transactionId: z.union([z.null(), z.string()]),
					purchaseKind: z.union([
						z.null(),
						z.literal("subscription"),
						z.literal("consumable"),
						z.literal("non_consumable"),
					]),
					processingStatus: z.enum(["pending", "failed", "processing", "processed", "skipped"]),
					processingError: z.union([z.null(), z.string()]),
					attempts: z.number(),
					nextAttemptAt: z.union([z.null(), z.string()]),
					processedAt: z.union([z.null(), z.string()]),
					createdAt: z.string(),
					updatedAt: z.string(),
					rawPayload: z.record(z.string(), z.unknown()).optional(),
				}),
			),
			recentProjectionJobs: z.array(
				z.object({
					id: z.string(),
					customerId: z.string(),
					billingAccountId: z.string(),
					idempotencyKey: z.string(),
					reason: z.enum([
						"purchase_verified",
						"provider_webhook",
						"expiry_reconciliation",
						"provider_reconciliation",
						"usage_changed",
					]),
					status: z.enum(["pending", "succeeded", "failed", "processing"]),
					attempts: z.number(),
					lastError: z.union([z.null(), z.string()]),
					nextAttemptAt: z.union([z.null(), z.string()]),
					lockedAt: z.union([z.null(), z.string()]),
					lockedBy: z.union([z.null(), z.string()]),
					payload: z.union([
						z.null(),
						z.object({
							billingAccountId: z.string(),
							generatedAt: z.string(),
							entitlements: z.object({
								billingAccountId: z.string(),
								entitlements: z.array(
									z.object({
										key: z.string(),
										active: z.boolean(),
										expiresAt: z.union([z.null(), z.string()]),
										metadata: z.record(z.string(), z.unknown()),
									}),
								),
								generatedAt: z.string(),
							}),
							balances: z.array(
								z.object({
									featureKey: z.string(),
									unit: z.string(),
									available: z.string(),
									held: z.string(),
									periodEndsAt: z.union([z.null(), z.string()]),
								}),
							),
							reason: z.enum([
								"purchase_verified",
								"provider_webhook",
								"expiry_reconciliation",
								"provider_reconciliation",
								"usage_changed",
							]),
							sequence: z.number().optional(),
							purchase: z
								.object({
									provider: z.enum(["google", "apple", "stripe"]),
									channel: z.enum(["ios", "android", "web"]),
									purchaseKind: z.enum(["subscription", "consumable", "non_consumable"]),
									transactionId: z.string(),
									productKey: z.string(),
									creditAmount: z.number(),
									totalCreditAmount: z.number().optional(),
									quantity: z.number().optional(),
									refundableQuantity: z.number().optional(),
									purchasedAt: z.string(),
								})
								.optional(),
							reversal: z
								.object({
									provider: z.enum(["google", "apple", "stripe"]),
									channel: z.enum(["ios", "android", "web"]),
									reason: z.enum(["refund", "dispute"]),
									transactionId: z.string(),
									originalTransactionId: z.string(),
									productKey: z.string(),
									creditAmount: z.number(),
									totalCreditAmount: z.number().optional(),
									quantity: z.number().optional(),
									reversedAt: z.string(),
								})
								.optional(),
						}),
					]),
					createdAt: z.string(),
					updatedAt: z.string(),
				}),
			),
		}),
	})
	.openapi("getV1AdminCustomersByBillingAccountByBillingAccountIdResponse200");

export const getV1AdminCustomersByCustomerIdPurchasesResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				customerId: z.string(),
				billingAccountId: z.string(),
				provider: z.enum(["google", "apple", "stripe"]),
				channel: z.enum(["ios", "android", "web"]),
				purchaseKind: z.enum(["subscription", "consumable", "non_consumable"]),
				status: z.enum(["revoked", "refunded", "completed", "voided"]),
				transactionId: z.string(),
				originalTransactionId: z.union([z.null(), z.string()]),
				productKey: z.string(),
				entitlementKey: z.string(),
				externalProductId: z.string(),
				externalPriceId: z.union([z.null(), z.string()]),
				purchasedAt: z.string(),
				invalidatedAt: z.union([z.null(), z.string()]),
				invalidationReason: z.union([z.null(), z.string()]),
				createdAt: z.string(),
			}),
		),
		pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
	})
	.openapi("getV1AdminCustomersByCustomerIdPurchasesResponse200");

export const getV1AdminCustomersByCustomerIdSubscriptionsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				customerId: z.string(),
				billingAccountId: z.string(),
				provider: z.enum(["google", "apple", "stripe"]),
				channel: z.enum(["ios", "android", "web"]),
				status: z.enum([
					"active",
					"expired",
					"revoked",
					"grace_period",
					"billing_retry",
					"cancelled",
					"refunded",
				]),
				externalSubscriptionId: z.string(),
				externalProductId: z.string(),
				externalPriceId: z.union([z.null(), z.string()]),
				productKey: z.string(),
				entitlementKey: z.string(),
				startsAt: z.string(),
				expiresAt: z.union([z.null(), z.string()]),
				autoRenew: z.boolean(),
				latestTransactionId: z.union([z.null(), z.string()]),
				providerReconciliationAttempts: z.number(),
				providerReconciliationError: z.union([z.null(), z.string()]),
				providerReconciliationNextAttemptAt: z.union([z.null(), z.string()]),
				providerReconciledAt: z.union([z.null(), z.string()]),
				needsAttention: z.boolean(),
				createdAt: z.string(),
				updatedAt: z.string(),
			}),
		),
		pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
	})
	.openapi("getV1AdminCustomersByCustomerIdSubscriptionsResponse200");

export const getV1AdminCustomersByCustomerIdStoreEventsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				provider: z.enum(["google", "apple", "stripe"]),
				channel: z.enum(["ios", "android", "web"]),
				externalEventId: z.union([z.null(), z.string()]),
				eventType: z.string(),
				customerId: z.union([z.null(), z.string()]),
				billingAccountId: z.union([z.null(), z.string()]),
				storeProductId: z.union([z.null(), z.string()]),
				transactionId: z.union([z.null(), z.string()]),
				purchaseKind: z.union([
					z.null(),
					z.literal("subscription"),
					z.literal("consumable"),
					z.literal("non_consumable"),
				]),
				processingStatus: z.enum(["pending", "failed", "processing", "processed", "skipped"]),
				processingError: z.union([z.null(), z.string()]),
				attempts: z.number(),
				nextAttemptAt: z.union([z.null(), z.string()]),
				processedAt: z.union([z.null(), z.string()]),
				createdAt: z.string(),
				updatedAt: z.string(),
				rawPayload: z.record(z.string(), z.unknown()).optional(),
			}),
		),
		pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
	})
	.openapi("getV1AdminCustomersByCustomerIdStoreEventsResponse200");

export const getV1AdminCustomersByCustomerIdProjectionJobsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				customerId: z.string(),
				billingAccountId: z.string(),
				idempotencyKey: z.string(),
				reason: z.enum([
					"purchase_verified",
					"provider_webhook",
					"expiry_reconciliation",
					"provider_reconciliation",
					"usage_changed",
				]),
				status: z.enum(["pending", "succeeded", "failed", "processing"]),
				attempts: z.number(),
				lastError: z.union([z.null(), z.string()]),
				nextAttemptAt: z.union([z.null(), z.string()]),
				lockedAt: z.union([z.null(), z.string()]),
				lockedBy: z.union([z.null(), z.string()]),
				payload: z.union([
					z.null(),
					z.object({
						billingAccountId: z.string(),
						generatedAt: z.string(),
						entitlements: z.object({
							billingAccountId: z.string(),
							entitlements: z.array(
								z.object({
									key: z.string(),
									active: z.boolean(),
									expiresAt: z.union([z.null(), z.string()]),
									metadata: z.record(z.string(), z.unknown()),
								}),
							),
							generatedAt: z.string(),
						}),
						balances: z.array(
							z.object({
								featureKey: z.string(),
								unit: z.string(),
								available: z.string(),
								held: z.string(),
								periodEndsAt: z.union([z.null(), z.string()]),
							}),
						),
						reason: z.enum([
							"purchase_verified",
							"provider_webhook",
							"expiry_reconciliation",
							"provider_reconciliation",
							"usage_changed",
						]),
						sequence: z.number().optional(),
						purchase: z
							.object({
								provider: z.enum(["google", "apple", "stripe"]),
								channel: z.enum(["ios", "android", "web"]),
								purchaseKind: z.enum(["subscription", "consumable", "non_consumable"]),
								transactionId: z.string(),
								productKey: z.string(),
								creditAmount: z.number(),
								totalCreditAmount: z.number().optional(),
								quantity: z.number().optional(),
								refundableQuantity: z.number().optional(),
								purchasedAt: z.string(),
							})
							.optional(),
						reversal: z
							.object({
								provider: z.enum(["google", "apple", "stripe"]),
								channel: z.enum(["ios", "android", "web"]),
								reason: z.enum(["refund", "dispute"]),
								transactionId: z.string(),
								originalTransactionId: z.string(),
								productKey: z.string(),
								creditAmount: z.number(),
								totalCreditAmount: z.number().optional(),
								quantity: z.number().optional(),
								reversedAt: z.string(),
							})
							.optional(),
					}),
				]),
				createdAt: z.string(),
				updatedAt: z.string(),
			}),
		),
		pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
	})
	.openapi("getV1AdminCustomersByCustomerIdProjectionJobsResponse200");

export const getV1AdminCustomersByCustomerIdResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			customer: z.object({
				id: z.string(),
				projectKey: z.string(),
				billingAccountId: z.string(),
				email: z.union([z.null(), z.string()]),
				metadata: z.record(z.string(), z.unknown()),
				createdAt: z.string(),
				updatedAt: z.string(),
			}),
			entitlementSnapshot: z.object({
				billingAccountId: z.string(),
				entitlements: z.array(
					z.object({
						key: z.string(),
						active: z.boolean(),
						expiresAt: z.union([z.null(), z.string()]),
						metadata: z.record(z.string(), z.unknown()),
					}),
				),
				generatedAt: z.string(),
			}),
			providerCustomers: z.array(
				z.object({
					provider: z.enum(["google", "apple", "stripe"]),
					externalCustomerId: z.string(),
					createdAt: z.string(),
				}),
			),
			activeSubscriptions: z.array(
				z.object({
					id: z.string(),
					customerId: z.string(),
					billingAccountId: z.string(),
					provider: z.enum(["google", "apple", "stripe"]),
					channel: z.enum(["ios", "android", "web"]),
					status: z.enum([
						"active",
						"expired",
						"revoked",
						"grace_period",
						"billing_retry",
						"cancelled",
						"refunded",
					]),
					externalSubscriptionId: z.string(),
					externalProductId: z.string(),
					externalPriceId: z.union([z.null(), z.string()]),
					productKey: z.string(),
					entitlementKey: z.string(),
					startsAt: z.string(),
					expiresAt: z.union([z.null(), z.string()]),
					autoRenew: z.boolean(),
					latestTransactionId: z.union([z.null(), z.string()]),
					providerReconciliationAttempts: z.number(),
					providerReconciliationError: z.union([z.null(), z.string()]),
					providerReconciliationNextAttemptAt: z.union([z.null(), z.string()]),
					providerReconciledAt: z.union([z.null(), z.string()]),
					needsAttention: z.boolean(),
					createdAt: z.string(),
					updatedAt: z.string(),
				}),
			),
			recentPurchases: z.array(
				z.object({
					id: z.string(),
					customerId: z.string(),
					billingAccountId: z.string(),
					provider: z.enum(["google", "apple", "stripe"]),
					channel: z.enum(["ios", "android", "web"]),
					purchaseKind: z.enum(["subscription", "consumable", "non_consumable"]),
					status: z.enum(["revoked", "refunded", "completed", "voided"]),
					transactionId: z.string(),
					originalTransactionId: z.union([z.null(), z.string()]),
					productKey: z.string(),
					entitlementKey: z.string(),
					externalProductId: z.string(),
					externalPriceId: z.union([z.null(), z.string()]),
					purchasedAt: z.string(),
					invalidatedAt: z.union([z.null(), z.string()]),
					invalidationReason: z.union([z.null(), z.string()]),
					createdAt: z.string(),
				}),
			),
			recentStoreEvents: z.array(
				z.object({
					id: z.string(),
					provider: z.enum(["google", "apple", "stripe"]),
					channel: z.enum(["ios", "android", "web"]),
					externalEventId: z.union([z.null(), z.string()]),
					eventType: z.string(),
					customerId: z.union([z.null(), z.string()]),
					billingAccountId: z.union([z.null(), z.string()]),
					storeProductId: z.union([z.null(), z.string()]),
					transactionId: z.union([z.null(), z.string()]),
					purchaseKind: z.union([
						z.null(),
						z.literal("subscription"),
						z.literal("consumable"),
						z.literal("non_consumable"),
					]),
					processingStatus: z.enum(["pending", "failed", "processing", "processed", "skipped"]),
					processingError: z.union([z.null(), z.string()]),
					attempts: z.number(),
					nextAttemptAt: z.union([z.null(), z.string()]),
					processedAt: z.union([z.null(), z.string()]),
					createdAt: z.string(),
					updatedAt: z.string(),
					rawPayload: z.record(z.string(), z.unknown()).optional(),
				}),
			),
			recentProjectionJobs: z.array(
				z.object({
					id: z.string(),
					customerId: z.string(),
					billingAccountId: z.string(),
					idempotencyKey: z.string(),
					reason: z.enum([
						"purchase_verified",
						"provider_webhook",
						"expiry_reconciliation",
						"provider_reconciliation",
						"usage_changed",
					]),
					status: z.enum(["pending", "succeeded", "failed", "processing"]),
					attempts: z.number(),
					lastError: z.union([z.null(), z.string()]),
					nextAttemptAt: z.union([z.null(), z.string()]),
					lockedAt: z.union([z.null(), z.string()]),
					lockedBy: z.union([z.null(), z.string()]),
					payload: z.union([
						z.null(),
						z.object({
							billingAccountId: z.string(),
							generatedAt: z.string(),
							entitlements: z.object({
								billingAccountId: z.string(),
								entitlements: z.array(
									z.object({
										key: z.string(),
										active: z.boolean(),
										expiresAt: z.union([z.null(), z.string()]),
										metadata: z.record(z.string(), z.unknown()),
									}),
								),
								generatedAt: z.string(),
							}),
							balances: z.array(
								z.object({
									featureKey: z.string(),
									unit: z.string(),
									available: z.string(),
									held: z.string(),
									periodEndsAt: z.union([z.null(), z.string()]),
								}),
							),
							reason: z.enum([
								"purchase_verified",
								"provider_webhook",
								"expiry_reconciliation",
								"provider_reconciliation",
								"usage_changed",
							]),
							sequence: z.number().optional(),
							purchase: z
								.object({
									provider: z.enum(["google", "apple", "stripe"]),
									channel: z.enum(["ios", "android", "web"]),
									purchaseKind: z.enum(["subscription", "consumable", "non_consumable"]),
									transactionId: z.string(),
									productKey: z.string(),
									creditAmount: z.number(),
									totalCreditAmount: z.number().optional(),
									quantity: z.number().optional(),
									refundableQuantity: z.number().optional(),
									purchasedAt: z.string(),
								})
								.optional(),
							reversal: z
								.object({
									provider: z.enum(["google", "apple", "stripe"]),
									channel: z.enum(["ios", "android", "web"]),
									reason: z.enum(["refund", "dispute"]),
									transactionId: z.string(),
									originalTransactionId: z.string(),
									productKey: z.string(),
									creditAmount: z.number(),
									totalCreditAmount: z.number().optional(),
									quantity: z.number().optional(),
									reversedAt: z.string(),
								})
								.optional(),
						}),
					]),
					createdAt: z.string(),
					updatedAt: z.string(),
				}),
			),
		}),
	})
	.openapi("getV1AdminCustomersByCustomerIdResponse200");

export const getV1AdminPurchasesResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				customerId: z.string(),
				billingAccountId: z.string(),
				provider: z.enum(["google", "apple", "stripe"]),
				channel: z.enum(["ios", "android", "web"]),
				purchaseKind: z.enum(["subscription", "consumable", "non_consumable"]),
				status: z.enum(["revoked", "refunded", "completed", "voided"]),
				transactionId: z.string(),
				originalTransactionId: z.union([z.null(), z.string()]),
				productKey: z.string(),
				entitlementKey: z.string(),
				externalProductId: z.string(),
				externalPriceId: z.union([z.null(), z.string()]),
				purchasedAt: z.string(),
				invalidatedAt: z.union([z.null(), z.string()]),
				invalidationReason: z.union([z.null(), z.string()]),
				createdAt: z.string(),
			}),
		),
		pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
	})
	.openapi("getV1AdminPurchasesResponse200");

export const getV1AdminSubscriptionsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				customerId: z.string(),
				billingAccountId: z.string(),
				provider: z.enum(["google", "apple", "stripe"]),
				channel: z.enum(["ios", "android", "web"]),
				status: z.enum([
					"active",
					"expired",
					"revoked",
					"grace_period",
					"billing_retry",
					"cancelled",
					"refunded",
				]),
				externalSubscriptionId: z.string(),
				externalProductId: z.string(),
				externalPriceId: z.union([z.null(), z.string()]),
				productKey: z.string(),
				entitlementKey: z.string(),
				startsAt: z.string(),
				expiresAt: z.union([z.null(), z.string()]),
				autoRenew: z.boolean(),
				latestTransactionId: z.union([z.null(), z.string()]),
				providerReconciliationAttempts: z.number(),
				providerReconciliationError: z.union([z.null(), z.string()]),
				providerReconciliationNextAttemptAt: z.union([z.null(), z.string()]),
				providerReconciledAt: z.union([z.null(), z.string()]),
				needsAttention: z.boolean(),
				createdAt: z.string(),
				updatedAt: z.string(),
			}),
		),
		pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
	})
	.openapi("getV1AdminSubscriptionsResponse200");

export const getV1AdminStoreEventsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				provider: z.enum(["google", "apple", "stripe"]),
				channel: z.enum(["ios", "android", "web"]),
				externalEventId: z.union([z.null(), z.string()]),
				eventType: z.string(),
				customerId: z.union([z.null(), z.string()]),
				billingAccountId: z.union([z.null(), z.string()]),
				storeProductId: z.union([z.null(), z.string()]),
				transactionId: z.union([z.null(), z.string()]),
				purchaseKind: z.union([
					z.null(),
					z.literal("subscription"),
					z.literal("consumable"),
					z.literal("non_consumable"),
				]),
				processingStatus: z.enum(["pending", "failed", "processing", "processed", "skipped"]),
				processingError: z.union([z.null(), z.string()]),
				attempts: z.number(),
				nextAttemptAt: z.union([z.null(), z.string()]),
				processedAt: z.union([z.null(), z.string()]),
				createdAt: z.string(),
				updatedAt: z.string(),
				rawPayload: z.record(z.string(), z.unknown()).optional(),
			}),
		),
		pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
	})
	.openapi("getV1AdminStoreEventsResponse200");

export const getV1AdminStoreEventsByEventIdResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			id: z.string(),
			provider: z.enum(["google", "apple", "stripe"]),
			channel: z.enum(["ios", "android", "web"]),
			externalEventId: z.union([z.null(), z.string()]),
			eventType: z.string(),
			customerId: z.union([z.null(), z.string()]),
			billingAccountId: z.union([z.null(), z.string()]),
			storeProductId: z.union([z.null(), z.string()]),
			transactionId: z.union([z.null(), z.string()]),
			purchaseKind: z.union([
				z.null(),
				z.literal("subscription"),
				z.literal("consumable"),
				z.literal("non_consumable"),
			]),
			processingStatus: z.enum(["pending", "failed", "processing", "processed", "skipped"]),
			processingError: z.union([z.null(), z.string()]),
			attempts: z.number(),
			nextAttemptAt: z.union([z.null(), z.string()]),
			processedAt: z.union([z.null(), z.string()]),
			createdAt: z.string(),
			updatedAt: z.string(),
			rawPayload: z.record(z.string(), z.unknown()).optional(),
		}),
	})
	.openapi("getV1AdminStoreEventsByEventIdResponse200");

export const getV1AdminProjectionJobsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				customerId: z.string(),
				billingAccountId: z.string(),
				idempotencyKey: z.string(),
				reason: z.enum([
					"purchase_verified",
					"provider_webhook",
					"expiry_reconciliation",
					"provider_reconciliation",
					"usage_changed",
				]),
				status: z.enum(["pending", "succeeded", "failed", "processing"]),
				attempts: z.number(),
				lastError: z.union([z.null(), z.string()]),
				nextAttemptAt: z.union([z.null(), z.string()]),
				lockedAt: z.union([z.null(), z.string()]),
				lockedBy: z.union([z.null(), z.string()]),
				payload: z.union([
					z.null(),
					z.object({
						billingAccountId: z.string(),
						generatedAt: z.string(),
						entitlements: z.object({
							billingAccountId: z.string(),
							entitlements: z.array(
								z.object({
									key: z.string(),
									active: z.boolean(),
									expiresAt: z.union([z.null(), z.string()]),
									metadata: z.record(z.string(), z.unknown()),
								}),
							),
							generatedAt: z.string(),
						}),
						balances: z.array(
							z.object({
								featureKey: z.string(),
								unit: z.string(),
								available: z.string(),
								held: z.string(),
								periodEndsAt: z.union([z.null(), z.string()]),
							}),
						),
						reason: z.enum([
							"purchase_verified",
							"provider_webhook",
							"expiry_reconciliation",
							"provider_reconciliation",
							"usage_changed",
						]),
						sequence: z.number().optional(),
						purchase: z
							.object({
								provider: z.enum(["google", "apple", "stripe"]),
								channel: z.enum(["ios", "android", "web"]),
								purchaseKind: z.enum(["subscription", "consumable", "non_consumable"]),
								transactionId: z.string(),
								productKey: z.string(),
								creditAmount: z.number(),
								totalCreditAmount: z.number().optional(),
								quantity: z.number().optional(),
								refundableQuantity: z.number().optional(),
								purchasedAt: z.string(),
							})
							.optional(),
						reversal: z
							.object({
								provider: z.enum(["google", "apple", "stripe"]),
								channel: z.enum(["ios", "android", "web"]),
								reason: z.enum(["refund", "dispute"]),
								transactionId: z.string(),
								originalTransactionId: z.string(),
								productKey: z.string(),
								creditAmount: z.number(),
								totalCreditAmount: z.number().optional(),
								quantity: z.number().optional(),
								reversedAt: z.string(),
							})
							.optional(),
					}),
				]),
				createdAt: z.string(),
				updatedAt: z.string(),
			}),
		),
		pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
	})
	.openapi("getV1AdminProjectionJobsResponse200");

export const getV1AdminCatalogProductsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				key: z.string(),
				entitlementKey: z.string(),
				creditAmount: z.number(),
				name: z.union([z.null(), z.string()]),
				description: z.union([z.null(), z.string()]),
				type: z.enum(["subscription", "consumable", "non_consumable"]),
				active: z.boolean(),
				metadata: z.record(z.string(), z.unknown()),
				createdAt: z.string(),
				updatedAt: z.string(),
			}),
		),
		pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
	})
	.openapi("getV1AdminCatalogProductsResponse200");

export const getV1AdminStatsSummaryResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			storeEvents: z.object({
				pending: z.number(),
				failed: z.number(),
				processing: z.number(),
				processed: z.number(),
				skipped: z.number(),
			}),
			projectionJobs: z.object({
				pending: z.number(),
				succeeded: z.number(),
				failed: z.number(),
				processing: z.number(),
			}),
			subscriptions: z.object({
				active: z.number(),
				gracePeriod: z.number(),
				needsAttention: z.number(),
			}),
			providers: z.object({
				google: z.object({ lastEventAt: z.union([z.null(), z.string()]) }).optional(),
				apple: z.object({ lastEventAt: z.union([z.null(), z.string()]) }).optional(),
				stripe: z.object({ lastEventAt: z.union([z.null(), z.string()]) }).optional(),
			}),
			recentStoreEvents: z.array(
				z.object({
					id: z.string(),
					provider: z.enum(["google", "apple", "stripe"]),
					channel: z.enum(["ios", "android", "web"]),
					externalEventId: z.union([z.null(), z.string()]),
					eventType: z.string(),
					customerId: z.union([z.null(), z.string()]),
					billingAccountId: z.union([z.null(), z.string()]),
					storeProductId: z.union([z.null(), z.string()]),
					transactionId: z.union([z.null(), z.string()]),
					purchaseKind: z.union([
						z.null(),
						z.literal("subscription"),
						z.literal("consumable"),
						z.literal("non_consumable"),
					]),
					processingStatus: z.enum(["pending", "failed", "processing", "processed", "skipped"]),
					processingError: z.union([z.null(), z.string()]),
					attempts: z.number(),
					nextAttemptAt: z.union([z.null(), z.string()]),
					processedAt: z.union([z.null(), z.string()]),
					createdAt: z.string(),
					updatedAt: z.string(),
					rawPayload: z.record(z.string(), z.unknown()).optional(),
				}),
			),
		}),
	})
	.openapi("getV1AdminStatsSummaryResponse200");

export const getV1AdminCatalogStoreProductsResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.array(
			z.object({
				id: z.string(),
				productId: z.string(),
				productKey: z.string(),
				provider: z.enum(["google", "apple", "stripe"]),
				channel: z.enum(["ios", "android", "web"]),
				externalProductId: z.string(),
				active: z.boolean(),
				metadata: z.record(z.string(), z.unknown()),
				createdAt: z.string(),
				updatedAt: z.string(),
				externalPriceId: z.union([z.null(), z.string()]),
				billingPeriod: z.string(),
				currency: z.union([z.null(), z.string()]),
				priceAmount: z.union([z.null(), z.number()]),
			}),
		),
		pagination: z.object({ nextCursor: z.union([z.null(), z.string()]) }),
	})
	.openapi("getV1AdminCatalogStoreProductsResponse200");

export const postV1AdminStoreEventsByEventIdReplayResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			eventId: z.string(),
			status: z.enum(["failed", "retryable", "processed", "ignored"]),
		}),
	})
	.openapi("postV1AdminStoreEventsByEventIdReplayResponse200");

export const postV1AdminReconciliationSubscriptionsRunResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({
			outcome: z.enum(["succeeded", "failed", "partial"]),
			expiredSubscriptions: z.number(),
			affectedCustomers: z.number(),
			providerClaimed: z.number(),
			providerProcessed: z.number(),
			providerSkipped: z.number(),
			providerFailed: z.number(),
		}),
	})
	.openapi("postV1AdminReconciliationSubscriptionsRunResponse200");

export const postV1AdminProjectionJobsByJobIdRetryResponse200Schema = z
	.object({
		success: z.literal(true),
		data: z.object({ jobId: z.string(), status: z.literal("pending") }),
	})
	.openapi("postV1AdminProjectionJobsByJobIdRetryResponse200");
