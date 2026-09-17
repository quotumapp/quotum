import { describe, expect, it } from "bun:test";
import { wrapAppleService } from "../../../src/providers/apple/adapter";
import { appleCapabilities } from "../../../src/providers/apple/capabilities";
import type { ProviderAdapter, ProviderServiceSource } from "../../../src/providers/contract";

const serviceMethods = [
	"getOrCreateAppAccountToken",
	"verifyPurchase",
	"handleNotification",
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
	return { calls, results, service: service as unknown as ProviderServiceSource<"apple"> };
}

const forwardingCases: Array<
	[string, ServiceMethod, (adapter: ProviderAdapter<"apple">, input: never) => Promise<unknown>]
> = [
	["webhooks.ingest", "handleNotification", (adapter, input) => adapter.webhooks.ingest(input)],
	[
		"purchases.verify",
		"verifyPurchase",
		(adapter, input) => required(adapter.purchases).verify(input),
	],
	[
		"purchases.accountLink",
		"getOrCreateAppAccountToken",
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

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("adapter group is missing");
	return value;
}

describe("Apple adapter wrapper", () => {
	it("identifies the provider with its declaration and no account identity by default", () => {
		const adapter = wrapAppleService(recordingService().service);

		expect(adapter.provider).toBe("apple");
		expect(adapter.declaration).toBe(appleCapabilities);
		expect(adapter.accountIdentity).toBeNull();
		expect(wrapAppleService(recordingService().service, "com.voysee.app").accountIdentity).toBe(
			"com.voysee.app",
		);
	});

	it.each(forwardingCases)(
		"%s forwards its argument unchanged to %s and returns its result",
		async (_group, method, invoke) => {
			const { calls, results, service } = recordingService();
			const input = { marker: method };

			const result = await invoke(wrapAppleService(service), input as never);

			expect(calls).toHaveLength(1);
			expect(calls[0]?.method).toBe(method);
			expect(calls[0]?.args).toHaveLength(1);
			expect(calls[0]?.args[0]).toBe(input);
			expect(calls[0]?.receiver).toBe(service);
			expect(result).toBe(results.get(method));
		},
	);

	it("has no Stripe-only groups", () => {
		const adapter = wrapAppleService(recordingService().service);

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

	it("leaves replay and reconciliation undefined for a service without the worker ports", () => {
		const { service } = recordingService([
			"getOrCreateAppAccountToken",
			"verifyPurchase",
			"handleNotification",
		]);

		const adapter = wrapAppleService(service);

		expect(adapter.replay).toBeUndefined();
		expect(adapter.reconciliation).toBeUndefined();
		expect(adapter.purchases).toBeDefined();
	});
});
