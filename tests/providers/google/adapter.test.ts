import { describe, expect, it } from "bun:test";
import type { ProviderAdapter, ProviderServiceSource } from "../../../src/providers/contract";
import { wrapGoogleService } from "../../../src/providers/google/adapter";
import { googleCapabilities } from "../../../src/providers/google/capabilities";

const serviceMethods = [
	"getAccountLink",
	"verifyPurchase",
	"handleRtdn",
	"verifyRtdnAuthorization",
	"replayStoreEvent",
	"reconcileSubscription",
] as const;

type ServiceMethod = (typeof serviceMethods)[number];

function recordingService(methods: readonly ServiceMethod[] = serviceMethods) {
	const calls: Array<{ method: string; args: unknown[]; receiver: unknown }> = [];
	const results = new Map<string, unknown>();
	const service: Record<string, unknown> = {};
	for (const method of methods) {
		const result = { result: method };
		results.set(method, result);
		service[method] = function (this: unknown, ...args: unknown[]) {
			calls.push({ method, args, receiver: this });
			return Promise.resolve(result);
		};
	}
	return { calls, results, service: service as unknown as ProviderServiceSource<"google"> };
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("adapter method is missing");
	return value;
}

const forwardingCases: Array<
	[string, ServiceMethod, (adapter: ProviderAdapter<"google">, input: never) => Promise<unknown>]
> = [
	["webhooks.ingest", "handleRtdn", (adapter, input) => adapter.webhooks.ingest(input)],
	[
		"webhooks.verifyAuthorization",
		"verifyRtdnAuthorization",
		(adapter, input) => required(adapter.webhooks.verifyAuthorization)(input),
	],
	[
		"purchases.verify",
		"verifyPurchase",
		(adapter, input) => required(adapter.purchases).verify(input),
	],
	[
		"purchases.accountLink",
		"getAccountLink",
		(adapter, input) => required(adapter.purchases).accountLink(input),
	],
	[
		"replay.replayStoreEvent",
		"replayStoreEvent",
		(adapter, input) => required(adapter.replay).replayStoreEvent(input),
	],
	[
		"reconciliation.reconcileSubscription",
		"reconcileSubscription",
		(adapter, input) => required(adapter.reconciliation).reconcileSubscription(input),
	],
];

describe("Google adapter wrapper", () => {
	it("identifies the provider with its declaration and no account identity by default", () => {
		const adapter = wrapGoogleService(recordingService().service);

		expect(adapter.provider).toBe("google");
		expect(adapter.declaration).toBe(googleCapabilities);
		expect(adapter.accountIdentity).toBeNull();
	});

	it.each(forwardingCases)(
		"%s forwards its argument unchanged to %s and returns its result",
		async (_group, method, invoke) => {
			const { calls, results, service } = recordingService();
			const input = { marker: method };

			const result = await invoke(wrapGoogleService(service), input as never);

			expect(calls).toHaveLength(1);
			expect(calls[0]?.method).toBe(method);
			expect(calls[0]?.args).toHaveLength(1);
			expect(calls[0]?.args[0]).toBe(input);
			expect(calls[0]?.receiver).toBe(service);
			expect(result).toBe(results.get(method));
		},
	);

	it("has no Stripe-only groups", () => {
		const adapter = wrapGoogleService(recordingService().service);

		for (const group of [
			"checkout",
			"portal",
			"commercial",
			"changes",
			"settlement",
			"topups",
			"promotions",
			"reads",
		] as const) {
			expect(adapter[group]).toBeUndefined();
		}
	});

	it("leaves optional methods and worker-port groups undefined when the service lacks them", () => {
		const { service } = recordingService(["getAccountLink", "verifyPurchase", "handleRtdn"]);

		const adapter = wrapGoogleService(service);

		expect(Object.hasOwn(adapter.webhooks, "verifyAuthorization")).toBe(false);
		expect(adapter.replay).toBeUndefined();
		expect(adapter.reconciliation).toBeUndefined();
		expect(adapter.purchases).toBeDefined();
	});
});
