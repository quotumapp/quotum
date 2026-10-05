import { z } from "zod";
import { sha256Hex, stableJson } from "../../billing/decimal";
import { BillingError } from "../../billing/errors";
import {
	executeProviderOperation,
	type ProviderOperation,
	type ProviderOperationOutcome,
	type ProviderOperationRecoveryStore,
} from "../../billing/provider-operations";
import type { WebBillingService } from "../../billing/web-provider";
import type {
	ProjectScopedBillingRepository,
	ProviderSubscriptionReconciliationRow,
	StoreEventReplayJobRow,
} from "../../db/repository";
import type { RuntimeConnectionConfigs } from "../../projects/connections";
import type { ProjectInstanceContext } from "../../projects/context";
import type { StoreEventReplayProviderResult } from "../../workers/store-event-replay";
import type { PaddlePriceBinding } from "./catalog";
import { PaddleCheckout } from "./checkout";
import { PaddleClient } from "./client";
import { paddleCorrelation } from "./commands";
import { PaddleCommercial } from "./commercial";
import { buildPaddleConfig } from "./config";
import { paddleCustomerResourceKey } from "./customer-operation";
import { assertPaddleCustomer, PaddleGateway } from "./gateway";
import { normalizePaddleEvent } from "./normalizer";
import { paddleOperationFailed } from "./operation-errors";
import { normalizePaddleEmail, type PaddlePlanPin } from "./plan";
import {
	type PaddleTransaction,
	paddleCorrelationSchema,
	paddleEventSchema,
	paddleId,
} from "./schemas";
import { verifyPaddleSignature } from "./webhook";

const customerSchema = z.object({
	id: paddleId("ctm"),
	email: z.email(),
	status: z.literal("active"),
	custom_data: z.unknown(),
});

export class PaddleBillingService implements WebBillingService {
	readonly gateway: PaddleGateway;
	readonly checkout: PaddleCheckout;
	readonly commercial: PaddleCommercial;
	constructor(
		private readonly project: ProjectInstanceContext,
		private readonly config: RuntimeConnectionConfigs["paddle"],
		private readonly repository: ProjectScopedBillingRepository,
		private readonly operations: ProviderOperationRecoveryStore,
		private readonly client = new PaddleClient(config),
	) {
		const { versionId: _, accountIdentity: __, ...credentials } = config;
		buildPaddleConfig(project, credentials);
		this.gateway = new PaddleGateway(client, config);
		this.checkout = new PaddleCheckout(project, operations, this.gateway, config);
		this.commercial = new PaddleCommercial(
			repository,
			this.gateway,
			config,
			(input, binding, plan) => this.createFixedCheckout(input, binding, plan),
		);
	}

	async createCheckoutSession(input: Parameters<WebBillingService["createCheckoutSession"]>[0]) {
		if (!input.idempotencyKey || input.successUrl || input.cancelUrl || input.expiresAt) {
			throw new BillingError(
				"Paddle checkout requires an idempotency key and the configured payment page",
				"PADDLE_CHECKOUT_INVALID",
				400,
			);
		}
		const replayed = await this.replaySucceededCheckout({
			...input,
			idempotencyKey: input.idempotencyKey,
		});
		if (replayed) return replayed;
		const binding = await this.repository.getPaddleBinding(input.productKey);
		return this.createFixedCheckout({ ...input, idempotencyKey: input.idempotencyKey }, binding);
	}

	/**
	 * A succeeded receipt replays from its durable operation: no provider read, and no dependence on
	 * the product still being on sale. A key that names another target falls through to the checks.
	 */
	private async replaySucceededCheckout(input: {
		billingAccountId: string;
		productKey: string;
		idempotencyKey: string;
	}) {
		const existingId = await this.repository.findPaddleOperation(
			input.billingAccountId,
			input.idempotencyKey,
			this.config.accountIdentity,
		);
		if (!existingId) return null;
		const existing = await this.operations.get(this.project, input.billingAccountId, existingId);
		if (existing.status !== "succeeded") return null;
		const binding = await this.repository.findPaddleBindingIncludingRetired(input.productKey);
		const request = existing.request as { bindings?: unknown; plan?: unknown };
		if (
			!binding ||
			stableJson(request.bindings) !== stableJson([binding]) ||
			stableJson(request.plan ?? null) !== stableJson(null)
		)
			return null;
		return {
			...z.object({ sessionId: paddleId("txn"), url: z.url() }).parse(existing.result),
			duplicate: true,
		};
	}

