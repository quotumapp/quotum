import { describe, expect, it } from "bun:test";
import {
	endPromotionPlanGrantInTx,
	grantPromotionPlanInTx,
	promotionPlanGrantIneligibility,
} from "../../src/db/repository/promotion-plan-grants";
import { FakeDatabase } from "./repository-fixture";

const grantable = {
	plan_id: "3",
	plan_version_id: "7",
	plan_kind: "base",
	trial_days: null,
	unsupported_items: false,
	default_plan: false,
};
const held = (active_grant: boolean, paid_base: boolean) => [{ active_grant, paid_base }];

function grantInput(durationUnit: "day" | "month", durationCount: number) {
	return {
		projectId: "project-id",
		customer: { id: "customer-id", billing_account_id: "account" },
		redemptionId: "redemption-id",
		terms: { planKey: "premium", durationUnit, durationCount },
		actor: "billing-account:account",
		requestHash: "a".repeat(64),
	};
}

async function errorCode(action: Promise<unknown>): Promise<string | undefined> {
	try {
		await action;
	} catch (error) {
		return (error as { code?: string }).code;
	}
	return undefined;
}

describe("promotionPlanGrantIneligibility", () => {
	const check = (responses: Array<Record<string, unknown>[]>) => {
		const database = new FakeDatabase(responses, { strict: true });
		const reason = promotionPlanGrantIneligibility(database as never, "project-id", {
			planKey: "premium",
			billingAccountId: "account",
		});
		return { database, reason };
	};

	it("refuses a plan no grant can hold before it looks at the account", async () => {
		for (const plan of [
			[],
			[{ ...grantable, plan_kind: "addon" }],
			[{ ...grantable, unsupported_items: true }],
			[{ ...grantable, default_plan: true }],
		]) {
			const { database, reason } = check([plan]);
			expect(await reason).toBe("PROMOTION_PLAN_NOT_ELIGIBLE");
			expect(database.queries).toHaveLength(1);
		}
	});

	it("reads only the plan's active published public version", async () => {
		const { database, reason } = check([[grantable], []]);

		expect(await reason).toBeNull();
		expect(database.queries[0]).toContain("version.id = p.active_version_id");
		expect(database.queries[0]).toContain("version.status = 'published'");
		expect(database.queries[0]).toContain("version.visibility = 'public'");
		expect(database.params[0]).toContain("premium");
	});

	it("accepts an account Quotum has not recorded without creating it", async () => {
		const { database, reason } = check([[grantable], []]);

		expect(await reason).toBeNull();
		expect(database.queries).toHaveLength(2);
		expect(database.queries.join("\n")).not.toMatch(/INSERT|UPDATE/);
	});

	it("refuses an account that holds a base plan through a grant or a paid subscription", async () => {
		const reasonFor = async (row: Record<string, unknown>[]) =>
			await check([[grantable], [{ id: "customer-id" }], row]).reason;

		expect(await reasonFor(held(true, false))).toBe("PROMOTION_PLAN_GRANT_ACTIVE");
		expect(await reasonFor(held(false, true))).toBe("PROMOTION_BASE_PLAN_ACTIVE");
		expect(await reasonFor(held(false, false))).toBeNull();
	});
});

describe("grantPromotionPlanInTx", () => {
	it("refuses before it supersedes the default plan or writes a grant", async () => {
		const refusal = async (responses: Array<Record<string, unknown>[]>) => {
			const database = new FakeDatabase([[], ...responses], { strict: true });
			const code = await errorCode(
				grantPromotionPlanInTx(database as never, grantInput("day", 30)),
			);
			expect(database.queries.join("\n")).not.toContain("INSERT INTO plan_grants");
			expect(database.queries.join("\n")).not.toContain("status = 'superseded'");
			return code;
		};

		expect(await refusal([[]])).toBe("PROMOTION_PLAN_NOT_ELIGIBLE");
		expect(await refusal([[{ ...grantable, plan_kind: "addon" }]])).toBe(
			"PROMOTION_PLAN_NOT_ELIGIBLE",
		);
		expect(await refusal([[grantable], held(true, false)])).toBe("PROMOTION_PLAN_GRANT_ACTIVE");
		expect(await refusal([[grantable], held(false, true)])).toBe("PROMOTION_BASE_PLAN_ACTIVE");
	});

	it("records elapsed grants first, then writes a promotion grant for the term", async () => {
		const insert = async (unit: "day" | "month", count: number) => {
			// Expiry sweep, plan, account state, default-plan grant, then an insert that returns nothing.
			const database = new FakeDatabase([[], [grantable], held(false, false), [], []], {
				strict: true,
			});
			await expect(
				grantPromotionPlanInTx(database as never, grantInput(unit, count)),
			).rejects.toThrow("could not be recorded");
			database.assertConsumed();
			expect(database.queries[0]).toContain("SET status = 'expired'");
			expect(database.queries[3]).toContain("origin = 'default'");
			return { query: database.queries[4] ?? "", params: database.params[4] ?? [] };
		};

		const days = await insert("day", 30);
		expect(days.query).toContain("INSERT INTO plan_grants");
		expect(days.query).toContain("'promotion', 'active'");
		expect(days.query).toMatch(/now\(\) \+ \$\d+ \* interval '24 hours'/);
		expect(days.query).toContain("binding.status = 'published'");
		expect(days.params).toEqual(
			expect.arrayContaining(["day", 30, "promotion:redemption-id", "redemption-id", "7"]),
		);

		const months = await insert("month", 3);
		expect(months.query).toMatch(/now\(\) \+ make_interval\(months => \$\d+::integer\)/);
		expect(months.params).toEqual(expect.arrayContaining(["month", 3]));
	});
});

describe("endPromotionPlanGrantInTx", () => {
	const input = {
		projectId: "project-id",
		redemptionId: "redemption-id",
		actor: "operator@example.com",
		reason: "Abuse report",
		idempotencyKey: "revoke-1",
		requestHash: "b".repeat(64),
	};

	it("does nothing for a redemption that gave no plan", async () => {
		const database = new FakeDatabase([[]], { strict: true });

		await endPromotionPlanGrantInTx(database as never, input);

		database.assertConsumed();
		expect(database.queries).toHaveLength(1);
		expect(database.queries[0]).toContain("g.promotion_redemption_id = $2::uuid");
		expect(database.queries[0]).toContain("FOR UPDATE OF g");
	});

	it("leaves a grant that is no longer running and delivers nothing", async () => {
		const grant = { id: "grant-id", customer_id: "customer-id", billing_account_id: "account" };
		const database = new FakeDatabase([[grant], []], { strict: true });

		await endPromotionPlanGrantInTx(database as never, input);

		database.assertConsumed();
		expect(database.queries[1]).toContain("status = 'ended'");
		expect(database.queries[1]).toMatch(/AND status = 'active'\s+AND ends_at > now\(\)/);
		expect(database.params[1]).toEqual(
			expect.arrayContaining(["operator@example.com", "Abuse report", "revoke-1", "grant-id"]),
		);
	});
});
