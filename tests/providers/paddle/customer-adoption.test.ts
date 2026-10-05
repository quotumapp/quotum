import { describe, expect, it } from "bun:test";
import { RejectedProviderWrite } from "../../../src/billing/provider-operations";
import { PaddleClient, PaddleRequestRejected } from "../../../src/providers/paddle/client";
import {
	adoptExistingPaddleCustomer,
	paddleCustomerIdFromDetail,
} from "../../../src/providers/paddle/customer-adoption";
import {
	paddleExistingCustomerReceiptCode,
	paddleOperationFailed,
} from "../../../src/providers/paddle/operation-errors";
import { id } from "./fixtures";

const existing = id("ctm", "e");
const entry = (overrides: Record<string, unknown> = {}) => ({
	id: existing,
	email: "buyer@example.com",
	status: "active",
	...overrides,
});
const reader = (handler: (path: string) => unknown) => ({
	get: async (path: string) => handler(path) as never,
});
const outcome = async (input: Parameters<typeof adoptExistingPaddleCustomer>[0]) => {
	try {
		return await adoptExistingPaddleCustomer(input);
	} catch (error) {
		return error instanceof RejectedProviderWrite ? error.code : error;
	}
};

describe("Paddle existing customer adoption", () => {
	it("reads the conflicting customer id from Paddle's detail only when it is well formed", () => {
		expect(
			paddleCustomerIdFromDetail(`customer email conflicts with customer of ID ${existing}`),
		).toBe(existing);
		expect(
			paddleCustomerIdFromDetail("customer email conflicts with customer of ID ctm_short"),
		).toBeNull();
		expect(paddleCustomerIdFromDetail(null)).toBeNull();
	});

	it("links one active customer with the same email, by id or by lookup", async () => {
		const claimed: string[] = [];
		const claim = async (customerId: string) => {
			claimed.push(customerId);
			return "linked" as const;
		};
		const byId = reader((path) => {
			expect(path).toBe(`/customers/${existing}`);
			return { data: entry({ email: "Buyer@Example.com" }) };
		});
		expect(
			await adoptExistingPaddleCustomer({
				client: byId,
				claim,
				email: "buyer@example.com",
				hintedCustomerId: existing,
			}),
		).toEqual({ customerId: existing });
		const byEmail = reader((path) => {
			expect(path).toContain("/customers?email=buyer%40example.com");
			return {
				data: [entry(), entry({ id: id("ctm", "f"), status: "archived" })],
				meta: { pagination: { has_more: false } },
			};
		});
		expect(
			await adoptExistingPaddleCustomer({
				client: byEmail,
				claim,
				email: "buyer@example.com",
				hintedCustomerId: null,
			}),
		).toEqual({ customerId: existing });
		expect(claimed).toEqual([existing, existing]);
	});

	it("names the reason it refused and never claims in those cases", async () => {
		let claims = 0;
		const claim = async () => {
			claims++;
			return "linked" as const;
		};
		const page = (data: unknown[], hasMore = false) =>
			reader(() => ({ data, meta: { pagination: { has_more: hasMore } } }));
		const run = (client: ReturnType<typeof reader>, hinted: string | null = null) =>
			outcome({ client, claim, email: "buyer@example.com", hintedCustomerId: hinted });
		expect(
			await run(
				reader(() => ({ data: entry({ status: "archived" }) })),
				existing,
			),
		).toBe(paddleExistingCustomerReceiptCode("inactive"));
		expect(
			await run(
				reader(() => ({ data: entry({ email: "other@example.com" }) })),
				existing,
			),
		).toBe(paddleExistingCustomerReceiptCode("email_mismatch"));
		expect(await run(page([entry(), entry({ id: id("ctm", "f") })]))).toBe(
			paddleExistingCustomerReceiptCode("ambiguous"),
		);
		expect(await run(page([]))).toBe(paddleExistingCustomerReceiptCode("ambiguous"));
		expect(await run(page([entry()], true))).toBe(paddleExistingCustomerReceiptCode("ambiguous"));
		expect(await run(page([entry({ status: "archived" })]))).toBe(
			paddleExistingCustomerReceiptCode("inactive"),
		);
		expect(claims).toBe(0);
		expect(
			await outcome({
				client: page([entry()]),
				claim: async () => "claimed",
				email: "buyer@example.com",
				hintedCustomerId: null,
			}),
		).toBe(paddleExistingCustomerReceiptCode("claimed"));
	});

	it("fails the key without a claim when Paddle cannot answer, and lets other rejections through", async () => {
		const claim = async () => "linked" as const;
		const unreachable = new PaddleClient({ apiKey: "pdl_sdbx_test_only" }, async () => {
			throw new Error("network");
		});
		expect(
			await outcome({
				client: unreachable,
				claim,
				email: "buyer@example.com",
				hintedCustomerId: null,
			}),
		).toBe("PADDLE_UNAVAILABLE");
		expect(
			await outcome({
				client: reader(() => ({ data: { id: "not-a-customer" } })),
				claim,
				email: "buyer@example.com",
				hintedCustomerId: existing,
			}),
		).toBe("PADDLE_UNAVAILABLE");
		const rejected = new PaddleRequestRejected(404, "not_found", null);
		const missing = await outcome({
			client: { get: async () => Promise.reject(rejected) },
			claim,
			email: "buyer@example.com",
			hintedCustomerId: existing,
		});
		expect(missing).toBe("not_found");
	});

	it("turns the receipt code into the typed refusal, with the reason", () => {
		const refusal = paddleOperationFailed({
			id: "op-1",
			errorCode: paddleExistingCustomerReceiptCode("claimed"),
		});
		expect(refusal).toMatchObject({
			code: "PADDLE_CUSTOMER_ALREADY_EXISTS",
			status: 409,
			details: { operationId: "op-1", status: "failed", reason: "claimed" },
		});
		expect(
			paddleOperationFailed({ id: "op-2", errorCode: "PADDLE_UNAVAILABLE" }).message,
		).toContain("retry with a new Idempotency-Key");
	});

	it("keeps Paddle's error detail on a rejection for id parsing", async () => {
		const client = new PaddleClient(
			{ apiKey: "pdl_sdbx_test_only" },
			async () =>
				Response.json(
					{ error: { code: "customer_already_exists", detail: `conflicts with ${existing}` } },
					{ status: 409 },
				),
			Date.now,
			{ get: () => 0, set: () => {} },
		);
		await expect(client.write("POST", "/customers", {})).rejects.toMatchObject({
			status: 409,
			code: "customer_already_exists",
			detail: `conflicts with ${existing}`,
		});
	});
});
