import { describe, expect, it } from "bun:test";
import type { PlatformProjectInstanceRecord } from "../../../src/platform/application/ports";
import type { ConnectionCipher } from "../../../src/platform/connections/cipher";
import {
	type ConnectionActor,
	type ConnectionGate,
	ConnectionLifecycle,
} from "../../../src/platform/connections/lifecycle";
import type { EnvironmentBillingPort } from "../../../src/platform/connections/ports";
import { ConnectionRepository } from "../../../src/platform/connections/repository";
import type { MerchantSql } from "../../../src/platform/database";
import { MerchantError } from "../../../src/platform/security";
import { canonicalJson } from "../../../src/platform/step-up";

const now = new Date("2026-01-01T00:00:00.000Z");
const inactiveProduction: PlatformProjectInstanceRecord = {
	id: "instance-1",
	platformProjectId: "project-1",
	key: "example",
	name: "Example Project",
	environment: "production",
	lifecycleStatus: "inactive",
	internalProject: false,
};
const operator: ConnectionActor = { kind: "operator", name: "ops-runbook" };

type Row = {
	id: string;
	kind: string;
	revision: number;
	enabled: boolean;
	active_version_id: string | null;
	settings: Record<string, unknown> | null;
	validated_at: Date | null;
	event_verified_at: Date | null;
};
const connection = (id: string, kind: string, revision: number, overrides: Partial<Row> = {}) => ({
	id,
	kind,
	revision,
	enabled: true,
	active_version_id: `${id}-version`,
	settings: {},
	validated_at: now,
	event_verified_at: kind === "projection" ? null : now,
	...overrides,
});
const readyConnections = [connection("c1", "projection", 1), connection("c2", "stripe", 2)];
const readyFingerprint = `hash(${canonicalJson({
	catalog: "7",
	connections: [
		["c1", 1, "c1-version"],
		["c2", 2, "c2-version"],
	],
})})`;

/** Answers the connection list and receipt lookups; records writes and activation calls. */
function activationSql(
	options: {
		connections?: Row[];
		/** The connection list the second read (under the lock) finds, when it differs. */
		connectionsUnderLock?: Row[];
		receipt?: { action: string; result: Record<string, unknown> };
		activated?: boolean;
	} = {},
) {
	const statements: { text: string; values: readonly unknown[] }[] = [];
	const activations: unknown[][] = [];
	let listReads = 0;
	const answer = (text: string, values: readonly unknown[]) => {
		const normalized = text.replace(/\s+/g, " ").trim();
		statements.push({ text: normalized, values });
		if (normalized.includes("FROM platform_connections c LEFT JOIN")) {
			listReads += 1;
			return listReads > 1 && options.connectionsUnderLock
				? options.connectionsUnderLock
				: (options.connections ?? readyConnections);
		}
		if (normalized.startsWith("SELECT action,result FROM platform_connection_operations"))
			return options.receipt ? [options.receipt] : [];
		return [];
	};
	const sql: MerchantSql = Object.assign(
		async (strings: TemplateStringsArray, ...values: unknown[]) =>
			answer(strings.join("?"), values),
		{
			query: async (query: { text: string; values: readonly unknown[] }) =>
				answer(query.text, query.values),
			begin: (work: (tx: MerchantSql) => Promise<unknown>) => work(sql),
			instances: {
				activateProduction: async (...args: unknown[]) => {
					activations.push(args);
					return options.activated ?? true;
				},
			},
		},
	) as unknown as MerchantSql;
	return { sql, statements, activations };
}

function billing(ready: boolean): EnvironmentBillingPort {
	return {
		catalogReadiness: async () => ({
			revisionId: ready ? "7" : null,
			providers: ready ? ["stripe"] : [],
			ready,
		}),
		promote: async () => {
			throw new Error("Unused");
		},
	};
}

function gateFor(
	hooks: string[],
	{
		environment = "production",
		instance = inactiveProduction,
		enforcesProductionLimit = false,
		actor = operator,
	}: {
		environment?: "sandbox" | "production";
		instance?: PlatformProjectInstanceRecord;
		enforcesProductionLimit?: boolean;
		actor?: ConnectionActor;
	} = {},
): ConnectionGate {
	return {
		actor,
		environment,
		enforcesProductionLimit,
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
		repository: new ConnectionRepository(sql, {} as ConnectionCipher),
		validator: {
			normalize: (_kind, _environment, input) => input,
			validate: async () => {
				throw new Error("Unused");
			},
		},
		hash: (value) => `hash(${value})`,
		now: () => now,
	});
}

async function failure(work: Promise<unknown>): Promise<MerchantError> {
	try {
		await work;
	} catch (error) {
		if (error instanceof MerchantError) return error;
		throw error;
	}
	throw new Error("Expected the call to fail");
}

