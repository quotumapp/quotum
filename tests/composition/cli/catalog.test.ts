import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSanitizedProcessEnv } from "../../../scripts/lib/sanitized-env";
import { expectedRevisionFor, runCatalogCommand } from "../../../src/composition/cli/catalog";

interface RecordedCall {
	method: string;
	pathname: string;
	headers: Headers;
	body: unknown;
}

const repositoryRoot = resolve(import.meta.dir, "../../..");
const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("catalog CLI", () => {
	it("prints status with project authentication only", async () => {
		const fixture = catalogServer();
		const result = await runCli(["status"], fixture.baseUrl);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ revision: 3, intentHash: "current-hash" });
		expect(result.stderr).toBe("");
		expect(fixture.calls).toHaveLength(1);
		expect(fixture.calls[0]).toMatchObject({ method: "GET", pathname: "/v1/admin/catalog" });
		expect(fixture.calls[0]?.headers.get("authorization")).toBe("Bearer project-secret");
		// Reading the published catalog is a project-auth read; only preview and publish carry the
		// operator key.
		expect(fixture.calls[0]?.headers.has("x-billing-operator-key")).toBe(false);
		expect(fixture.calls[0]?.headers.has("x-billing-actor")).toBe(false);
	});

	it("adopts bindings with operator attribution and a stable request key", async () => {
		const fixture = catalogServer();
		const directory = await mkdtemp(join(tmpdir(), "billing-binding-test-"));
		temporaryDirectories.push(directory);
		const file = join(directory, "binding.json");
		await writeFile(
			file,
			JSON.stringify({
				productKey: "premium",
				name: "Premium",
				kind: "subscription",
				entitlementKey: "premium",
				credits: 100,
				externalProductId: "prod_test",
				externalPriceId: "price_test",
			}),
		);
		const first = await runCli(["bindings", "adopt", file], fixture.baseUrl);
		const retry = await runCli(["bindings", "adopt", file], fixture.baseUrl);
		expect(first.exitCode).toBe(0);
		expect(retry.exitCode).toBe(0);
		expect(fixture.calls).toHaveLength(2);
		expect(fixture.calls[0]?.headers.get("idempotency-key")).toBe(
			fixture.calls[1]?.headers.get("idempotency-key"),
		);
		expect(fixture.calls[0]?.headers.get("x-billing-operator-key")).toBe("operator-secret");
		expect(fixture.calls[0]?.headers.get("x-billing-actor")).toBeTruthy();
	});

	it("runs the same command through `quotum catalog`", async () => {
		const fixture = catalogServer();
		const result = await runCli(["status"], fixture.baseUrl, ["src/cli.ts", "catalog"]);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ revision: 3, intentHash: "current-hash" });
		expect(fixture.calls.map((call) => `${call.method} ${call.pathname}`)).toEqual([
			"GET /v1/admin/catalog",
		]);
	});

	it("diffs and pushes the unchanged catalog snapshot against its declared revision", async () => {
		const fixture = catalogServer();
		const directory = await mkdtemp(join(tmpdir(), "billing-catalog-test-"));
		temporaryDirectories.push(directory);
		const catalogPath = join(directory, "catalog.ts");
		await writeFile(
			catalogPath,
			`export const expectedRevision = 7;
export const catalog = { features: [], plans: [], topups: [], rateCards: [] };
`,
			"utf8",
		);

		const diff = await runCli(["diff", catalogPath], fixture.baseUrl);
		expect(diff.exitCode).toBe(0);
		expect(JSON.parse(diff.stdout)).toEqual({
			changed: true,
			currentRevision: 3,
			nextRevision: 8,
			intentHash: "next-hash",
			expiresAt: "2026-08-30T12:15:00.000Z",
			impact: { plansCreated: 1 },
		});
		expect(fixture.calls.map((call) => `${call.method} ${call.pathname}`)).toEqual([
			"GET /v1/admin/catalog",
			"POST /v1/admin/catalog/preview",
		]);
		expect(fixture.calls[1]?.body).toEqual({
			expectedRevision: 7,
			catalog: { features: [], plans: [], topups: [], rateCards: [] },
		});

		fixture.calls.length = 0;
		const push = await runCli(["push", catalogPath], fixture.baseUrl);
		expect(push.exitCode).toBe(0);
		expect(JSON.parse(push.stdout)).toMatchObject({ revision: 8, duplicate: false });
		expect(fixture.calls.map((call) => `${call.method} ${call.pathname}`)).toEqual([
			"GET /v1/admin/catalog",
			"POST /v1/admin/catalog/preview",
			"POST /v1/admin/catalog/publish",
		]);
		expect(fixture.calls[2]?.body).toEqual({
			expectedRevision: 7,
			previewToken: "preview-token",
			catalog: { features: [], plans: [], topups: [], rateCards: [] },
		});
	});

	it("expects the declared revision, null included, and the current one only when none is declared", () => {
		expect(expectedRevisionFor(null, 3)).toBeNull();
		expect(expectedRevisionFor(7, 3)).toBe(7);
		expect(expectedRevisionFor(undefined, 3)).toBe(3);
		expect(expectedRevisionFor(undefined, null)).toBeNull();
	});

	it("keeps an explicit null expectedRevision and follows the current one only when absent", async () => {
		const fixture = catalogServer();
		const directory = await mkdtemp(join(tmpdir(), "billing-catalog-test-"));
		temporaryDirectories.push(directory);
		const firstPublication = join(directory, "first.ts");
		await writeFile(
			firstPublication,
			`export const expectedRevision = null;
export const catalog = { features: [], plans: [], topups: [], rateCards: [] };
`,
			"utf8",
		);
		const unpinned = join(directory, "unpinned.ts");
		await writeFile(
			unpinned,
			"export const catalog = { features: [], plans: [], topups: [], rateCards: [] };\n",
			"utf8",
		);

		// `null` means "publish only while nothing is published", so it must reach the API as null.
		await runCli(["push", firstPublication], fixture.baseUrl);
		expect(
			fixture.calls.map(
				(call) => (call.body as { expectedRevision?: unknown } | null)?.expectedRevision,
			),
		).toEqual([undefined, null, null]);

		fixture.calls.length = 0;
		await runCli(["diff", unpinned], fixture.baseUrl);
		expect(fixture.calls[1]?.body).toMatchObject({ expectedRevision: 3 });
	});

	it("stops at a preview revision conflict without publishing or leaking credentials", async () => {
		const fixture = catalogServer({ previewConflict: true });
		const directory = await mkdtemp(join(tmpdir(), "billing-catalog-test-"));
		temporaryDirectories.push(directory);
		const catalogPath = join(directory, "catalog.ts");
		await writeFile(
			catalogPath,
			`export const expectedRevision = 7;
export const catalog = { features: [], plans: [], topups: [], rateCards: [] };
`,
			"utf8",
		);
		const push = await runCli(["push", catalogPath], fixture.baseUrl);
		expect(push.exitCode).not.toBe(0);
		expect(push.stderr).toContain("Catalog revision 7 is stale");
		expect(push.stderr).not.toContain("project-secret");
		expect(push.stderr).not.toContain("operator-secret");
		expect(push.stdout).toBe("");
		expect(fixture.calls.map((call) => `${call.method} ${call.pathname}`)).toEqual([
			"GET /v1/admin/catalog",
			"POST /v1/admin/catalog/preview",
		]);
	});
});

