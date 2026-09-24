import { describe, expect, it } from "bun:test";
import type { PlatformProjectInstanceRecord } from "../../../src/platform/application/ports";
import {
	type OperatorConnectionTarget,
	operatorConnectionGate,
} from "../../../src/platform/connections/operator-gate";
import type { MerchantSql } from "../../../src/platform/database";
import { MerchantError } from "../../../src/platform/security";

const target: OperatorConnectionTarget = {
	organizationId: "organization-1",
	platformProjectId: "project-1",
	instanceId: "instance-1",
	environment: "sandbox",
};

const instance: PlatformProjectInstanceRecord = {
	id: "instance-1",
	platformProjectId: "project-1",
	key: "alpha-sandbox",
	name: "Alpha",
	environment: "sandbox",
	lifecycleStatus: "active",
	internalProject: false,
};

/** Answers the organization check with `organization` and lists `instances` for the project. */
function fakeSql(
	organization: { status: string; has_members: boolean } | undefined,
	instances: PlatformProjectInstanceRecord[] = [instance],
	locked: unknown[] = [{ id: "organization-1" }],
) {
	const statements: { text: string; values: unknown[] }[] = [];
	const sql = Object.assign(
		async (strings: TemplateStringsArray, ...values: unknown[]) => {
			const text = strings.join("?");
			statements.push({ text, values });
			if (text.includes("FOR UPDATE")) return locked;
			return organization === undefined ? [] : [organization];
		},
		{
			instances: {
				forProject: async (platformProjectId: string) => {
					statements.push({ text: "instances.forProject", values: [platformProjectId] });
					return instances;
				},
			},
		},
	) as unknown as MerchantSql;
	return { sql, statements };
}

describe("operatorConnectionGate", () => {
	it("records the operator and resolves the target through the instance port", async () => {
		const gate = operatorConnectionGate("ops-runbook", target, { allowMemberOrganizations: false });
		expect(gate.actor).toEqual({ kind: "operator", name: "ops-runbook" });
		expect(gate.environment).toBe("sandbox");
		const { sql, statements } = fakeSql({ status: "active", has_members: false });
		await expect(gate.instance(sql, true)).resolves.toEqual(instance);
		expect(statements.map((statement) => statement.values)).toEqual([
			["organization-1", "organization-1"],
			["project-1"],
		]);
		await expect(gate.organizationId(sql)).resolves.toBe("organization-1");
		await expect(gate.confirm(sql, "credentials.rotate", "key")).resolves.toBeUndefined();
	});

	it("applies the merchant gate's instance filters", async () => {
		const gate = operatorConnectionGate("ops", target, { allowMemberOrganizations: false });
		for (const candidate of [
			{ ...instance, environment: "production" as const },
			{ ...instance, internalProject: true },
			{ ...instance, lifecycleStatus: "deactivated" as const },
			{ ...instance, id: "instance-2" },
		]) {
			const { sql } = fakeSql({ status: "active", has_members: false }, [candidate]);
			await expect(gate.instance(sql, false)).rejects.toThrow(MerchantError);
		}
		const inactive = fakeSql({ status: "active", has_members: false }, [
			{ ...instance, lifecycleStatus: "inactive" },
		]);
		await expect(gate.instance(inactive.sql, true)).resolves.toMatchObject({ id: "instance-1" });
	});

	it("requires an active organization", async () => {
		const gate = operatorConnectionGate("ops", target, { allowMemberOrganizations: true });
		for (const organization of [undefined, { status: "suspended", has_members: false }]) {
			const { sql, statements } = fakeSql(organization);
			await expect(gate.instance(sql, false)).rejects.toThrow("This environment is unavailable.");
			expect(statements.some((statement) => statement.text === "instances.forProject")).toBe(false);
		}
		const { sql, statements } = fakeSql({ status: "active", has_members: false }, [instance], []);
		await expect(gate.lock(sql)).rejects.toThrow("This environment is unavailable.");
		expect(statements[0]?.text).toContain("status='active' FOR UPDATE");
	});

	it("leaves organizations with members to them while the merchant platform runs", async () => {
		const members = { status: "active", has_members: true };
		await expect(
			operatorConnectionGate("ops", target, { allowMemberOrganizations: false }).instance(
				fakeSql(members).sql,
				false,
			),
		).rejects.toThrow("This organization has members");
		await expect(
			operatorConnectionGate("ops", target, { allowMemberOrganizations: true }).instance(
				fakeSql(members).sql,
				false,
			),
		).resolves.toEqual(instance);
	});

	it("checks for members again once it holds the organization lock", async () => {
		const gate = operatorConnectionGate("ops", target, { allowMemberOrganizations: false });
		// A membership accepted after instance() passed is seen under the lock.
		const joined = fakeSql({ status: "active", has_members: true });
		await expect(gate.lock(joined.sql)).rejects.toThrow("This organization has members");
		expect(joined.statements.map((statement) => statement.text)).toEqual([
			expect.stringContaining("FOR UPDATE"),
			expect.stringContaining("platform_memberships"),
		]);
		await expect(gate.lock(fakeSql({ status: "active", has_members: false }).sql)).resolves.toBe(
			undefined,
		);
		// Without the merchant platform, members do not matter and the lock alone is enough.
		const headless = fakeSql({ status: "active", has_members: true });
		await expect(
			operatorConnectionGate("ops", target, { allowMemberOrganizations: true }).lock(headless.sql),
		).resolves.toBeUndefined();
		expect(headless.statements).toHaveLength(1);
	});
});
