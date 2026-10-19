import { describe, expect, it } from "bun:test";
import {
	checkRequestBody,
	confirmRequestBody,
	consumeRequestBody,
	reserveRequestBody,
} from "../../scripts/lib/load-requests";
import { checkBodySchema, consumeBodySchema } from "../../src/app/contracts/usage-api";
import { confirmBodySchema, reserveBodySchema } from "../../src/app/metering-routes";

describe("load lane request bodies", () => {
	it("are accepted by the routes' own strict schemas", () => {
		expect(checkBodySchema.safeParse(checkRequestBody()).success).toBe(true);
		expect(consumeBodySchema.safeParse(consumeRequestBody()).success).toBe(true);
		expect(reserveBodySchema.safeParse(reserveRequestBody("100")).success).toBe(true);
		expect(confirmBodySchema.safeParse(confirmRequestBody("100")).success).toBe(true);
	});

	it("keep every field the lane sends after parsing", () => {
		// A strict schema refuses unknown keys, but an optional key it did not read would be
		// dropped silently; compare what survives parsing with what was sent.
		expect(consumeBodySchema.parse(consumeRequestBody("7"))).toEqual(consumeRequestBody("7"));
		expect(checkBodySchema.parse(checkRequestBody("7"))).toEqual(checkRequestBody("7"));
		expect(reserveBodySchema.parse(reserveRequestBody("100", 60))).toEqual(
			reserveRequestBody("100", 60),
		);
		expect(confirmBodySchema.parse(confirmRequestBody("100"))).toEqual(confirmRequestBody("100"));
	});

	it("are told apart from the legacy check and consume bodies the API refuses", () => {
		const legacy = { featureKey: "model_tokens", quantity: "1" };
		expect(checkBodySchema.safeParse(legacy).success).toBe(false);
		expect(consumeBodySchema.safeParse(legacy).success).toBe(false);
		// Reservations use the same public featureId/value vocabulary.
		expect(reserveBodySchema.safeParse({ ...legacy, expiresInSeconds: 60 }).success).toBe(false);
		expect(reserveBodySchema.safeParse(consumeRequestBody()).success).toBe(true);
	});
});
