import { describe, expect, it } from "bun:test";
import { contractBody } from "../../src/app/controls-routes";
import {
	commercialActionExecuteBodySchema,
	commercialActionPreviewBodySchema,
} from "../../src/app/customer-routes";

describe("billing request validation", () => {
	it("trims checkout URLs and preserves omitted and nullable fields", () => {
		const intent = { kind: "checkout_plan", planKey: "pro" } as const;
		expect(commercialActionPreviewBodySchema.parse({ intent })).toEqual({
			intent: { ...intent, quantities: {} },
		});
		expect(
			commercialActionPreviewBodySchema.parse({
				intent: {
					...intent,
					successUrl: " https://app.example.com/success?session_id={CHECKOUT_SESSION_ID} ",
					cancelUrl: null,
				},
			}).intent,
		).toMatchObject({
			successUrl: "https://app.example.com/success?session_id={CHECKOUT_SESSION_ID}",
			cancelUrl: null,
		});
	});

	it("retains safe positive integer limits on checkout quantities", () => {
		for (const quantity of [1, Number.MAX_SAFE_INTEGER, 0, -1, 1.5, 2 ** 53, Infinity, NaN]) {
			const result = commercialActionPreviewBodySchema.safeParse({
				intent: { kind: "checkout_plan", planKey: "pro", quantities: { seats: quantity } },
			});
			expect(result.success, String(quantity)).toBe(Number.isSafeInteger(quantity) && quantity > 0);
		}
	});

	it("accepts UTC and explicit timestamp offsets but rejects local and malformed dates", () => {
		const body = {
			billingAccountId: "account_1",
			contractKey: "contract",
			version: 1,
			planKey: "pro",
		};
		for (const effectiveAt of ["2026-09-16T12:30:00Z", "2026-09-16T12:30:00+03:00"]) {
			expect(contractBody.parse({ ...body, effectiveAt, expiresAt: null })).toEqual({
				...body,
				effectiveAt,
				expiresAt: null,
			});
		}
		for (const effectiveAt of ["2026-09-16T12:30:00", "2026-02-30T12:30:00Z", "bad"]) {
			expect(contractBody.safeParse({ ...body, effectiveAt }).success).toBe(false);
		}
	});

	it("keeps commercial preview tokens strict without introducing UUID trimming", () => {
		const previewToken = "123e4567-e89b-12d3-a456-426614174000";
		expect(commercialActionExecuteBodySchema.parse({ previewToken })).toEqual({ previewToken });
		for (const value of ["bad", ` ${previewToken} `, null]) {
			expect(commercialActionExecuteBodySchema.safeParse({ previewToken: value }).success).toBe(
				false,
			);
		}
	});
});
