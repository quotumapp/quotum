import { z } from "zod";
import type { ProjectionContract } from "../billing/types";
import type { AppleBillingEnv, GooglePlayBillingEnv, StripeBillingEnv } from "../env";

export interface ProjectRuntimeConfig {
	projectInstanceKey: string;
	projectionUrl: string;
	projectionSecret: string;
	projectionContract?: ProjectionContract;
	apple?: AppleBillingEnv | null;
	googlePlay?: GooglePlayBillingEnv | null;
	stripe?: StripeBillingEnv | null;
}

const appleProjectConfigSchema = z
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

const googlePlayProjectConfigSchema = z
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

const stripeProjectConfigSchema = z
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

const projectRuntimeConfigSchema = z
	.object({
		projectInstanceKey: z
			.string()
			.trim()
			.min(1)
			.max(80)
			.regex(/^[a-z0-9][a-z0-9_-]*$/, "project key must be a lowercase slug"),
		projectionUrl: z.string().trim().url(),
		projectionSecret: z.string().trim().min(1),
		projectionContract: z.enum(["billing_state_v1"]).default("billing_state_v1"),
		apple: appleProjectConfigSchema.nullable().optional(),
		googlePlay: googlePlayProjectConfigSchema.nullable().optional(),
		stripe: stripeProjectConfigSchema.nullable().optional(),
	})
	.strict();

const projectRuntimeConfigsSchema = z.array(projectRuntimeConfigSchema).min(1);

export function parseProjectRuntimeConfigs(value: string): ProjectRuntimeConfig[] {
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(value);
	} catch {
		throw new Error("BILLING_PROJECT_RUNTIME_JSON must be valid JSON");
	}

	const parsed = projectRuntimeConfigsSchema.safeParse(parsedJson);
	if (!parsed.success) {
		throw new Error("BILLING_PROJECT_RUNTIME_JSON is invalid");
	}

	const seenKeys = new Set<string>();
	for (const project of parsed.data) {
		if (seenKeys.has(project.projectInstanceKey)) {
			throw new Error("BILLING_PROJECT_RUNTIME_JSON contains duplicate project instance keys");
		}
		seenKeys.add(project.projectInstanceKey);
	}

	return parsed.data.map((project) =>
		project.stripe === null || project.stripe === undefined
			? project
			: {
					...project,
					stripe: {
						...project.stripe,
						allowedReturnOrigins:
							project.stripe.allowedReturnOrigins ?? defaultStripeOrigins(project.stripe),
					},
				},
	);
}

function defaultStripeOrigins(config: {
	checkoutSuccessUrl: string;
	checkoutCancelUrl: string;
	portalReturnUrl: string;
}): string[] {
	return [
		...new Set(
			[config.checkoutSuccessUrl, config.checkoutCancelUrl, config.portalReturnUrl].map(
				(value) => new URL(value).origin,
			),
		),
	];
}
