import { describe, expect, it } from "bun:test";
import { ensurePostgresImage } from "../../scripts/lib/postgres-container";

function fakeRegistry(outcomes: { exists: boolean[]; pull: Array<"ok" | "fail"> }) {
	const calls: string[] = [];
	const registry = {
		async exists() {
			calls.push("exists");
			return outcomes.exists.shift() ?? false;
		},
		async pull() {
			calls.push("pull");
			if ((outcomes.pull.shift() ?? "fail") === "fail") {
				throw new Error("(HTTP code 500) server error");
			}
		},
	};
	return { calls, registry };
}

describe("Postgres lane image", () => {
	it("uses an image that is already present without pulling", async () => {
		const { calls, registry } = fakeRegistry({ exists: [true], pull: [] });
		await ensurePostgresImage({ registry, sleep: async () => {} });
		expect(calls).toEqual(["exists"]);
	});

	it("retries a failed pull with exponential backoff until the image is present", async () => {
		const { calls, registry } = fakeRegistry({
			exists: [false, true],
			pull: ["fail", "fail", "ok"],
		});
		const waits: number[] = [];
		await ensurePostgresImage({ registry, sleep: async (ms) => void waits.push(ms) });
		expect(calls).toEqual(["exists", "pull", "pull", "pull", "exists"]);
		expect(waits).toEqual([2_000, 4_000]);
	});

	it("pulls again when a finished pull leaves no local image", async () => {
		const { calls, registry } = fakeRegistry({ exists: [false, false, true], pull: ["ok", "ok"] });
		await ensurePostgresImage({ registry, sleep: async () => {} });
		expect(calls).toEqual(["exists", "pull", "exists", "pull", "exists"]);
	});

	it("fails with the last registry error once the attempts are spent", async () => {
		const { calls, registry } = fakeRegistry({ exists: [false], pull: [] });
		let failure: unknown;
		try {
			await ensurePostgresImage({ attempts: 3, registry, sleep: async () => {} });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("after 3 attempts: (HTTP code 500) server error");
		expect(calls.filter((call) => call === "pull")).toHaveLength(3);
	});
});
