import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	BillingError,
	CapabilityError,
	type CapabilityErrorDetails,
	capabilityErrorCodes,
	classifyBillingError,
	InternalBillingError,
	InvalidRequestError,
	NotConfiguredError,
	PersistenceConflictError,
} from "../../src/billing/errors";
import {
	type CapabilityLayer,
	capabilityLayers,
	capabilityReasonCodes,
	type RuntimeCapabilityVerdict,
} from "../../src/shared/provider-capabilities";

function blockedVerdict(layer: CapabilityLayer): RuntimeCapabilityVerdict {
	return {
		provider: "apple",
		operation: "checkout.hosted",
		outcome: "blocked",
		level: "unsupported",
		blockingLayer: layer,
		reasons: [{ code: "PROVIDER_UNSUPPORTED", layer }],
	};
}

describe("CapabilityError", () => {
	const expected: Record<
		CapabilityLayer,
		{ code: string; status: number; classification: BillingError["classification"] }
	> = {
		provider: {
			code: "PROVIDER_CAPABILITY_UNSUPPORTED",
			status: 400,
			classification: "invalid_request",
		},
		implementation: {
			code: "PROVIDER_CAPABILITY_UNSUPPORTED",
			status: 400,
			classification: "invalid_request",
		},
		configuration: {
			code: "PROVIDER_CAPABILITY_NOT_CONFIGURED",
			status: 409,
			classification: "not_configured",
		},
		operation: {
			code: "PROVIDER_ACTION_REQUIRED",
			status: 409,
			classification: "invalid_request",
		},
	};

	it("maps every blocking layer to its code, status and explicit classification", () => {
		expect(Object.keys(capabilityErrorCodes)).toEqual([...capabilityLayers]);
		for (const layer of capabilityLayers) {
			const details = { verdict: blockedVerdict(layer) };
			const error = new CapabilityError(`Blocked at ${layer}`, layer, details);
			expect(error).toBeInstanceOf(BillingError);
			expect({
				name: error.name,
				message: error.message,
				code: error.code,
				status: error.status,
				classification: error.classification,
				exposeMessage: error.exposeMessage,
				blockingLayer: error.blockingLayer,
			}).toEqual({
				name: "CapabilityError",
				message: `Blocked at ${layer}`,
				...expected[layer],
				exposeMessage: true,
				blockingLayer: layer,
			});
			const declared: (typeof expected)[CapabilityLayer] = capabilityErrorCodes[layer];
			expect(declared).toEqual(expected[layer]);
			expect(error.details).toBe(details);
		}
	});

	it("never classifies a 409 capability rejection as a persistence conflict", () => {
		for (const layer of ["configuration", "operation"] as const) {
			const error = new CapabilityError("Blocked", layer, { verdict: blockedVerdict(layer) });
			expect(error.status).toBe(409);
			expect(error.classification).not.toBe("persistence_conflict");
		}
		expect(new PersistenceConflictError("conflict").classification).toBe("persistence_conflict");
	});

	it("keeps PROVIDER_OPERATION_UNCERTAIN reserved", () => {
		const codes = Object.values(capabilityErrorCodes).map((entry) => entry.code);
		expect(new Set(codes)).toEqual(
			new Set([
				"PROVIDER_CAPABILITY_UNSUPPORTED",
				"PROVIDER_CAPABILITY_NOT_CONFIGURED",
				"PROVIDER_ACTION_REQUIRED",
			]),
		);
	});

	it("carries catalog compatibility details and exposes them when classified", () => {
		const details: CapabilityErrorDetails = {
			providerCompatibility: [
				{
					target: { kind: "plan", key: "pro" },
					provider: "apple",
					channel: "ios",
					productKey: "pro_monthly",
					requiredOperations: ["catalog.trial"],
					compatible: false,
					verdicts: [{ ...blockedVerdict("provider"), operation: "catalog.trial" }],
				},
			],
		};
		const error = new CapabilityError("Plan pro cannot bind apple", "provider", details);
		expect(classifyBillingError(error)).toEqual({
			code: "PROVIDER_CAPABILITY_UNSUPPORTED",
			message: "Plan pro cannot bind apple",
			status: 400,
			classification: "invalid_request",
			details,
		});
	});
});

