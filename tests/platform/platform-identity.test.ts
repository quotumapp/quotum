import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parsePlatformBootstrapManifest,
	platformBootstrapCredentialEnvironment,
} from "../../src/platform/bootstrap/manifest";
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

const secret = `${"A".repeat(42)}Q`;

function sha256Hex(value: string | Uint8Array): string {
	return typeof value === "string"
		? createHash("sha256").update(value, "utf8").digest("hex")
		: Buffer.from(value).toString("hex");
}

describe("project API credentials", () => {
	it("generates environment-prefixed tokens whose verifier hashes the whole token", () => {
		for (const [environment, prefix] of [
			["sandbox", "sqpk_"],
			["production", "pqpk_"],
		] as const) {
			const generated = generateProjectApiCredential(environment);
			const parsed = parseProjectApiCredential(generated.token);

			expect(generated.token).toMatch(new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`, "u"));
			expect(generated.token).toHaveLength(48);
			expect(generated.environment).toBe(environment);
			expect(generated.credentialId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
			);
			expect(generated.token).not.toContain(generated.credentialId);
			expect(parsed).toEqual({ environment, secretVerifier: generated.secretVerifier });
			expect(hashProjectApiCredential(generated.token)).toEqual(generated.secretVerifier);
			expect(sha256Hex(generated.secretVerifier)).toBe(sha256Hex(generated.token));
			expect(sha256Hex(generated.secretVerifier)).not.toBe(sha256Hex(generated.token.slice(5)));
			expect(generated.secretVerifier).toHaveLength(32);
			expect(Buffer.from(generated.secretVerifier).toString("utf8")).not.toContain(generated.token);
		}
		expect(generateProjectApiCredential("sandbox").token).not.toBe(
			generateProjectApiCredential("sandbox").token,
		);
	});

	it("refuses to issue credentials outside sandbox and production", () => {
		for (const environment of ["internal", "live", ""]) {
			expect(() => generateProjectApiCredential(environment as "sandbox")).toThrow(
				"Project API credentials are issued only for sandbox or production instances",
			);
		}
	});

	it("binds the environment prefix into the verifier", () => {
		const sandbox = parseProjectApiCredential(`sqpk_${secret}`);
		const production = parseProjectApiCredential(`pqpk_${secret}`);
		if (sandbox === null || production === null) throw new Error("Expected parsed credentials");

		expect(sandbox.environment).toBe("sandbox");
		expect(production.environment).toBe("production");
		expect(sha256Hex(sandbox.secretVerifier)).toBe(sha256Hex(`sqpk_${secret}`));
		expect(sha256Hex(production.secretVerifier)).toBe(sha256Hex(`pqpk_${secret}`));
		expect(sha256Hex(sandbox.secretVerifier)).not.toBe(sha256Hex(production.secretVerifier));
	});

	it("accepts exactly 43 base64url secret characters", () => {
		expect(parseProjectApiCredential(`sqpk_${"-_09azAZ".repeat(5)}abc`)).not.toBeNull();
		expect(parseProjectApiCredential(`sqpk_${secret.slice(1)}`)).toBeNull();
		expect(parseProjectApiCredential(`pqpk_${secret}A`)).toBeNull();
		expect(parseProjectApiCredential("sqpk_")).toBeNull();
	});

	it("rejects malformed, modified-prefix, and legacy tokens", () => {
		const generated = generateProjectApiCredential("production");
		const body = generated.token.slice("pqpk_".length);
		for (const token of [
			"",
			"project-secret",
			body,
			`${generated.token}\n`,
			` ${generated.token}`,
			`PQPK_${body}`,
			`iqpk_${body}`,
			`qpk_${body}`,
			`pqpk-${body}`,
			`pqpk_v1.${body}`,
			`sqpk_${secret.slice(0, 42)}+`,
			`sqpk_${secret.slice(0, 42)}/`,
			`sqpk_${secret.slice(0, 42)}=`,
			`sqpk_${secret.slice(0, 42)}.`,
			`qpk_v1.${generated.credentialId}.${body}`,
			`qpk_v1.00000000-0000-4000-8000-000000000001.${secret}`,
		]) {
			expect(parseProjectApiCredential(token)).toBeNull();
		}
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
		const token = `pqpk_${secret}`;
		try {
			await writePlatformCredentialOutput(path, [{ projectInstanceKey: "voysee", token }]);
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
				version: 1,
				credentials: [{ projectInstanceKey: "voysee", credential: token }],
			});
			await expect(writePlatformCredentialOutput(path, [])).rejects.toThrow();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("derives each issued credential's prefix from the validated manifest", () => {
		const manifest = parsePlatformBootstrapManifest(JSON.stringify(validManifest()));
		expect(platformBootstrapCredentialEnvironment(manifest, "voysee-production")).toBe(
			"production",
		);
		expect(platformBootstrapCredentialEnvironment(manifest, "voysee-sandbox")).toBe("sandbox");

		const undeclared = validManifest();
		const sandbox = undeclared.organizations[0]?.projects[0]?.instances[1];
		if (sandbox === undefined) throw new Error("Expected a sandbox bootstrap instance");
		sandbox.issueCredential = false;
		for (const key of ["voysee-sandbox", "unknown-instance"]) {
			expect(() =>
				platformBootstrapCredentialEnvironment(
					parsePlatformBootstrapManifest(JSON.stringify(undeclared)),
					key,
				),
			).toThrow(`Bootstrap does not declare a credential for ${key}`);
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
								projectInstanceCount: 2,
								credentialsToIssue: [],
								credentialsIssued: 2,
							};
						},
					},
					manifest,
					["voysee-production", "voysee-sandbox"],
					path,
					() => {
						throw new Error("stdout unavailable");
					},
				),
			).rejects.toThrow("stdout unavailable");
			const output = JSON.parse(await readFile(path, "utf8")) as {
				credentials: Array<{ projectInstanceKey: string; credential: string }>;
			};
			const written = new Map(
				output.credentials.map((entry) => [entry.projectInstanceKey, entry.credential]),
			);
			const production = written.get("voysee-production") ?? "";
			const sandbox = written.get("voysee-sandbox") ?? "";
			expect(production).toMatch(/^pqpk_[A-Za-z0-9_-]{43}$/u);
			expect(sandbox).toMatch(/^sqpk_[A-Za-z0-9_-]{43}$/u);
			const parsedProduction = parseProjectApiCredential(production);
			const parsedSandbox = parseProjectApiCredential(sandbox);
			if (parsedProduction === null || parsedSandbox === null) {
				throw new Error("expected parsed credentials");
			}
			expect(issued).toEqual([
				{
					appliedManifest: manifest,
					credentials: [
						{
							credentialId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
							projectInstanceKey: "voysee-production",
							environment: "production",
							secretVerifier: parsedProduction.secretVerifier,
						},
						{
							credentialId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
							projectInstanceKey: "voysee-sandbox",
							environment: "sandbox",
							secretVerifier: parsedSandbox.secretVerifier,
						},
					],
				},
			]);
			expect(hashProjectApiCredential(production)).toEqual(parsedProduction.secretVerifier);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("issues nothing for a credential the manifest does not declare", async () => {
		const directory = await mkdtemp(join(tmpdir(), "quotum-platform-credentials-"));
		const path = join(directory, "credentials.json");
		const manifest = parsePlatformBootstrapManifest(JSON.stringify(validManifest()));
		try {
			await expect(
				applyPlatformBootstrap(
					{
						async apply(): Promise<never> {
							throw new Error("apply must not run");
						},
					},
					manifest,
					["voysee-internal"],
					path,
				),
			).rejects.toThrow("Bootstrap does not declare a credential for voysee-internal");
			await expect(readFile(path, "utf8")).rejects.toThrow();
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
	type Environment = "sandbox" | "production" | "internal";
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
								environment: "production" as Environment,
								lifecycleStatus: "active" as const,
								issueCredential: true,
							},
							{
								key: "voysee-sandbox",
								environment: "sandbox" as Environment,
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