describe("ConnectionLifecycle.readiness", () => {
	it("is ready once every enabled connection is fresh, verified and cataloged", async () => {
		const { sql } = activationSql();
		const readiness = await lifecycleWith(sql).readiness(gateFor([]), billing(true));
		expect(readiness).toMatchObject({
			instanceId: "instance-1",
			instanceKey: "example",
			lifecycleStatus: "inactive",
			ready: true,
			blockers: [],
			catalogRevisionId: "7",
			fingerprint: readyFingerprint,
		});
	});

	it("names each blocker with its connection, in the order the console parses them", async () => {
		const stale = new Date(now.getTime() - 900_001);
		const { sql } = activationSql({
			connections: [
				connection("c1", "projection", 1, { validated_at: stale }),
				connection("c2", "stripe", 2, { event_verified_at: null }),
			],
		});
		const readiness = await lifecycleWith(sql).readiness(gateFor([]), billing(false));
		expect(readiness.ready).toBe(false);
		expect(readiness.blockers).toEqual([
			"PROJECTION_VALIDATION_REQUIRED",
			"STRIPE_EVENT_REQUIRED",
			"STRIPE_CATALOG_REQUIRED",
			"PUBLISHED_CATALOG_REQUIRED",
		]);
		expect(readiness.blockerDetails).toEqual([
			{
				code: "PROJECTION_VALIDATION_REQUIRED",
				gating: true,
				connectionKind: "projection",
				observed: { validatedAt: stale.toISOString(), maxAgeSeconds: 900 },
			},
			{
				code: "STRIPE_EVENT_REQUIRED",
				gating: true,
				connectionKind: "stripe",
				provider: "stripe",
			},
			{
				code: "STRIPE_CATALOG_REQUIRED",
				gating: true,
				connectionKind: "stripe",
				provider: "stripe",
			},
			{ code: "PUBLISHED_CATALOG_REQUIRED", gating: true },
		]);
	});

	it("needs a provider and treats a missing projection as unvalidated", async () => {
		const { sql } = activationSql({ connections: [] });
		const readiness = await lifecycleWith(sql).readiness(gateFor([]), billing(false));
		expect(readiness.blockers).toEqual([
			"PROVIDER_REQUIRED",
			"PROJECTION_VALIDATION_REQUIRED",
			"PUBLISHED_CATALOG_REQUIRED",
		]);
	});
});

