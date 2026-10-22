import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { type ConnectionGate, ConnectionLifecycle } from "../../src/platform/connections/lifecycle";
import { merchantFixture, stubConnectionValidation } from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

const lifecycle = new ConnectionLifecycle({
	sql: f.sql,
	repository: f.connectionRepository,
	validator: stubConnectionValidation(),
	hash: (value) => f.store.hash(value),
	now: () => f.store.now(),
});

async function seedSandbox(): Promise<{ organizationId: string; platformProjectId: string }> {
	const [organization] = await f.sql<{ id: string }[]>`
		INSERT INTO platform_organizations(slug,name) VALUES('acme','Acme Company') RETURNING id
	`;
	const [platformProject] = await f.sql<{ id: string }[]>`
		INSERT INTO platform_projects(organization_id,key,name)
		VALUES(${organization?.id ?? null},'example','Example Project') RETURNING id
	`;
	if (!organization || !platformProject) throw new Error("Missing seeded topology");
	await f.sql`
		INSERT INTO projects(key,name,platform_project_id,environment,lifecycle_status,internal_project)
		VALUES('example-sandbox','Example Project',${platformProject.id},'sandbox','active',false)
	`;
	return { organizationId: organization.id, platformProjectId: platformProject.id };
}

/** A gate with direct database access, like an operator command: it resolves and locks only. */
function operatorGate(topology: {
	organizationId: string;
	platformProjectId: string;
}): ConnectionGate {
	return {
		actor: { kind: "operator", name: "ops-runbook" },
		environment: "sandbox",
		async instance(sql) {
			const instance = (await sql.instances.forProject(topology.platformProjectId)).find(
				(candidate) => candidate.environment === "sandbox",
			);
			if (!instance) throw new Error("Missing sandbox instance");
			return instance;
		},
		async lock(tx) {
			await tx`SELECT id FROM platform_organizations WHERE id=${topology.organizationId} FOR UPDATE`;
		},
		async confirm() {},
		async organizationId() {
			return topology.organizationId;
		},
	};
}

describe("connection lifecycle with an operator actor", () => {
	it("audits every change under the operator's name and no principal", async () => {
		const topology = await seedSandbox();
		const gate = operatorGate(topology);

		const draft = await lifecycle.draft(gate, "projection", "operator-draft-1", {
			settings: { projectionUrl: "https://backend.example/billing/projection" },
			secrets: {},
			expectedRevision: 0,
		});
		expect(draft).toMatchObject({ secretDisclosed: true, projectionSecret: expect.any(String) });
		await lifecycle.validate(gate, "projection", draft.draftId);
		const committed = await lifecycle.commit(
			gate,
			"projection",
			draft.draftId,
			"operator-commit-1",
		);
		expect(committed).toMatchObject({ enabled: true, revision: 1 });
		const revision = 1;
		const issued = await lifecycle.rotateCredential(gate, "operator-rotate-1", "full");
		expect(issued).toMatchObject({ access: "full", credentialDisclosed: true });
		expect(
			(await lifecycle.rotateCredential(gate, "operator-rotate-2", "full")).credentialDisclosed,
		).toBeTrue();
		await lifecycle.disable(gate, "projection", "operator-disable-1", revision);

		const events = await f.sql<
			{
				principal_id: string | null;
				organization_id: string | null;
				action: string;
				metadata: Record<string, unknown>;
			}[]
		>`SELECT principal_id,organization_id,action,metadata FROM platform_audit_events ORDER BY created_at,action`;
		const operator = "ops-runbook";
		expect(events).toEqual([
			{
				principal_id: null,
				organization_id: topology.organizationId,
				action: "connection.draft_created",
				metadata: { kind: "projection", operator },
			},
			{
				principal_id: null,
				organization_id: topology.organizationId,
				action: "connection.committed",
				metadata: { kind: "projection", versionId: draft.draftId, operator },
			},
			{
				principal_id: null,
				organization_id: topology.organizationId,
				action: "credential.issued",
				metadata: { access: "full", operator },
			},
			{
				principal_id: null,
				organization_id: topology.organizationId,
				action: "credential.rotated",
				metadata: { access: "full", operator },
			},
			{
				principal_id: null,
				organization_id: topology.organizationId,
				action: "connection.disabled",
				metadata: { kind: "projection", revision, operator },
			},
		]);
		const [live] = await f.sql<{ count: number }[]>`
			SELECT count(*)::int AS count FROM platform_project_api_credentials
			WHERE access='full' AND revoked_at IS NULL
		`;
		expect(live?.count).toBe(1);
	});
});
