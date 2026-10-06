import { describe, expect, it } from "bun:test";
import { createBillingChangesPort } from "../../src/composition/billing-changes";
import type { BillingRepository } from "../../src/db/repository";
import type {
	MerchantBillingCommand,
	MerchantBillingPort,
} from "../../src/platform/application/billing-port";

const context = { projectInstanceId: "00000000-0000-4000-8000-000000000001", actor: "tester" };

/**
 * A change port over a fake billing port. The account summary answers like the real one: the same
 * state on every read, stamped with the time of that read.
 */
function changes(state: { available: string }) {
	const applied: MerchantBillingCommand[] = [];
	let reads = 0;
	const port = {
		dispatch: async (command: MerchantBillingCommand) => {
			if (command.operation === "account.summary") {
				reads += 1;
				return {
					status: 200,
					body: {
						success: true,
						data: {
							billingAccountId: command.parameters[0],
							generatedAt: new Date(Date.UTC(2026, 9, 6, 12, 0, reads)).toISOString(),
							balances: [{ featureKey: "ai_credits", available: state.available }],
						},
					},
				};
			}
			if (command.idempotencyKey?.startsWith("mcp:")) applied.push(command);
			return { status: 200, body: { success: true, data: { reset: true } } };
		},
	} as unknown as MerchantBillingPort;
	const repository = {
		administrationTarget: async () => [{ id: "7", cooldown_until: null }],
		previewAdministration: async (work: (repository: BillingRepository) => Promise<unknown>) =>
			work(repository),
		withAdministrationReceipt: async (
			_project: string,
			_key: string,
			_hash: string,
			work: (repository: BillingRepository) => Promise<unknown>,
		) => work(repository),
	} as unknown as BillingRepository;
	return { port: createBillingChangesPort(repository, () => port), applied };
}

const reset = { action: "topups.reset", parameters: ["customer-a", "7"], body: {} };

describe("billing change fingerprint", () => {
	it("applies a change whose reviewed read only differs in when it was generated", async () => {
		const { port, applied } = changes({ available: "100" });
		const preview = await port.prepare(context, reset);
		// The reviewer sees the state, not the read's timestamp.
		expect(preview.before).toEqual({
			configuration: {
				success: true,
				data: {
					billingAccountId: "customer-a",
					balances: [{ featureKey: "ai_credits", available: "100" }],
				},
			},
			target: [{ id: "7", cooldown_until: null }],
		});
		expect(await port.apply(context, preview, "mcp:change-1")).toMatchObject({ status: 200 });
		expect(applied.map((command) => command.operation)).toEqual(["topups.reset"]);
	});

	it("still refuses a change when the reviewed state itself changed", async () => {
		const state = { available: "100" };
		const { port, applied } = changes(state);
		const preview = await port.prepare(context, reset);
		state.available = "40";
		expect(await port.apply(context, preview, "mcp:change-1")).toEqual({
			status: 409,
			body: {
				success: false,
				error: {
					code: "BILLING_CHANGE_STALE",
					message: "The reviewed state changed. Prepare a new proposal.",
				},
			},
		});
		expect(applied).toEqual([]);
	});
});
