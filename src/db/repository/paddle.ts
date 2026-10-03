import { sql } from "drizzle-orm";
import { z } from "zod";
import { BillingError } from "../../billing/errors";
import type { ProjectInstanceContext } from "../../projects/context";
import { type PaddlePriceBinding, paddlePriceBindingSchema } from "../../providers/paddle/catalog";
import type { NormalizedPaddleEvent } from "../../providers/paddle/normalizer";
import { type PaddleCommercialTarget, paddlePlanPinSchema } from "../../providers/paddle/plan";
import type { PaddleSubscription, PaddleTransaction } from "../../providers/paddle/schemas";
import { RepositoryModule } from "./base";
import { materializeSubscriptionAllocations } from "./catalog-allocations";
import { enqueueProjectionSyncJob, recomputeCustomerEntitlements } from "./entitlements";
import { ensureCustomer, upsertProviderCustomer } from "./identities";
import { upsertPurchase, upsertSubscription } from "./mutations";
import { paddlePlanTarget } from "./paddle-plans";
import { executeOne } from "./query";
import { recordStoreEventProcessingResult } from "./store-events";
import type { StoreProductIdentityRow } from "./types";

const correlationSchema = z.object({
	quotum: z.object({ operationId: z.uuid(), requestHash: z.string() }),
});
type SubscriptionEvent = Extract<NormalizedPaddleEvent, { kind: "subscription" }>;

/** Persists the initial fixed-price sandbox scope through the normal entitlement/projection path. */
export class PaddleBillingRepository extends RepositoryModule {
	async operationId(
		project: ProjectInstanceContext,
		billingAccountId: string,
		idempotencyKey: string,
		accountIdentity: string,
	) {
		const row = await executeOne<{ id: string }>(
			this.database,
			sql`SELECT id FROM provider_operations WHERE project_id = ${project.projectInstanceId} AND billing_account_id = ${billingAccountId} AND provider = 'paddle' AND provider_account_id = ${accountIdentity} AND idempotency_key = ${idempotencyKey} AND operation = 'checkout.hosted'`,
		);
		return row?.id ?? null;
	}
	plan(project: ProjectInstanceContext, billingAccountId: string, planKey: string) {
		return paddlePlanTarget(this.database, project.projectInstanceId, billingAccountId, planKey);
	}
	async product(
		project: ProjectInstanceContext,
		productKey: string,
	): Promise<PaddleCommercialTarget> {
		const row = await executeOne<{ id: string; name: string }>(
			this.database,
			sql`
			SELECT sp.id, p.name FROM store_products sp JOIN products p ON p.project_id = sp.project_id AND p.id = sp.product_id
			WHERE sp.project_id = ${project.projectInstanceId} AND sp.provider = 'paddle' AND sp.channel = 'web' AND sp.active = true AND p.active = true AND p.key = ${productKey} AND p.type = 'subscription'
		`,
		);
		if (!row) mismatch();
		return {
			productKey,
			name: row.name,
			priceKey: productKey,
			storeProductId: row.id,
			binding: await this.binding(project, productKey),
			plan: null,
		};
	}
	async customer(
		project: ProjectInstanceContext,
		billingAccountId: string,
		providerAccountId: string,
	): Promise<string | null> {
		const row = await executeOne<{ external_customer_id: string }>(
			this.database,
			sql`
			SELECT pc.external_customer_id FROM provider_customers pc JOIN customers c
			ON c.id = pc.customer_id AND c.project_id = pc.project_id
			WHERE pc.project_id = ${project.projectInstanceId} AND c.billing_account_id = ${billingAccountId}
			AND pc.provider = 'paddle' AND pc.provider_account_id = ${providerAccountId}
		`,
		);
		return row?.external_customer_id ?? null;
	}
	async binding(project: ProjectInstanceContext, productKey: string) {
		const row = await executeOne<{
			external_product_id: string;
			external_price_id: string;
			currency: string;
			price_amount: number;
			billing_period: string;
			billing_period_count: number;
		}>(
			this.database,
			sql`
			SELECT sp.external_product_id, sp.external_price_id, sp.currency, sp.price_amount, sp.billing_period, sp.billing_period_count
			FROM store_products sp JOIN products p ON p.id = sp.product_id AND p.project_id = sp.project_id
			WHERE sp.project_id = ${project.projectInstanceId} AND sp.provider = 'paddle' AND sp.channel = 'web'
			AND sp.active = true AND p.active = true AND p.type = 'subscription' AND p.key = ${productKey}
		`,
		);
		if (!row) mismatch();
		return paddlePriceBindingSchema.parse({
			priceId: row.external_price_id,
			productId: row.external_product_id,
			productType: "subscription",
			currency: row.currency?.toUpperCase(),
			unitAmountMinor: String(row.price_amount),
			billingCycle: { interval: row.billing_period, frequency: row.billing_period_count },
			trialPeriod: null,
			quantity: 1,
		});
	}
	async linkCustomer(
		project: ProjectInstanceContext,
		input: {
			billingAccountId: string;
			customerId: string;
			providerAccountId: string;
		},
	): Promise<void> {
		await this.transaction(async (tx) => {
			const customer = await ensureCustomer(tx, project.projectInstanceId, input.billingAccountId);
			const existing = await executeOne<{
				external_customer_id: string;
				provider_account_id: string | null;
			}>(
				tx,
				sql`
				SELECT external_customer_id, provider_account_id FROM provider_customers
				WHERE project_id = ${project.projectInstanceId} AND customer_id = ${customer.id} AND provider = 'paddle'
			`,
			);
			if (
				existing &&
				(existing.external_customer_id !== input.customerId ||
					existing.provider_account_id !== input.providerAccountId)
			)
				mismatch();
			await upsertProviderCustomer(tx, project.projectInstanceId, {
				customerId: customer.id,
				provider: "paddle",
				externalCustomerId: input.customerId,
				providerAccountId: input.providerAccountId,
				identityError: "Paddle customer identity mismatch",
			});
		});
	}

