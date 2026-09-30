import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DrizzleQueryError } from "drizzle-orm/errors";
import type { PlatformBootstrapInspection } from "../src/platform/bootstrap/service";
import {
	type PlatformBootstrapCommandDependencies,
	runPlatformBootstrapCommand,
} from "../src/platform-bootstrap";

const manifest = {
	version: 1,
	organizations: [
		{
			slug: "acme-organization",
			name: "Acme Organization",
			projects: [
				{
					key: "acme",
					name: "Acme",
					instances: [
						{
							key: "acme-sandbox",
							environment: "sandbox",
							lifecycleStatus: "active",
							issueCredential: true,
						},
					],
				},
			],
		},
	],
};

const inspection: PlatformBootstrapInspection = {
	state: "empty",
	organizationCount: 0,
	logicalProjectCount: 0,
	projectInstanceCount: 0,
	organizationsToCreate: ["acme-organization"],
	logicalProjectsToCreate: ["acme-organization/acme"],
	projectInstancesToCreate: ["acme-sandbox"],
	credentialsToIssue: ["acme-sandbox"],
	readOnlyCredentialsToIssue: [],
};

const environment = {
	POSTGRES_URI: "postgres://bootstrap.invalid/quotum",
	BILLING_PLATFORM_BOOTSTRAP_JSON: JSON.stringify(manifest),
};

/** A bootstrap service that records `apply` and answers `inspect` as given. */
function fakeService(inspect: () => Promise<PlatformBootstrapInspection> = async () => inspection) {
	const applied: unknown[] = [];
	let closed = 0;
	const openService: NonNullable<PlatformBootstrapCommandDependencies["openService"]> = () => ({
		service: {
			inspect,
			async apply(_manifest, credentials) {
				applied.push(credentials);
				return {
					...inspection,
					state: "exact" as const,
					credentialsIssued: credentials.length,
					organizationsCreated: ["acme-organization"],
					logicalProjectsCreated: ["acme-organization/acme"],
					projectInstancesCreated: ["acme-sandbox"],
				};
			},
		},
		close: async () => {
			closed += 1;
		},
	});
	return { openService, applied, closed: () => closed };
}

async function run(
	argv: string[],
	env: Record<string, string | undefined> = environment,
	service = fakeService(),
) {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runPlatformBootstrapCommand(argv, env, {
		openService: service.openService,
		output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
	});
	return { code, out, err, service };
}

