import { describe, expect, it } from "bun:test";
import type { AvailableActionFacts } from "../../src/billing/insights";
import {
	admittedProviders,
	providerCapabilityCatalog,
	providerCapabilityDeclaration,
	runtimeCapabilityDeclaration,
} from "../../src/providers/capabilities";
import type { SubscriptionPendingChange } from "../../src/providers/capability-read-types";
import {
	accountActionConditionKinds,
	accountActionOperations,
	createProviderCapabilityReads,
	subscriptionActionConditionKinds,
	subscriptionActionOperations,
} from "../../src/providers/capability-reads";
import type { ProviderConnectionState } from "../../src/providers/registry";
import { stripeCapabilities } from "../../src/providers/stripe/capabilities";
import {
	type BillingProvider,
	type CapabilityConditionKind,
	type ProviderCapabilityDeclaration,
	type ProviderOperation,
	providerOperations,
	type RuntimeCapabilityVerdict,
} from "../../src/shared/provider-capabilities";
import { projectInstanceContext } from "../helpers/project-context";

const project = projectInstanceContext();
const generatedAt = "2026-09-18T12:00:00.000Z";
const now = () => new Date(generatedAt);

function configured(overrides: { enabled?: boolean; validated?: boolean } = {}) {
	const enabled = overrides.enabled ?? true;
	const validated = overrides.validated ?? true;
	return {
		connection: {
			configured: true,
			enabled,
			validated,
			validatedAt: validated ? "2026-09-18T11:00:00.000Z" : null,
			accountIdentity: null,
		},
		configuration: { connectionEnabled: enabled, connectionValidated: validated, accountFlags: {} },
	} satisfies ProviderConnectionState;
}

const undescribed: ProviderConnectionState = { connection: null, configuration: undefined };

function reads(input: {
	states?: Partial<Record<BillingProvider, ProviderConnectionState>>;
	admitted?: BillingProvider[];
	facts?: AvailableActionFacts;
	capabilities?: ReadonlyMap<BillingProvider, ProviderCapabilityDeclaration>;
}) {
	const described: BillingProvider[] = [];
	const factCalls: string[] = [];
	const service = createProviderCapabilityReads({
		registry: {
			admitted: () => [...(input.admitted ?? admittedProviders())],
			async describe(_project, provider) {
				described.push(provider);
				return input.states?.[provider] ?? configured();
			},
		},
		facts: {
			async getAvailableActionFacts(_project, billingAccountId) {
				factCalls.push(billingAccountId);
				return input.facts ?? { customerExists: true, subscriptions: [] };
			},
		},
		...(input.capabilities === undefined ? {} : { capabilities: input.capabilities }),
		now,
	});
	return { service, described, factCalls };
}

function verdict(
	verdicts: readonly RuntimeCapabilityVerdict[],
	provider: BillingProvider,
	operation: ProviderOperation,
): RuntimeCapabilityVerdict {
	const found = verdicts.find(
		(entry) => entry.provider === provider && entry.operation === operation,
	);
	if (found === undefined) throw new Error(`missing ${provider} ${operation}`);
	return found;
}

type FactSubscription = AvailableActionFacts["subscriptions"][number];

function subscription(overrides: Partial<FactSubscription> = {}): FactSubscription {
	return {
		externalSubscriptionId: "sub_1",
		provider: "stripe",
		channel: "web",
		status: "active",
		planKey: "pro",
		currentPeriodEnd: "2026-10-18T12:00:00.000Z",
		cancelAtPeriodEnd: false,
		pendingChange: null,
		...overrides,
	};
}

