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
import { canonicalJson } from "../../../src/platform/step-up";

const now = new Date("2026-01-01T00:00:00.000Z");
const activeProduction: PlatformProjectInstanceRecord = {
	id: "instance-1",
	platformProjectId: "project-1",
	key: "example",
	name: "Example Project",
	environment: "production",
	lifecycleStatus: "active",
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

/** Readiness reads only; transaction or mutation attempts fail this fixture. */
function readinessSql(options: { connections?: Row[] } = {}) {
	const sql = {
		query: async ({ text }: { text: string }) =>
			text.replace(/\s+/g, " ").includes("FROM platform_connections c LEFT JOIN")
				? (options.connections ?? readyConnections)
				: [],
	} as unknown as MerchantSql;
	return { sql };
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
		instance = activeProduction,
		actor = operator,
	}: {
		environment?: "sandbox" | "production";
		instance?: PlatformProjectInstanceRecord;
		actor?: ConnectionActor;
	} = {},
): ConnectionGate {
	return {
		actor,
		environment,
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

describe("ConnectionLifecycle.readiness", () => {
	it("is ready once every enabled connection is fresh, verified and cataloged", async () => {
		const { sql } = readinessSql();
		const readiness = await lifecycleWith(sql).readiness(gateFor([]), billing(true));
		expect(readiness).toMatchObject({
			instanceId: "instance-1",
			instanceKey: "example",
			lifecycleStatus: "active",
			ready: true,
			blockers: [],
			catalogRevisionId: "7",
			fingerprint: readyFingerprint,
		});
	});

	it("names each blocker with its connection, in the order the console parses them", async () => {
		const stale = new Date(now.getTime() - 900_001);
		const { sql } = readinessSql({
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
				gating: false,
				connectionKind: "projection",
				observed: { validatedAt: stale.toISOString(), maxAgeSeconds: 900 },
			},
			{
				code: "STRIPE_EVENT_REQUIRED",
				gating: false,
				connectionKind: "stripe",
				provider: "stripe",
			},
			{
				code: "STRIPE_CATALOG_REQUIRED",
				gating: false,
				connectionKind: "stripe",
				provider: "stripe",
			},
			{ code: "PUBLISHED_CATALOG_REQUIRED", gating: false },
		]);
	});

	it("needs a provider and treats a missing projection as unvalidated", async () => {
		const { sql } = readinessSql({ connections: [] });
		const readiness = await lifecycleWith(sql).readiness(gateFor([]), billing(false));
		expect(readiness.blockers).toEqual([
			"PROVIDER_REQUIRED",
			"PROJECTION_VALIDATION_REQUIRED",
			"PUBLISHED_CATALOG_REQUIRED",
		]);
	});
});
