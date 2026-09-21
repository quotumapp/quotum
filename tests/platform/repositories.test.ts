import { describe, expect, it } from "bun:test";
import type {
	PlatformQuery,
	PlatformQueryExecutor,
} from "../../src/platform/persistence/query-executor";
import {
	acquirePlatformBootstrapLock,
	PlatformLogicalProjectRepository,
	PlatformOnboardingDraftRepository,
	PlatformOrganizationRepository,
	PlatformProjectCredentialRepository,
} from "../../src/platform/persistence/repositories";

class RecordingExecutor implements PlatformQueryExecutor {
	readonly calls: PlatformQuery[] = [];

	constructor(private readonly responses: readonly (readonly unknown[])[]) {}

	async query<Row>(query: PlatformQuery): Promise<readonly Row[]> {
		this.calls.push(query);
		return (this.responses[this.calls.length - 1] ?? []) as readonly Row[];
	}
}

describe("platform schema-neutral repositories", () => {
	it("lists and creates organizations with bound values", async () => {
		const executor = new RecordingExecutor([
			[{ id: "organization-id", slug: "voysee", name: "Voysee" }],
			[{ id: "created-id", slug: "wiseley", name: "Wiseley" }],
			[{ id: "other-id" }],
			[],
			[{ id: "organization-id" }],
		]);
		const repository = new PlatformOrganizationRepository(executor);

		await expect(repository.list()).resolves.toEqual([
			{ id: "organization-id", slug: "voysee", name: "Voysee" },
		]);
		await expect(repository.create({ slug: "wiseley", name: "Wiseley" })).resolves.toEqual({
			id: "created-id",
			slug: "wiseley",
			name: "Wiseley",
		});
		expect(executor.calls[0]?.text).toContain("FROM platform_organizations");
		expect(executor.calls[1]?.text).toContain("VALUES ($1, $2)");
		expect(executor.calls[1]?.values).toEqual(["wiseley", "Wiseley"]);
		await expect(
			repository.slugBelongsToAnotherOrganization("wiseley", "organization-id"),
		).resolves.toBe(true);
		expect(executor.calls[2]?.text).toContain("WHERE slug = $1 AND id <> $2");
		expect(executor.calls[2]?.values).toEqual(["wiseley", "organization-id"]);
		const updatedAt = new Date("2026-09-18T12:00:00.000Z");
		await repository.update({
			id: "organization-id",
			name: "Wiseley",
			slug: "wiseley",
			updatedAt,
		});
		expect(executor.calls[3]?.text).toContain("SET name = $1, slug = $2, updated_at = $3");
		expect(executor.calls[3]?.values).toEqual(["Wiseley", "wiseley", updatedAt, "organization-id"]);
		await repository.lockById("organization-id");
		expect(executor.calls[4]?.text).toContain("WHERE id = $1");
		expect(executor.calls[4]?.text).toContain("FOR UPDATE");
		expect(executor.calls[4]?.values).toEqual(["organization-id"]);
	});

	it("conditionally bumps onboarding draft revisions with bound values", async () => {
		const executor = new RecordingExecutor([[{ id: "draft-id" }], []]);
		const repository = new PlatformOnboardingDraftRepository(executor);
		const updatedAt = new Date("2026-09-18T12:00:00.000Z");

		await expect(
			repository.bumpRevision({ id: "draft-id", expectedRevision: 3, updatedAt }),
		).resolves.toBe(true);
		await expect(
			repository.bumpRevision({ id: "draft-id", expectedRevision: 2, updatedAt }),
		).resolves.toBe(false);
		expect(executor.calls[0]?.text).toContain("WHERE id = $2 AND revision = $3");
		expect(executor.calls[0]?.values).toEqual([updatedAt, "draft-id", 3]);
	});

	it("maps logical-project ownership and binds create inputs", async () => {
		const executor = new RecordingExecutor([
			[
				{
					id: "project-id",
					organization_id: "organization-id",
					key: "billing",
					name: "Billing",
				},
			],
			[
				{
					id: "created-id",
					organization_id: "organization-id",
					key: "analytics",
					name: "Analytics",
				},
			],
		]);
		const repository = new PlatformLogicalProjectRepository(executor);

		await expect(repository.list()).resolves.toEqual([
			{
				id: "project-id",
				organizationId: "organization-id",
				key: "billing",
				name: "Billing",
			},
		]);
		await expect(
			repository.create({
				organizationId: "organization-id",
				key: "analytics",
				name: "Analytics",
			}),
		).resolves.toEqual({
			id: "created-id",
			organizationId: "organization-id",
			key: "analytics",
			name: "Analytics",
		});
		expect(executor.calls[1]?.values).toEqual(["organization-id", "analytics", "Analytics"]);
	});

	it("stores only a bound credential verifier and maps credential state", async () => {
		const verifier = new Uint8Array(32).fill(7);
		const executor = new RecordingExecutor([
			[
				{
					id: "credential-id",
					project_instance_id: "instance-id",
					revoked_at: null,
				},
			],
			[],
		]);
		const repository = new PlatformProjectCredentialRepository(executor);

		await expect(repository.list()).resolves.toEqual([
			{ id: "credential-id", projectInstanceId: "instance-id", revokedAt: null },
		]);
		await repository.create({
			id: "new-credential-id",
			projectInstanceId: "instance-id",
			secretVerifier: verifier,
		});
		expect(executor.calls[1]?.text).toContain("VALUES ($1, $2, 'billing_api', $3)");
		expect(executor.calls[1]?.values).toEqual(["new-credential-id", "instance-id", verifier]);
	});

	it("takes the platform bootstrap advisory lock through the same executor", async () => {
		const executor = new RecordingExecutor([[]]);
		await acquirePlatformBootstrapLock(executor);
		expect(executor.calls).toEqual([
			{
				text: "SELECT pg_advisory_xact_lock($1, $2)",
				values: [760_911, 520_384_007],
			},
		]);
	});
});
