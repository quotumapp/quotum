import { describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { subscriptionStatuses } from "../../src/billing/types";
import {
	isEndedSubscriptionStatus,
	subscriptionStatusRank,
	subscriptionStatusRankSql,
	subscriptionUpdateIsMonotonicSql,
} from "../../src/db/repository/mutations";
import { renderDrizzleSql } from "../helpers/drizzle-sql";

describe("subscription status rank", () => {
	it("orders live states below ending ones, in the order the statuses are declared", () => {
		const ranks = subscriptionStatuses.map((status) => subscriptionStatusRank(status));
		expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
		expect(new Set(ranks).size).toBe(ranks.length);
		expect(subscriptionStatusRank("active")).toBeLessThan(subscriptionStatusRank("cancelled"));
		expect(subscriptionStatusRank("cancelled")).toBeLessThan(subscriptionStatusRank("expired"));
		expect(subscriptionStatusRank("not-a-status")).toBe(0);
	});

	it("calls a state ended once it is cancelled, expired, refunded or revoked", () => {
		const ended = subscriptionStatuses.filter((status) => isEndedSubscriptionStatus(status));
		expect(ended).toEqual(["cancelled", "expired", "refunded", "revoked"]);
		expect(isEndedSubscriptionStatus("not-a-status")).toBe(false);
	});

	it("renders the same ranks in SQL as the application uses", () => {
		const rendered = renderDrizzleSql(subscriptionStatusRankSql(sql`subscriptions.status`));
		for (const status of subscriptionStatuses) {
			expect(rendered).toContain(`WHEN '${status}' THEN ${subscriptionStatusRank(status)}`);
		}
		expect(rendered).toContain("ELSE 0");
	});

	it("lets an ended state replace a live one only for a write that reports it", () => {
		const ordinary = renderDrizzleSql(subscriptionUpdateIsMonotonicSql(false));
		const ending = renderDrizzleSql(subscriptionUpdateIsMonotonicSql(false, true));
		const outranks = /END\s+> CASE subscriptions\.status/;
		expect(ordinary).not.toMatch(outranks);
		expect(ending).toMatch(outranks);
		// Everything the ordinary guard checks is still checked.
		expect(ending).toContain(
			"COALESCE(EXCLUDED.expires_at, EXCLUDED.starts_at) > COALESCE(subscriptions.expires_at, subscriptions.starts_at)",
		);
	});
});
