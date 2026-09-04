import { describe, expect, it } from "bun:test";
import {
	checkProjectRuntimeConfiguration,
	PostgresProjectInstanceContextResolver,
} from "../../src/composition/project-instance-persistence";
import { generateProjectApiCredential } from "../../src/platform/credentials/project-api-token";
import { isTenantTrafficEligible } from "../../src/projects/context";

const mappedContext = {
	organizationId: "00000000-0000-4000-8000-000000000001",
	organizationSlug: "voysee-organization",
	logicalProjectId: "00000000-0000-4000-8000-000000000002",
	logicalProjectKey: "voysee",
	projectInstanceId: "00000000-0000-4000-8000-000000000003",
	projectInstanceKey: "voysee",
	environment: "production" as const,
	lifecycleStatus: "active" as const,
	internalProject: false,
};

function contextRow(overrides: Record<string, unknown> = {}) {
	return {
		organization_id: mappedContext.organizationId,
		organization_slug: mappedContext.organizationSlug,
		logical_project_id: mappedContext.logicalProjectId,
		logical_project_key: mappedContext.logicalProjectKey,
		project_instance_id: mappedContext.projectInstanceId,
		project_instance_key: mappedContext.projectInstanceKey,
		environment: mappedContext.environment,
		lifecycle_status: mappedContext.lifecycleStatus,
		internal_project: mappedContext.internalProject,
		...overrides,
	};
}

describe("Postgres project instance composition adapter", () => {
	it("fails closed when the database authority is unavailable", async () => {
		let calls = 0;
		const unavailableClient = {
			async unsafe() {
				calls += 1;
				throw new Error("database unavailable");
			},
		};
		const resolver = new PostgresProjectInstanceContextResolver(unavailableClient as never);
		const credential = generateProjectApiCredential().token;

		await expect(resolver.resolveCredential(credential)).resolves.toEqual({ kind: "unavailable" });
		await expect(resolver.resolveInstanceKey("voysee")).resolves.toEqual({ kind: "unavailable" });
		await expect(
			resolver.resolveInstanceId("00000000-0000-4000-8000-000000000003"),
		).resolves.toEqual({ kind: "unavailable" });
		expect(calls).toBe(3);
	});

	it("rejects malformed identities without touching the database", async () => {
		let calls = 0;
		const resolver = new PostgresProjectInstanceContextResolver({
			async unsafe() {
				calls += 1;
				return [];
			},
		} as never);

		await expect(resolver.resolveCredential("legacy-plaintext-key")).resolves.toEqual({
			kind: "not_found",
		});
		await expect(resolver.resolveInstanceKey("Not A Slug")).resolves.toEqual({ kind: "not_found" });
		await expect(resolver.resolveInstanceId("not-a-uuid")).resolves.toEqual({ kind: "not_found" });
		expect(calls).toBe(0);
	});

	it("maps resolved credential, routing-key, and UUID lookups to the full trusted context", async () => {
		const generated = generateProjectApiCredential();
		const resolver = new PostgresProjectInstanceContextResolver({
			async unsafe(query: string) {
				return query.includes("platform_project_api_credentials")
					? [
							contextRow({
								secret_verifier: generated.secretVerifier,
								expires_at: null,
								revoked_at: null,
							}),
						]
					: [contextRow()];
			},
		} as never);

		await expect(resolver.resolveCredential(generated.token)).resolves.toEqual({
			kind: "resolved",
			context: mappedContext,
		});
		await expect(resolver.resolveInstanceKey("voysee")).resolves.toEqual({
			kind: "resolved",
			context: mappedContext,
		});
		await expect(resolver.resolveInstanceId(mappedContext.projectInstanceId)).resolves.toEqual({
			kind: "resolved",
			context: mappedContext,
		});
	});

	it("returns not-found for absent or mismatched verifiers and ineligible for expiry or revocation", async () => {
		const generated = generateProjectApiCredential();
		const other = generateProjectApiCredential();
		const resolverFor = (row: Record<string, unknown> | undefined) =>
			new PostgresProjectInstanceContextResolver({
				async unsafe() {
					return row === undefined ? [] : [row];
				},
			} as never);

		await expect(resolverFor(undefined).resolveCredential(generated.token)).resolves.toEqual({
			kind: "not_found",
		});
		await expect(
			resolverFor(
				contextRow({
					secret_verifier: other.secretVerifier,
					expires_at: null,
					revoked_at: null,
				}),
			).resolveCredential(generated.token),
		).resolves.toEqual({ kind: "not_found" });
		for (const eligibility of [
			{ expires_at: new Date(Date.now() - 1), revoked_at: null },
			{ expires_at: null, revoked_at: new Date() },
		]) {
			await expect(
				resolverFor(
					contextRow({ secret_verifier: generated.secretVerifier, ...eligibility }),
				).resolveCredential(generated.token),
			).resolves.toEqual({ kind: "ineligible" });
		}
	});

	it("allows tenant traffic only for active non-internal instances", () => {
		expect(isTenantTrafficEligible(mappedContext)).toBe(true);
		for (const lifecycleStatus of [
			"inactive",
			"suspended",
			"deactivating",
			"deactivated",
		] as const) {
			expect(isTenantTrafficEligible({ ...mappedContext, lifecycleStatus })).toBe(false);
		}
		expect(
			isTenantTrafficEligible({
				...mappedContext,
				environment: "internal",
				internalProject: true,
			}),
		).toBe(false);
	});

	it("requires runtime configuration to match every database instance exactly", async () => {
		const client = {
			async unsafe() {
				return [{ key: "voysee" }, { key: "wiseley" }];
			},
		};
		const runtime = (projectInstanceKey: string) => ({
			projectInstanceKey,
			projectionUrl: `https://${projectInstanceKey}.example.test`,
			projectionSecret: `${projectInstanceKey}-secret`,
		});

		await expect(
			checkProjectRuntimeConfiguration([runtime("wiseley"), runtime("voysee")], client as never),
		).resolves.toBe(true);
		await expect(
			checkProjectRuntimeConfiguration([runtime("voysee")], client as never),
		).resolves.toBe(false);
	});
});
