import { describe, expect, it } from "bun:test";
import { ZodError } from "zod";
import { paddleConfigSchema } from "../../../src/providers/paddle/config";
import { paddleRequiredEvents } from "../../../src/providers/paddle/connection";
import {
	requirePaddlePreflightEnvironment,
	runPaddlePreflight,
} from "../../../src/testing/paddle-preflight";
import { binding, config, price } from "./fixtures";

describe("Paddle sandbox preflight", () => {
	it("reports malformed payment URLs as validation failures", () => {
		for (const paymentPageUrl of ["invalid", "/relative", "https://", "http://example.com/pay"]) {
			expect(paddleConfigSchema.safeParse({ ...config, paymentPageUrl }).success).toBe(false);
		}
	});
	it("rejects malformed webhook URLs before any provider request", async () => {
		let requests = 0;
		await expect(
			runPaddlePreflight(
				{ connection: config, webhookUrl: "invalid", bindings: [binding] },
				async () => {
					requests++;
					return Response.json({});
				},
			),
		).rejects.toBeInstanceOf(ZodError);
		expect(requests).toBe(0);
	});
	it("requires explicit test guards before reading a credential file", () => {
		const env = {
			BILLING_ENV: "test",
			BILLING_TEST_PADDLE_SANDBOX: "true",
			BILLING_TEST_PADDLE_CONFIG_FILE: "/private/config.json",
		};
		expect(requirePaddlePreflightEnvironment(env)).toBe(env.BILLING_TEST_PADDLE_CONFIG_FILE);
		for (const invalid of [
			{ ...env, BILLING_ENV: "production" },
			{ ...env, BILLING_TEST_PADDLE_SANDBOX: "false" },
			{ ...env, BILLING_TEST_PADDLE_CONFIG_FILE: "" },
		])
			expect(() => requirePaddlePreflightEnvironment(invalid)).toThrow("requires");
	});
	it("performs reads only and does not confuse preflight with qualification or expose secrets", async () => {
		const webhookUrl = "https://billing.example/v1/webhooks/paddle/acme";
		const result = await runPaddlePreflight(
			{ connection: config, webhookUrl, bindings: [binding] },
			async (url, init) => {
				expect(init?.method).toBe("GET");
				return Response.json({
					data: String(url).includes("notification-settings")
						? {
								id: config.notificationSettingId,
								type: "url",
								destination: webhookUrl,
								active: true,
								api_version: 1,
								endpoint_secret_key: config.webhookSecret,
								traffic_source: "platform",
								subscribed_events: paddleRequiredEvents.map((name) => ({ name })),
							}
						: price,
				});
			},
		);
		expect(result).toMatchObject({
			status: "preflight_passed",
			qualification: "pending",
			validatedPriceIds: [price.id],
		});
		expect(JSON.stringify(result)).not.toContain(config.apiKey);
		expect(JSON.stringify(result)).not.toContain(config.webhookSecret);
	});
});
