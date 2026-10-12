import { describe, expect, it } from "bun:test";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import {
	customerErasureDispositions,
	deleteBatches,
	rewriteBatches,
	scrubBatches,
} from "../../src/db/repository/customer-erasure-dispositions";
import * as schema from "../../src/db/schema";

const identityColumns = new Set(["customer_id", "billing_account_id"]);

/** Every table the schema mirror declares that carries a customer or a billing account id. */
function identityTables(): string[] {
	const names: string[] = [];
	for (const value of Object.values(schema)) {
		if (!(value instanceof PgTable)) continue;
		const config = getTableConfig(value);
		if (config.columns.some((column) => identityColumns.has(column.name))) names.push(config.name);
	}
	return names.sort();
}

describe("customer erasure dispositions", () => {
	it("decides every table that carries a customer or billing account id", () => {
		const decided = new Set(Object.keys(customerErasureDispositions));
		const undecided = identityTables().filter((table) => !decided.has(table));

		// A new table with `customer_id` or `billing_account_id` must be classified in
		// src/db/repository/customer-erasure-dispositions.ts before it can ship.
		expect(undecided).toEqual([]);
	});

	it("names no table the schema does not have", () => {
		const known = new Set(identityTables());
		const stale = Object.keys(customerErasureDispositions).filter((table) => !known.has(table));

		expect(stale).toEqual([]);
	});

	it("gives every retained table a reason", () => {
		for (const [table, disposition] of Object.entries(customerErasureDispositions)) {
			if (disposition.kind === "retain") {
				expect(disposition.reason.length, table).toBeGreaterThan(0);
			}
		}
	});

	it("has a batch for every table it says it deletes, rewrites or scrubs", () => {
		const batched = new Set(
			[...deleteBatches, ...rewriteBatches, ...scrubBatches].map((batch) => batch.table),
		);
		// `customers` is rewritten by the request transaction; `usage_events` and the unlinked
		// store events have their own steps.
		const exempt = new Set(["customers", "usage_events", "customer_erasures"]);
		const missing = Object.entries(customerErasureDispositions)
			.filter(([table, disposition]) => disposition.kind !== "retain" && !exempt.has(table))
			.map(([table]) => table)
			.filter((table) => !batched.has(table));

		expect(missing).toEqual([]);
	});

	it("deletes the identity-bearing tables before it rewrites anything", () => {
		const deleted = deleteBatches.map((batch) => batch.table);
		for (const table of [
			"provider_customers",
			"checkout_requests",
			"payment_setup_sessions",
			"projection_sync_jobs",
		]) {
			expect(deleted).toContain(table);
		}
	});
});
