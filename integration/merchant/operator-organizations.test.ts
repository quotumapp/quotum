import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { runConnectionsCommand } from "../../src/composition/cli/connections";
import { runOrganizationsCommand } from "../../src/composition/cli/organizations";
import { BunPlatformUnitOfWork } from "../../src/composition/project-instance-persistence";
import { parsePlatformBootstrapManifest } from "../../src/platform/bootstrap/manifest";
import { PlatformBootstrapService } from "../../src/platform/bootstrap/service";
import type { MerchantSessionView } from "../../src/platform/contracts";
import { MerchantBrowser, merchantFixture, stubConnectionValidation } from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

/** Settings of a console deployment's operator; the key matches the fixture's connection cipher. */
const env = {
	POSTGRES_URI: process.env.POSTGRES_URI,
	QUOTUM_SECRETS_KEY_ID: "test",
	QUOTUM_SECRETS_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
	QUOTUM_AUTH_SECRET: "operator-organizations-test-secret-0123456789",
	QUOTUM_CONSOLE_ENABLED: "true",
	QUOTUM_ACTOR: "ops-runbook",
};

/** An organization the way `platform:bootstrap` creates it: a sandbox, no keys and no members. */
async function seed(): Promise<void> {
	const manifest = parsePlatformBootstrapManifest(
		JSON.stringify({
			version: 1,
			organizations: [
				{
					slug: "acme",
					name: "Acme",
					projects: [
						{
							key: "alpha",
							name: "Alpha",
							instances: [
								{
									key: "alpha-sandbox",
									environment: "sandbox",
									lifecycleStatus: "active",
									issueCredential: false,
								},
							],
						},
					],
				},
			],
		}),
	);
	await new PlatformBootstrapService(new BunPlatformUnitOfWork(f.client)).apply(manifest, []);
}

type Result = { code: number; stderr: string; json: Record<string, unknown> };

async function organizations(argv: string[]): Promise<Result> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runOrganizationsCommand(argv, env, {
		output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
	});
	return { code, stderr: err.join("\n"), json: code === 0 ? JSON.parse(out.join("\n")) : {} };
}

const addOwner = (email: string, ...extra: string[]) =>
	organizations(["add-owner", "acme", "--email", email, ...extra]);

async function signedIn(email: string): Promise<MerchantBrowser> {
	const browser = new MerchantBrowser(f);
	await browser.signup(email);
	return browser;
}

const memberships = async (browser: MerchantBrowser) =>
	(await browser.json<MerchantSessionView>("/api/platform/session")).memberships.map(
		(membership) => `${membership.organizationSlug}:${membership.role}`,
	);

const operatorAudit = () => f.sql`
	SELECT principal_id, target, metadata FROM platform_audit_events
	WHERE action='membership.operator_owner_added' ORDER BY created_at
`;

describe("quotum organizations add-owner", () => {
	it("hands a bootstrap-created organization to a person who has signed in", async () => {
		await seed();
		const owner = await signedIn("owner@acme.example");
		expect(await memberships(owner)).toEqual([]);

		const added = await addOwner("owner@acme.example");
		expect(added).toMatchObject({
			code: 0,
			json: { organization: "acme", email: "owner@acme.example", role: "Owner", added: true },
		});
		expect(await memberships(owner)).toEqual(["acme:Owner"]);

		// Running it again changes nothing.
		const again = await addOwner("OWNER@acme.example");
		expect(again.json).toMatchObject({ added: false, membershipId: added.json.membershipId });
		const audit = await operatorAudit();
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({ principal_id: null, target: added.json.membershipId });
		// The audit event names the operator, never the address.
		expect(JSON.stringify(audit[0]?.metadata)).toBe(JSON.stringify({ operator: "ops-runbook" }));

		// The organization now has a member, and the operator CLI still reads it.
		const list = await runConnectionsCommand(["list", "alpha-sandbox"], env, {
			validator: stubConnectionValidation(),
			output: { stdout: () => undefined, stderr: () => undefined },
		});
		expect(list).toBe(0);
	});

	it("needs a person who has signed in", async () => {
		await seed();
		const missing = await addOwner("nobody@acme.example");
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("No merchant user has signed in with that address");
		expect(await f.sql`SELECT 1 FROM platform_memberships`).toHaveLength(0);
	});

	it("needs a stated reason once the organization has members, and never edits a membership", async () => {
		await seed();
		const first = await signedIn("owner@acme.example");
		const second = await signedIn("second@acme.example");
		await addOwner("owner@acme.example");

		const refused = await addOwner("second@acme.example");
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("--member-override-reason");
		expect(await memberships(second)).toEqual([]);

		const reasoned = await addOwner(
			"second@acme.example",
			"--member-override-reason",
			"the first owner asked for a second",
		);
		expect(reasoned.json).toMatchObject({ added: true });
		expect(await memberships(second)).toEqual(["acme:Owner"]);
		const audit = await operatorAudit();
		expect(
			audit.map((row) => (row.metadata as Record<string, unknown>).memberOverrideReason),
		).toEqual([undefined, "the first owner asked for a second"]);

		// A person with another role keeps it; the merchant application owns role changes.
		await f.sql`UPDATE platform_memberships SET role='Admin' WHERE role='Owner' AND id=${String(
			audit[0]?.target,
		)}`;
		const admin = await addOwner(
			"owner@acme.example",
			"--member-override-reason",
			"promote the admin back",
		);
		expect(admin.code).toBe(1);
		expect(admin.stderr).toContain("(Admin, active); change it in the merchant application");
		expect(await memberships(first)).toEqual(["acme:Admin"]);
	});
});