function catalogServer(options: { previewConflict?: boolean; unchanged?: boolean } = {}): {
	baseUrl: string;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const body = request.method === "GET" ? null : await request.json();
			calls.push({
				method: request.method,
				pathname: url.pathname,
				headers: request.headers,
				body,
			});
			if (url.pathname === "/v1/admin/catalog/bindings/adopt")
				return Response.json({
					success: true,
					data: {
						productId: "00000000-0000-4000-8000-000000000001",
						storeProductId: "00000000-0000-4000-8000-000000000002",
						productKey: "premium",
						externalProductId: "prod_test",
						externalPriceId: "price_test",
						active: true,
					},
				});

			if (request.method === "GET" && url.pathname === "/v1/admin/catalog") {
				return Response.json({
					success: true,
					data: { revision: 3, intentHash: "current-hash", catalog: null },
				});
			}
			if (request.method === "POST" && url.pathname === "/v1/admin/catalog/preview") {
				if (options.previewConflict === true) {
					return Response.json(
						{
							success: false,
							error: {
								code: "CATALOG_REVISION_CONFLICT",
								message: "Catalog revision 7 is stale",
							},
						},
						{ status: 409 },
					);
				}
				return Response.json({
					success: true,
					data: {
						previewToken: "preview-token",
						intentHash: options.unchanged === true ? "current-hash" : "next-hash",
						nextRevision: 8,
						expiresAt: "2026-08-30T12:15:00.000Z",
						impact: { plansCreated: 1 },
					},
				});
			}
			if (request.method === "POST" && url.pathname === "/v1/admin/catalog/publish") {
				return Response.json({
					success: true,
					data: { revision: 8, intentHash: "next-hash", duplicate: false },
				});
			}
			return Response.json(
				{ success: false, error: { code: "NOT_FOUND", message: "Unexpected request" } },
				{ status: 404 },
			);
		},
	});
	servers.push(server);
	return { baseUrl: `http://127.0.0.1:${server.port}`, calls };
}

