import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { request as httpRequest, IncomingMessage } from "node:http";
import type { request as httpsRequest } from "node:https";
import { createConnectionValidation } from "../../src/composition/connection-validation";
import type { ConnectionInput } from "../../src/platform/connections/ports";
import { MerchantError } from "../../src/platform/security";

const privateReceivers = { allowedNetworks: ["10.20.0.0/16"], allowInsecureHttp: true };
const context = {
	instanceId: "instance-id",
	instanceKey: "example-sandbox",
	versionId: "version-id",
};

function projection(projectionUrl: string, projectionSecret?: string): ConnectionInput {
	const secrets: Record<string, string> = {};
	if (projectionSecret !== undefined) secrets.projectionSecret = projectionSecret;
	return { settings: { projectionUrl }, secrets };
}

/** A receiver that echoes the verification challenge, recording each URL it was sent. */
function echoingReceiver(requested: string[]) {
	return ((url: URL, _options: unknown, onResponse?: (res: IncomingMessage) => void) => {
		const req = new EventEmitter() as EventEmitter & {
			end: (payload: string) => void;
			destroy: () => void;
		};
		req.destroy = () => undefined;
		req.end = (payload) => {
			requested.push(url.toString());
			const { challenge } = JSON.parse(payload) as { challenge: string };
			const res = new EventEmitter() as EventEmitter & { statusCode: number; destroy: () => void };
			res.statusCode = 200;
			res.destroy = () => undefined;
			onResponse?.(res as IncomingMessage);
			res.emit("data", Buffer.from(JSON.stringify({ success: true, challenge })));
			res.emit("end");
		};
		return req;
	}) as unknown as typeof httpRequest & typeof httpsRequest;
}

describe("projection connection validation", () => {
	it("accepts an http receiver URL only when the destination policy allows plain http", () => {
		const publicOnly = createConnectionValidation();
		expect(() =>
			publicOnly.normalize("projection", "sandbox", projection("http://receiver.internal:8080")),
		).toThrow(MerchantError);
		expect(
			publicOnly.normalize("projection", "sandbox", projection("https://backend.example/billing"))
				.settings,
		).toEqual({ projectionUrl: "https://backend.example/billing" });

		const headless = createConnectionValidation({ destinationPolicy: privateReceivers });
		expect(
			headless.normalize("projection", "production", projection("http://receiver.internal:8080"))
				.settings,
		).toEqual({ projectionUrl: "http://receiver.internal:8080" });
		expect(() =>
			headless.normalize("projection", "sandbox", projection("ftp://receiver.internal")),
		).toThrow(MerchantError);
	});

	it("verifies a private receiver through the destination policy", async () => {
		const requested: string[] = [];
		const receiver = echoingReceiver(requested);
		const lookup = async () => [{ address: "10.20.0.9", family: 4 }];
		const headless = createConnectionValidation({
			destinationPolicy: privateReceivers,
			destinationDependencies: { lookup, request: receiver, httpRequest: receiver },
		});
		await expect(
			headless.validate(
				"projection",
				"sandbox",
				projection("http://receiver.internal:8080/billing", "receiver-secret"),
				context,
			),
		).resolves.toEqual({
			identity: "http://receiver.internal:8080",
			eventVerified: true,
			checks: [{ code: "PROJECTION_DELIVERY", passed: true }],
		});
		expect(requested).toEqual([
			"http://receiver.internal:8080/billing/internal/billing/projections/verify",
		]);

		// The merchant platform's public default refuses the same receiver.
		const publicOnly = createConnectionValidation({
			destinationDependencies: { lookup, request: receiver, httpRequest: receiver },
		});
		await expect(
			publicOnly.validate(
				"projection",
				"sandbox",
				projection("https://receiver.internal/billing", "receiver-secret"),
				context,
			),
		).rejects.toMatchObject({ code: "PROJECTION_RECEIVER_UNREACHABLE", status: 422 });
		expect(requested).toHaveLength(1);
	});

	it("answers a refused, unresolvable or failing receiver with one 422", async () => {
		const failing = ((_url: URL, _options: unknown) => {
			const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
			req.destroy = () => undefined;
			req.end = () => req.emit("error", new Error("connect ECONNREFUSED"));
			return req;
		}) as unknown as typeof httpRequest & typeof httpsRequest;
		const addresses: Record<string, string> = {
			"private.example.com": "10.0.0.5",
			"metadata.example.com": "169.254.169.254",
			"down.example.com": "93.184.215.14",
		};
		const validation = createConnectionValidation({
			destinationDependencies: {
				lookup: async (hostname) => {
					const address = addresses[hostname];
					if (!address)
						throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
							code: "ENOTFOUND",
						});
					return [{ address, family: 4 }];
				},
				request: failing,
			},
		});
		const answers = [];
		for (const hostname of [...Object.keys(addresses), "missing.example.com"]) {
			const failure = await validation
				.validate("projection", "sandbox", projection(`https://${hostname}`, "secret"), context)
				.catch((error: unknown) => error);
			expect(failure).toBeInstanceOf(MerchantError);
			answers.push({
				code: (failure as MerchantError).code,
				status: (failure as MerchantError).status,
				message: (failure as MerchantError).message,
			});
		}
		expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
		expect(answers[0]).toMatchObject({ code: "PROJECTION_RECEIVER_UNREACHABLE", status: 422 });
	});

	it("keeps a local fault out of the receiver answer", async () => {
		const broken = (() => {
			throw new TypeError("request is not a function");
		}) as unknown as typeof httpRequest & typeof httpsRequest;
		const validation = createConnectionValidation({
			destinationDependencies: {
				lookup: async () => [{ address: "93.184.215.14", family: 4 }],
				request: broken,
			},
		});
		const failure = await validation
			.validate(
				"projection",
				"sandbox",
				projection("https://receiver.example.com", "secret"),
				context,
			)
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(TypeError);
	});
});

