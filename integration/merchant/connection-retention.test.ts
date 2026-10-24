import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { StripeAppEvents } from "../../src/platform/connections/stripe-events";
import { PlatformRetentionSweep } from "../../src/platform/retention";
import {
	MerchantBrowser,
	merchantFixture,
	merchantTestScope,
	onboard,
	stubConnectionValidation,
	stubEnvironmentBilling,
} from "./fixture";

const fixture = merchantFixture({
	connectionValidation: stubConnectionValidation(),
	environmentBilling: stubEnvironmentBilling(() => fixture.sql),
});
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
			(
				await sql`SELECT event_id FROM platform_stripe_app_events WHERE account_id='acct_retention' ORDER BY event_id`
			).map((r) => r.event_id),
		).toEqual(["recent"]);
	});
	it("keeps credential replay receipts after outer request idempotency expires", async () => {
		const browser = new MerchantBrowser(fixture);
		await onboard(browser);
		const body = { scope: merchantTestScope, access: "read_only" };
		await browser.json<Record<string, unknown>>(
			"/api/platform/environments/credentials/rotate",
			body,
			{
				key: "original-rotate",
			},
		);
		await browser.json<Record<string, unknown>>(
			"/api/platform/environments/credentials/revoke",
			body,
			{
				key: "original-revoke",
			},
		);
		await browser.json<Record<string, unknown>>(
			"/api/platform/environments/credentials/rotate",
			body,
			{
				key: "replacement-rotate",
			},
		);
		const before =
			await sql`SELECT id FROM platform_project_api_credentials WHERE access='read_only' AND revoked_at IS NULL`;
		await sql`UPDATE platform_connection_operations SET created_at=now()-interval '31 days'`;
		await sql`UPDATE platform_idempotency SET created_at=now()-interval '31 days'`;
		expect((await new PlatformRetentionSweep(sql).runOnce()).failures).toEqual([]);
		expect(
			await sql`SELECT id FROM platform_connection_operations WHERE action LIKE 'credential.%'`,
		).toHaveLength(3);
		expect(
			await browser.json<Record<string, unknown>>(
				"/api/platform/environments/credentials/revoke",
				body,
				{
					key: "original-revoke",
				},
			),
		).toEqual({ access: "read_only", revoked: true });
		expect(
			await browser.json<Record<string, unknown>>(
				"/api/platform/environments/credentials/rotate",
				body,
				{
					key: "original-rotate",
				},
			),
		).toEqual({ access: "read_only", credentialDisclosed: false });
		expect(
			await sql`SELECT id FROM platform_project_api_credentials WHERE access='read_only' AND revoked_at IS NULL`,
		).toEqual(before);
	});

	it("bounds unmapped quarantine at thirty days and keeps mapped unresolved events", async () => {
		const who = await actor();
		const [connection] = await sql<
			{ id: string }[]
		>`INSERT INTO platform_connections(project_instance_id,kind,stripe_account_id,stripe_livemode) VALUES(${who.instance_id},'stripe','acct_mapped',false) RETURNING id`;
		const [version] = await sql<
			{ id: string }[]
		>`INSERT INTO platform_connection_versions(connection_id,project_instance_id,expected_revision,settings,status,request_key,request_fingerprint) VALUES(${connection.id},${who.instance_id},0,'{"authMethod":"oauth"}','active','mapped-version','hash') RETURNING id`;
		await sql`UPDATE platform_connections SET active_version_id=${version.id} WHERE id=${connection.id}`;
		const [clock] = await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
		if (!clock) throw new Error("Missing database clock");
		const cutoff = new Date(clock.now.getTime() - 30 * 86400000);
		await sql`INSERT INTO platform_stripe_app_events(event_id,account_id,livemode,payload,created_at) VALUES ('mapped','acct_mapped',false,'{}',${cutoff}::timestamptz-interval '1 day'),('boundary','acct_unknown',false,'{}',${cutoff}::timestamptz),('expired-a','acct_unknown',false,'{}',${cutoff}::timestamptz-interval '1 millisecond'),('expired-b','acct_unknown',false,'{}',${cutoff}::timestamptz-interval '1 day')`;
		const first = await new PlatformRetentionSweep(sql, {
			now: () => clock.now,
			batchSize: 1,
			maxBatchesPerTable: 1,
		}).runOnce();
		expect(first.deleted.platform_stripe_app_events).toBe(1);
		expect(first.capped).toContain("platform_stripe_app_events");
		const second = await new PlatformRetentionSweep(sql, { now: () => clock.now }).runOnce();
		expect(second.failures).toEqual([]);
		expect(second.deleted.platform_stripe_app_events).toBe(1);
		expect(
			(await sql`SELECT event_id FROM platform_stripe_app_events ORDER BY event_id`).map(
				(row) => row.event_id,
			),
		).toEqual(["boundary", "mapped"]);
	});

	it("commits deauthorization and event completion together only for the inspected mapping", async () => {
		const who = await actor();
		const [connection] = await sql<
			{ id: string }[]
		>`INSERT INTO platform_connections(project_instance_id,kind,enabled,stripe_account_id,stripe_livemode) VALUES(${who.instance_id},'stripe',true,'acct_retention',false) RETURNING id`;
		const [version] = await sql<
			{ id: string }[]
		>`INSERT INTO platform_connection_versions(connection_id,project_instance_id,expected_revision,settings,status,request_key,request_fingerprint) VALUES(${connection.id},${who.instance_id},0,'{"authMethod":"oauth"}','active','new-version','hash') RETURNING id`;
		await sql`UPDATE platform_connections SET active_version_id=${version.id} WHERE id=${connection.id}`;
		const events = new StripeAppEvents(sql);
		await events.accept({
			event_id: "evt_revoke",
			account_id: "acct_retention",
			livemode: false,
			payload: {},
		});
		const input = {
			eventId: "evt_revoke",
			connectionId: connection.id,
			versionId: version.id,
			accountId: "acct_retention",
			livemode: false,
			disable: true,
		};
		for (const mismatch of [
			{ accountId: "acct_other" },
			{ livemode: true },
			{ versionId: "00000000-0000-4000-8000-000000000000" },
		])
			expect(await events.completeDeauthorization({ ...input, ...mismatch })).toBe(false);
		expect(
			(await sql`SELECT enabled FROM platform_connections WHERE id=${connection.id}`)[0]?.enabled,
		).toBe(true);
		expect(
			(
				await sql`SELECT processed_at FROM platform_stripe_app_events WHERE event_id='evt_revoke'`
			)[0]?.processed_at,
		).toBeNull();
		// A storage failure must roll back the disable as well as the processed marker.
		await sql`ALTER TABLE platform_stripe_app_events ADD CONSTRAINT reject_test_completion CHECK (event_id <> 'evt_revoke' OR processed_at IS NULL)`;
		try {
			await expect(events.completeDeauthorization(input)).rejects.toThrow("reject_test_completion");
			expect(
				(await sql`SELECT enabled FROM platform_connections WHERE id=${connection.id}`)[0]?.enabled,
			).toBe(true);
		} finally {
			await sql`ALTER TABLE platform_stripe_app_events DROP CONSTRAINT reject_test_completion`;
		}
		expect(await events.completeDeauthorization(input)).toBe(true);
		expect(await events.completeDeauthorization(input)).toBe(true);
		expect(
			(await sql`SELECT enabled,revision FROM platform_connections WHERE id=${connection.id}`)[0],
		).toMatchObject({ enabled: false, revision: 1 });
		expect(
			(
				await sql`SELECT processed_at FROM platform_stripe_app_events WHERE event_id='evt_revoke'`
			)[0]?.processed_at,
		).not.toBeNull();
	});
});