describe("ConnectionLifecycle.activate", () => {
	it("resolves, locks and confirms through the gate, then audits the operator by name", async () => {
		const { sql, statements, activations } = activationSql();
		const hooks: string[] = [];
		const delivered: string[] = [];
		const result = await lifecycleWith(sql).activate(gateFor(hooks), billing(true), "key-1", {
			fingerprint: null,
			deliver: async (credential) => {
				delivered.push(credential);
			},
		});
		expect(hooks).toEqual([
			"instance:false",
			"instance:true",
			"lock:production.activate",
			"organization",
			`confirm:environment.activate:${readyFingerprint}`,
			"organization",
		]);
		expect(result).toMatchObject({ active: true, credentialDisclosed: true });
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toMatch(/^pqpk_[A-Za-z0-9_-]{43}$/u);
		expect((result as { credential?: string }).credential).toBe(delivered[0]);
		expect(activations).toEqual([
			["instance-1", "organization-1", "7", { enforceProductionLimit: false }],
		]);
		expect(
			statements
				.filter((statement) => statement.text.startsWith("INSERT INTO platform_audit_events"))
				.map((statement) => statement.values),
		).toEqual([
			[
				null,
				"organization-1",
				"environment.activated",
				"instance-1",
				JSON.stringify({ catalogRevisionId: "7", operator: "ops-runbook" }),
			],
		]);
		const receipt = statements.find((statement) =>
			statement.text.startsWith("INSERT INTO platform_connection_operations"),
		);
		expect(receipt?.values.slice(0, 3)).toEqual([
			"instance-1",
			"key-1",
			`activate:${readyFingerprint}`,
		]);
		// The stored receipt never holds the key.
		expect(JSON.stringify(receipt?.values)).not.toContain(delivered[0] ?? "missing");
	});

	it.each([true, false])(
		"hands the gate's production-limit setting (%p) to the port",
		async (enforce) => {
			const { sql, activations } = activationSql();
			await lifecycleWith(sql).activate(
				gateFor([], { enforcesProductionLimit: enforce }),
				billing(true),
				"key-1",
				{ fingerprint: null },
			);
			expect(activations[0]?.[3]).toEqual({ enforceProductionLimit: enforce });
		},
	);

	it("binds a merchant to the reviewed fingerprint and refuses any other", async () => {
		const { sql, activations } = activationSql();
		const hooks: string[] = [];
		const stale = await failure(
			lifecycleWith(sql).activate(gateFor(hooks), billing(true), "key-1", {
				fingerprint: "stale",
			}),
		);
		expect(stale).toMatchObject({ code: "ENVIRONMENT_NOT_READY", status: 409 });
		expect(activations).toEqual([]);
		const reviewed = await lifecycleWith(sql).activate(gateFor(hooks), billing(true), "key-2", {
			fingerprint: readyFingerprint,
		});
		expect(reviewed).toMatchObject({ active: true, credentialDisclosed: true });
		expect(hooks).toContain(`confirm:environment.activate:${readyFingerprint}`);
	});

	it("activates nothing and issues no key while a blocker remains", async () => {
		const { sql, statements, activations } = activationSql({ connections: [] });
		let delivered = false;
		const error = await failure(
			lifecycleWith(sql).activate(gateFor([]), billing(false), "key-1", {
				fingerprint: null,
				deliver: async () => {
					delivered = true;
				},
			}),
		);
		expect(error).toMatchObject({ code: "ENVIRONMENT_NOT_READY", status: 409 });
		expect(delivered).toBe(false);
		expect(activations).toEqual([]);
		expect(statements.filter((statement) => statement.text.startsWith("INSERT INTO"))).toEqual([]);
	});

	it("refuses a connection whose validation went stale between readiness and the lock", async () => {
		const { sql, activations } = activationSql();
		let underLock = false;
		const lifecycle = new ConnectionLifecycle({
			sql,
			repository: new ConnectionRepository(sql, {} as ConnectionCipher),
			validator: {
				normalize: (_kind, _environment, input) => input,
				validate: async () => {
					throw new Error("Unused");
				},
			},
			hash: (value) => `hash(${value})`,
			now: () => (underLock ? new Date(now.getTime() + 900_001) : now),
		});
		const gate: ConnectionGate = {
			...gateFor([]),
			async lock() {
				underLock = true;
			},
		};
		const error = await failure(
			lifecycle.activate(gate, billing(true), "key-1", { fingerprint: null }),
		);
		expect(error).toMatchObject({ code: "ENVIRONMENT_NOT_READY", status: 409 });
		expect(error.message).toContain("Refresh connection verification");
		expect(activations).toEqual([]);
	});

	it("refuses a connection that changed between readiness and the lock", async () => {
		const { sql, activations } = activationSql({
			connectionsUnderLock: [connection("c1", "projection", 1), connection("c2", "stripe", 3)],
		});
		const error = await failure(
			lifecycleWith(sql).activate(gateFor([]), billing(true), "key-1", { fingerprint: null }),
		);
		expect(error).toMatchObject({ code: "CONNECTION_CHANGED", status: 409 });
		expect(activations).toEqual([]);
	});

	it("refuses the activation when the production limit or catalog changed", async () => {
		const { sql } = activationSql({ activated: false });
		const error = await failure(
			lifecycleWith(sql).activate(gateFor([]), billing(true), "key-1", { fingerprint: null }),
		);
		expect(error).toMatchObject({ code: "ACTIVATION_CONFLICT", status: 409 });
	});

	it("answers an active environment without a key or a second activation", async () => {
		const { sql, activations } = activationSql();
		let delivered = false;
		const result = await lifecycleWith(sql).activate(
			gateFor([], { instance: { ...inactiveProduction, lifecycleStatus: "active" } }),
			billing(true),
			"key-1",
			{
				fingerprint: null,
				deliver: async () => {
					delivered = true;
				},
			},
		);
		expect(result as unknown).toEqual({ active: true, credentialDisclosed: false });
		expect(delivered).toBe(false);
		expect(activations).toEqual([]);
	});

	it("replays a saved receipt without a key and rejects the key for another request", async () => {
		const saved = { active: true, credentialDisclosed: false };
		const replay = activationSql({
			receipt: { action: `activate:${readyFingerprint}`, result: saved },
		});
		const result = await lifecycleWith(replay.sql).activate(gateFor([]), billing(true), "key-1", {
			fingerprint: null,
		});
		expect(result as unknown).toEqual(saved);
		expect(replay.activations).toEqual([]);
		const other = activationSql({ receipt: { action: "activate:another", result: saved } });
		expect(
			await failure(
				lifecycleWith(other.sql).activate(gateFor([]), billing(true), "key-1", {
					fingerprint: null,
				}),
			),
		).toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
	});

	it("leaves sandbox to onboarding without reading anything", async () => {
		const { sql, statements } = activationSql();
		const hooks: string[] = [];
		const error = await failure(
			lifecycleWith(sql).activate(
				gateFor(hooks, { environment: "sandbox" }),
				billing(true),
				"key-1",
				{ fingerprint: null },
			),
		);
		expect(error).toMatchObject({ code: "INVALID_REQUEST" });
		expect(hooks).toEqual([]);
		expect(statements).toEqual([]);
	});

	it("fails the activation when the key cannot be delivered", async () => {
		const { sql } = activationSql();
		await expect(
			lifecycleWith(sql).activate(gateFor([]), billing(true), "key-1", {
				fingerprint: null,
				deliver: async () => {
					throw new Error("disk full");
				},
			}),
		).rejects.toThrow("disk full");
	});
});
