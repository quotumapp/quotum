import { z } from "zod";
import {
	capabilityBillingIntervals,
	capabilityCollectionMethods,
	capabilityLayers,
	capabilityReasonCodes,
	catalogCompatibilityTargetKinds,
	providerOperations,
} from "./provider-capabilities";

/**
 * Wire mirrors of the provider capability contract in `./provider-capabilities.ts` that both the
 * billing and platform surfaces embed. `src/app/contracts/provider-responses.ts` re-exports the
 * PascalCase schemas as named OpenAPI components.
 */
export const ProviderOperationSchema = z.enum(providerOperations);

export const CapabilityConditionSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("connection_enabled") }),
	z.object({ kind: z.literal("connection_validated") }),
	z.object({
		kind: z.literal("account_flag"),
		flag: z.string(),
		expected: z.array(z.union([z.string(), z.boolean()])),
	}),
	z.object({ kind: z.literal("currency"), allowed: z.array(z.string()) }),
	z.object({ kind: z.literal("catalog_bound") }),
	z.object({ kind: z.literal("subscription_state"), allowed: z.array(z.string()) }),
	z.object({ kind: z.literal("cancellation_pending"), required: z.literal(true) }),
	z.object({
		kind: z.literal("collection_method"),
		allowed: z.array(z.enum(capabilityCollectionMethods)),
	}),
	z.object({
		kind: z.literal("billing_interval"),
		allowed: z.array(z.enum(capabilityBillingIntervals)),
	}),
	z.object({ kind: z.literal("uniform_billing_interval") }),
	z.object({
		kind: z.literal("saved_payment_method"),
		required: z.literal(true),
		resolveWith: ProviderOperationSchema.optional(),
	}),
	z.object({ kind: z.literal("renewal_exclusion_window"), minutes: z.number() }),
	z.object({ kind: z.literal("requires_prior"), operation: ProviderOperationSchema }),
	z.object({
		kind: z.literal("amount_bounds"),
		minMinor: z.number().optional(),
		maxMinor: z.number().optional(),
	}),
	z.object({ kind: z.literal("quantity_integer") }),
]);

export const CapabilityResolutionSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("customer_action"), operation: ProviderOperationSchema.optional() }),
	z.object({
		kind: z.literal("merchant_configuration"),
		connectionKind: z.string(),
		flag: z.string().optional(),
	}),
	z.object({ kind: z.literal("wait_until"), at: z.string() }),
	z.object({ kind: z.literal("checked_at_execution") }),
	z.object({ kind: z.literal("none") }),
]);

export const CapabilityReasonSchema = z.object({
	code: z.enum(capabilityReasonCodes),
	layer: z.enum(capabilityLayers),
	condition: CapabilityConditionSchema.optional(),
	observed: z
		.record(z.string(), z.union([z.null(), z.string(), z.number(), z.boolean()]))
		.optional(),
	resolution: CapabilityResolutionSchema.optional(),
});

/** Renders inline wherever it is embedded; it is never a named component. */
export const catalogCompatibilityTargetSchema = z.object({
	kind: z.enum(catalogCompatibilityTargetKinds),
	key: z.string(),
	priceKey: z.union([z.null(), z.string()]).optional(),
});
