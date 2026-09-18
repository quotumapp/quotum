import { expect, test } from "bun:test";
import { routeTables } from "../helpers/route-tables";

/**
 * Parsers a route that accepts a body may use: `none`, or a named parser that reads under a cap
 * (`flexJson` for private `/v1` bodies, `merchantJson` for merchant JSON). Without an explicit
 * parser, Elysia's built-in parsers read the whole body, and they run before authentication.
 */
const BOUNDED_PARSERS = new Set(["none", "flexJson", "merchantJson"]);

test("every route that can receive a body declares a bounded parser", () => {
	const unbounded: string[] = [];
	let checked = 0;
	for (const app of routeTables()) {
		for (const route of app.routes) {
			// Elysia never parses GET or HEAD bodies.
			if (route.method === "GET" || route.method === "HEAD") continue;
			checked += 1;
			const parse = (route.hooks as { parse?: unknown }).parse;
			const entries = Array.isArray(parse) ? parse : [];
			// A second entry means a merged global or guard parser, which Elysia would also run.
			const parser = entries.length === 1 ? (entries[0] as { fn?: unknown }).fn : undefined;
			if (typeof parser !== "string" || !BOUNDED_PARSERS.has(parser)) {
				unbounded.push(`${route.method} ${route.path} parse=${JSON.stringify(parse ?? null)}`);
			}
		}
	}

	expect(checked).toBeGreaterThan(70);
	expect(unbounded).toEqual([]);
});
