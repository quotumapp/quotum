import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	merchantOAuthClientScopes,
	merchantOAuthClients,
} from "../../src/testing/merchant-oauth-clients";

/** `ARRAY['a','b']` as its items. */
const items = (array: string) => [...array.matchAll(/'([^']*)'/g)].map((match) => match[1]);

describe("the test runtime's MCP clients", () => {
	it("are registered as the migration registers them, proposal scope included", () => {
		const migration = readFileSync(
			resolve(import.meta.dir, "../../migrations/004_merchant.sql"),
			"utf8",
		);
		const rows = [
			...migration.matchAll(
				/^\('([a-z-]+)','([^']+)',ARRAY\[([^\]]*)\],ARRAY\[([^\]]*)\],ARRAY\['authorization_code','refresh_token'\]/gm,
			),
		].map(([, clientId, name, redirectUris, scopes]) => ({
			clientId,
			name,
			redirectUris: items(redirectUris ?? ""),
			scopes: items(scopes ?? ""),
		}));
		expect(rows).toEqual(
			merchantOAuthClients.map((client) => ({
				clientId: client.clientId,
				name: client.name,
				redirectUris: [client.redirectUri],
				scopes: [...merchantOAuthClientScopes],
			})),
		);
		// Without it a reset would leave clients that can only ever connect read-only.
		expect(merchantOAuthClientScopes).toContain("quotum.billing.write");
	});
});
