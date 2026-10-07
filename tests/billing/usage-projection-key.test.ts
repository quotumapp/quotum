import { describe, expect, it } from "bun:test";
import {
	isUsageKey,
	usageDeliveryKey,
	usageKeySqlPrefix,
	usageProjectionKey,
} from "../../src/billing/usage-projection-key";

describe("usage projection keys", () => {
	it("keeps the coalescing key apart from the per-snapshot delivery key", () => {
		expect(usageProjectionKey("customer_1")).toBe("usage:customer_1");
		expect(usageDeliveryKey("customer_1", 7)).toBe("usage:customer_1:7");
		expect(isUsageKey(usageProjectionKey("customer_1"))).toBe(true);
		expect(isUsageKey(usageDeliveryKey("customer_1", 7))).toBe(true);
		expect(isUsageKey("purchase:txn_1")).toBe(false);
	});

	it("exposes the SQL prefix as a quoted literal that matches the key prefix", () => {
		expect(usageKeySqlPrefix).toBe("'usage:'");
		expect(usageProjectionKey("c")).toStartWith(usageKeySqlPrefix.slice(1, -1));
	});
});
