import { describe, expect, it } from "bun:test";
import { reducesAccess } from "../../src/platform/team";

describe("reducesAccess", () => {
	it("counts demotions, suspensions and removals, never a no-op or a promotion", () => {
		const active = (role: "Admin" | "Developer" | "Operator" | "Viewer") => ({
			role,
			status: "active",
		});
		expect(reducesAccess(active("Admin"), active("Admin"))).toBe(false);
		expect(reducesAccess(active("Viewer"), active("Developer"))).toBe(false);
		expect(reducesAccess(active("Developer"), active("Admin"))).toBe(false);
		expect(reducesAccess({ role: "Viewer", status: "suspended" }, active("Viewer"))).toBe(false);
		expect(
			reducesAccess({ role: "Viewer", status: "suspended" }, { role: "Viewer", status: "removed" }),
		).toBe(false);
		expect(reducesAccess(active("Admin"), active("Developer"))).toBe(true);
		// A sideways move still drops what the old role could do.
		expect(reducesAccess(active("Developer"), active("Operator"))).toBe(true);
		expect(reducesAccess(active("Viewer"), { role: "Viewer", status: "suspended" })).toBe(true);
		expect(reducesAccess(active("Viewer"), { role: "Viewer", status: "removed" })).toBe(true);
	});
});