async function withDirectory(test: (directory: string) => Promise<void>) {
	const directory = await mkdtemp(join(tmpdir(), "quotum-bootstrap-cli-"));
	try {
		await test(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe("quotum bootstrap", () => {
	it("prints the inspection and exits 2 while --apply has work to do", async () => {
		const result = await run(["--check"]);
		expect(result.code).toBe(2);
		expect(JSON.parse(result.out.join("\n"))).toEqual(inspection);
		expect(result.err).toEqual([]);
		expect(result.service.closed()).toBe(1);
	});

	it("applies the manifest and writes the credentials file", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "credentials.json");
			const result = await run(["--apply", "--credentials-out", path]);
			expect(result.code).toBe(0);
			expect(JSON.parse(result.out.join("\n"))).toMatchObject({
				state: "exact",
				credentialsIssued: 1,
				credentialsOut: path,
			});
			expect(result.service.applied).toHaveLength(1);
			expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ version: 1 });
		});
	});

	it("names a missing setting on one line and exits 1", async () => {
		for (const name of ["POSTGRES_URI", "BILLING_PLATFORM_BOOTSTRAP_JSON"]) {
			const result = await run(["--check"], { ...environment, [name]: undefined });
			expect(result.code).toBe(1);
			expect(result.err).toEqual([`${name} environment variable is required`]);
			expect(result.out).toEqual([]);
		}
	});

	it("names the manifest field that is invalid", async () => {
		const inactive = structuredClone(manifest);
		const instance = inactive.organizations[0]?.projects[0]?.instances[0];
		if (instance === undefined) throw new Error("Expected a bootstrap instance");
		instance.lifecycleStatus = "suspended";
		const cases: [string, string][] = [
			["{", "BILLING_PLATFORM_BOOTSTRAP_JSON must be valid JSON"],
			[
				JSON.stringify(inactive),
				"BILLING_PLATFORM_BOOTSTRAP_JSON is invalid at organizations[0].projects[0].instances[0].issueCredential: only active instances can receive project API credentials",
			],
			[
				JSON.stringify({ ...manifest, apiKey: "plaintext-key" }),
				'BILLING_PLATFORM_BOOTSTRAP_JSON is invalid: Unrecognized key: "apiKey"',
			],
		];
		for (const [value, message] of cases) {
			const result = await run(["--check"], {
				...environment,
				BILLING_PLATFORM_BOOTSTRAP_JSON: value,
			});
			expect(result.code).toBe(1);
			expect(result.err).toEqual([message]);
			expect(result.err.join("\n")).not.toContain("plaintext-key");
		}
	});

	it("refuses --apply without --credentials-out before writing anything", async () => {
		const result = await run(["--apply"]);
		expect(result.code).toBe(64);
		expect(result.err).toEqual([
			"--credentials-out is required when bootstrap will issue credentials. Run `quotum bootstrap --help` for usage.",
		]);
		expect(result.service.applied).toEqual([]);
		expect(result.service.closed()).toBe(1);
	});

	it("never overwrites an existing credentials file", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "credentials.json");
			await writeFile(path, "keep", "utf8");
			const result = await run(["--apply", "--credentials-out", path]);
			expect(result.code).toBe(1);
			expect(result.err).toEqual([
				`--credentials-out ${path} already exists; bootstrap never overwrites a credentials file`,
			]);
			expect(await readFile(path, "utf8")).toBe("keep");
			expect(result.service.applied).toEqual([]);
		});
	});

	it("says why the credentials file cannot be created", async () => {
		await withDirectory(async (directory) => {
			const path = join(directory, "missing", "credentials.json");
			const result = await run(["--apply", "--credentials-out", path]);
			expect(result.code).toBe(1);
			expect(result.err).toEqual([
				`--credentials-out ${path} cannot be created: its directory does not exist`,
			]);
			expect(result.service.applied).toEqual([]);
		});
	});

	it("refuses wrong arguments with exit 64", async () => {
		for (const argv of [[], ["--apply", "--credentials-out"], ["--check", "--apply"]]) {
			const result = await run(argv);
			expect(result.code).toBe(64);
			expect(result.err).toEqual([
				"Usage: quotum bootstrap --check | --apply [--credentials-out <path>]. Run `quotum bootstrap --help` for usage.",
			]);
		}
	});

	it("says the schema is not migrated instead of repeating the failed SQL", async () => {
		const cause = Object.assign(new Error('relation "platform_organizations" does not exist'), {
			errno: "42P01",
		});
		const result = await run(
			["--check"],
			environment,
			fakeService(async () => {
				throw new DrizzleQueryError("SELECT secret_query FROM platform_organizations", [], cause);
			}),
		);
		expect(result.code).toBe(1);
		expect(result.err).toEqual([
			'The database schema is not migrated (relation "platform_organizations" does not exist); run `quotum migrate` first.',
		]);
	});

	it("reports an unreachable database on one line", async () => {
		const out: string[] = [];
		const err: string[] = [];
		const code = await runPlatformBootstrapCommand(
			["--check"],
			{ ...environment, POSTGRES_URI: "postgres://quotum@127.0.0.1:1/quotum" },
			{ output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) } },
		);
		expect(code).toBe(1);
		expect(out).toEqual([]);
		expect(err).toHaveLength(1);
		expect(err[0]).not.toContain("\n");
	});
});