	previewCommercialAction(
		input: Parameters<NonNullable<WebBillingService["previewCommercialAction"]>>[0],
	) {
		return this.commercial.preview(input);
	}
	executeCommercialAction(
		input: Parameters<NonNullable<WebBillingService["executeCommercialAction"]>>[0],
	) {
		return this.commercial.execute(input);
	}

	private async createFixedCheckout(
		input: {
			billingAccountId: string;
			email?: string | null;
			idempotencyKey: string;
			previewToken?: string;
		},
		binding: PaddlePriceBinding,
		plan?: PaddlePlanPin,
	) {
		const existingId = await this.repository.findPaddleOperation(
			input.billingAccountId,
			input.idempotencyKey,
			this.config.accountIdentity,
		);
		if (existingId) {
			const existing = await this.operations.get(this.project, input.billingAccountId, existingId);
			const request = existing.request as { bindings?: unknown; plan?: unknown };
			if (
				stableJson(request.bindings) !== stableJson([binding]) ||
				stableJson(request.plan ?? null) !== stableJson(plan ?? null)
			)
				throw new BillingError(
					"Checkout key belongs to another target",
					"IDEMPOTENCY_CONFLICT",
					409,
				);
			if (existing.status !== "succeeded" && existing.status !== "prepared") pending(existing);
			if (existing.status === "succeeded")
				return {
					...z.object({ sessionId: paddleId("txn"), url: z.url() }).parse(existing.result),
					duplicate: true,
				};
		}
		await this.gateway.validatePrices([binding], true);
		let customerId = await this.repository.getPaddleCustomer(
			input.billingAccountId,
			this.config.accountIdentity,
		);
		const email = normalizePaddleEmail(input.email);
		if (!customerId && !email)
			throw new BillingError(
				"Email is required to create the Paddle customer",
				"PADDLE_CUSTOMER_EMAIL_REQUIRED",
				400,
			);
		const customerKey = customerId
			? null
			: await this.repository.paddleCustomerOperationKey(
					input.billingAccountId,
					email,
					input.idempotencyKey,
				);
		if (customerKey !== null)
			await this.repository.assertPaddleCustomerIntent(
				input.billingAccountId,
				this.config.accountIdentity,
				email,
				customerKey,
			);
		// A cooldown refusal must not leave a reservation or receipt behind for this key.
		this.gateway.assertAvailable();
		const reservationId = await this.repository.reservePaddleCheckout({
			billingAccountId: input.billingAccountId,
			idempotencyKey: input.idempotencyKey,
			previewToken: input.previewToken,
			providerAccountId: this.config.accountIdentity,
			connectionVersionId: this.config.versionId,
			target: { binding, plan: plan ?? null },
		});
		try {
			const beforeDispatch = (operation: ProviderOperation) =>
				this.repository.bindPaddleCheckoutOperation(reservationId, operation);
			if (customerId === null) {
				if (customerKey === null) throw new Error("Paddle customer operation key was not resolved");
				const request = { email };
				const operation = await executeProviderOperation({
					beforeDispatch,
					project: this.project,
					store: this.operations,
					intent: {
						billingAccountId: input.billingAccountId,
						provider: "paddle",
						providerAccountId: this.config.accountIdentity,
						connectionVersionId: this.config.versionId,
						idempotencyKey: customerKey,
						resourceKey: paddleCustomerResourceKey(input.billingAccountId),
						operation: "customer.create",
						requestHash: sha256Hex(stableJson(request)),
						request,
					},
					write: async (operation) => {
						if (operation.connectionVersionId !== this.config.versionId)
							throw new Error("Resolve the recorded connection before dispatch");
						const response = await this.client.write("POST", "/customers", {
							email,
							custom_data: paddleCorrelation({
								operationId: operation.id,
								requestHash: operation.requestHash,
							}),
						});
						const customer = customerSchema.parse(response.data);
						if (
							customer.email !== email ||
							stableJson(customer.custom_data) !==
								stableJson(
									paddleCorrelation({
										operationId: operation.id,
										requestHash: operation.requestHash,
									}),
								)
						)
							throw new Error("Paddle customer email differs");
						return { providerObjectId: customer.id, result: { customerId: customer.id } };
					},
				});
				if (operation.status === "failed")
					await this.repository.rejectPaddleCheckout(reservationId, operation);
				if (operation.status !== "succeeded" || !operation.providerObjectId) pending(operation);
				customerId = operation.providerObjectId;
				await this.repository.linkPaddleCustomer({
					billingAccountId: input.billingAccountId,
					customerId,
					providerAccountId: this.config.accountIdentity,
				});
			}
			const operation = await this.checkout.create({
				beforeDispatch,
				billingAccountId: input.billingAccountId,
				idempotencyKey: input.idempotencyKey,
				customerId,
				bindings: [binding],
				...(plan ? { plan } : {}),
			});
			if (operation.status === "failed")
				await this.repository.rejectPaddleCheckout(reservationId, operation);
			if (operation.status !== "succeeded") pending(operation);
			return {
				...z.object({ sessionId: paddleId("txn"), url: z.url() }).parse(operation.result),
				duplicate: false,
			};
		} catch (error) {
			await this.repository.rejectUnboundPaddleCheckout(input);
			throw error;
		}
	}

