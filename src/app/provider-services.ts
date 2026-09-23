import { NotConfiguredError } from "../billing/errors";
import type { ProviderAdapterMethod } from "../providers/contract";
import type { ProviderRegistry } from "../providers/registry";
import type {
	AppleStoreKitServiceLike,
	GooglePlayBillingServiceLike,
	ProjectProviderServiceResolver,
	StripeBillingServiceLike,
} from "./types";

/** The request path's per-provider service lookups, answered by the provider registry. */
export function projectProviderServiceResolver(
	registry: ProviderRegistry,
): ProjectProviderServiceResolver {
	return {
		appleStoreKitService: (project, purpose = "new") => registry.service(project, "apple", purpose),
		googlePlayBillingService: (project, purpose = "new") =>
			registry.service(project, "google", purpose),
		stripeBillingService: (project, purpose = "new") =>
			registry.service(project, "stripe", purpose),
	};
}

export function requireAppleStoreKitService(
	service: AppleStoreKitServiceLike | null,
): AppleStoreKitServiceLike {
	if (service === null) {
		throw new NotConfiguredError(
			"Apple StoreKit provider is not configured",
			"BILLING_PROVIDER_NOT_CONFIGURED",
			501,
		);
	}

	return service;
}

export function requireGooglePlayBillingService(
	service: GooglePlayBillingServiceLike | null,
): GooglePlayBillingServiceLike {
	if (service === null) {
		throw new NotConfiguredError(
			"Google Play provider is not configured",
			"BILLING_PROVIDER_NOT_CONFIGURED",
			501,
		);
	}

	return service;
}

export function requireStripeBillingService(
	service: StripeBillingServiceLike | null,
): StripeBillingServiceLike {
	if (service === null) {
		throw new NotConfiguredError(
			"Stripe provider is not configured",
			"BILLING_PROVIDER_NOT_CONFIGURED",
			503,
		);
	}

	return service;
}

/** The optional Stripe service method behind each adapter method a request guard checks. */
const stripeGuardedMethods = {
	"reads.catalog": "getCatalog",
	"reads.billingAccount": "getBillingAccount",
	"commercial.preview": "previewCommercialAction",
	"commercial.execute": "executeCommercialAction",
	"commercial.requestChange": "requestSubscriptionChange",
	"checkout.createPlan": "createRecurringCheckoutSession",
	"paymentMethods.setupSession": "getPaymentSetupSession",
	"checkout.expire": "expireCheckoutSession",
} as const satisfies Partial<Record<ProviderAdapterMethod, keyof StripeBillingServiceLike>>;

type StripeGuardedAdapterMethod = keyof typeof stripeGuardedMethods;

/**
 * The service's method for `adapterMethod`, bound to it. A service without the method is a
 * provider that is not configured for it; `message` keeps the route's own wording.
 */
export function requireProviderMethod<M extends StripeGuardedAdapterMethod>(
	service: StripeBillingServiceLike,
	provider: "stripe",
	adapterMethod: M,
	message: string,
): NonNullable<StripeBillingServiceLike[(typeof stripeGuardedMethods)[M]]> {
	const method: unknown = service[stripeGuardedMethods[adapterMethod]];
	if (typeof method !== "function") {
		throw new NotConfiguredError(message, undefined, 503, { provider, adapterMethod });
	}
	return method.bind(service) as NonNullable<
		StripeBillingServiceLike[(typeof stripeGuardedMethods)[M]]
	>;
}
