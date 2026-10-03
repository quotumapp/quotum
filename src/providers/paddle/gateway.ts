import { z } from "zod";
import { BillingError } from "../../billing/errors";
import { type PaddlePriceBinding, validatePaddleItemSet, validatePaddlePrice } from "./catalog";
import type { PaddleClient } from "./client";
import type { PaddleCommand, PaddleCorrelation } from "./commands";
import type { PaddleConfig } from "./config";
import {
	type PaddleTransaction,
	paddleId,
	paddleSubscriptionSchema,
	paddleTransactionSchema,
} from "./schemas";

/** Authenticated Paddle transport; mutations are called only from durable dispatchers. */
export class PaddleGateway {
	constructor(
		private readonly client: Pick<PaddleClient, "get" | "write">,
		private readonly config: Pick<PaddleConfig, "paymentPageUrl">,
	) {}

	async validatePrices(
		bindings: readonly PaddlePriceBinding[],
		fixedSubscription = false,
	): Promise<void> {
		validatePaddleItemSet(bindings);
		// Sequential to avoid bursting the seller's shared IP limit for large item sets.
		for (const binding of bindings) {
			const response = await this.client.get(`/prices/${paddleId("pri").parse(binding.priceId)}`);
			const price = validatePaddlePrice(binding, response.data);
			if (
				fixedSubscription &&
				(bindings.length !== 1 ||
					binding.productType !== "subscription" ||
					binding.quantity !== 1 ||
					price.trial_period !== null ||
					price.quantity.minimum !== 1 ||
					price.quantity.maximum !== 1)
			)
				throw new BillingError(
					"Paddle sandbox checkout requires one recurring price locked to quantity one without a trial",
					"PADDLE_CHECKOUT_SCOPE_UNSUPPORTED",
					409,
				);
		}
	}

	async subscription(id: string) {
		const response = await this.client.get(`/subscriptions/${paddleId("sub").parse(id)}`);
		const subscription = paddleSubscriptionSchema.parse(response.data);
		if (subscription.id !== id) throw new Error("Paddle returned a different subscription");
		return subscription;
	}

	async transaction(id: string) {
		const response = await this.client.get(`/transactions/${paddleId("txn").parse(id)}`);
		const transaction = paddleTransactionSchema.parse(response.data);
		if (transaction.id !== id) throw new Error("Paddle returned a different transaction");
		return transaction;
	}

	/** Call only inside the durable operation's single dispatch callback. */
	async dispatch(command: PaddleCommand): Promise<unknown> {
		return (await this.client.write(command.method, command.path, command.body)).data;
	}

	checkoutResult(raw: unknown): { sessionId: string; url: string } {
		const transaction = paddleTransactionSchema.parse(raw);
		if (transaction.collection_mode !== "automatic" || !transaction.checkout?.url) {
			throw new Error("Paddle transaction has no checkout link");
		}
		const url = new URL(transaction.checkout.url);
		const expected = new URL(this.config.paymentPageUrl);
		expected.searchParams.set("_ptxn", transaction.id);
		url.searchParams.sort();
		expected.searchParams.sort();
		if (url.href !== expected.href) throw new Error("Paddle returned a different payment page");
		return { sessionId: transaction.id, url: url.href };
	}

	/** Authenticated portal links are returned on demand and must never enter the operation ledger. */
	async portal(customerId: string): Promise<{ url: string }> {
		const response = await this.client.write(
			"POST",
			`/customers/${paddleId("ctm").parse(customerId)}/portal-sessions`,
			{},
		);
		const data = z
			.object({
				customer_id: paddleId("ctm"),
				urls: z.object({ general: z.object({ overview: z.url() }) }),
			})
			.parse(response.data);
		const url = new URL(data.urls.general.overview);
		if (
			data.customer_id !== customerId ||
			url.protocol !== "https:" ||
			url.hostname !== "sandbox-customer-portal.paddle.com" ||
			url.username ||
			url.password ||
			url.port
		) {
			throw new Error("Paddle returned an invalid portal session");
		}
		return { url: url.href };
	}

	/** A complete scan may establish one matching effect; absence never authorizes another write. */
	async recoverCheckout(input: {
		customerId: string;
		correlation: PaddleCorrelation;
		bindings: readonly PaddlePriceBinding[];
	}): Promise<
		| { status: "succeeded"; transaction: PaddleTransaction }
		| { status: "requires_review"; reason: "not_found" | "ambiguous" | "mismatch" | "scan_limit" }
	> {
		const customerId = paddleId("ctm").parse(input.customerId);
		validatePaddleItemSet(input.bindings);
		const params = new URLSearchParams({
			customer_id: customerId,
			origin: "api",
			per_page: "30",
			order_by: "id[ASC]",
		});
		const matches: PaddleTransaction[] = [];
		const cursors = new Set<string>();
		for (let page = 0; page < 100; page++) {
			const response = await this.client.get(`/transactions?${params}`);
			const transactions = z.array(paddleTransactionSchema).parse(response.data);
			for (const transaction of transactions) {
				if (transaction.customer_id !== customerId)
					throw new Error("Paddle returned another customer's transaction");
				// Subscription transactions inherit custom_data; they cannot prove the original create.
				if (transaction.origin !== "api") continue;
				const correlation = z
					.object({ quotum: z.object({ operationId: z.string(), requestHash: z.string() }) })
					.safeParse(transaction.custom_data);
				if (
					!correlation.success ||
					correlation.data.quotum.operationId !== input.correlation.operationId
				)
					continue;
				if (
					correlation.data.quotum.requestHash !== input.correlation.requestHash ||
					!matchesPaddleCheckoutItems(transaction, input.bindings)
				)
					return { status: "requires_review", reason: "mismatch" };
				matches.push(transaction);
			}
			if (matches.length > 1) return { status: "requires_review", reason: "ambiguous" };
			const pagination = response.meta?.pagination;
			if (!pagination || typeof pagination.has_more !== "boolean")
				throw new Error("Paddle pagination is incomplete");
			if (!pagination.has_more) {
				const match = matches[0];
				return match
					? { status: "succeeded", transaction: match }
					: { status: "requires_review", reason: "not_found" };
			}
			// Never follow an authenticated URL supplied by a response. Only carry its validated cursor.
			const next = new URL(pagination.next ?? "");
			const cursor = paddleId("txn").parse(next.searchParams.get("after"));
			if (
				next.origin !== "https://sandbox-api.paddle.com" ||
				next.pathname !== "/transactions" ||
				cursors.has(cursor)
			) {
				throw new Error("Paddle pagination is invalid");
			}
			cursors.add(cursor);
			params.set("after", cursor);
		}
		return { status: "requires_review", reason: "scan_limit" };
	}
}

/** Required before accepting metadata from a webhook or API result as an account link. */
export function assertPaddleCustomer(expected: string, actual: string | null): void {
	if (expected !== actual)
		throw new BillingError(
			"Paddle object belongs to another customer",
			"PADDLE_CUSTOMER_MISMATCH",
			409,
		);
}

export function matchesPaddleCheckoutItems(
	transaction: PaddleTransaction,
	bindings: readonly PaddlePriceBinding[],
): boolean {
	return (
		transaction.currency_code === bindings[0]?.currency &&
		transaction.collection_mode === "automatic" &&
		transaction.details.line_items.length === bindings.length &&
		bindings.every((binding) => {
			const matches = transaction.details.line_items.filter(
				(item) => item.price_id === binding.priceId,
			);
			return (
				matches.length === 1 &&
				matches[0]?.quantity === binding.quantity &&
				matches[0]?.product.id === binding.productId
			);
		})
	);
}
