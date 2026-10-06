import type { SQL } from "bun";

/**
 * The pre-registered public MCP clients, as `migrations/004_merchant.sql` registers them. The test
 * runtime truncates the table on reset and registers them again, so they must stay the migration's:
 * a client registered without `quotum.billing.write` can never ask for change proposals, and a test
 * stack would then exercise read-only connections only.
 */
export const merchantOAuthClients = [
	{
		clientId: "quotum-claude-code",
		name: "Claude Code",
		redirectUri: "http://localhost:8788/callback",
	},
	{ clientId: "quotum-cursor", name: "Cursor", redirectUri: "http://localhost:8787/callback" },
] as const;

export const merchantOAuthClientScopes = [
	"quotum.read",
	"quotum.billing.write",
	"offline_access",
] as const;

/** Registers the clients in an emptied `platform_auth_oauth_clients`. */
export async function registerMerchantOAuthClients(database: SQL): Promise<void> {
	for (const client of merchantOAuthClients) {
		await database`
			INSERT INTO platform_auth_oauth_clients(
				client_id, name, redirect_uris, scopes, grant_types, response_types,
				token_endpoint_auth_method, require_p_k_c_e, skip_consent, created_at, updated_at
			) VALUES (
				${client.clientId}, ${client.name}, ARRAY[${client.redirectUri}]::text[],
				string_to_array(${merchantOAuthClientScopes.join(",")}, ','),
				ARRAY['authorization_code','refresh_token'], ARRAY['code'], 'none', true, false,
				now(), now()
			)
		`;
	}
}