describe("BillingError details", () => {
	it("leaves the details key absent when none are provided", () => {
		for (const error of [
			new BillingError("plain", "SOME_CODE"),
			new BillingError("explicit undefined", "SOME_CODE", 400, { details: undefined }),
			new InvalidRequestError("invalid"),
			new NotConfiguredError("Stripe provider is not configured", undefined, 503),
			new NotConfiguredError("Stripe provider is not configured", undefined, 503, undefined),
		]) {
			expect(Object.hasOwn(error, "details")).toBe(false);
			expect(error.details).toBeUndefined();
			expect(Object.hasOwn(classifyBillingError(error), "details")).toBe(false);
		}
	});

	it("adds details to NotConfiguredError without changing its code, status or classification", () => {
		const details = { provider: "stripe", adapterMethod: "reads.catalog" };
		const error = new NotConfiguredError(
			"Stripe catalog is not available",
			"BILLING_PROVIDER_NOT_CONFIGURED",
			503,
			details,
		);
		expect(error.details).toBe(details);
		expect(classifyBillingError(error)).toEqual({
			code: "BILLING_PROVIDER_NOT_CONFIGURED",
			message: "Stripe catalog is not available",
			status: 503,
			classification: "not_configured",
			details,
		});
		expect(new NotConfiguredError("Apple", undefined, undefined, details)).toMatchObject({
			code: "BILLING_PROVIDER_NOT_CONFIGURED",
			status: 501,
			classification: "not_configured",
		});
	});

	it("drops details together with the message when the message is not exposed", () => {
		const hidden = new BillingError("secret", "SOME_CODE", 500, {
			exposeMessage: false,
			details: { connection: "internal" },
		});
		expect(hidden.details).toEqual({ connection: "internal" });
		const classified = classifyBillingError(hidden);
		expect(classified).toEqual({
			code: "SOME_CODE",
			message: "Billing request failed",
			status: 500,
			classification: "internal",
		});
		expect(Object.hasOwn(classified, "details")).toBe(false);
	});
});

describe("classifyBillingError", () => {
	it("returns exactly the four envelope keys for errors without details", () => {
		expect(classifyBillingError(new InvalidRequestError("bad input"))).toEqual({
			code: "INVALID_REQUEST",
			message: "bad input",
			status: 400,
			classification: "invalid_request",
		});
		expect(Object.keys(classifyBillingError(new InternalBillingError("boom"))).sort()).toEqual([
			"classification",
			"code",
			"message",
			"status",
		]);
	});

	it("hides anything that is not a billing error", () => {
		const classified = classifyBillingError(
			Object.assign(new Error("database password"), { details: { secret: true } }),
		);
		expect(classified).toEqual({
			code: "INTERNAL_ERROR",
			message: "Billing request failed",
			status: 500,
			classification: "internal",
		});
		expect(Object.hasOwn(classified, "details")).toBe(false);
	});
});

describe("error inventory", () => {
	async function inventory(): Promise<Map<string, string[]>> {
		const registry = JSON.parse(
			await readFile(new URL("../../contracts/v1/errors.json", import.meta.url), "utf8"),
		) as {
			codes: Array<{ code: string; sources: string[] }>;
		};
		return new Map(registry.codes.map(({ code, sources }) => [code, sources]));
	}

	it("records the capability codes from src/billing/errors.ts and nothing reserved", async () => {
		const codes = await inventory();
		for (const { code } of Object.values(capabilityErrorCodes))
			expect(codes.get(code), code).toEqual(["src/billing/errors.ts"]);
		expect(
			[...codes.keys()].filter((code) => /^PROVIDER_(?:CAPABILITY|ACTION|OPERATION)_/.test(code)),
		).toEqual([
			"PROVIDER_ACTION_REQUIRED",
			"PROVIDER_CAPABILITY_NOT_CONFIGURED",
			"PROVIDER_CAPABILITY_UNSUPPORTED",
		]);
		expect(codes.has("PROVIDER_OPERATION_UNCERTAIN")).toBe(false);
		expect(
			[...codes]
				.filter(([, sources]) => sources.includes("src/billing/errors.ts"))
				.map(([code]) => code),
		).toEqual([
			"BILLING_PROVIDER_NOT_CONFIGURED",
			"BILLING_PROVIDER_UNAVAILABLE",
			"INTERNAL_ERROR",
			"INVALID_REQUEST",
			"NOT_FOUND",
			"PERSISTENCE_CONFLICT",
			"PROVIDER_ACTION_REQUIRED",
			"PROVIDER_CAPABILITY_NOT_CONFIGURED",
			"PROVIDER_CAPABILITY_UNSUPPORTED",
			"UNAUTHORIZED",
		]);
	});

	it("keeps capability reason codes out of the inventory", async () => {
		const codes = await inventory();
		// The platform's own connection error shares its name with a reason code.
		expect(
			capabilityReasonCodes
				.filter((code) => codes.has(code))
				.map((code) => [code, codes.get(code)]),
		).toEqual([["CONNECTION_VALIDATION_REQUIRED", ["src/platform/connections/lifecycle.ts"]]]);
		const capabilitySources = new Set([
			"src/shared/provider-capabilities.ts",
			"src/providers/capabilities.ts",
			"src/providers/catalog-compatibility-types.ts",
			"src/providers/registry.ts",
			"src/catalog/provider-compatibility.ts",
			"src/app/provider-services.ts",
		]);
		expect(
			[...codes]
				.filter(([, sources]) => sources.some((source) => capabilitySources.has(source)))
				.map(([code]) => code),
		).toEqual(["BILLING_PROVIDER_NOT_CONFIGURED"]);
	});

	it("keeps STRIPE_NOT_CONFIGURED to the Stripe service's own dependency guards", async () => {
		const codes = await inventory();
		expect(codes.get("STRIPE_NOT_CONFIGURED")).toEqual([
			"src/providers/stripe/payment-setup.ts",
			"src/providers/stripe/service.ts",
		]);
		expect(codes.get("BILLING_PROVIDER_NOT_CONFIGURED")).toEqual([
			"src/app/provider-services.ts",
			"src/billing/errors.ts",
		]);
	});
});