describe("provider environment capabilities", () => {
	it("evaluates every operation in contract order through the configuration layer", async () => {
		const { service, described } = reads({
			states: {
				apple: undescribed,
				google: configured(),
				stripe: configured({ enabled: false }),
			},
		});

		const result = await service.environment(project);

		expect(result.schemaVersion).toBe(1);
		expect(result.generatedAt).toBe(generatedAt);
		expect(described).toEqual(["apple", "google", "stripe"]);
		expect(
			result.providers.map(({ provider, channel, connectionKind }) => ({
				provider,
				channel,
				connectionKind,
			})),
		).toEqual([
			{ provider: "apple", channel: "ios", connectionKind: "apple" },
			{ provider: "google", channel: "android", connectionKind: "google" },
			{ provider: "stripe", channel: "web", connectionKind: "stripe" },
		]);
		for (const entry of result.providers) {
			expect(entry.operations.map((operation) => operation.operation)).toEqual([
				...providerOperations,
			]);
			for (const operation of entry.operations) {
				expect(operation.provider).toBe(entry.provider);
				expect(operation.reasons.filter((reason) => reason.layer === "operation")).toEqual([]);
			}
		}

		const [apple, google, stripe] = result.providers;
		expect(apple?.connection).toBeNull();
		const unknown = verdict(apple?.operations ?? [], "apple", "purchase.verify");
		expect(unknown.outcome).toBe("undetermined");
		expect(unknown.reasons.map((reason) => reason.code)).toEqual([
			"FACT_UNAVAILABLE",
			"FACT_UNAVAILABLE",
		]);
		expect(verdict(google?.operations ?? [], "google", "purchase.verify").outcome).toBe(
			"available",
		);
		expect(stripe?.connection).toMatchObject({ configured: true, enabled: false });
		const disabled = verdict(stripe?.operations ?? [], "stripe", "checkout.hosted");
		expect(disabled).toMatchObject({ outcome: "blocked", blockingLayer: "configuration" });
		expect(disabled.reasons).toEqual([
			{
				code: "CONNECTION_DISABLED",
				layer: "configuration",
				condition: { kind: "connection_enabled" },
				observed: { connectionEnabled: false },
				resolution: { kind: "merchant_configuration", connectionKind: "stripe" },
			},
		]);
		// Recovery operations need a validated connection, not an enabled one.
		expect(verdict(stripe?.operations ?? [], "stripe", "webhook.ingest").outcome).toBe("available");
	});
});

