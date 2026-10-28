import Stripe from "stripe";
import type {
	StripeSetupRun,
	StripeSetupStore,
} from "../../platform/connections/stripe-setup-store";
import { STRIPE_API_VERSION } from "../../providers/stripe/client";
import { canonicalJson } from "../../shared/canonical-json";
import { stripeErrorStatus } from "../stripe-connection-validation";
import {
	type SetupBinding,
	type SetupCredentials,
	SetupFailure,
	type StripeSetupManifest,
} from "./schema";

export const setupStripeClient = (key: string) =>
	new Stripe(key, { apiVersion: STRIPE_API_VERSION, timeout: 10_000, maxNetworkRetries: 0 });

export async function checkSetupAccounts(
	manifest: StripeSetupManifest,
	credentials: SetupCredentials,
	client: (key: string) => Stripe,
) {
	const prefix = manifest.environment === "production" ? "rk_live_" : "rk_test_";
	if (![credentials.setupKey, credentials.runtimeKey].every((key) => key.startsWith(prefix)))
		throw new SetupFailure("credential_mode_mismatch");
	if (credentials.setupKey === credentials.runtimeKey)
		throw new SetupFailure("separate_setup_and_runtime_keys_required");
	const accounts = await Promise.all([
		client(credentials.setupKey).accounts.retrieve(null),
		client(credentials.runtimeKey).accounts.retrieve(null),
	]);
	if (accounts.some((account) => account.id !== manifest.accountId))
		throw new SetupFailure("stripe_account_mismatch");
}

export async function inspectBinding(
	client: Stripe,
	binding: SetupBinding,
	production: boolean,
	ids?: { product: string; price: string },
) {
	const productId = ids?.product ?? (binding.source === "reuse" ? binding.externalProductId : "");
	const priceId = ids?.price ?? (binding.source === "reuse" ? binding.externalPriceId : "");
	const [product, price] = await Promise.all([
		client.products.retrieve(productId),
		client.prices.retrieve(priceId),
	]);
	if (
		product.deleted ||
		!product.active ||
		!price.active ||
		product.livemode !== production ||
		price.livemode !== production ||
		price.product !== productId
	)
		throw new SetupFailure("product_price_or_environment_mismatch");
	if (
		price.billing_scheme !== "per_unit" ||
		price.unit_amount === null ||
		price.custom_unit_amount ||
		price.transform_quantity ||
		(binding.kind !== "subscription" && price.unit_amount <= 0)
	)
		throw new SetupFailure("unsupported_price_shape");
	if (
		(binding.kind === "subscription") !== (price.type === "recurring") ||
		(price.recurring && price.recurring.usage_type !== "licensed")
	)
		throw new SetupFailure("price_cadence_mismatch");
	if (
		binding.source === "create" &&
		(price.currency !== binding.currency ||
			price.unit_amount !== binding.unitAmountMinor ||
			price.tax_behavior !== binding.taxBehavior ||
			(binding.interval &&
				(price.recurring?.interval !== binding.interval ||
					price.recurring.interval_count !== binding.intervalCount)))
	)
		throw new SetupFailure("created_price_changed");
	return { product: product.id, price: price.id };
}

export function checkEndpoint(endpoint: Stripe.WebhookEndpoint, production: boolean) {
	if (
		endpoint.livemode !== production ||
		endpoint.application ||
		endpoint.api_version !== STRIPE_API_VERSION
	)
		throw new SetupFailure("webhook_account_mode_or_version_mismatch");
}

/** Journal before dispatch; a lost response never authorizes an uncorrelated second create. */
export class SetupProviderWrites {
	constructor(
		readonly store: StripeSetupStore,
		readonly run: StripeSetupRun,
		readonly lease: string,
		readonly authorize: () => Promise<void>,
	) {}
	metadata(key: string) {
		return { quotum_setup_id: this.run.id, quotum_setup_step: key };
	}
	async write(
		key: string,
		request: unknown,
		call: (options: Stripe.RequestOptions) => Promise<{ id: string; secret?: string }>,
		recover?: () => Promise<{ id: string } | null>,
	): Promise<{ id: string }> {
		await this.authorize();
		await this.store.renew(this.run.id, this.lease);
		const step = await this.store.step(this.run.id, this.lease, key, request);
		if (canonicalJson(step.request) !== canonicalJson(request))
			throw new SetupFailure("setup_step_conflict");
		if (step.result) return { id: String(step.result.id) };
		await this.store.patch(this.run.id, this.lease, { currentStep: key });
		let result: { id: string; secret?: string };
		if (Date.now() - step.created_at.getTime() >= 23 * 60 * 60_000) {
			const found = await recover?.();
			if (!found) throw new SetupFailure("uncertain_provider_write_requires_review");
			result = found;
		} else {
			try {
				result = await call({ idempotencyKey: `quotum-setup:${this.run.id}:${key}` });
			} catch (error) {
				const status = stripeErrorStatus(error);
				if (status === 401 || status === 403)
					throw new SetupFailure("setup_key_permission_or_authentication_failed");
				// A cached 500 can conceal a committed write. Reconcile owned resources before retrying.
				const found = status === undefined || status >= 500 ? await recover?.() : null;
				if (!found) throw error;
				result = found;
			}
		}
		await this.store.renew(this.run.id, this.lease);
		// The endpoint secret is returned once. Persist it encrypted before saving its ID receipt.
		if (result.secret) await this.store.seal(this.run, this.lease, result.secret);
		await this.store.finish(this.run.id, this.lease, key, { id: result.id });
		return { id: result.id };
	}
	async find(items: AsyncIterable<{ id: string; metadata: Stripe.Metadata | null }>, key: string) {
		let found: { id: string } | null = null;
		let count = 0;
		for await (const item of items) {
			if (++count > 10_000) throw new SetupFailure("provider_reconciliation_limit_requires_review");
			if (
				item.metadata?.quotum_setup_id === this.run.id &&
				item.metadata.quotum_setup_step === key
			) {
				if (found) throw new SetupFailure("ambiguous_provider_objects_require_review");
				found = { id: item.id };
			}
		}
		return found;
	}
}
