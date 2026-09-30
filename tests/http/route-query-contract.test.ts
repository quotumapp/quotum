import { expect, test } from "bun:test";
import { OPERATION_DOC, type OperationDoc } from "../../src/shared/http";
import { routeTables } from "../helpers/route-tables";

/**
 * Handler source that reads the query string: through the URL, or through Elysia's `query`
 * context (destructured or as a property). An object key named `query` is not a read.
 */
const READS_QUERY = /searchParams|queryParams\(|[{,]\s*query\s*[,}]|\.query\b/;

test("every route whose handler reads the query string documents its query parameters", () => {
	const undocumented: string[] = [];
	let checked = 0;
	for (const app of routeTables()) {
		for (const route of app.routes) {
			if (!READS_QUERY.test(String(route.handler))) continue;
			checked += 1;
			const hooks = route.hooks as { query?: unknown; detail?: Record<string, unknown> };
			const doc = hooks.detail?.[OPERATION_DOC] as OperationDoc | undefined;
			if (hooks.query === undefined && doc?.request?.query === undefined) {
				undocumented.push(`${route.method} ${route.path}`);
			}
		}
	}
	expect(checked).toBeGreaterThan(20);
	expect(undocumented).toEqual([]);
});