	async record(
		project: ProjectInstanceContext,
		input: {
			providerAccountId: string;
			normalized: SubscriptionEvent;
			transaction?: PaddleTransaction;
			externalEventId: string;
			eventType: string;
			rawPayload: Record<string, unknown>;
			replayStoreEventId?: string;
		},
	): Promise<{ status: "processed"; billingAccountId: string }> {
		return await this.transaction(async (tx) => {
			const projectId = project.projectInstanceId;
			const state = input.normalized;
			const sub = state.subscription;
			const correlation = correlationSchema.parse(sub.custom_data).quotum;
			const intent = await executeOne<{
				billing_account_id: string;
				request: {
					customerId: string;
					bindings: PaddlePriceBinding[];
					plan?: unknown;
				};
			}>(
				tx,
				sql`
				SELECT billing_account_id, request FROM provider_operations
				WHERE project_id = ${projectId} AND id = ${correlation.operationId} AND provider = 'paddle'
					AND provider_account_id = ${input.providerAccountId} AND request_hash = ${correlation.requestHash}
					AND operation = 'checkout.hosted' AND status <> 'failed'
			`,
			);
			if (!intent || intent.request.customerId !== sub.customer_id) mismatch();
			const customer = await executeOne<{ id: string; billing_account_id: string }>(
				tx,
				sql`
				SELECT c.id, c.billing_account_id FROM customers c JOIN provider_customers pc
					ON pc.customer_id = c.id AND pc.project_id = c.project_id
				WHERE c.project_id = ${projectId} AND c.billing_account_id = ${intent.billing_account_id}
					AND pc.provider = 'paddle' AND pc.external_customer_id = ${sub.customer_id}
					AND pc.provider_account_id = ${input.providerAccountId} FOR NO KEY UPDATE OF c
			`,
			);
			if (!customer) mismatch();
			// This increment admits a single fixed recurring item. Other item sets need their own
			// conformance evidence and cannot silently collapse into one entitlement allocation.
			assertFixedSubscription(sub, intent.request.bindings);
			const item = sub.items[0];
			if (!item) mismatch();
			const product = await executeOne<StoreProductIdentityRow>(
				tx,
				sql`
				SELECT sp.id, sp.product_id, p.key AS product_key, p.type AS product_type, p.credit_amount
				FROM store_products sp JOIN products p ON p.id = sp.product_id AND p.project_id = sp.project_id
				WHERE sp.project_id = ${projectId} AND sp.provider = 'paddle' AND sp.channel = 'web'
					AND sp.external_product_id = ${item.price.product_id} AND sp.external_price_id = ${item.price.id}
					AND sp.active = true AND p.active = true
			`,
			);
			if (product?.product_type !== "subscription") mismatch();
			const payment = input.transaction;
			if (
				payment &&
				(payment.status !== "completed" ||
					payment.customer_id !== sub.customer_id ||
					payment.subscription_id !== sub.id ||
					payment.collection_mode !== "automatic" ||
					payment.currency_code !== sub.currency_code ||
					payment.details.line_items.length !== 1 ||
					payment.details.line_items[0]?.price_id !== item.price.id ||
					payment.details.line_items[0]?.quantity !== 1 ||
					payment.details.line_items[0]?.product.id !== item.price.product_id)
			)
				mismatch();
			const event = await recordStoreEventProcessingResult(tx, projectId, {
				provider: "paddle",
				channel: "web",
				externalEventId: input.externalEventId,
				eventType: input.eventType,
				customerId: customer.id,
				storeProductId: product.id,
				transactionId: payment?.id ?? sub.id,
				purchaseKind: "subscription",
				processingStatus: "processed",
				processingError: null,
				rawPayload: input.rawPayload,
				raiseIdentityMismatch: true,
				replayStoreEventId: input.replayStoreEventId ?? null,
			});
			if (!event.applied)
				return { status: "processed", billingAccountId: customer.billing_account_id };
			const current = await executeOne<{
				id: string;
				last_provider_event_created: number | string;
			}>(
				tx,
				sql`
				SELECT id, last_provider_event_created FROM subscriptions WHERE project_id = ${projectId}
					AND provider = 'paddle' AND external_subscription_id = ${sub.id} FOR UPDATE
			`,
			);
			const updated = Date.parse(sub.updated_at);
			const period = sub.current_billing_period;
			const start = new Date(period?.starts_at ?? sub.started_at ?? sub.updated_at);
			const end = period
				? new Date(period.ends_at)
				: new Date(sub.canceled_at ?? sub.paused_at ?? sub.updated_at);
			let subscriptionId = current?.id;
			if (!current || Number(current.last_provider_event_created) < updated) {
				subscriptionId = await upsertSubscription(tx, projectId, {
					customerId: customer.id,
					productId: product.product_id,
					storeProductId: product.id,
					provider: "paddle",
					channel: "web",
					providerAccountId: input.providerAccountId,
					externalSubscriptionId: sub.id,
					externalProductId: item.price.product_id,
					externalPriceId: item.price.id,
					status: state.status,
					providerStatus: sub.status,
					startsAt: new Date(sub.started_at ?? start),
					expiresAt: end,
					currentPeriodStart: start,
					currentPeriodEnd: end,
					autoRenew: ["active", "past_due"].includes(sub.status) && !state.cancelAtPeriodEnd,
					cancelAtPeriodEnd: state.cancelAtPeriodEnd,
					latestTransactionId: payment?.id ?? null,
					lastProviderEventCreated: updated,
					enforceProviderEventOrder: true,
					replaceExpiresAt: true,
					rawState: sub,
					updateProduct: false,
					identityError: "Paddle subscription identity mismatch",
				});
				if (intent.request.plan !== undefined) {
					const pin = paddlePlanPinSchema.parse(intent.request.plan);
					if (pin.storeProductId !== product.id) mismatch();
					const pinned = await executeOne(
						tx,
						sql`
						UPDATE subscriptions s SET plan_version_id = pv.id, catalog_revision_id = pv.catalog_revision_id
						FROM plan_versions pv JOIN price_components pc ON pc.project_id = pv.project_id AND pc.plan_version_id = pv.id
						WHERE s.project_id = ${projectId} AND s.id = ${subscriptionId} AND pv.project_id = s.project_id
						AND pv.id = ${pin.planVersionId}::bigint AND pv.catalog_revision_id = ${pin.catalogRevisionId}::bigint AND pc.id = ${pin.priceComponentId}::bigint
						AND (s.plan_version_id IS NULL OR s.plan_version_id = pv.id) RETURNING s.id
					`,
					);
					if (!pinned) mismatch();
					await executeOne(
						tx,
						sql`
						INSERT INTO subscription_items(project_id, subscription_id, price_component_id, quantity, unit_amount_minor, currency, active, starts_at)
						SELECT ${projectId}, ${subscriptionId}, pc.id, 1, pc.unit_amount_minor, pc.currency, true, ${start.toISOString()}
						FROM price_components pc WHERE pc.project_id = ${projectId} AND pc.id = ${pin.priceComponentId}::bigint
						ON CONFLICT(project_id, subscription_id, price_component_id) DO UPDATE SET quantity=1, active=true, ends_at=NULL, updated_at=now()
						RETURNING id
					`,
					);
				}
				await materializeSubscriptionAllocations(tx, {
					preservePlanVersion: intent.request.plan !== undefined,
					projectId,
					customerId: customer.id,
					storeProductId: product.id,
					subscriptionId,
					status: state.status,
					periodStartAt: start,
					periodEndAt: end,
				});
			}
			if (!subscriptionId) throw new Error("Paddle subscription was not recorded");
			if (payment)
				await upsertPurchase(tx, projectId, {
					customerId: customer.id,
					productId: product.product_id,
					storeProductId: product.id,
					subscriptionId,
					provider: "paddle",
					channel: "web",
					purchaseKind: "subscription",
					transactionId: payment.id,
					originalTransactionId: sub.id,
					status: "completed",
					purchasedAt: new Date(payment.updated_at),
					invalidatedAt: null,
					invalidationReason: null,
					rawPayload: payment,
					amountPaidMinor: z.coerce
						.number()
						.int()
						.nonnegative()
						.safe()
						.parse(payment.details.totals.grand_total),
					currency: payment.currency_code,
					identityError: "Paddle transaction identity mismatch",
				});
			const entitlements = await recomputeCustomerEntitlements(
				tx,
				projectId,
				customer.billing_account_id,
			);
			await enqueueProjectionSyncJob(tx, {
				customerId: customer.id,
				idempotencyKey: `paddle:${input.externalEventId}`,
				reason: "provider_webhook",
				payload: {
					billingAccountId: customer.billing_account_id,
					reason: "provider_webhook",
					entitlements,
					...(payment
						? {
								purchase: {
									provider: "paddle" as const,
									channel: "web" as const,
									purchaseKind: "subscription" as const,
									transactionId: payment.id,
									productKey: product.product_key,
									creditAmount: product.credit_amount,
									quantity: 1,
									purchasedAt: new Date(payment.updated_at).toISOString(),
								},
							}
						: {}),
				},
			});
			return { status: "processed", billingAccountId: customer.billing_account_id };
		});
	}
}

function assertFixedSubscription(sub: PaddleSubscription, bindings: PaddlePriceBinding[]): void {
	const item = sub.items[0];
	const binding = bindings[0] ? paddlePriceBindingSchema.parse(bindings[0]) : undefined;
	if (
		sub.collection_mode !== "automatic" ||
		sub.status === "trialing" ||
		sub.items.length !== 1 ||
		!item ||
		!binding ||
		bindings.length !== 1 ||
		item.quantity !== 1 ||
		binding.quantity !== 1 ||
		item.price.id !== binding.priceId ||
		item.price.product_id !== binding.productId ||
		sub.currency_code !== binding.currency ||
		item.price.unit_price.currency_code !== binding.currency ||
		item.price.unit_price.amount !== binding.unitAmountMinor ||
		item.price.billing_cycle?.interval !== binding.billingCycle?.interval ||
		item.price.billing_cycle?.frequency !== binding.billingCycle?.frequency ||
		item.price.billing_cycle === null ||
		item.price.trial_period !== null
	)
		mismatch();
}
function mismatch(): never {
	throw new BillingError(
		"Paddle state does not match the recorded checkout and customer",
		"PADDLE_FULFILLMENT_MISMATCH",
		409,
	);
}
