import { describe, expect, it } from "bun:test";
import { EntitlementService } from "../../src/billing/entitlements";

describe("EntitlementService", () => {
	it("returns entitlement snapshots from the repository", async () => {
		const service = new EntitlementService({
			getEntitlementSnapshot(_project, billingAccountId: string) {
				return Promise.resolve({
					billingAccountId,
					generatedAt: "2026-05-31T00:00:00.000Z",
					entitlements: [
						{
							key: "premium",
							active: true,
							expiresAt: "2026-06-30T00:00:00.000Z",
							metadata: { provider: "stripe" },
						},
					],
				});
			},
		});

		const snapshot = await service.getSnapshot({ projectKey: "wiseley" }, "user_1");

		expect(snapshot.entitlements[0]).toEqual({
			key: "premium",
			active: true,
			expiresAt: "2026-06-30T00:00:00.000Z",
			metadata: { provider: "stripe" },
		});
		expect(snapshot.billingAccountId).toBe("user_1");
	});

	it("rejects blank billing account ids before calling the repository", async () => {
		let called = false;
		const service = new EntitlementService({
			getEntitlementSnapshot() {
				called = true;
				return Promise.reject(new Error("should not be called"));
			},
		});

		await expect(service.getSnapshot({ projectKey: "wiseley" }, " ")).rejects.toThrow(
			"billingAccountId is required",
		);
		expect(called).toBe(false);
	});
});
