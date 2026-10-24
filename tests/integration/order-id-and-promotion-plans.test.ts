import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { type SQL as DrizzleSQL, sql as drizzleSql } from "drizzle-orm";
import { googlePurchaseInvalidationTargetSql } from "../../src/db/repository/invalidations";
import { dueStripePromotionObjectsSql } from "../../src/db/repository/promotion-provider-objects";
import { executeRows } from "../../src/db/repository/query";
import type { TransactionalQueryExecutor } from "../../src/db/repository/types";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import { publishAiCreditsCatalog } from "./helpers/metering-catalog";

const localDescribe = describeLocalPostgres(describe, describe.skip);
let context: LocalPostgresContext;

/**
 * Plans a statement with sequential scans off, so the plan names an index only when the statement
 * can use one and the statistics make it cheaper than the alternatives.
 */
async function plan(statement: DrizzleSQL): Promise<string> {
	const database = context.db as unknown as TransactionalQueryExecutor;
	const lines = await database.transaction(async (tx) => {
		await tx.execute(drizzleSql`SET LOCAL enable_seqscan = off`);
		return await executeRows<Record<string, string>>(
			tx,
			drizzleSql`EXPLAIN (COSTS OFF) ${statement}`,
		);
	});
	return lines.map((line) => Object.values(line).join("")).join("\n");
}

localDescribe("Order id and promotion object index use", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});

	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await publishAiCreditsCatalog(context.repository);
	});

	afterAll(async () => {
		await context.sql.close();
	});

	it("claims Stripe promotion objects through the due index, retire requests included", async () => {
		await context.repository.promotions.createPromotion(integrationProjectContext(), {
			key: "plan-test",
			name: "Plan test",
			effect: {
				kind: "discount",
				discount: { type: "percent", percentOffBps: 1000, duration: "once", durationMonths: null },
			},
			targets: [{ kind: "product", key: "echo_credits_10" }],
			actor: "integration-test",
		});
		// A table the way production has it: thousands of objects in step with Stripe, a handful due.
		await context.sql`
			INSERT INTO promotion_provider_objects (
				project_id, promotion_id, provider, object_kind, external_id, applies_to_hash, status,
				desired_active, provider_active, retire_requested, ready_at, next_attempt_at
			)
			SELECT promotion.project_id, promotion.id, 'stripe', 'coupon', concat('cpn_', series.n),
				lpad(series.n::text, 64, '0'), 'ready', true, true, false, now(),
				now() - INTERVAL '1 hour'
			FROM (SELECT project_id, id FROM promotions LIMIT 1) promotion
			CROSS JOIN generate_series(1, 5000) AS series(n)
		`;
		// Due only through the retire arm: in step with Stripe (inactive both ways) but asked to go.
		await context.sql`
			UPDATE promotion_provider_objects
			SET desired_active = false, provider_active = false, retire_requested = true
			WHERE external_id IN ('cpn_1', 'cpn_2', 'cpn_3')
		`;
		await context.sql`ANALYZE promotion_provider_objects`;

		const claim = await plan(dueStripePromotionObjectsSql(100, 60_000));

		expect(claim).toContain("idx_billing_promotion_provider_objects_due");
	});

	it("finds a Google purchase by order id or latest order id through their indexes", async () => {
		await context.sql`
			INSERT INTO customers (project_id, billing_account_id)
			SELECT id, 'order-account' FROM projects WHERE key = 'acme'
		`;
		await context.sql`
			INSERT INTO purchases (
				project_id, customer_id, product_id, provider, channel, purchase_kind, transaction_id,
				status, raw_payload
			)
			SELECT customer.project_id, customer.id, product.id, 'google', 'android', 'consumable',
				concat('token_', series.n), 'completed',
				jsonb_build_object(
					'orderId', concat('GPA.', series.n),
					'latestOrderId', concat('GPA.', series.n, '..1')
				)
			FROM customers customer
			JOIN products product
				ON product.project_id = customer.project_id AND product.key = 'echo_credits_10'
			CROSS JOIN generate_series(1, 5000) AS series(n)
			WHERE customer.billing_account_id = 'order-account'
		`;
		await context.sql`ANALYZE purchases`;
		const [project] = await context.sql<Array<{ id: string }>>`
			SELECT id FROM projects WHERE key = 'acme'
		`;

		const lookup = await plan(
			googlePurchaseInvalidationTargetSql(project?.id ?? "", {
				purchaseToken: "unknown-token",
				orderId: "GPA.42",
			}),
		);

		expect(lookup).toContain("idx_billing_purchases_raw_payload_order_id");
		expect(lookup).toContain("idx_billing_purchases_raw_payload_latest_order_id");
	});
});
