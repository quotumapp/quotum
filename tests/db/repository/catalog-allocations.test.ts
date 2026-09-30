import { describe, expect, it } from "bun:test";
import {
	snapshotPredates,
	snapshotPredatesChange,
} from "../../../src/db/repository/catalog-allocations";

describe("snapshotPredatesChange", () => {
	const change = { id: "42", appliedAt: new Date("2026-09-30T10:00:10.500Z") };
	const snapshot = (billingChangeId: string | null | undefined, createdAt: Date | null) => ({
		previousStoreProductId: null,
		createdAt,
		...(billingChangeId === undefined ? {} : { billingChangeId }),
	});

	it("trusts the change stamp over the clocks", () => {
		// Stamped by the change itself: taken after it reached the provider, whatever the clocks say.
		expect(snapshotPredatesChange(snapshot("42", new Date("2026-09-30T10:00:00Z")), change)).toBe(
			false,
		);
		expect(snapshotPredatesChange(snapshot("42", null), change)).toBe(false);
		// Stamped by another change, or by none: taken before it, even when read live or later.
		expect(snapshotPredatesChange(snapshot("41", new Date("2026-09-30T10:05:00Z")), change)).toBe(
			true,
		);
		expect(snapshotPredatesChange(snapshot(null, null), change)).toBe(true);
	});

	it("falls back to the clocks only for a snapshot without metadata", () => {
		expect(
			snapshotPredatesChange(snapshot(undefined, new Date("2026-09-30T10:00:09Z")), change),
		).toBe(true);
		expect(
			snapshotPredatesChange(snapshot(undefined, new Date("2026-09-30T10:00:11Z")), change),
		).toBe(false);
	});
});

describe("snapshotPredates", () => {
	const appliedAt = new Date("2026-09-30T10:00:10.500Z");

	it("treats a snapshot from before the change was applied as earlier", () => {
		expect(snapshotPredates(new Date("2026-09-30T10:00:09Z"), appliedAt)).toBe(true);
		// Stripe stamps whole seconds: the second the change was applied counts as earlier.
		expect(snapshotPredates(new Date("2026-09-30T10:00:10Z"), appliedAt.toISOString())).toBe(true);
	});

	it("treats a later snapshot, or one read live, as reflecting the change", () => {
		expect(snapshotPredates(new Date("2026-09-30T10:00:11Z"), appliedAt)).toBe(false);
		expect(snapshotPredates(null, appliedAt)).toBe(false);
		expect(snapshotPredates(new Date("2026-09-30T10:00:09Z"), null)).toBe(false);
	});
});
