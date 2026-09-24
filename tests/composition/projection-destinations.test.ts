import { describe, expect, it } from "bun:test";
import { projectionDestinationPolicy } from "../../src/composition/projection-destinations";
import { publicDestinationPolicy } from "../../src/shared/safe-http";

const receivers = { allowedNetworks: ["10.20.0.0/16"], allowInsecureHttp: true };

describe("projectionDestinationPolicy", () => {
	it("keeps public HTTPS when no private network is approved", () => {
		expect(projectionDestinationPolicy({}, true)).toBe(publicDestinationPolicy);
		expect(projectionDestinationPolicy({}, false)).toBe(publicDestinationPolicy);
	});

	it("approves private receivers only for a headless deployment", () => {
		expect(projectionDestinationPolicy({ projectionReceivers: receivers }, false)).toBe(receivers);
		expect(() => projectionDestinationPolicy({ projectionReceivers: receivers }, true)).toThrow(
			"BILLING_PROJECTION_ALLOWED_NETWORKS and BILLING_PROJECTION_ALLOW_INSECURE_HTTP require QUOTUM_MERCHANT_ENABLED=false",
		);
	});
});