	async observeOperation(
		operation: ProviderOperation,
	): Promise<Exclude<ProviderOperationOutcome, { status: "failed" }>> {
		if (
			operation.provider !== "paddle" ||
			operation.providerAccountId !== this.config.accountIdentity ||
			operation.connectionVersionId !== this.config.versionId
		)
			return { status: "requires_review", errorCode: "PROVIDER_OPERATION_ACCOUNT_MISMATCH" };
		if (operation.operation === "checkout.hosted") return this.checkout.observe(operation);
		if (operation.operation !== "customer.create")
			return { status: "requires_review", errorCode: "PADDLE_OPERATION_UNSUPPORTED" };
		const request = z.object({ email: z.email() }).strict().parse(operation.request);
		if (sha256Hex(stableJson(request)) !== operation.requestHash)
			return { status: "requires_review", errorCode: "PADDLE_OPERATION_INTENT_MISMATCH" };
		const { email } = request;
		const response = await this.client.get(
			`/customers?${new URLSearchParams({ email, per_page: "200", status: "active,archived" })}`,
		);
		if (response.meta?.pagination?.has_more !== false)
			return { status: "requires_review", errorCode: "PADDLE_CUSTOMER_SCAN_INCOMPLETE" };
		const customers = z
			.array(customerSchema.extend({ status: z.enum(["active", "archived"]) }))
			.parse(response.data);
		const matches = customers.filter(
			(customer) =>
				customer.email === email &&
				stableJson(customer.custom_data) ===
					stableJson(
						paddleCorrelation({ operationId: operation.id, requestHash: operation.requestHash }),
					),
		);
		const customer = matches[0];
		if (matches.length !== 1 || !customer || customer.status !== "active")
			return { status: "requires_review", errorCode: "PADDLE_CUSTOMER_UNRESOLVED" };
		await this.repository.linkPaddleCustomer({
			billingAccountId: operation.billingAccountId,
			customerId: customer.id,
			providerAccountId: this.config.accountIdentity,
		});
		return {
			status: "succeeded",
			providerObjectId: customer.id,
			result: { customerId: customer.id },
		};
	}

	async getCheckoutSessionStatus(input: { billingAccountId: string; sessionId: string }) {
		const customerId = await this.repository.getPaddleCustomer(
			input.billingAccountId,
			this.config.accountIdentity,
		);
		if (!customerId)
			throw new BillingError("Paddle customer was not found", "PADDLE_CUSTOMER_NOT_FOUND", 404);
		const transaction = await this.gateway.transaction(input.sessionId);
		assertPaddleCustomer(customerId, transaction.customer_id);
		return {
			sessionId: transaction.id,
			status: transaction.status,
			paymentStatus: transaction.status,
			customerEmail: null,
			productKey: null,
		};
	}

	async createPortalSession(): Promise<{ url: string }> {
		throw new BillingError(
			"Paddle portal qualification is pending",
			"PADDLE_OPERATION_UNSUPPORTED",
			409,
		);
	}

	async handleWebhook(input: { rawBody: string; signatureHeader: string | null }) {
		verifyPaddleSignature({
			body: input.rawBody,
			signature: input.signatureHeader,
			secret: this.config.webhookSecret,
		});
		const event = paddleEventSchema.parse(JSON.parse(input.rawBody));
		await this.repository.enqueueProviderStoreEvent({
			provider: "paddle",
			channel: "web",
			externalEventId: event.event_id,
			eventType: event.event_type,
			transactionId: typeof event.data.id === "string" ? event.data.id : null,
			rawPayload: { ...event, quotumAccountIdentity: this.config.accountIdentity },
		});
		return { status: "queued" as const, eventType: event.event_type };
	}

