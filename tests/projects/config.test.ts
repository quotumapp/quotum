import { describe, expect, it } from "bun:test";
import {
	googlePlayProjectConfigSchema,
	stripeProjectConfigSchema,
} from "../../src/projects/config";

const stripeConfig = {
	secretKey: "sk_test_fixture",
	webhookSecret: "whsec_fixture",
	checkoutSuccessUrl: "https://app.example.com/success?session_id={CHECKOUT_SESSION_ID}",
	checkoutCancelUrl: "https://app.example.com/cancel",
	portalReturnUrl: "https://app.example.com/billing",
};

describe("provider configuration URL validation", () => {
	it("trims Stripe URLs and origins without rewriting the checkout placeholder", () => {
		const config = stripeProjectConfigSchema.parse({
			...stripeConfig,
			checkoutSuccessUrl: ` \t${stripeConfig.checkoutSuccessUrl} \n`,
			checkoutCancelUrl: ` ${stripeConfig.checkoutCancelUrl} `,
			portalReturnUrl: ` ${stripeConfig.portalReturnUrl} `,
			allowedReturnOrigins: [" https://app.example.com ", " http://localhost:3000 "],
		});
		expect(config).toMatchObject({
			...stripeConfig,
			allowedReturnOrigins: ["https://app.example.com", "http://localhost:3000"],
		});
	});

	it("requires the Stripe checkout session placeholder", () => {
		expect(() =>
			stripeProjectConfigSchema.parse({
				...stripeConfig,
				checkoutSuccessUrl: "https://app.example.com/success",
			}),
		).toThrow("Stripe checkout success URL must include the session placeholder");
	});

	it("rejects malformed return URLs", () => {
		for (const field of ["checkoutSuccessUrl", "checkoutCancelUrl", "portalReturnUrl"]) {
			expect(
				stripeProjectConfigSchema.safeParse({ ...stripeConfig, [field]: "not a URL" }).success,
			).toBe(false);
		}
	});

	it("requires exact HTTP origins without paths, queries, or credentials", () => {
		for (const origin of [
			"https://app.example.com/",
			"https://app.example.com/path",
			"https://app.example.com?query=1",
			"https://user:password@app.example.com",
			"ftp://app.example.com",
		]) {
			expect(
				stripeProjectConfigSchema.safeParse({
					...stripeConfig,
					allowedReturnOrigins: [origin],
				}).success,
			).toBe(false);
		}
	});

	it("trims the Google RTDN audience while preserving complete and disabled auth configs", () => {
		const config = {
			packageName: "com.example.app",
			serviceAccountJson: "{}",
			serviceAccountKeyFile: null,
			obfuscatedAccountIdSecret: "fixture-secret",
			rtdnAudience: " https://billing.example.com/google \n",
			rtdnServiceAccountEmail: "pubsub@example.iam.gserviceaccount.com",
			rtdnAuthorizedParty: "fixture-party",
			enablePublisherMutations: false,
		};
		expect(googlePlayProjectConfigSchema.parse(config).rtdnAudience).toBe(
			"https://billing.example.com/google",
		);
		expect(
			googlePlayProjectConfigSchema.safeParse({ ...config, rtdnAudience: "not a URL" }).success,
		).toBe(false);
		expect(googlePlayProjectConfigSchema.safeParse({ ...config, rtdnAudience: null }).success).toBe(
			false,
		);
		expect(
			googlePlayProjectConfigSchema.parse({
				...config,
				rtdnAudience: null,
				rtdnServiceAccountEmail: null,
				rtdnAuthorizedParty: null,
			}).rtdnAudience,
		).toBeNull();
	});
});