describe("billing account available actions", () => {
	it("reports the account actions of every admitted provider", async () => {
		const { service, described, factCalls } = reads({});

		const result = await service.availableActions(project, "acct_1");

		expect(described).toEqual(["apple", "google", "stripe"]);
		expect(factCalls).toEqual(["acct_1"]);
		expect(result).toMatchObject({
			schemaVersion: 1,
			billingAccountId: "acct_1",
			customerExists: true,
			generatedAt,
			subscriptions: [],
		});
		expect(result.account.map((entry) => `${entry.provider}:${entry.operation}`)).toEqual(
			admittedProviders().flatMap((provider) =>
				accountActionOperations.map((operation) => `${provider}:${operation}`),
			),
		);
		expect(verdict(result.account, "stripe", "checkout.hosted").outcome).toBe("available");
		expect(verdict(result.account, "google", "purchase.verify").outcome).toBe("available");
		expect(verdict(result.account, "apple", "checkout.hosted")).toMatchObject({
			outcome: "blocked",
			blockingLayer: "provider",
		});
		// Only a provider call could tell whether a payment method is saved, so none is made.
		const automatic = verdict(result.account, "stripe", "topup.automatic");
		expect(automatic).toMatchObject({ outcome: "undetermined", blockingLayer: null });
		expect(automatic.reasons).toEqual([
			{
				code: "FACT_UNAVAILABLE",
				layer: "operation",
				condition: {
					kind: "saved_payment_method",
					required: true,
					resolveWith: "topup.customer_initiated",
				},
				observed: { savedPaymentMethod: "unknown" },
				resolution: { kind: "checked_at_execution" },
			},
		]);
	});

	it("evaluates subscription actions against the subscription's own provider and state", async () => {
		const pendingChange: SubscriptionPendingChange = {
			changeId: "11111111-1111-4111-8111-111111111111",
			status: "pending",
			effectiveMode: "period_end",
			effectiveAt: "2026-10-18T12:00:00.000Z",
		};
		const { service } = reads({
			facts: {
				customerExists: true,
				subscriptions: [
					subscription({ pendingChange }),
					subscription({ externalSubscriptionId: "sub_expired", status: "expired" }),
					subscription({
						externalSubscriptionId: "gpa.1",
						provider: "google",
						channel: "android",
						planKey: null,
						currentPeriodEnd: null,
					}),
				],
			},
		});

		const result = await service.availableActions(project, "acct_1");
		const [active, expired, google] = result.subscriptions;

		expect(active).toMatchObject({
			id: "sub_1",
			provider: "stripe",
			channel: "web",
			status: "active",
			planKey: "pro",
			currentPeriodEnd: "2026-10-18T12:00:00.000Z",
			cancelAtPeriodEnd: false,
			pendingChange,
		});
		for (const entry of result.subscriptions) {
			expect(entry.actions.map((action) => action.operation)).toEqual([
				...subscriptionActionOperations,
			]);
			expect(entry.actions.every((action) => action.provider === entry.provider)).toBe(true);
		}
		// Cancelling is available; uncancelling is blocked because nothing is pending to clear.
		expect(active?.actions.map((action) => action.outcome)).toEqual([
			"available",
			"available",
			"available",
			"available",
			"blocked",
		]);
		expect(active?.actions.at(-1)?.reasons).toEqual([
			expect.objectContaining({
				code: "CANCELLATION_NOT_PENDING",
				observed: { cancellationPending: false },
			}),
		]);
		expect(expired?.pendingChange).toBeNull();
		for (const action of expired?.actions ?? []) {
			expect(action).toMatchObject({ outcome: "blocked", blockingLayer: "operation" });
			expect(action.reasons[0]).toMatchObject({
				code: "SUBSCRIPTION_STATE",
				observed: { subscriptionState: "expired" },
			});
		}
		// Uncancelling an expired subscription is blocked on both of its operation conditions.
		expect(expired?.actions.at(-1)?.reasons.map((reason) => reason.code)).toEqual([
			"SUBSCRIPTION_STATE",
			"CANCELLATION_NOT_PENDING",
		]);
		expect(google?.actions.map((action) => action.reasons[0]?.code)).toEqual([
			"PROVIDER_UNSUPPORTED",
			"PROVIDER_MANAGED",
			"PROVIDER_MANAGED",
			"PROVIDER_MANAGED",
			"PROVIDER_MANAGED",
		]);
	});

	it("leaves connection conditions undetermined when a provider has no configuration facts", async () => {
		const facts: AvailableActionFacts = {
			customerExists: true,
			// A pending cancellation, so no operation fact is decided against the subscription and
			// only the missing configuration facts are left to report.
			subscriptions: [subscription({ cancelAtPeriodEnd: true })],
		};
		const undescribedStripe = reads({ states: { stripe: undescribed }, facts });
		const unadmittedStripe = reads({ admitted: ["apple", "google"], facts });

		const results = await Promise.all(
			[undescribedStripe, unadmittedStripe].map(({ service }) =>
				service.availableActions(project, "acct_1"),
			),
		);
		for (const result of results) {
			const [entry] = result.subscriptions;
			expect(entry?.actions).toHaveLength(subscriptionActionOperations.length);
			for (const action of entry?.actions ?? []) {
				expect(action).toMatchObject({ outcome: "undetermined", blockingLayer: null });
				expect(action.reasons).toEqual([
					expect.objectContaining({
						code: "FACT_UNAVAILABLE",
						condition: { kind: "connection_enabled" },
					}),
					expect.objectContaining({
						code: "FACT_UNAVAILABLE",
						condition: { kind: "connection_validated" },
					}),
				]);
			}
		}
		expect(unadmittedStripe.described).toEqual(["apple", "google"]);
		expect(new Set(results[1]?.account.map((entry) => entry.provider))).toEqual(
			new Set(["apple", "google"]),
		);
	});

	it("passes the renewal date and the read time to renewal windows", async () => {
		const windowed: ProviderCapabilityDeclaration = {
			...stripeCapabilities,
			operations: {
				...stripeCapabilities.operations,
				"subscription.change.apply": {
					...stripeCapabilities.operations["subscription.change.apply"],
					conditions: [{ kind: "renewal_exclusion_window", minutes: 60 }],
				},
			},
		};
		const capabilities = new Map<BillingProvider, ProviderCapabilityDeclaration>([
			["apple", providerCapabilityDeclaration("apple")],
			["google", providerCapabilityDeclaration("google")],
			["stripe", windowed],
		]);
		const { service } = reads({
			capabilities,
			facts: {
				customerExists: true,
				subscriptions: [
					subscription({ currentPeriodEnd: "2026-09-18T12:30:00.000Z" }),
					subscription({ externalSubscriptionId: "sub_open", currentPeriodEnd: null }),
				],
			},
		});

		const [renewing, open] = (await service.availableActions(project, "acct_1")).subscriptions;

		expect(verdict(renewing?.actions ?? [], "stripe", "subscription.change.apply").reasons).toEqual(
			[
				{
					code: "RENEWAL_EXCLUSION_WINDOW",
					layer: "operation",
					condition: { kind: "renewal_exclusion_window", minutes: 60 },
					observed: { nextRenewalAt: "2026-09-18T12:30:00.000Z", now: generatedAt, minutes: 60 },
					resolution: { kind: "wait_until", at: "2026-09-18T12:30:00.000Z" },
				},
			],
		);
		expect(verdict(open?.actions ?? [], "stripe", "subscription.change.apply")).toMatchObject({
			outcome: "undetermined",
			reasons: [
				expect.objectContaining({
					code: "FACT_UNAVAILABLE",
					observed: { nextRenewalAt: null, now: generatedAt },
				}),
			],
		});
	});

	it("still evaluates account actions for an unknown billing account", async () => {
		const { service } = reads({ facts: { customerExists: false, subscriptions: [] } });

		const result = await service.availableActions(project, "acct_missing");

		expect(result).toMatchObject({
			billingAccountId: "acct_missing",
			customerExists: false,
			subscriptions: [],
		});
		expect(result.account).toHaveLength(
			admittedProviders().length * accountActionOperations.length,
		);
	});
});