	async replayStoreEvent(row: StoreEventReplayJobRow): Promise<StoreEventReplayProviderResult> {
		if (
			row.provider !== "paddle" ||
			row.project_id !== this.project.projectInstanceId ||
			row.raw_payload.quotumAccountIdentity !== this.config.accountIdentity
		)
			throw new Error("Paddle event connection identity mismatch");
		return this.processEvent(row.raw_payload, row.id);
	}

	private async processEvent(
		raw: Record<string, unknown>,
		replayStoreEventId?: string,
	): Promise<StoreEventReplayProviderResult> {
		const event = paddleEventSchema.parse(raw);
		if (event.event_type === "transaction.canceled") {
			const transaction = await this.gateway.transactionIdentity(
				paddleId("txn").parse(event.data.id),
			);
			if (transaction.status !== "canceled")
				return { status: "ignored", reason: "Paddle transaction is not currently canceled" };
			if (
				transaction.origin !== "api" ||
				!paddleCorrelationSchema.safeParse(transaction.custom_data).success
			)
				return { status: "ignored", reason: "Paddle transaction is not a Quotum checkout create" };
			await this.repository.recordPaddleCancellation({
				providerAccountId: this.config.accountIdentity,
				transaction,
				externalEventId: event.event_id,
				rawPayload: raw,
				replayStoreEventId,
			});
			return { status: "processed" };
		}
		let transaction: PaddleTransaction | undefined;
		let subscriptionId: string;
		if (event.event_type === "transaction.completed") {
			transaction = await this.gateway.transaction(paddleId("txn").parse(event.data.id));
			if (transaction.status !== "completed" || !transaction.subscription_id)
				throw new Error("Paddle transaction is not a completed subscription purchase");
			subscriptionId = transaction.subscription_id;
		} else if (event.event_type.startsWith("subscription.")) {
			subscriptionId = paddleId("sub").parse(event.data.id);
		} else
			return {
				status: "ignored",
				reason: "Paddle event is outside the qualified subscription scope",
			};
		// Always observe current authenticated state; delayed deliveries cannot restore old access.
		const subscription = await this.gateway.subscription(subscriptionId);
		const normalized = normalizePaddleEvent({
			...event,
			event_type: "subscription.updated",
			data: subscription,
		});
		if (normalized.kind !== "subscription") throw new Error("Expected Paddle subscription state");
		await this.repository.recordPaddleEvent({
			providerAccountId: this.config.accountIdentity,
			normalized,
			transaction,
			externalEventId: event.event_id,
			eventType: event.event_type,
			rawPayload: raw,
			replayStoreEventId,
		});
		return { status: "processed" };
	}

	async reconcileSubscription(
		row: ProviderSubscriptionReconciliationRow,
	): Promise<{ status: "processed" | "skipped" }> {
		if (
			row.provider !== "paddle" ||
			row.project_id !== this.project.projectInstanceId ||
			row.provider_account_id !== this.config.accountIdentity
		)
			throw new Error("Paddle subscription account mismatch");
		const subscription = await this.gateway.subscription(row.external_subscription_id);
		const normalized = normalizePaddleEvent({
			event_id: `evt_${"0".repeat(26)}`,
			event_type: "subscription.updated",
			occurred_at: subscription.updated_at,
			data: subscription,
		});
		if (normalized.kind !== "subscription") throw new Error("Expected Paddle subscription state");
		await this.repository.recordPaddleEvent({
			providerAccountId: this.config.accountIdentity,
			normalized,
			externalEventId: `reconcile:${subscription.id}:${subscription.updated_at}`,
			eventType: "subscription.reconciled",
			rawPayload: subscription,
		});
		return { status: "processed" };
	}
}

function pending(operation: ProviderOperation): never {
	if (operation.status === "failed") throw paddleOperationFailed(operation);
	throw new BillingError(
		"Inspect the provider operation before retrying checkout",
		"PROVIDER_OPERATION_PENDING",
		409,
		{
			details: { operationId: operation.id, status: operation.status },
		},
	);
}
