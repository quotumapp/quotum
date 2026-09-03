import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ProjectionContract } from "../billing/types";
import type { AppleBillingEnv, GooglePlayBillingEnv, StripeBillingEnv } from "../env";
import type { ProjectContext } from "./context";

export type ProjectApiKeyResolver = (apiKey: string) => ProjectContext | null;

export interface BillingCatalogDeclaration {
	key: string;
	name: string;
	kind: "subscription" | "topup";
	plan: string | null;
	currency: string;
	amountCents: number;
	credits: number;
	interval: "month" | "year" | null;
	entitlementKey: string;
	externalProductId: string;
	externalPriceId: string;
	active: boolean;
}

export interface ProjectRuntimeConfig {
	key: string;
	apiKey: string;
	active: boolean;
	projectionUrl: string;
	projectionSecret: string;
	projectionContract?: ProjectionContract;
	catalog?: BillingCatalogDeclaration[];
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

const catalogDeclarationSchema = z
	.object({
		key: z.string().trim().min(1).max(120),
		name: z.string().trim().min(1).max(120),
		kind: z.enum(["subscription", "topup"]),
		plan: z.string().trim().min(1).max(120).nullable(),
		currency: z
			.string()
			.trim()
			.regex(/^[A-Za-z]{3}$/u)
			.transform((value) => value.toUpperCase()),
		amountCents: z.number().int().positive().max(1_000_000),
		credits: z.number().int().positive().max(100_000),
		interval: z.enum(["month", "year"]).nullable(),
		entitlementKey: z.string().trim().min(1).max(120).default("paid"),
		externalProductId: z.string().trim().min(1).max(256),
		externalPriceId: z.string().trim().min(1).max(256),
		active: z.boolean().default(true),
	})
	.superRefine((declaration, context) => {
		const subscription = declaration.kind === "subscription";
		if (subscription !== (declaration.plan !== null && declaration.interval !== null)) {
			context.addIssue({
				code: "custom",
				message: "subscription catalog items require a plan and billing interval",
			});
		}
		if (!subscription && (declaration.plan !== null || declaration.interval !== null)) {
			context.addIssue({
				code: "custom",
				message: "top-up catalog items cannot contain subscription facts",
			});
		}
	});

const projectRuntimeConfigSchema = z.object({
	key: z
		.string()
		.trim()
		.min(1)
		.regex(/^[a-z0-9][a-z0-9_-]*$/, "project key must be a lowercase slug"),
	apiKey: z.string().min(16),
	active: z.boolean().default(true),
	projectionUrl: z.string().trim().url(),
	projectionSecret: z.string().trim().min(1),
	projectionContract: z.enum(["billing_state_v1"]).default("billing_state_v1"),
	catalog: z.array(catalogDeclarationSchema).max(16).default([]),
	apple: appleProjectConfigSchema.nullable().optional(),
	googlePlay: googlePlayProjectConfigSchema.nullable().optional(),
	stripe: stripeProjectConfigSchema.nullable().optional(),
});

const projectRuntimeConfigsSchema = z.array(projectRuntimeConfigSchema).min(1);

export function parseProjectRuntimeConfigs(value: string): ProjectRuntimeConfig[] {
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(value);
	} catch {
		throw new Error("BILLING_PROJECTS_JSON must be valid JSON");
	}

	const parsed = projectRuntimeConfigsSchema.safeParse(parsedJson);
	if (!parsed.success) {
		throw new Error("BILLING_PROJECTS_JSON is invalid");
	}

	const seenKeys = new Set<string>();
	const seenApiKeys = new Set<string>();
	for (const project of parsed.data) {
		if (seenKeys.has(project.key)) {
			throw new Error("BILLING_PROJECTS_JSON contains duplicate project keys");
		}
		if (seenApiKeys.has(project.apiKey)) {
			throw new Error("BILLING_PROJECTS_JSON contains duplicate project API keys");
		}
		seenKeys.add(project.key);
		seenApiKeys.add(project.apiKey);
		if (new Set(project.catalog.map((item) => item.key)).size !== project.catalog.length) {
			throw new Error("BILLING_PROJECTS_JSON contains duplicate catalog keys");
		}
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

export function createProjectApiKeyResolver(
	projects: readonly ProjectRuntimeConfig[],
): ProjectApiKeyResolver {
	return (apiKey) => {
		let resolvedProject: ProjectContext | null = null;

		for (const project of projects) {
			if (project.active && constantTimeEquals(apiKey, project.apiKey)) {
				resolvedProject = { projectKey: project.key };
			}
		}

		return resolvedProject;
	};
}

function constantTimeEquals(actual: string, expected: string): boolean {
	const actualBuffer = Buffer.from(actual, "utf8");
	const expectedBuffer = Buffer.from(expected, "utf8");

	if (actualBuffer.byteLength !== expectedBuffer.byteLength) {
		return false;
	}

	return timingSafeEqual(actualBuffer, expectedBuffer);
}