/** Condition kinds on `operations` that the available-actions facts do not decide. */
function unmappedKinds(
	declaration: ProviderCapabilityDeclaration,
	operations: readonly ProviderOperation[],
	mapped: readonly CapabilityConditionKind[],
): string[] {
	return operations.flatMap((operation) =>
		declaration.operations[operation].conditions
			.filter((condition) => !mapped.includes(condition.kind))
			.map((condition) => `${declaration.provider}:${operation}:${condition.kind}`),
	);
}

describe("available-actions coverage", () => {
	it("keeps admitted declarations within the condition kinds the facts decide", () => {
		for (const provider of admittedProviders()) {
			const declaration = providerCapabilityCatalog.get(provider);
			if (declaration === undefined) throw new Error(`missing ${provider}`);
			const runtime = runtimeCapabilityDeclaration(declaration);
			expect(unmappedKinds(runtime, accountActionOperations, accountActionConditionKinds)).toEqual(
				[],
			);
			expect(
				unmappedKinds(runtime, subscriptionActionOperations, subscriptionActionConditionKinds),
			).toEqual([]);
		}
	});

	it("flags a condition kind the facts do not decide", () => {
		const currency: ProviderCapabilityDeclaration = {
			...stripeCapabilities,
			operations: {
				...stripeCapabilities.operations,
				"checkout.hosted": {
					...stripeCapabilities.operations["checkout.hosted"],
					conditions: [{ kind: "currency", allowed: ["USD"] }],
				},
			},
		};
		expect(unmappedKinds(currency, accountActionOperations, accountActionConditionKinds)).toEqual([
			"stripe:checkout.hosted:currency",
		]);
	});
});
