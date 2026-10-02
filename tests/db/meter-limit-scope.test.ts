import { describe, expect, it } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";
import { meterLimitScopeSelector, scopeSetSql } from "../../src/db/repository/meter-limit-scope";
import { meterLimitScopeConflictError } from "../../src/db/repository/meter-limit-scope-guards";
import { renderDrizzleSql } from "../helpers/drizzle-sql";

describe("meter-limit scope sets", () => {
	it("selects every row for the account, one entity's rows, or the no-entity bucket", () => {
		const rendered = (scope: "account" | "entity", entityId: string | null) =>
			renderDrizzleSql(scopeSetSql(drizzleSql`w`, meterLimitScopeSelector(scope, entityId)));
		// An account scope ignores the entity a write names.
		expect(meterLimitScopeSelector("account", "7")).toEqual({ scope: "account", entityId: null });
		expect(rendered("account", "7")).toContain("TRUE");
		expect(rendered("entity", "7")).toContain("w.entity_id = $1::bigint");
		const bucket = rendered("entity", null);
		expect(bucket).toContain("w.entity_id IS NULL");
		// Rows written before declared scopes belong to the bucket; the account row does not.
		expect(bucket).toContain("w.scope IS NULL OR w.scope = 'entity'");
	});

	it("refuses a purchase or plan change with the scope reason", () => {
		expect(meterLimitScopeConflictError(["api_requests", "exports"])).toMatchObject({
			code: "ADDON_METER_LIMIT_CONFLICT",
			status: 409,
			details: { reason: "scope", featureKeys: ["api_requests", "exports"] },
		});
	});
});
