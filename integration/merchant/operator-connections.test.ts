import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";
import {
	type ConnectionsCommandDependencies,
	runConnectionsCommand,
} from "../../src/composition/cli/connections";
import { runCredentialsCommand } from "../../src/composition/cli/credentials";
import { openOperatorContext } from "../../src/composition/cli/operator-context";
import {
	BunPlatformUnitOfWork,
	PostgresProjectInstanceContextResolver,
} from "../../src/composition/project-instance-persistence";
import { parsePlatformBootstrapManifest } from "../../src/platform/bootstrap/manifest";
import { PlatformBootstrapService } from "../../src/platform/bootstrap/service";
import type { ConnectionValidationPort } from "../../src/platform/connections/ports";
import { MerchantBrowser, merchantFixture, stubConnectionValidation } from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

/** Settings an operator deployment provides; the key matches the fixture's connection cipher. */
const env = {
	POSTGRES_URI: process.env.POSTGRES_URI,
	QUOTUM_SECRETS_KEY_ID: "test",
	QUOTUM_SECRETS_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
	QUOTUM_AUTH_SECRET: "operator-connections-test-secret-0123456789",
	QUOTUM_MERCHANT_ENABLED: "false",
	QUOTUM_ACTOR: "ops-runbook",
};

/** One organization with an active sandbox and an active production environment, no keys yet. */
async function seed(): Promise<void> {
	const manifest = parsePlatformBootstrapManifest(
		JSON.stringify({
			version: 1,
			organizations: [
				{
					slug: "ops",
					name: "Operations",
					projects: [
						{
							key: "alpha",
							name: "Alpha",
							instances: [
								{
									key: "alpha-sandbox",
									environment: "sandbox",
									lifecycleStatus: "active",
									issueCredential: false,
								},
								{
									key: "alpha",
									environment: "production",
									lifecycleStatus: "active",
									issueCredential: false,
								},
							],
						},
					],
				},
			],
		}),
	);
	await new PlatformBootstrapService(new BunPlatformUnitOfWork(f.client)).apply(manifest, []);
}

async function instanceId(key: string): Promise<string> {
	const [row] = await f.sql<{ id: string }[]>`SELECT id FROM projects WHERE key=${key}`;
	if (!row) throw new Error(`Missing instance ${key}`);
	return row.id;
}

type Result = { code: number; stdout: string; stderr: string; json: Record<string, unknown> };

async function run(
	command: typeof runConnectionsCommand | typeof runCredentialsCommand,
	argv: string[],
	dependencies: ConnectionsCommandDependencies = {},
	settings: Record<string, string | undefined> = env,
): Promise<Result> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await command(argv, settings, {
		validator: stubConnectionValidation(),
		...dependencies,
		output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
	});
	const stdout = out.join("\n");
	return { code, stdout, stderr: err.join("\n"), json: code === 0 ? JSON.parse(stdout) : {} };
}

const connections = (argv: string[], dependencies?: ConnectionsCommandDependencies) =>
	run(runConnectionsCommand, argv, dependencies);
const credentials = (argv: string[], settings?: Record<string, string | undefined>) =>
	run(runCredentialsCommand, argv, {}, settings);