describe("Paddle connection custody", () => {
	const settings = {
		notificationSettingId: `ntfset_${"a".repeat(26)}`,
		paymentPageUrl: "https://merchant.example/pay",
		clientToken: "test_example",
		webhookUrl: "https://billing.example/v1/projects/example-sandbox/webhooks/paddle",
	};
	const secrets = { apiKey: "pdl_sdbx_example", webhookSecret: "sandbox-webhook-secret-example" };
	it("separates credentials and refuses production or incorrectly placed secrets", () => {
		const validation = createConnectionValidation();
		expect(validation.normalize("paddle", "sandbox", { settings, secrets })).toEqual({
			settings,
			secrets,
		});
		expect(() => validation.normalize("paddle", "production", { settings, secrets })).toThrow(
			MerchantError,
		);
		expect(() =>
			validation.normalize("paddle", "sandbox", {
				settings: { ...settings, apiKey: secrets.apiKey },
				secrets,
			}),
		).toThrow(MerchantError);
		expect(() =>
			validation.normalize("paddle", "sandbox", {
				settings,
				secrets: { ...secrets, clientToken: settings.clientToken },
			}),
		).toThrow(MerchantError);
		expect(() =>
			validation.normalize("paddle", "sandbox", {
				settings,
				secrets: { ...secrets, apiKey: "pdl_live_example" },
			}),
		).toThrow(MerchantError);
	});
	it("rejects foreign ingress and production before any provider call", async () => {
		const validation = createConnectionValidation();
		await expect(
			validation.validate("paddle", "production", { settings, secrets }, context),
		).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
		for (const webhookUrl of [
			"http://billing.example/v1/projects/example-sandbox/webhooks/paddle",
			"https://billing.example/v1/projects/foreign/webhooks/paddle",
			`${settings.webhookUrl}?secret=x`,
		]) {
			await expect(
				validation.validate(
					"paddle",
					"sandbox",
					{ settings: { ...settings, webhookUrl }, secrets },
					context,
				),
			).rejects.toMatchObject({ code: "CONNECTION_INVALID" });
		}
	});
});
