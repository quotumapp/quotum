import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";
import { sqlstateOf } from "../../src/db/postgres-errors";
import { carryOverAllowances } from "../../src/db/repository/carry-over";
import { type FeatureRow, lockAllocations } from "../../src/db/repository/metering-persistence";
import { executeOne } from "../../src/db/repository/query";
import type { QueryExecutor } from "../../src/db/repository/types";
import { resetAndSeedIntegrationData } from "./helpers/catalog-fixtures";
import {
	createLocalPostgresContext,
	describeLocalPostgres,
	integrationProjectContext,
	type LocalPostgresContext,
} from "./helpers/local-postgres";
import {
	seedPhase3MeteringCatalog,
	seedPhase3MeteringSubscription,
} from "./helpers/phase3-fixtures";

let context: LocalPostgresContext;
const project = () => integrationProjectContext();
const pid = (tx: QueryExecutor) =>
	executeOne<{ pid: number }>(tx, drizzleSql`SELECT pg_backend_pid() AS pid`);
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { resolve, promise };
}
async function waiting(pid: number) {
	for (let i = 0; i < 200; i++) {
		const [row] = await context.sql`SELECT wait_event_type FROM pg_stat_activity WHERE pid=${pid}`;
		if (row?.wait_event_type === "Lock") return;
		await Bun.sleep(10);
	}
	throw new Error("Backend did not wait on expected lock");
}
describeLocalPostgres(describe, describe.skip)("carry-over allocation lock order", () => {
	beforeAll(async () => {
		context = await createLocalPostgresContext();
	});
	beforeEach(async () => {
		await resetAndSeedIntegrationData(context.sql);
		await seedPhase3MeteringCatalog(context.sql);
	});
	afterAll(() => context.sql.close());
	it("carry-over waits in spend order behind metering without a deadlock", async () => {
		await seedPhase3MeteringSubscription(context.sql, "lock-qa", "workspace");
		const [subject] =
			await context.sql`SELECT c.id AS customer_id,s.id AS subscription_id,s.plan_version_id,f.id AS feature_id,i.id AS item_id FROM customers c JOIN subscriptions s ON s.customer_id=c.id JOIN features f ON f.project_id=c.project_id AND f.key='ai_credits' JOIN plan_items i ON i.plan_version_id=s.plan_version_id AND i.feature_id=f.id WHERE c.billing_account_id='lock-qa'`;
		const inserted: Array<string | number> = [];
		for (const [key, hours] of [
			["first-id", 2],
			["second-id", 1],
		] as const) {
			const [row] =
				await context.sql`INSERT INTO balance_allocations(project_id,customer_id,subscription_id,feature_id,plan_item_id,source_kind,source_key,quantity,expires_at) VALUES(${project().projectInstanceId},${subject.customer_id},${subject.subscription_id},${subject.feature_id},${subject.item_id},'subscription',${key},100,now()+make_interval(hours=>${hours})) RETURNING id`;
			inserted.push(row.id);
		}
		const feature = await executeOne<FeatureRow>(
			context.db as never,
			drizzleSql`SELECT * FROM features WHERE id=${String(subject.feature_id)}::bigint`,
		);
		if (!feature) throw new Error("Missing feature");
		const release = deferred();
		const held = deferred();
		const holder = context.sql.begin(async (tx) => {
			await tx`SELECT id FROM balance_allocations WHERE id=${inserted[1]} FOR UPDATE`;
			held.resolve();
			await release.promise;
		});
		await held.promise;
		const meterPid = deferred<number>();
		const carryPid = deferred<number>();
		const meter = context.db.transaction(async (tx) => {
			const p = await pid(tx as unknown as QueryExecutor);
			if (!p) throw new Error("Missing meter backend");
			meterPid.resolve(p.pid);
			await lockAllocations(
				tx as never,
				project().projectInstanceId,
				subject.customer_id,
				feature,
				null,
			);
		});
		const meterResult = meter.then(
			() => ({ code: null }),
			(error) => ({ code: sqlstateOf(error) }),
		);
		await waiting(await meterPid.promise);
		const carry = context.db.transaction(async (tx) => {
			const p = await pid(tx as unknown as QueryExecutor);
			if (!p) throw new Error("Missing carry backend");
			carryPid.resolve(p.pid);
			await carryOverAllowances(tx as never, {
				projectId: project().projectInstanceId,
				customerId: subject.customer_id,
				subscriptionId: subject.subscription_id,
				changeId: "qa-lock",
				outgoingPlanVersionId: String(subject.plan_version_id),
				incomingPlanVersionId: String(subject.plan_version_id),
				balances: ["ai_credits"],
				usages: [],
				periodStartAt: new Date(),
				periodEndAt: new Date(Date.now() + 3600_000),
			});
		});
		const carryResult = carry.then(
			() => ({ code: null }),
			(error) => ({ code: sqlstateOf(error) }),
		);
		try {
			await waiting(await carryPid.promise);
		} finally {
			release.resolve();
		}
		await holder;
		const outcomes = await Promise.all([meterResult, carryResult]);
		expect(outcomes.map((r) => r.code)).toEqual([null, null]);
	});
});
