import { describe, expect, it } from "bun:test";
import type { MerchantSql } from "../../src/platform/database";
import { addOrganizationOwner } from "../../src/platform/operator-owner";

interface Scenario {
	organization?: { id: string; status: string; member_limit: number };
	hasMembers?: boolean;
	person?: { id: string; status: string; email_verified: boolean };
	membership?: { id: string; role: string; status: string };
	used?: number;
}

const acme = { id: "organization-1", status: "active", member_limit: 3 };
const person = { id: "principal-1", status: "active", email_verified: true };
const input = { organizationSlug: "acme", email: "owner@acme.example", operator: "ops-runbook" };

/** Answers each statement the function issues from `scenario` and records all of them. */
function fakeSql(scenario: Scenario) {
	const statements: { text: string; values: readonly unknown[] }[] = [];
	const answer = (raw: string, values: readonly unknown[]) => {
		const text = raw.replace(/\s+/g, " ").trim();
		statements.push({ text, values });
		if (text.includes("FROM platform_organizations WHERE slug="))
			return scenario.organization ? [scenario.organization] : [];
		if (text.includes("AS has_members"))
			return [{ status: "active", has_members: scenario.hasMembers ?? false }];
		if (text.includes("FROM platform_principals")) return scenario.person ? [scenario.person] : [];
		if (text.startsWith("SELECT count(*)")) return [{ used: scenario.used ?? 0 }];
		if (
			text.includes("FROM platform_memberships WHERE organization_id") &&
			text.includes("FOR UPDATE")
		)
			return scenario.membership ? [scenario.membership] : [];
		if (text.startsWith("INSERT INTO platform_memberships")) return [{ id: "membership-new" }];
		return [];
	};
	const sql: MerchantSql = Object.assign(
		async (strings: TemplateStringsArray, ...values: unknown[]) =>
			answer(strings.join("?"), values),
		{
			query: async (query: { text: string; values: readonly unknown[] }) =>
				answer(query.text, query.values),
			begin: (work: (tx: MerchantSql) => Promise<unknown>) => work(sql),
		},
	) as unknown as MerchantSql;
	return {
		sql,
		statements,
		inserts: () => statements.filter((s) => s.text.startsWith("INSERT INTO platform_memberships")),
		audit: () =>
			statements
				.filter((s) => s.text.startsWith("INSERT INTO platform_audit_events"))
				.map((s) => s.values),
	};
}

describe("addOrganizationOwner", () => {
	it("makes a signed-in person the owner of an organization nobody has joined", async () => {
		const db = fakeSql({ organization: acme, person });
		await expect(addOrganizationOwner(db.sql, input)).resolves.toEqual({
			organization: "acme",
			email: "owner@acme.example",
			role: "Owner",
			membershipId: "membership-new",
			added: true,
		});
		expect(db.statements[0]?.text).toContain("FOR UPDATE");
		expect(db.inserts().map((s) => s.values)).toEqual([["organization-1", "principal-1"]]);
		expect(db.inserts()[0]?.text).toContain("'Owner'");
		// The audit event names the operator and the membership, never the address.
		expect(db.audit()).toEqual([
			[
				null,
				"organization-1",
				"membership.operator_owner_added",
				"membership-new",
				JSON.stringify({ operator: "ops-runbook" }),
			],
		]);
	});

	it("finds the person by address ignoring case and surrounding space", async () => {
		const db = fakeSql({ organization: acme, person });
		const result = await addOrganizationOwner(db.sql, { ...input, email: "  Owner@ACME.example " });
		expect(result.email).toBe("Owner@ACME.example");
		const lookup = db.statements.find((s) => s.text.includes("FROM platform_principals"));
		expect(lookup?.text).toContain("lower(u.email)=lower(?)");
		expect(lookup?.values).toEqual(["Owner@ACME.example"]);
	});

	it("changes nothing for a person who already owns the organization", async () => {
		const db = fakeSql({
			organization: acme,
			person,
			membership: { id: "membership-1", role: "Owner", status: "active" },
			hasMembers: true,
		});
		// The organization has members, yet a repeated run needs no reason because nothing changes.
		await expect(addOrganizationOwner(db.sql, input)).resolves.toMatchObject({
			membershipId: "membership-1",
			added: false,
		});
		expect(db.inserts()).toHaveLength(0);
		expect(db.audit()).toHaveLength(0);
	});

	it("never changes another membership", async () => {
		for (const membership of [
			{ id: "membership-1", role: "Admin", status: "active" },
			{ id: "membership-1", role: "Owner", status: "suspended" },
			{ id: "membership-1", role: "Viewer", status: "removed" },
		]) {
			const db = fakeSql({ organization: acme, person, membership, hasMembers: true });
			await expect(
				addOrganizationOwner(db.sql, { ...input, memberOverrideReason: "owner asked" }),
			).rejects.toThrow(`(${membership.role}, ${membership.status}); change it in the merchant`);
			expect(db.inserts()).toHaveLength(0);
			expect(db.audit()).toHaveLength(0);
		}
	});

	it("leaves an organization that already has members to them unless the operator says why", async () => {
		const refused = fakeSql({ organization: acme, person, hasMembers: true });
		await expect(addOrganizationOwner(refused.sql, input)).rejects.toThrow(
			"--member-override-reason",
		);
		expect(refused.inserts()).toHaveLength(0);

		const reasoned = fakeSql({ organization: acme, person, hasMembers: true });
		await expect(
			addOrganizationOwner(reasoned.sql, {
				...input,
				memberOverrideReason: "owner left the company",
			}),
		).resolves.toMatchObject({ added: true });
		expect(reasoned.audit()).toEqual([
			[
				null,
				"organization-1",
				"membership.operator_owner_added",
				"membership-new",
				JSON.stringify({ operator: "ops-runbook", memberOverrideReason: "owner left the company" }),
			],
		]);
	});

	it("needs an active organization that exists", async () => {
		await expect(addOrganizationOwner(fakeSql({ person }).sql, input)).rejects.toThrow(
			"Organization acme was not found",
		);
		const suspended = fakeSql({ organization: { ...acme, status: "suspended" }, person });
		await expect(addOrganizationOwner(suspended.sql, input)).rejects.toThrow(
			"Organization acme is suspended",
		);
		expect(suspended.inserts()).toHaveLength(0);
	});

	it("needs a merchant user who has signed in, is active and has a verified address", async () => {
		await expect(addOrganizationOwner(fakeSql({ organization: acme }).sql, input)).rejects.toThrow(
			"No merchant user has signed in with that address",
		);
		for (const candidate of [
			{ ...person, status: "suspended" },
			{ ...person, email_verified: false },
		]) {
			const db = fakeSql({ organization: acme, person: candidate });
			await expect(addOrganizationOwner(db.sql, input)).rejects.toThrow(
				"not active or has not verified",
			);
			expect(db.inserts()).toHaveLength(0);
		}
	});

	it("respects the organization's member limit", async () => {
		const full = fakeSql({ organization: acme, person, used: 3 });
		await expect(addOrganizationOwner(full.sql, input)).rejects.toThrow(
			"reached its member limit of 3",
		);
		expect(full.inserts()).toHaveLength(0);
		await expect(
			addOrganizationOwner(fakeSql({ organization: acme, person, used: 2 }).sql, input),
		).resolves.toMatchObject({ added: true });
	});
});
