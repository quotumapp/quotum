import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CommercialActionIntent } from "../../src/billing/commercial";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

/**
 * Every intent a preview may be stored under. The `satisfies` keeps it equal to the intent union,
 * so adding a commercial verb without widening the CHECK fails here rather than in Postgres when a
 * merchant first previews it.
 */
const intentKinds = [
	"checkout_plan",
	"checkout_product",
	"subscription_change",
	"cancel",
	"uncancel",
] as const;

type IntentKindsCoverUnion = CommercialActionIntent["kind"] extends (typeof intentKinds)[number]
	? (typeof intentKinds)[number] extends CommercialActionIntent["kind"]
		? true
		: never
	: never;
const _intentKindsMatchTheUnion: IntentKindsCoverUnion = true;

describe("commercial_action_previews intent CHECK", () => {
	it("accepts exactly the commercial intent kinds", () => {
		const sql = read("migrations/003_metering_and_pricing.sql");
		const check = sql.match(/intent_kind IN \(([^)]*)\)/)?.[1];
		expect(check).toBeDefined();
		const allowed = (check ?? "")
			.split(",")
			.map((value) => value.trim().replace(/^'|'$/g, ""))
			.filter((value) => value !== "");

		expect(allowed).toEqual([...intentKinds]);
	});

	it("mirrors the CHECK in the Drizzle column type", () => {
		const schema = read("src/db/schema.ts");
		const column = schema.match(/intentKind: text\("intent_kind"\)\s*\n\s*\.\$type<([^>]*)>/)?.[1];
		expect(column).toBeDefined();
		const mirrored = (column ?? "")
			.split("|")
			.map((value) => value.trim().replace(/^"|"$/g, ""))
			.filter((value) => value !== "");

		expect(mirrored).toEqual([...intentKinds]);
	});
});
