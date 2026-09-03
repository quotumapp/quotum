import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface RecordedCall {
	method: string;
	pathname: string;
	headers: Headers;
	body: unknown;
}

const repositoryRoot = resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("billing catalog CLI", () => {
	it("prints status through the authenticated operator contract", async () => {
		const fixture = catalogServer();
		const result = await runCli(["status"], fixture.baseUrl);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ revision: 3, intentHash: "current-hash" });
		expect(result.stderr).toBe("");
		expect(fixture.calls).toHaveLength(1);
		expect(fixture.calls[0]).toMatchObject({ method: "GET", pathname: "/v1/admin/catalog" });
		expect(fixture.calls[0]?.headers.get("authorization")).toBe("Bearer project-secret");
		expect(fixture.calls[0]?.headers.get("x-billing-operator-key")).toBe("operator-secret");
		expect(fixture.calls[0]?.headers.get("x-billing-actor")).toBe("catalog-test");
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
});

function catalogServer(): { baseUrl: string; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const server = Bun.serve({
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
			if (request.method === "GET" && url.pathname === "/v1/admin/catalog") {
				return Response.json({
					success: true,
					data: { revision: 3, intentHash: "current-hash", catalog: null },
				});
			}
			if (request.method === "POST" && url.pathname === "/v1/admin/catalog/preview") {
				return Response.json({
					success: true,
					data: {
						previewToken: "preview-token",
						intentHash: "next-hash",
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
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const environment: Record<string, string> = {
		...Object.fromEntries(
			Object.entries(process.env).filter(
				(entry): entry is [string, string] => entry[1] !== undefined,
			),
		),
		BILLING_BASE_URL: baseUrl,
		BILLING_PROJECT_API_KEY: "project-secret",
		BILLING_OPERATOR_API_KEY: "operator-secret",
		BILLING_ACTOR: "catalog-test",
	};
	delete environment.BILLING_PROJECT_KEY;
	const processHandle = Bun.spawn(
		[process.execPath, "run", "scripts/billing-catalog.ts", ...args],
		{
			cwd: repositoryRoot,
			env: environment,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
		processHandle.exited,
	]);
	return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}
