import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlatformBootstrapManifest } from "../../src/platform/bootstrap/manifest";
import {
	generateProjectApiCredential,
	hashProjectApiCredential,
	parseProjectApiCredential,
} from "../../src/platform/credentials/project-api-token";
import {
	applyPlatformBootstrap,
	platformBootstrapCheckExitCode,
	writePlatformCredentialOutput,
} from "../../src/platform-bootstrap";

describe("project API credentials", () => {
	it("generates an opaque token whose stored verifier is deterministic", () => {
		const generated = generateProjectApiCredential();
		const parsed = parseProjectApiCredential(generated.token);

		expect(generated.token).toMatch(/^qpk_v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);
		expect(parsed?.credentialId).toBe(generated.credentialId);
		expect(parsed?.secretVerifier).toEqual(generated.secretVerifier);
		expect(hashProjectApiCredential(generated.token)).toEqual(generated.secretVerifier);
		expect(generated.secretVerifier).toHaveLength(32);
		expect(Buffer.from(generated.secretVerifier).toString("utf8")).not.toContain(generated.token);
	});

	it("rejects malformed and modified tokens", () => {
		const generated = generateProjectApiCredential();
		expect(parseProjectApiCredential("project-secret")).toBeNull();
		expect(parseProjectApiCredential(`${generated.token}x`)).toBeNull();
		expect(parseProjectApiCredential(generated.token.replace("qpk_v1", "qpk_v2"))).toBeNull();
	});
});

describe("platform bootstrap manifest", () => {
	it("parses a strict organization, logical-project, and instance topology", () => {
		const manifest = validManifest();
		expect(parsePlatformBootstrapManifest(JSON.stringify(manifest))).toEqual(manifest);
	});

	it("rejects duplicate instance identities and unsafe credential declarations", () => {
		const duplicate = validManifest();
		duplicate.organizations[0]?.projects.push({
			key: "another-project",
			name: "Another Project",
			instances: [
				{
					key: "voysee-production",
					environment: "production",
					lifecycleStatus: "active",
					issueCredential: true,
				},
			],
		});
		expect(() => parsePlatformBootstrapManifest(JSON.stringify(duplicate))).toThrow(
			"BILLING_PLATFORM_BOOTSTRAP_JSON is invalid",
		);

		const internal = validManifest();
		const instance = internal.organizations[0]?.projects[0]?.instances[0];
		if (instance === undefined) throw new Error("Expected a bootstrap instance");
		instance.environment = "internal";
		expect(() => parsePlatformBootstrapManifest(JSON.stringify(internal))).toThrow(
			"BILLING_PLATFORM_BOOTSTRAP_JSON is invalid",
		);
	});

	it("rejects unknown fields instead of silently retaining legacy assumptions", () => {
		const manifest = validManifest() as ReturnType<typeof validManifest> & { apiKey?: string };
		manifest.apiKey = "plaintext-key";
		expect(() => parsePlatformBootstrapManifest(JSON.stringify(manifest))).toThrow(
			"BILLING_PLATFORM_BOOTSTRAP_JSON is invalid",
		);
	});
});

describe("platform bootstrap check", () => {
	it("requires both exact topology and all declared credentials", () => {
		expect(platformBootstrapCheckExitCode({ state: "empty", credentialsToIssue: ["voysee"] })).toBe(
			2,
		);
		expect(platformBootstrapCheckExitCode({ state: "exact", credentialsToIssue: ["voysee"] })).toBe(
			2,
		);
		expect(platformBootstrapCheckExitCode({ state: "exact", credentialsToIssue: [] })).toBe(0);
	});

	it("writes credentials once with owner-only permissions", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quotum-platform-credentials-"));
		const path = join(directory, "credentials.json");
		try {
			await writePlatformCredentialOutput(path, [
				{ projectInstanceKey: "voysee", token: "qpk_v1.test.secret" },
			]);
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				version: 1,
				credentials: [{ projectInstanceKey: "voysee", credential: "qpk_v1.test.secret" }],
			});
			await expect(writePlatformCredentialOutput(path, [])).rejects.toThrow();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("retains the only credential copy after the database commit", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quotum-platform-credentials-"));
		const path = join(directory, "credentials.json");
		const manifest = parsePlatformBootstrapManifest(JSON.stringify(validManifest()));
		const issued: unknown[] = [];
		try {
			await expect(
				applyPlatformBootstrap(
					{
						async apply(appliedManifest, credentials) {
							issued.push({ appliedManifest, credentials });
							return {
								state: "exact" as const,
								organizationCount: 1,
								logicalProjectCount: 1,
								projectInstanceCount: 1,
								credentialsToIssue: [],
								credentialsIssued: 1,
							};
						},
					},
					manifest,
					["voysee-production"],
					path,
					() => {
						throw new Error("stdout unavailable");
					},
				),
			).rejects.toThrow("stdout unavailable");
			const output = JSON.parse(await readFile(path, "utf8")) as {
				credentials: Array<{ credential: string }>;
			};
			const written = output.credentials[0]?.credential;
			expect(written).toMatch(/^qpk_v1\./);
			const parsed = parseProjectApiCredential(written ?? "");
			expect(parsed).not.toBeNull();
			if (parsed === null) {
				throw new Error("expected a parsed credential");
			}
			expect(issued).toEqual([
				{
					appliedManifest: manifest,
					credentials: [
						{
							credentialId: parsed.credentialId,
							projectInstanceKey: "voysee-production",
							secretVerifier: parsed.secretVerifier,
						},
					],
				},
			]);
			expect(hashProjectApiCredential(written ?? "")).toEqual(parsed.secretVerifier);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("removes credential output when the database transaction fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quotum-platform-credentials-"));
		const path = join(directory, "credentials.json");
		const manifest = parsePlatformBootstrapManifest(JSON.stringify(validManifest()));
		try {
			await expect(
				applyPlatformBootstrap(
					{
						async apply(): Promise<never> {
							throw new Error("transaction rolled back");
						},
					},
					manifest,
					["voysee-production"],
					path,
				),
			).rejects.toThrow("transaction rolled back");
			await expect(readFile(path, "utf8")).rejects.toThrow();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

function validManifest() {
	return {
		version: 1 as const,
		organizations: [
			{
				slug: "voysee-organization",
				name: "Voysee Organization",
				projects: [
					{
						key: "voysee",
						name: "Voysee",
						instances: [
							{
								key: "voysee-production",
								environment: "production" as "production" | "internal",
								lifecycleStatus: "active" as const,
								issueCredential: true,
							},
						],
					},
				],
			},
		],
	};
}
