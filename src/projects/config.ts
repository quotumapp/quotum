import { z } from "zod";

export const appleProjectConfigSchema = z
	.object({
		bundleId: z.string().trim().min(1),
		appAppleId: z.number().int().positive().nullable(),
		issuerId: z.string().trim().min(1),
		keyId: z.string().trim().min(1),
		privateKey: z.string().trim().min(1),
		environment: z.enum(["sandbox", "production"]),
		enableOnlineChecks: z.boolean(),
		rootCertificatesDir: z.string().trim().min(1).nullable(),
	})
	.strict()
	.superRefine((config, context) => {
		if (config.environment !== "production") {
			return;
		}
		if (config.appAppleId === null) {
			context.addIssue({ code: "custom", message: "production Apple config requires appAppleId" });
		}
		if (!config.enableOnlineChecks) {
			context.addIssue({
				code: "custom",
				message: "production Apple config requires online checks",
			});
		}
	});

export const googlePlayProjectConfigSchema = z
	.object({
		packageName: z.string().trim().min(1),
		serviceAccountJson: z.string().trim().min(1).nullable(),
		serviceAccountKeyFile: z.string().trim().min(1).nullable(),
		obfuscatedAccountIdSecret: z.string().trim().min(1),
		previousObfuscatedAccountIdSecrets: z.array(z.string().trim().min(1)).default([]),
		rtdnAudience: z.string().trim().url().nullable(),
		rtdnServiceAccountEmail: z.string().trim().min(1).nullable(),
		rtdnAuthorizedParty: z.string().trim().min(1).nullable().default(null),
		enablePublisherMutations: z.boolean(),
	})
	.strict()
	.superRefine((config, context) => {
		if ((config.serviceAccountJson === null) === (config.serviceAccountKeyFile === null)) {
			context.addIssue({
				code: "custom",
				message: "Google config requires exactly one service account source",
			});
		}
		const rtdnValues = [
			config.rtdnAudience,
			config.rtdnServiceAccountEmail,
			config.rtdnAuthorizedParty,
		];
		if (rtdnValues.some((value) => value !== null) && rtdnValues.some((value) => value === null)) {
			context.addIssue({ code: "custom", message: "Google RTDN auth config must be complete" });
		}
		const previousSecrets = new Set(config.previousObfuscatedAccountIdSecrets);
		if (
			previousSecrets.size !== config.previousObfuscatedAccountIdSecrets.length ||
			previousSecrets.has(config.obfuscatedAccountIdSecret)
		) {
			context.addIssue({ code: "custom", message: "Google account id secrets must be unique" });
		}
	});

export const stripeProjectConfigSchema = z
	.object({
		secretKey: z.string().trim().min(1),
		webhookSecret: z.string().trim().min(1),
		checkoutSuccessUrl: z.string().trim().url(),
		checkoutCancelUrl: z.string().trim().url(),
		portalReturnUrl: z.string().trim().url(),
		allowedReturnOrigins: z
			.array(
				z
					.string()
					.trim()
					.url()
					.refine((value) => {
						const url = new URL(value);
						return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
					}, "must be an HTTP origin"),
			)
			.min(1)
			.optional(),
		taxMode: z.enum(["disabled", "test", "registered"]).default("disabled"),
		integrationIdentifier: z
			.string()
			.trim()
			.regex(/^[a-z0-9_-]*[a-z]{8}$/u)
			.max(64)
			.default("qfmxzjpa"),
	})
	.strict()
	.superRefine((config, context) => {
		if (!config.checkoutSuccessUrl.includes("{CHECKOUT_SESSION_ID}")) {
			context.addIssue({
				code: "custom",
				message: "Stripe checkout success URL must include the session placeholder",
				path: ["checkoutSuccessUrl"],
			});
		}
		if (config.taxMode === "test" && !/^[sr]k_test_/u.test(config.secretKey)) {
			context.addIssue({
				code: "custom",
				message: "Stripe tax test mode requires a Stripe test key",
				path: ["taxMode"],
			});
		}
	});