async function runCli(
	args: string[],
	baseUrl: string,
	entry: readonly string[] = ["src/composition/cli/catalog.ts"],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const environment: Record<string, string> = {
		...createSanitizedProcessEnv(),
		BILLING_BASE_URL: baseUrl,
		BILLING_PROJECT_API_KEY: "project-secret",
		BILLING_OPERATOR_API_KEY: "operator-secret",
		BILLING_ACTOR: "catalog-test",
	};
	const processHandle = Bun.spawn([process.execPath, "run", ...entry, ...args], {
		cwd: repositoryRoot,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
		processHandle.exited,
	]);
	return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

describe("catalog command in process", () => {
	const env = (fixture: { baseUrl: string }, extra: Record<string, string> = {}) => ({
		BILLING_BASE_URL: fixture.baseUrl,
		BILLING_PROJECT_API_KEY: "project-secret",
		...extra,
	});
	const captured = () => {
		const out: string[] = [];
		const err: string[] = [];
		return {
			out,
			err,
			output: {
				stdout: (value: string) => out.push(value),
				stderr: (value: string) => err.push(value),
			},
		};
	};

	it("reads the status without the operator key", async () => {
		const fixture = catalogServer();
		const result = captured();
		expect(await runCatalogCommand(["status"], env(fixture), result.output)).toBe(0);
		expect(JSON.parse(result.out.join("\n"))).toMatchObject({ revision: 3 });
		expect(result.err).toEqual([]);
		expect(fixture.calls[0]?.headers.has("x-billing-operator-key")).toBe(false);
	});

	it("requires the operator key for diff and push before calling the API", async () => {
		const fixture = catalogServer();
		for (const command of ["diff", "push"]) {
			const result = captured();
			expect(await runCatalogCommand([command, "catalog.ts"], env(fixture), result.output)).toBe(1);
			expect(result.err).toEqual([`BILLING_OPERATOR_API_KEY is required for catalog ${command}`]);
		}
		expect(fixture.calls).toEqual([]);
	});

	it("diffs and pushes with the operator key", async () => {
		const fixture = catalogServer();
		const directory = await mkdtemp(join(tmpdir(), "billing-catalog-test-"));
		temporaryDirectories.push(directory);
		const catalogPath = join(directory, "catalog.ts");
		await writeFile(
			catalogPath,
			"export const catalog = { features: [], plans: [], topups: [], rateCards: [] };\n",
			"utf8",
		);
		const operatorEnv = env(fixture, { BILLING_OPERATOR_API_KEY: "operator-secret" });
		const diff = captured();
		expect(await runCatalogCommand(["diff", catalogPath], operatorEnv, diff.output)).toBe(0);
		expect(JSON.parse(diff.out.join("\n"))).toEqual({
			changed: true,
			currentRevision: 3,
			nextRevision: 8,
			intentHash: "next-hash",
			expiresAt: "2026-08-30T12:15:00.000Z",
			impact: { plansCreated: 1 },
		});
		const push = captured();
		expect(await runCatalogCommand(["push", catalogPath], operatorEnv, push.output)).toBe(0);
		expect(JSON.parse(push.out.join("\n"))).toEqual({
			revision: 8,
			intentHash: "next-hash",
			duplicate: false,
		});
		expect(fixture.calls.at(-1)?.headers.get("x-billing-actor")).toBe("catalog-cli");
	});

	it("leaves an already published catalog alone on push unless forced", async () => {
		const fixture = catalogServer({ unchanged: true });
		const directory = await mkdtemp(join(tmpdir(), "billing-catalog-test-"));
		temporaryDirectories.push(directory);
		const catalogPath = join(directory, "catalog.ts");
		await writeFile(
			catalogPath,
			"export const catalog = { features: [], plans: [], topups: [], rateCards: [] };\n",
			"utf8",
		);
		const operatorEnv = env(fixture, { BILLING_OPERATOR_API_KEY: "operator-secret" });
		const requests = () => fixture.calls.map((call) => `${call.method} ${call.pathname}`);
		const run = async (args: string[]) => {
			fixture.calls.length = 0;
			const result = captured();
			const exitCode = await runCatalogCommand(args, operatorEnv, result.output);
			return { exitCode, out: result.out.join("\n"), err: result.err };
		};

		const push = await run(["push", catalogPath]);
		expect(push.exitCode).toBe(0);
		expect(JSON.parse(push.out)).toEqual({
			changed: false,
			published: false,
			revision: 3,
			intentHash: "current-hash",
		});
		expect(requests()).toEqual(["GET /v1/admin/catalog", "POST /v1/admin/catalog/preview"]);

		const forced = await run(["push", catalogPath, "--force"]);
		expect(forced.exitCode).toBe(0);
		expect(JSON.parse(forced.out)).toMatchObject({ revision: 8, duplicate: false });
		expect(requests()).toEqual([
			"GET /v1/admin/catalog",
			"POST /v1/admin/catalog/preview",
			"POST /v1/admin/catalog/publish",
		]);

		const misspelled = await run(["push", catalogPath, "--forced"]);
		expect(misspelled.exitCode).toBe(64);
		expect(misspelled.err.join("\n")).toContain("Unknown option --forced.");
		expect((await run(["diff", catalogPath, "--force"])).exitCode).toBe(64);
		expect(requests()).toEqual([]);
	});

	it("reports an API refusal on one line with its code", async () => {
		const fixture = catalogServer({ previewConflict: true });
		const directory = await mkdtemp(join(tmpdir(), "billing-catalog-test-"));
		temporaryDirectories.push(directory);
		const catalogPath = join(directory, "catalog.ts");
		await writeFile(
			catalogPath,
			"export const catalog = { features: [], plans: [], topups: [], rateCards: [] };\n",
			"utf8",
		);
		const result = captured();
		const code = await runCatalogCommand(
			["diff", catalogPath],
			env(fixture, { BILLING_OPERATOR_API_KEY: "operator-secret" }),
			result.output,
		);
		expect(code).toBe(1);
		expect(result.out).toEqual([]);
		expect(result.err).toEqual(["CATALOG_REVISION_CONFLICT: Catalog revision 7 is stale"]);
	});

	it("prints help and refuses unknown commands with exit 64", async () => {
		const help = captured();
		expect(await runCatalogCommand([], {}, help.output)).toBe(0);
		expect(help.out.join("\n")).toContain(
			"diff, push and bindings also need BILLING_OPERATOR_API_KEY",
		);
		const unknown = captured();
		expect(await runCatalogCommand(["publish"], {}, unknown.output)).toBe(64);
		expect(unknown.err).toEqual([
			"Unknown catalog command: publish. Run `quotum catalog --help` for usage.",
		]);
		const provision = captured();
		expect(await runCatalogCommand(["provision"], {}, provision.output)).toBe(64);
		expect(provision.err.join("\n")).toContain("quotum catalog provision");
		const missingFile = captured();
		expect(
			await runCatalogCommand(
				["diff"],
				{ BILLING_BASE_URL: "http://127.0.0.1:1", BILLING_OPERATOR_API_KEY: "operator-secret" },
				missingFile.output,
			),
		).toBe(64);
		expect(missingFile.err).toEqual([
			"diff requires a catalog TypeScript file. Run `quotum catalog --help` for usage.",
		]);
	});
});

describe("catalog command with --instance", () => {
	const captured = () => {
		const out: string[] = [];
		const err: string[] = [];
		return {
			out,
			err,
			output: {
				stdout: (value: string) => out.push(value),
				stderr: (value: string) => err.push(value),
			},
		};
	};

	it("rejects the direct options with exit 64 before it touches the database", async () => {
		for (const [argv, message] of [
			[["status", "--instance"], "--instance needs a value."],
			[["status", "--instance", "--actor"], "--instance needs a value."],
			[["status", "--instance", "a", "--instance", "b"], "--instance is given more than once."],
			[["status", "--actor", "ops"], "apply only with --instance"],
			[["status", "--member-override-reason", "why"], "apply only with --instance"],
			[["diff", "catalog.ts", "--instance", "alpha"], "Name the operator with --actor"],
			[["push", "catalog.ts", "--instance", "alpha"], "Name the operator with --actor"],
			[["bindings", "adopt", "b.json", "--instance", "alpha"], "Name the operator with --actor"],
			[["diff", "catalog.ts", "--instance", "alpha", "--actor", "bad name"], "--actor must be"],
			[
				[
					"diff",
					"catalog.ts",
					"--instance",
					"alpha",
					"--actor",
					"ops",
					"--member-override-reason",
					" ",
				],
				"--member-override-reason must be",
			],
			[["status", "--instance", "alpha", "--force"], "Unknown option --force."],
			[["bindings", "list", "--instance", "alpha", "extra", "--actor", "ops"], "Use bindings list"],
		] as const) {
			const result = captured();
			// No POSTGRES_URI and no BILLING_* are set, so any attempt to connect or call would differ.
			expect(await runCatalogCommand([...argv], {}, result.output), argv.join(" ")).toBe(64);
			expect(result.err.join("\n"), argv.join(" ")).toContain(message);
			expect(result.out).toEqual([]);
		}
	});

	it("reads without naming an operator, and needs the database settings", async () => {
		for (const argv of [
			["status", "--instance", "alpha"],
			["bindings", "list", "--instance", "alpha"],
		]) {
			const result = captured();
			// Direct mode never reads BILLING_BASE_URL; the first thing it needs is the database.
			expect(
				await runCatalogCommand(argv, { BILLING_BASE_URL: "http://127.0.0.1:1" }, result.output),
			).toBe(1);
			expect(result.err).toEqual(["POSTGRES_URI is required"]);
		}
	});

	it("takes the operator from QUOTUM_ACTOR as the other operator commands do", async () => {
		const result = captured();
		expect(
			await runCatalogCommand(
				["diff", "catalog.ts", "--instance", "alpha"],
				{ QUOTUM_ACTOR: "ops-runbook" },
				result.output,
			),
		).toBe(1);
		expect(result.err).toEqual(["POSTGRES_URI is required"]);
	});

	it("documents the direct mode in its help", async () => {
		const help = captured();
		expect(await runCatalogCommand(["--help"], {}, help.output)).toBe(0);
		const text = help.out.join("\n");
		expect(text).toContain("--instance <key>");
		expect(text).toContain("operator:<name>");
		expect(text).toContain("--member-override-reason");
	});
});
