import { z } from "zod";
import { previewSchema } from "../../app/catalog-routes";
import { MerchantError } from "../../platform/security";
import { stripeProjectConfigSchema } from "../../projects/config";

const https = z.url().refine((value) => {
	const url = new URL(value);
	return url.protocol === "https:" && !url.username && !url.password && !url.hash;
}, "An HTTPS URL without credentials or fragment is required");
const productFields = {
	productKey: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
	name: z.string().trim().min(1).max(120),
	kind: z.enum(["subscription", "topup", "gift"]),
	entitlementKey: z.string().trim().min(1).max(120),
	credits: z.number().int().min(0).max(100_000),
};
const binding = z
	.discriminatedUnion("source", [
		z
			.object({
				...productFields,
				source: z.literal("reuse"),
				externalProductId: z.string().regex(/^prod_[A-Za-z0-9]+$/),
				externalPriceId: z.string().regex(/^price_[A-Za-z0-9]+$/),
			})
			.strict(),
		z
			.object({
				...productFields,
				source: z.literal("create"),
				currency: z.string().regex(/^[a-z]{3}$/),
				unitAmountMinor: z.number().int().positive().max(99_999_999),
				interval: z.enum(["day", "week", "month", "year"]).optional(),
				intervalCount: z.number().int().min(1).max(365).default(1),
				taxBehavior: z.enum(["exclusive", "inclusive", "unspecified"]).default("unspecified"),
			})
			.strict(),
	])
	.superRefine((value, ctx) => {
		if (value.kind === "topup" && value.credits === 0)
			ctx.addIssue({ code: "custom", message: "Top-ups require credits" });
		if (value.kind === "gift" && value.credits !== 0)
			ctx.addIssue({ code: "custom", message: "Gifts have no credits" });
		if (
			value.source === "create" &&
			(value.kind === "subscription") !== (value.interval !== undefined)
		)
			ctx.addIssue({ code: "custom", message: "Only subscriptions require a recurring interval" });
	});

export const stripeSetupManifestSchema = previewSchema
	.extend({
		version: z.literal(1),
		instance: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
		accountId: z.string().regex(/^acct_[A-Za-z0-9]+$/),
		environment: z.enum(["sandbox", "production"]),
		publicOrigin: https.refine(
			(value) => new URL(value).origin === value,
			"Use an origin without a path",
		),
		settings: z
			.object({
				checkoutSuccessUrl: stripeProjectConfigSchema.shape.checkoutSuccessUrl,
				checkoutCancelUrl: stripeProjectConfigSchema.shape.checkoutCancelUrl,
				portalReturnUrl: stripeProjectConfigSchema.shape.portalReturnUrl,
				allowedReturnOrigins: stripeProjectConfigSchema.shape.allowedReturnOrigins,
				taxMode: stripeProjectConfigSchema.shape.taxMode,
				integrationIdentifier: stripeProjectConfigSchema.shape.integrationIdentifier,
			})
			.strict(),
		bindings: z.array(binding).min(1).max(100),
		webhook: z.discriminatedUnion("source", [
			z.object({ source: z.literal("create") }).strict(),
			z
				.object({ source: z.literal("reuse"), endpointId: z.string().regex(/^we_[A-Za-z0-9]+$/) })
				.strict(),
		]),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (new Set(value.bindings.map((item) => item.productKey)).size !== value.bindings.length)
			ctx.addIssue({ code: "custom", message: "Product keys must be unique" });
	});
export type StripeSetupManifest = z.infer<typeof stripeSetupManifestSchema>;
export type SetupBinding = StripeSetupManifest["bindings"][number];

export const setupCredentialsSchema = z
	.object({
		setupKey: z.string().regex(/^rk_(test|live)_\S+$/),
		runtimeKey: z.string().regex(/^rk_(test|live)_\S+$/),
		webhookSecret: z
			.string()
			.regex(/^whsec_\S+$/)
			.optional(),
	})
	.strict();
export type SetupCredentials = z.infer<typeof setupCredentialsSchema>;

/** A bounded, deliberate diagnostic; never propagate Stripe messages or credential values. */
export class SetupFailure extends Error {
	constructor(readonly reason: string) {
		super(reason);
	}
}

const permission = z.string().regex(/^[a-z_]{1,64}_(read|write)$/);
export const setupDiagnosticsSchema = z.object({
	checks: z
		.array(
			z.object({
				check: permission,
				reason: z.enum([
					"authentication_failed",
					"missing_permission",
					"provider_unavailable",
					"rate_limited",
				]),
				missingPermission: permission.optional(),
				httpStatus: z.number().int().min(400).max(599).optional(),
			}),
		)
		.max(32),
	missingPermissions: z.array(permission).max(32),
	unverifiedPermissions: z.array(permission).max(32),
});
/** Only permission tokens and fixed diagnostic vocabulary can leave the provider boundary. */
export function setupDiagnostics(error: unknown) {
	if (!(error instanceof MerchantError) || error.code !== "STRIPE_CONNECTION_INVALID") return null;
	const result = setupDiagnosticsSchema.safeParse(error.details);
	return result.success ? result.data : null;
}

export const stripeSetupEvents = [
	"checkout.session.completed",
	"checkout.session.async_payment_succeeded",
	"checkout.session.async_payment_failed",
	"checkout.session.expired",
	"invoice.paid",
	"invoice.payment_failed",
	"customer.subscription.created",
	"customer.subscription.updated",
	"customer.subscription.deleted",
	"customer.subscription.trial_will_end",
	"refund.created",
	"refund.updated",
	"charge.refunded",
	"charge.dispute.created",
] as const;
