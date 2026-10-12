import { describe, expect, it } from "bun:test";
import { createPostgresContainer } from "../../scripts/lib/postgres-container";

const dataDirectory = "/var/lib/postgresql";
const bytesPerUnit: Record<string, number> = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** The tmpfs options the container asks Docker for; creating the object never contacts Docker. */
function dataTmpfsOptions(): string | undefined {
	const container = createPostgresContainer({ postgresDatabase: "acme_billing_test" });
	const { hostConfig } = container as unknown as {
		hostConfig: { Tmpfs?: Record<string, string> };
	};
	return hostConfig.Tmpfs?.[dataDirectory];
}

describe("Postgres lane container", () => {
	it("holds the data directory on a tmpfs the unsharded integration lane fits in", () => {
		const options = dataTmpfsOptions();
		expect(options).toBeDefined();
		const size = /(?:^|,)size=(\d+)([kmg]?)(?:,|$)/i.exec(options ?? "");
		expect(size).not.toBeNull();
		const bytes = Number(size?.[1]) * (bytesPerUnit[(size?.[2] ?? "").toLowerCase()] ?? Number.NaN);
		// The unsharded lane peaks near 570 MB; 512 MB ran out of space and PANICked PostgreSQL.
		expect(bytes).toBeGreaterThanOrEqual(2 * 1024 ** 3);
	});
});
