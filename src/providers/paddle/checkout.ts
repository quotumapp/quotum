import { z } from "zod";
import { sha256Hex, stableJson } from "../../billing/decimal";
import { BillingError } from "../../billing/errors";
import {
	executeProviderOperation,
	type ProviderOperation,
	type ProviderOperationOutcome,
	type ProviderOperationStore,
} from "../../billing/provider-operations";
import type { ProjectInstanceContext } from "../../projects/context";
import { paddlePriceBindingSchema } from "./catalog";
import { paddleCheckoutCommand } from "./commands";
import type { PaddleConfig } from "./config";
import { matchesPaddleCheckoutItems, type PaddleGateway } from "./gateway";
import { type PaddlePlanPin, paddlePlanPinSchema } from "./plan";
import { paddleId, paddleTransactionSchema } from "./schemas";

const checkoutIntentSchema = z.object({
	customerId: paddleId("ctm"),
	bindings: z.array(paddlePriceBindingSchema).min(1),
	paymentPageUrl: z.url(),
	plan: paddlePlanPinSchema.optional(),
});

/** One remote transaction per durable intent, including after a lost response or process crash. */
export class PaddleCheckout {
	constructor(
		private readonly project: ProjectInstanceContext,
		private readonly store: ProviderOperationStore,
		private readonly gateway: PaddleGateway,
		private readonly connection: Pick<PaddleConfig, "paymentPageUrl"> & {
			accountIdentity: string;
			versionId: string;
		},
	) {}

	async create(input: {
		billingAccountId: string;
		idempotencyKey: string;
		customerId: string;
		bindings: z.infer<typeof paddlePriceBindingSchema>[];
		plan?: PaddlePlanPin;
		beforeDispatch?: (operation: ProviderOperation) => Promise<void>;
	}): Promise<ProviderOperation> {
		const request = checkoutIntentSchema.parse({
			...input,
			paymentPageUrl: this.connection.paymentPageUrl,
		});
		// Validation is read-only. A rejected catalog never reserves or dispatches an operation.
		await this.gateway.validatePrices(request.bindings, true);
		return await executeProviderOperation({
			beforeDispatch: input.beforeDispatch,
			project: this.project,
			store: this.store,
			intent: {
				billingAccountId: input.billingAccountId,
				provider: "paddle",
				providerAccountId: this.connection.accountIdentity,
				connectionVersionId: this.connection.versionId,
				idempotencyKey: input.idempotencyKey,
				resourceKey: `checkout:${sha256Hex(input.billingAccountId)}`,
				operation: "checkout.hosted",
				requestHash: sha256Hex(stableJson(request)),
				request,
			},
			write: async (operation) => {
				if (operation.connectionVersionId !== this.connection.versionId)
					throw new Error("Resolve the recorded connection before dispatch");
				const raw = await this.gateway.dispatch(
					paddleCheckoutCommand({
						customerId: request.customerId,
						bindings: request.bindings,
						config: this.connection,
						correlation: { operationId: operation.id, requestHash: operation.requestHash },
					}),
				);
				const transaction = paddleTransactionSchema.parse(raw);
				if (
					transaction.customer_id !== request.customerId ||
					!matchesPaddleCheckoutItems(transaction, request.bindings) ||
					stableJson(transaction.custom_data) !==
						stableJson({
							quotum: { operationId: operation.id, requestHash: operation.requestHash },
						})
				)
					throw new Error("Paddle checkout response differs from its recorded intent");
				const result = this.gateway.checkoutResult(transaction);
				return { providerObjectId: result.sessionId, result };
			},
		});
	}

	/** Resolve the recorded connection version before constructing this observer. Never dispatches. */
	async observe(
		operation: ProviderOperation,
	): Promise<Exclude<ProviderOperationOutcome, { status: "failed" }>> {
		if (
			operation.provider !== "paddle" ||
			operation.operation !== "checkout.hosted" ||
			operation.providerAccountId !== this.connection.accountIdentity ||
			operation.connectionVersionId !== this.connection.versionId
		) {
			return { status: "requires_review", errorCode: "PROVIDER_OPERATION_ACCOUNT_MISMATCH" };
		}
		const request = checkoutIntentSchema.parse(operation.request);
		if (
			sha256Hex(stableJson(request)) !== operation.requestHash ||
			request.paymentPageUrl !== this.connection.paymentPageUrl
		) {
			throw new BillingError(
				"Paddle operation intent changed",
				"PADDLE_OPERATION_INTENT_MISMATCH",
				409,
			);
		}
		const recovered = await this.gateway.recoverCheckout({
			customerId: request.customerId,
			bindings: request.bindings,
			correlation: { operationId: operation.id, requestHash: operation.requestHash },
		});
		if (recovered.status === "requires_review")
			return {
				status: "requires_review",
				errorCode: `PADDLE_CHECKOUT_${recovered.reason.toUpperCase()}`,
			};
		return {
			status: "succeeded",
			providerObjectId: recovered.transaction.id,
			result: this.gateway.checkoutResult(recovered.transaction),
		};
	}
}