async function withDirectory(work: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "quotum-operator-connections-"));
	try {
		await work(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

describe("operator connection commands", () => {
	it("drafts, validates, commits and disables a projection without the merchant platform", async () => {
		await seed();
		await withDirectory(async (directory) => {
			const settings = join(directory, "projection.json");
			await writeFile(
				settings,
				JSON.stringify({ projectionUrl: "https://backend.example/billing" }),
			);
			const secretOut = join(directory, "projection-secret.json");
			const draft = await connections([
				"draft",
				"alpha-sandbox",
				"projection",
				"--settings",
				settings,
				"--secret-out",
				secretOut,
			]);
			expect(draft.code).toBe(0);
			expect(draft.json).toMatchObject({
				instance: "alpha-sandbox",
				kind: "projection",
				expectedRevision: 0,
				secretOut,
			});
			const draftId = String(draft.json.draftId);
			const written = JSON.parse(await readFile(secretOut, "utf8"));
			expect(written).toEqual({ version: 1, projectionSecret: expect.any(String) });
			expect((await stat(secretOut)).mode & 0o777).toBe(0o600);
			expect(draft.stdout).not.toContain(written.projectionSecret);
			const version = await f.connectionRepository.version(
				await instanceId("alpha-sandbox"),
				draftId,
			);
			expect((await f.connectionRepository.secrets(version)).projectionSecret).toBe(
				written.projectionSecret,
			);

			expect((await connections(["validate", "alpha-sandbox", "projection", draftId])).code).toBe(
				0,
			);
			const commitArgs = [
				"commit",
				"alpha-sandbox",
				"projection",
				draftId,
				"--request-key",
				"commit-projection-1",
			];
			const committed = await connections(commitArgs);
			expect(committed.json).toMatchObject({
				requestKey: "commit-projection-1",
				revision: 1,
				enabled: true,
			});
			// A retry with the same key replays the receipt instead of changing anything again.
			expect((await connections(commitArgs)).json).toEqual(committed.json);
			expect((await connections(["list", "alpha-sandbox"])).json).toMatchObject({
				instance: "alpha-sandbox",
				environment: "sandbox",
				connections: [{ kind: "projection", enabled: true, revision: 1, activeVersionId: draftId }],
			});

			const stale = await connections([
				"disable",
				"alpha-sandbox",
				"projection",
				"--expected-revision",
				"0",
			]);
			expect(stale.code).toBe(1);
			expect(stale.stderr).toContain("CONNECTION_CHANGED");
			const disabled = await connections([
				"disable",
				"alpha-sandbox",
				"projection",
				"--expected-revision",
				"1",
			]);
			expect(disabled.json).toMatchObject({ enabled: false, revision: 2 });

			expect(
				await f.sql`
					SELECT principal_id, action, metadata->>'operator' AS operator
					FROM platform_audit_events ORDER BY created_at
				`,
			).toEqual([
				{ principal_id: null, action: "connection.draft_created", operator: "ops-runbook" },
				{ principal_id: null, action: "connection.committed", operator: "ops-runbook" },
				{ principal_id: null, action: "connection.disabled", operator: "ops-runbook" },
			]);
		});
	});

	it("commits an active production provider only after its setup event arrives", async () => {
		await seed();
		const validator: ConnectionValidationPort = {
			normalize: (_kind, _environment, input) => input,
			async validate() {
				return {
					identity: "acct_operator",
					eventVerified: false,
					checks: [{ code: "TEST_VERIFIED", passed: true }],
				};
			},
		};
		await withDirectory(async (directory) => {
			const settings = join(directory, "stripe.json");
			await writeFile(
				settings,
				JSON.stringify({ checkoutSuccessUrl: "https://shop.example/success" }),
			);
			const draft = await connections(
				["draft", "alpha", "stripe", "--settings", settings, "--secrets-file", "-"],
				{
					validator,
					stdin: async () =>
						new TextEncoder().encode(
							JSON.stringify({ secretKey: "rk_live_operator", webhookSecret: "whsec_operator" }),
						),
				},
			);
			expect(draft.code).toBe(0);
			const draftId = String(draft.json.draftId);
			const setupPath = `/v1/projects/alpha/connections/${draftId}/webhooks/stripe`;
			expect(draft.json.setupWebhookPath).toBe(setupPath);
			expect(draft.stdout).not.toContain("rk_live_operator");

			const refused = await connections(["commit", "alpha", "stripe", draftId], { validator });
			expect(refused.code).toBe(1);
			expect(refused.stderr).toContain("PROVIDER_EVENT_REQUIRED");
			expect(refused.stderr).toContain(setupPath);

			const waiting = connections(
				["commit", "alpha", "stripe", draftId, "--wait-for-event", "10s"],
				{
					validator,
					pollIntervalMs: 25,
				},
			);
			await Bun.sleep(300);
			const version = await f.connectionRepository.version(await instanceId("alpha"), draftId);
			// Future-dated like the webhook tests: the draft is dated by the database clock.
			await f.connectionRepository.recordEvent(
				version,
				"acct_operator",
				new Date(Date.now() + 30_000),
			);
			const committed = await waiting;
			expect(committed.code).toBe(0);
			expect(committed.json).toMatchObject({ revision: 1, enabled: true });
		});
	});

	it("rotates and revokes project credentials into owner-only files", async () => {
		await seed();
		const resolver = new PostgresProjectInstanceContextResolver(f.client);
		await withDirectory(async (directory) => {
			const rotate = async (access: string, file: string, ...extra: string[]) => {
				const result = await credentials([
					"rotate",
					"alpha",
					"--access",
					access,
					"--credentials-out",
					join(directory, file),
					...extra,
				]);
				return { ...result, path: join(directory, file) };
			};
			const token = async (path: string, field: string) =>
				String(JSON.parse(await readFile(path, "utf8"))[field][0].credential);

			const first = await rotate("full", "full-1.json");
			expect(first.json).toMatchObject({
				instance: "alpha",
				access: "full",
				credentialDisclosed: true,
				credentialsOut: first.path,
			});
			expect((await stat(first.path)).mode & 0o777).toBe(0o600);
			const firstToken = await token(first.path, "credentials");
			expect(firstToken).toStartWith("pqpk_");
			expect(first.stdout).not.toContain(firstToken);
			expect((await resolver.resolveCredential(firstToken)).kind).toBe("resolved");

			const second = await rotate("full", "full-2.json", "--request-key", "rotate-full-2");
			const secondToken = await token(second.path, "credentials");
			expect((await resolver.resolveCredential(secondToken)).kind).toBe("resolved");
			expect((await resolver.resolveCredential(firstToken)).kind).not.toBe("resolved");
			// A replay of the same key discloses nothing and leaves no file behind.
			const replay = await rotate("full", "full-3.json", "--request-key", "rotate-full-2");
			expect(replay.json).toMatchObject({ credentialDisclosed: false, credentialsOut: null });
			await expect(stat(replay.path)).rejects.toMatchObject({ code: "ENOENT" });
			// An existing output path is refused before anything changes.
			expect((await rotate("full", "full-2.json")).code).toBe(1);
			expect((await resolver.resolveCredential(secondToken)).kind).toBe("resolved");

			const readOnly = await rotate("read_only", "read-only.json");
			expect(await token(readOnly.path, "readOnlyCredentials")).toStartWith("pqrk_");
			expect((await credentials(["status", "alpha"])).json).toMatchObject({
				full: { live: true },
				readOnly: { live: true },
			});
			expect((await credentials(["revoke", "alpha", "--access", "read_only"])).json).toMatchObject({
				access: "read_only",
				revoked: true,
			});
			expect((await credentials(["status", "alpha"])).json).toMatchObject({
				full: { live: true },
				readOnly: { live: false },
			});
		});
		const actions = await f.sql<{ action: string }[]>`
			SELECT action FROM platform_audit_events WHERE metadata->>'operator'='ops-runbook' ORDER BY created_at
		`;
		expect(actions.map((row) => row.action)).toEqual([
			"credential.issued",
			"credential.rotated",
			"credential.issued",
			"credential.revoked",
		]);
	});

	it("keeps the old key when the new one cannot be delivered", async () => {
		await seed();
		const resolver = new PostgresProjectInstanceContextResolver(f.client);
		const context = await openOperatorContext(env, { validator: stubConnectionValidation() });
		try {
			const target = await context.target("alpha");
			const rotate = (key: string, deliver: (token: string) => Promise<void>) =>
				context.lifecycle.rotateCredential(
					context.gate(target, "ops-runbook"),
					key,
					"full",
					deliver,
				);
			let current = "";
			await rotate("rotate-first", async (token) => {
				current = token;
			});
			expect((await resolver.resolveCredential(current)).kind).toBe("resolved");

			await expect(
				rotate("rotate-undelivered", async () => {
					throw new Error("disk full");
				}),
			).rejects.toThrow("disk full");
			// The rotation rolled back: the old key still works and the request key has no receipt.
			expect((await resolver.resolveCredential(current)).kind).toBe("resolved");
			const receipts = await f.sql`
				SELECT 1 FROM platform_connection_operations WHERE request_key='rotate-undelivered'
			`;
			expect(receipts).toHaveLength(0);

			// So retrying the same request issues a key instead of replaying a receipt without one.
			let replacement = "";
			await expect(
				rotate("rotate-undelivered", async (token) => {
					replacement = token;
				}),
			).resolves.toMatchObject({ credentialDisclosed: true });
			expect((await resolver.resolveCredential(replacement)).kind).toBe("resolved");
			expect((await resolver.resolveCredential(current)).kind).not.toBe("resolved");
		} finally {
			await context.close();
		}
	});

	it("keeps no projection draft when its secret cannot be delivered", async () => {
		await seed();
		const context = await openOperatorContext(env, { validator: stubConnectionValidation() });
		try {
			const target = await context.target("alpha-sandbox");
			const draft = (deliver: (secret: string) => Promise<void>) =>
				context.lifecycle.draft(
					context.gate(target, "ops-runbook"),
					"projection",
					"draft-undelivered",
					{
						settings: { projectionUrl: "https://backend.example/billing" },
						secrets: {},
						expectedRevision: 0,
					},
					deliver,
				);
			await expect(
				draft(async () => {
					throw new Error("disk full");
				}),
			).rejects.toThrow("disk full");
			// The draft rolled back: no version holds the undelivered secret and the key has nothing
			// to replay.
			expect(
				await f.sql`SELECT 1 FROM platform_connection_versions WHERE request_key='draft-undelivered'`,
			).toHaveLength(0);

			// So retrying the same request drafts again and delivers the secret the draft stores.
			let delivered = "";
			const retried = await draft(async (secret) => {
				delivered = secret;
			});
			expect(retried).toMatchObject({ secretDisclosed: true, projectionSecret: delivered });
			const version = await f.connectionRepository.version(
				await instanceId("alpha-sandbox"),
				retried.draftId,
			);
			expect((await f.connectionRepository.secrets(version)).projectionSecret).toBe(delivered);
			expect(await f.sql`SELECT action FROM platform_audit_events`).toEqual([
				{ action: "connection.draft_created" },
			]);
		} finally {
			await context.close();
		}
	});

	it("leaves organizations with members to them while the merchant platform runs", async () => {
		await seed();
		await new MerchantBrowser(f).signup();
		await f.sql`
			INSERT INTO platform_memberships(organization_id, principal_id, role)
			SELECT o.id, p.id, 'Owner' FROM platform_organizations o, platform_principals p
			WHERE o.slug='ops'
		`;
		const merchantMode = await credentials(["status", "alpha"], {
			...env,
			QUOTUM_MERCHANT_ENABLED: "true",
		});
		expect(merchantMode.code).toBe(1);
		expect(merchantMode.stderr).toContain("This organization has members");
		expect((await credentials(["status", "alpha"])).code).toBe(0);
	});

	it("runs through the quotum executable", async () => {
		await seed();
		await withDirectory(async (directory) => {
			const processEnv = { ...createSanitizedProcessEnv(), ...env };
			const quotum = async (...args: string[]) => {
				const child = Bun.spawn(["bun", "--no-env-file", "src/cli.ts", ...args], {
					env: processEnv,
					stdout: "pipe",
					stderr: "pipe",
				});
				const [code, stdout, stderr] = await Promise.all([
					child.exited,
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
				]);
				return { code, stdout, stderr };
			};
			const help = await quotum("connections", "--help");
			expect(help.code).toBe(0);
			expect(help.stdout).toContain("connections draft <instance>");

			const credentialsOut = join(directory, "sandbox.json");
			const rotated = await quotum(
				"credentials",
				"rotate",
				"alpha-sandbox",
				"--access",
				"full",
				"--credentials-out",
				credentialsOut,
			);
			expect(rotated).toMatchObject({ code: 0, stderr: "" });
			expect(JSON.parse(rotated.stdout)).toMatchObject({
				credentialsOut,
				credentialDisclosed: true,
			});
			expect(await readFile(credentialsOut, "utf8")).toContain("sqpk_");

			const settings = join(directory, "projection.json");
			await writeFile(
				settings,
				JSON.stringify({ projectionUrl: "https://backend.example/billing" }),
			);
			const secretOut = join(directory, "projection-secret.json");
			const drafted = await quotum(
				"connections",
				"draft",
				"alpha-sandbox",
				"projection",
				"--settings",
				settings,
				"--secret-out",
				secretOut,
			);
			expect(drafted).toMatchObject({ code: 0, stderr: "" });
			expect(JSON.parse(await readFile(secretOut, "utf8")).projectionSecret).toBeString();
		});
	});
});
