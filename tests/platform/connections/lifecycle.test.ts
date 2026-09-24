import { describe, expect, it } from "bun:test";
import type { PlatformProjectInstanceRecord } from "../../../src/platform/application/ports";
import {
	type ConnectionActor,
	type ConnectionGate,
	ConnectionLifecycle,
} from "../../../src/platform/connections/lifecycle";
import type { ConnectionRepository } from "../../../src/platform/connections/repository";
import type { MerchantSql } from "../../../src/platform/database";

const instance: PlatformProjectInstanceRecord = {
	id: "instance-1",
	platformProjectId: "project-1",
	key: "example-sandbox",
	name: "Example Project",
	environment: "sandbox",
	lifecycleStatus: "active",
	internalProject: false,
};
const principal: ConnectionActor = { kind: "principal", principalId: "principal-1" };
const operator: ConnectionActor = { kind: "operator", name: "ops-runbook" };

/** Records every statement. Only the connection update reports a changed row. */
function recordingSql() {
	const statements: { text: string; values: readonly unknown[] }[] = [];
	const record = (text: string, values: readonly unknown[]) => {
		statements.push({ text: text.replace(/\s+/g, " ").trim(), values });
		return text.includes("UPDATE platform_connections SET")
			? [{ id: "connection-1", revision: 4 }]
			: [];
	};
	const sql: MerchantSql = Object.assign(
		async (strings: TemplateStringsArray, ...values: unknown[]) =>
			record(strings.join("?"), values),
		{
			query: async (query: { text: string; values: readonly unknown[] }) =>
				record(query.text, query.values),
			begin: (work: (tx: MerchantSql) => Promise<unknown>) => work(sql),
		},
	) as unknown as MerchantSql;
	return { sql, statements };
}

/** A gate that records each hook the lifecycle calls, in order. */
function recordingGate(actor: ConnectionActor, hooks: string[]): ConnectionGate {
	return {
		actor,
		environment: "sandbox",
		async instance(_sql, write) {
			hooks.push(`instance:${write}`);
			return instance;
		},
		async lock(_tx, capability) {
			hooks.push(`lock:${capability ?? "none"}`);
		},
		async confirm(_tx, action, target) {
			hooks.push(`confirm:${action}:${target}`);
		},
		async organizationId() {
			hooks.push("organization");
			return "organization-1";
		},
	};
}

function lifecycleWith(sql: MerchantSql) {
	return new ConnectionLifecycle({
		sql,
		repository: {} as ConnectionRepository,
		validator: {
			normalize: (_kind, _environment, input) => input,
			validate: async () => {
				throw new Error("Unused");
			},
		},
		hash: (value) => `hash(${value})`,
		now: () => new Date("2026-01-01T00:00:00.000Z"),
	});
}

async function run(
	actor: ConnectionActor,
	operation: (lifecycle: ConnectionLifecycle, gate: ConnectionGate) => Promise<unknown>,
) {
	const { sql, statements } = recordingSql();
	const hooks: string[] = [];
	const result = await operation(lifecycleWith(sql), recordingGate(actor, hooks));
	const audit = statements.filter((statement) =>
		statement.text.startsWith("INSERT INTO platform_audit_events"),
	);
	return { result, hooks, audit: audit.map((statement) => statement.values) };
}

describe("ConnectionLifecycle", () => {
	it("resolves, locks and confirms through the gate before it writes an audit event", async () => {
		const disabled = await run(principal, (lifecycle, gate) =>
			lifecycle.disable(gate, "projection", "key-1", 3),
		);
		expect(disabled.hooks).toEqual([
			"instance:true",
			"lock:none",
			"confirm:connections.manage:disable:projection:3",
			"organization",
		]);
		const rotated = await run(principal, (lifecycle, gate) =>
			lifecycle.rotateCredential(gate, "key-2", "full"),
		);
		expect(rotated.hooks).toEqual([
			"instance:true",
			"lock:sandbox.credentials.rotate",
			"confirm:credentials.rotate:key-2",
			"organization",
		]);
		expect(rotated.result).toMatchObject({ access: "full", credentialDisclosed: true });
	});

	it("records a principal actor as the audit principal", async () => {
		const { audit } = await run(principal, (lifecycle, gate) =>
			lifecycle.disable(gate, "projection", "key-1", 3),
		);
		expect(audit).toEqual([
			[
				"principal-1",
				"organization-1",
				"connection.disabled",
				"connection-1",
				JSON.stringify({ kind: "projection", revision: 3 }),
			],
		]);
	});

	it("records an operator actor by name, without a principal", async () => {
		const disabled = await run(operator, (lifecycle, gate) =>
			lifecycle.disable(gate, "projection", "key-1", 3),
		);
		expect(disabled.audit).toEqual([
			[
				null,
				"organization-1",
				"connection.disabled",
				"connection-1",
				JSON.stringify({ kind: "projection", revision: 3, operator: "ops-runbook" }),
			],
		]);
		const rotated = await run(operator, (lifecycle, gate) =>
			lifecycle.rotateCredential(gate, "key-2", "read_only"),
		);
		expect(rotated.audit).toEqual([
			[
				null,
				"organization-1",
				"credential.issued",
				"instance-1",
				JSON.stringify({ access: "read_only", operator: "ops-runbook" }),
			],
		]);
	});
});
