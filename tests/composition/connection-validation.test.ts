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
		).rejects.toThrow("A public HTTPS destination is required");
		expect(requested).toHaveLength(1);
	});
});
