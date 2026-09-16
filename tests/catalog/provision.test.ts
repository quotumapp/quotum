import { describe, expect, it } from "bun:test";
import { syncConfiguredCatalog } from "../../src/catalog/provision";
import { driverError } from "../helpers/postgres-errors";

function databaseFailingWith(errors: Error[]) {
	let attempts = 0;
	const database = {
		async transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
			const error = errors[attempts];
			attempts += 1;
			if (error !== undefined) {
				throw error;
			}
			return await callback({});
		},
	};
	return { database, attempts: () => attempts };
}

describe("syncConfiguredCatalog", () => {
	it("re-runs the import transaction after a PostgreSQL deadlock", async () => {
		const { database, attempts } = databaseFailingWith([driverError("40P01", "deadlock detected")]);

		await syncConfiguredCatalog([], {} as never, database as never);

		expect(attempts()).toBe(2);
	});

	it("rethrows other PostgreSQL errors without retrying", async () => {
		const { database, attempts } = databaseFailingWith([
			driverError("23505", "duplicate key value violates unique constraint"),
		]);

		await expect(syncConfiguredCatalog([], {} as never, database as never)).rejects.toMatchObject({
			cause: { errno: "23505" },
		});
		expect(attempts()).toBe(1);
	});
});
