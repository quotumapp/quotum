import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { StripeAppEvents } from "../../src/platform/connections/stripe-events";
import { PlatformRetentionSweep } from "../../src/platform/retention";
import { MerchantBrowser, merchantFixture, onboard } from "./fixture";

const fixture = merchantFixture();
const { sql } = fixture;
beforeEach(() => fixture.reset());
afterAll(() => sql.close());
async function actor() {
	await onboard(new MerchantBrowser(fixture));
	const [row] = await sql<
		{ principal_id: string; session_id: string; instance_id: string }[]
	>`SELECT p.id AS principal_id,s.id AS session_id,i.id AS instance_id FROM platform_principals p JOIN platform_memberships m ON m.principal_id=p.id JOIN platform_merchant_sessions s ON s.principal_id=p.id JOIN platform_projects lp ON lp.organization_id=m.organization_id JOIN projects i ON i.platform_project_id=lp.id WHERE i.environment='sandbox'`;
	if (!row) throw new Error("Missing actor");
	return row;
}
describe("connection artifact retention", () => {
	it("deletes expired drafts with sealed secrets and terminal artifacts, keeping live state", async () => {
		const who = await actor();
		const [connection] = await sql<
			{ id: string }[]
		>`INSERT INTO platform_connections(project_instance_id,kind) VALUES(${who.instance_id},'projection') RETURNING id`;
		if (!connection) throw new Error("Missing connection");
		for (const status of ["draft", "validated", "expired", "active", "retired"]) {
			const [version] = await sql<
				{ id: string }[]
			>`INSERT INTO platform_connection_versions(connection_id,project_instance_id,expected_revision,settings,status,request_key,request_fingerprint,expires_at) VALUES(${connection.id},${who.instance_id},0,'{}'::jsonb,${status},${`old-${status}`},'hash',now()-interval '8 days') RETURNING id`;
			if (!version) throw new Error("Missing version");
			await sql`INSERT INTO platform_connection_secrets(connection_id,version_id,purpose,envelope) VALUES(${connection.id},${version.id},'secret','{"ciphertext":"sealed"}'::jsonb)`;
			if (status === "active")
				await sql`UPDATE platform_connections SET active_version_id=${version.id} WHERE id=${connection.id}`;
		}
		await sql`INSERT INTO platform_connection_operations(project_instance_id,request_key,action,request_fingerprint,result,created_at) VALUES(${who.instance_id},'old-operation','commit','hash','{}',now()-interval '31 days'),(${who.instance_id},'new-operation','commit','hash','{}',now())`;
		await sql`INSERT INTO platform_connection_oauth_states(state_hash,project_instance_id,principal_id,session_id,expected_revision,settings,expires_at) VALUES('old',${who.instance_id},${who.principal_id},${who.session_id},0,'{}',now()-interval '8 days'),('live',${who.instance_id},${who.principal_id},${who.session_id},0,'{}',now()+interval '1 day')`;
		await sql`INSERT INTO platform_stripe_app_events(event_id,account_id,livemode,payload,created_at,processed_at) VALUES('old','acct_retention',false,'{}',now()-interval '32 days',now()-interval '31 days'),('pending','acct_retention',false,'{}',now()-interval '32 days',NULL),('recent','acct_retention',false,'{}',now(),now())`;
		const sweep = () =>
			new PlatformRetentionSweep(sql, { connectionsOnly: true, batchSize: 1 }).runOnce();
		const results = await Promise.all([sweep(), sweep()]);
		expect(results.flatMap((r) => r.failures)).toEqual([]);
		expect(results.reduce((n, r) => n + r.deleted.platform_connection_versions, 0)).toBe(3);
		expect(results.reduce((n, r) => n + r.deleted.platform_connection_secrets, 0)).toBe(3);
		expect(
			(await sql`SELECT status FROM platform_connection_versions ORDER BY status`).map(
				(r) => r.status,
			),
		).toEqual(["active", "retired"]);
		expect(await sql`SELECT * FROM platform_connection_secrets`).toHaveLength(2);
		expect(
			(await sql`SELECT request_key FROM platform_connection_operations`).map((r) => r.request_key),
		).toEqual(["new-operation"]);
		expect(
			(await sql`SELECT state_hash FROM platform_connection_oauth_states`).map((r) => r.state_hash),
		).toEqual(["live"]);
		expect(
			(await sql`SELECT event_id FROM platform_stripe_app_events WHERE account_id='acct_retention' ORDER BY event_id`).map(
				(r) => r.event_id,
			),
		).toEqual(["pending", "recent"]);
	});
	it("does not let an old deauthorization event disable a replacement version", async () => {
		const who = await actor();
		const [connection] = await sql<
			{ id: string }[]
		>`INSERT INTO platform_connections(project_instance_id,kind,enabled) VALUES(${who.instance_id},'stripe',true) RETURNING id`;
		if (!connection) throw new Error("Missing connection");
		const [version] = await sql<
			{ id: string; created_at: Date }[]
		>`INSERT INTO platform_connection_versions(connection_id,project_instance_id,expected_revision,settings,status,request_key,request_fingerprint) VALUES(${connection.id},${who.instance_id},0,'{}','active','new-version','hash') RETURNING id,created_at`;
		if (!version) throw new Error("Missing version");
		await sql`UPDATE platform_connections SET active_version_id=${version.id} WHERE id=${connection.id}`;
		const events = new StripeAppEvents(sql);
		await events.deauthorize(
			connection.id,
			version.id,
			new Date(version.created_at.getTime() - 1000),
		);
		expect(
			(await sql`SELECT enabled FROM platform_connections WHERE id=${connection.id}`)[0]?.enabled,
		).toBe(true);
		await events.deauthorize(
			connection.id,
			version.id,
			new Date(version.created_at.getTime() + 1000),
		);
		expect(
			(await sql`SELECT enabled FROM platform_connections WHERE id=${connection.id}`)[0]?.enabled,
		).toBe(false);
	});
});
