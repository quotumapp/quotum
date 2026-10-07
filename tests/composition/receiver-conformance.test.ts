import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { request as httpRequest, IncomingMessage } from "node:http";
import type { request as httpsRequest } from "node:https";
import { checkReceiver } from "../../src/composition/cli/projections";
import { createConnectionValidation } from "../../src/composition/connection-validation";
import { verifyProjectionSignature } from "../../src/projections/http-types";

function receiver(status?: number, ignoreAuth = false, responseBody?: string) {
	return ((
		_url: URL,
		options: { headers: Record<string, string> },
		onResponse: (res: IncomingMessage) => void,
	) => {
		const req = new EventEmitter() as EventEmitter & {
			end: (body: string) => void;
			destroy: () => void;
		};
		req.destroy = () => {};
		req.end = (body) => {
			const headers = options.headers;
			const authenticated =
				ignoreAuth ||
				(headers.authorization === "Bearer secret" &&
					verifyProjectionSignature({
						secret: "secret",
						body,
						timestamp: headers["X-Billing-Timestamp"] ?? "",
						signature: headers["X-Billing-Signature"] ?? "",
					}));
			const res = new EventEmitter() as EventEmitter & { statusCode: number; destroy: () => void };
			res.statusCode = status ?? (authenticated ? 200 : 401);
			res.destroy = () => {};
			onResponse(res as IncomingMessage);
			res.emit(
				"data",
				Buffer.from(
					responseBody ?? JSON.stringify({ success: true, challenge: JSON.parse(body).challenge }),
				),
			);
			res.emit("end");
		};
		return req;
	}) as unknown as typeof httpRequest & typeof httpsRequest;
}
const policy = { allowedNetworks: ["10.20.0.0/16"], allowInsecureHttp: true };
const lookup = async () => [{ address: "10.20.0.9", family: 4 }];
describe("receiver diagnostics and conformance", () => {
	it("accepts a correct receiver and rejects one that ignores authentication", async () => {
		const request = receiver();
		expect(
			await checkReceiver("http://receiver.test", "sandbox", "secret", {
				policy,
				lookup,
				request,
				httpRequest: request,
			}),
		).toMatchObject({ success: true });
		const insecure = receiver(undefined, true);
		const result = await checkReceiver("http://receiver.test", "sandbox", "secret", {
			policy,
			lookup,
			request: insecure,
			httpRequest: insecure,
		});
		expect(result.success).toBe(false);
		expect(result.checks.filter((check) => !check.passed)).toHaveLength(3);
	});
	it.each([401, 404, 503])("preserves receiver HTTP %s in validation details", async (status) => {
		const request = receiver(status);
		const validator = createConnectionValidation({
			destinationPolicy: policy,
			destinationDependencies: { lookup, request, httpRequest: request },
		});
		await expect(
			validator.validate(
				"projection",
				"sandbox",
				{
					settings: { projectionUrl: "http://receiver.test" },
					secrets: { projectionSecret: "secret" },
				},
				{ instanceId: "instance", instanceKey: "sandbox", versionId: "version" },
			),
		).rejects.toMatchObject({
			code: "PROJECTION_VERIFICATION_FAILED",
			details: {
				checks: [{ check: "projection_verification", httpStatus: status, reason: "http_status" }],
			},
		});
	});
	it.each([
		["not-json", "invalid_json"],
		["null", "invalid_acknowledgment"],
		['{"success":true,"challenge":"wrong"}', "challenge_mismatch"],
	])("distinguishes invalid HTTP 200 responses: %s", async (body, reason) => {
		const request = receiver(200, false, body);
		const validator = createConnectionValidation({
			destinationPolicy: policy,
			destinationDependencies: { lookup, request, httpRequest: request },
		});
		await expect(
			validator.validate(
				"projection",
				"sandbox",
				{
					settings: { projectionUrl: "http://receiver.test" },
					secrets: { projectionSecret: "secret" },
				},
				{ instanceId: "instance", instanceKey: "sandbox", versionId: "version" },
			),
		).rejects.toMatchObject({
			details: { checks: [{ check: "projection_verification", httpStatus: 200, reason }] },
		});
	});

	it("explains rejection of standard Stripe keys without echoing credentials", () => {
		const validator = createConnectionValidation();
		try {
			validator.normalize("stripe", "sandbox", {
				settings: {
					checkoutSuccessUrl: "https://example.com/{CHECKOUT_SESSION_ID}",
					checkoutCancelUrl: "https://example.com/cancel",
					portalReturnUrl: "https://example.com/portal",
				},
				secrets: { secretKey: "sk_test_PRIVATE", webhookSecret: "whsec_PRIVATE" },
			});
			throw new Error("expected rejection");
		} catch (error) {
			expect(error).toMatchObject({
				code: "INVALID_CONNECTION",
				details: {
					checks: [{ check: "stripe_key", field: "secretKey", reason: "restricted_key_required" }],
				},
			});
			expect(JSON.stringify(error)).not.toContain("PRIVATE");
		}
	});
});
