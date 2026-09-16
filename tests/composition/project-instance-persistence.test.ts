import { describe, expect, it } from "bun:test";
import { PostgresProjectInstanceContextResolver } from "../../src/composition/project-instance-persistence";
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
		const credential = generateProjectApiCredential("production").token;

		await expect(resolver.resolveCredential(credential)).resolves.toEqual({ kind: "unavailable" });
		await expect(resolver.resolveInstanceKey("voysee")).resolves.toEqual({ kind: "unavailable" });
		await expect(
			resolver.resolveInstanceId("00000000-0000-4000-8000-000000000003"),
		).resolves.toEqual({ kind: "unavailable" });
		expect(calls).toBe(3);
	});

	it("rejects malformed and legacy identities without touching the database", async () => {
		let calls = 0;
		const resolver = new PostgresProjectInstanceContextResolver({
			async unsafe() {
				calls += 1;
				return [];
			},
		} as never);
		const secret = generateProjectApiCredential("production").token.slice("pqpk_".length);

		for (const credential of [
			"legacy-plaintext-key",
			`qpk_v1.00000000-0000-4000-8000-000000000001.${secret}`,
			`qpk_${secret}`,
			`xqpk_${secret}`,
			`pqpk_${secret.slice(1)}`,
		]) {
			await expect(resolver.resolveCredential(credential)).resolves.toEqual({
				kind: "not_found",
			});
		}
		await expect(resolver.resolveInstanceKey("Not A Slug")).resolves.toEqual({ kind: "not_found" });
		await expect(resolver.resolveInstanceId("not-a-uuid")).resolves.toEqual({ kind: "not_found" });
		expect(calls).toBe(0);
	});

	it("looks credentials up by the whole-token hash and billing audience", async () => {
		const generated = generateProjectApiCredential("production");
		const queries: Array<{ text: string; values: readonly unknown[] }> = [];
		const resolver = new PostgresProjectInstanceContextResolver({
			async unsafe(text: string, values: readonly unknown[] = []) {
				queries.push({ text, values });
				return [];
			},
		} as never);

		await expect(resolver.resolveCredential(generated.token)).resolves.toEqual({
			kind: "not_found",
		});
		expect(queries).toHaveLength(1);
		const [query] = queries;
		expect(query?.text).toContain("WHERE credentials.secret_verifier = $1");
		expect(query?.text).toContain("AND credentials.audience = 'billing_api'");
		expect(query?.text).not.toContain("credentials.id =");
		expect(query?.values).toEqual([generated.secretVerifier]);
		expect(query?.values).not.toContain(generated.token);
	});

	it("maps resolved credential, routing-key, and UUID lookups to the full trusted context", async () => {
		const generated = generateProjectApiCredential("production");
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

	it("resolves sandbox credentials only for sandbox instances", async () => {
		const sandbox = generateProjectApiCredential("sandbox");
		const production = generateProjectApiCredential("production");
		const resolverFor = (row: Record<string, unknown>) =>
			new PostgresProjectInstanceContextResolver({
				async unsafe() {
					return [{ expires_at: null, revoked_at: null, ...row }];
				},
			} as never);

		await expect(
			resolverFor(
				contextRow({ environment: "sandbox", secret_verifier: sandbox.secretVerifier }),
			).resolveCredential(sandbox.token),
		).resolves.toEqual({
			kind: "resolved",
			context: { ...mappedContext, environment: "sandbox" },
		});
		for (const [credential, environment] of [
			[sandbox, "production"],
			[production, "sandbox"],
			[production, "internal"],
		] as const) {
			await expect(
				resolverFor(
					contextRow({
						environment,
						internal_project: environment === "internal",
						secret_verifier: credential.secretVerifier,
					}),
				).resolveCredential(credential.token),
			).resolves.toEqual({ kind: "not_found" });
		}
	});

	it("returns not-found for absent or mismatched verifiers and ineligible for expiry or revocation", async () => {
		const generated = generateProjectApiCredential("production");
		const other = generateProjectApiCredential("production");
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
});
