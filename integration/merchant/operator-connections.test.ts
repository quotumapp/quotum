import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSanitizedProcessEnv } from "../../scripts/lib/sanitized-env";
import {
	type ConnectionsCommandDependencies,
	runConnectionsCommand,
} from "../../src/composition/cli/connections";
import { runCredentialsCommand } from "../../src/composition/cli/credentials";
import {
	type EnvironmentsCommandDependencies,
	runEnvironmentsCommand,
} from "../../src/composition/cli/environments";
import { openOperatorContext } from "../../src/composition/cli/operator-context";
import {
	BunPlatformUnitOfWork,
	PostgresProjectInstanceContextResolver,
} from "../../src/composition/project-instance-persistence";
import { PlatformBootstrapService } from "../../src/platform/bootstrap/service";
import type { ConnectionValidationPort } from "../../src/platform/connections/ports";
import {
	MerchantBrowser,
	merchantFixture,
	stubConnectionValidation,
	stubEnvironmentBilling,
} from "./fixture";
import {
	connectProductionInstance,
	operatorEnv as env,
	lifecycleStatusOf,
	publishAiCreditsOnProduction,
	runOperator,
	seedOperatorOrganization,
	operatorTopology as topology,
	withScratchDirectory,
} from "./operator-fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

const seed = (productionStatus?: "active" | "inactive") =>
	seedOperatorOrganization(f, productionStatus);

async function instanceId(key: string): Promise<string> {
	const [row] = await f.sql<{ id: string }[]>`SELECT id FROM projects WHERE key=${key}`;
	if (!row) throw new Error(`Missing instance ${key}`);
	return row.id;
}

const run = runOperator;

const connections = (argv: string[], dependencies?: ConnectionsCommandDependencies) =>
	run(runConnectionsCommand, argv, dependencies);
const credentials = (argv: string[], settings?: Record<string, string | undefined>) =>
	run(runCredentialsCommand, argv, {}, settings);
/** Activation reads the published catalog through `billing`; the stub answers from the instance row. */
const environments = (
	argv: string[],
	settings?: Record<string, string | undefined>,
	dependencies: EnvironmentsCommandDependencies = { billing: stubEnvironmentBilling(() => f.sql) },
) => run(runEnvironmentsCommand, argv, dependencies, settings);

const withDirectory = withScratchDirectory;

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

	it("reads organizations with members, and changes them only with a stated reason", async () => {
		await seed();
		await new MerchantBrowser(f).signup();
		await f.sql`
			INSERT INTO platform_memberships(organization_id, principal_id, role)
			SELECT o.id, p.id, 'Owner' FROM platform_organizations o, platform_principals p
			WHERE o.slug='ops'
		`;
		const merchantMode = { ...env, QUOTUM_CONSOLE_ENABLED: "true" };
		// Reads need no flag.
		expect((await credentials(["status", "alpha"], merchantMode)).code).toBe(0);
		expect((await run(runConnectionsCommand, ["list", "alpha"], {}, merchantMode)).code).toBe(0);
		await withDirectory(async (directory) => {
			const rotate = (file: string, ...extra: string[]) =>
				credentials(
					[
						"rotate",
						"alpha",
						"--access",
						"full",
						"--credentials-out",
						join(directory, file),
						...extra,
					],
					merchantMode,
				);
			const refused = await rotate("refused.json");
			expect(refused.code).toBe(1);
			expect(refused.stderr).toContain("This organization has members");
			expect(refused.stderr).toContain("--member-override-reason");
			expect(await Bun.file(join(directory, "refused.json")).exists()).toBe(false);
			expect(
				await f.sql`SELECT 1 FROM platform_audit_events WHERE metadata->>'operator' IS NOT NULL`,
			).toHaveLength(0);

			const allowed = await rotate(
				"allowed.json",
				"--member-override-reason",
				"owner asked for a rotation",
			);
			expect(allowed.code).toBe(0);
			expect(await Bun.file(join(directory, "allowed.json")).exists()).toBe(true);
		});
		expect(
			await f.sql`
				SELECT metadata->>'operator' AS operator, metadata->>'memberOverrideReason' AS reason
				FROM platform_audit_events WHERE metadata->>'operator' IS NOT NULL
			`,
		).toEqual([{ operator: "ops-runbook", reason: "owner asked for a rotation" }]);
		// Without the merchant platform, members never stand in the way.
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
			const environmentsHelp = await quotum("environments", "--help");
			expect(environmentsHelp.code).toBe(0);
			expect(environmentsHelp.stdout).toContain("environments activate <instance>");
			// A fresh process builds its own billing reads; nothing is published, so it is not ready.
			const readiness = await quotum("environments", "readiness", "alpha-sandbox");
			expect(readiness.code).toBe(2);
			expect(JSON.parse(readiness.stdout)).toMatchObject({
				instance: "alpha-sandbox",
				ready: false,
				blockers: expect.arrayContaining(["PUBLISHED_CATALOG_REQUIRED"]),
			});

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

const connectProduction = connectProductionInstance;
const publishCatalog = () => publishAiCreditsOnProduction(f);
const lifecycleOf = (key: string) => lifecycleStatusOf(f, key);

describe("operator environment activation", () => {
	it("reports what blocks an environment, then activates it into an owner-only file", async () => {
		await seed("inactive");
		const resolver = new PostgresProjectInstanceContextResolver(f.client);
		await withDirectory(async (directory) => {
			const out = join(directory, "production.json");
			const activate = (...extra: string[]) =>
				environments(["activate", "alpha", "--credentials-out", out, ...extra]);

			const bare = await environments(["readiness", "alpha"]);
			expect(bare.code).toBe(2);
			expect(bare.stderr).toContain("Not ready");
			expect(bare.json).toMatchObject({
				instance: "alpha",
				environment: "production",
				lifecycleStatus: "inactive",
				ready: false,
				blockers: [
					"PROVIDER_REQUIRED",
					"PROJECTION_VALIDATION_REQUIRED",
					"PUBLISHED_CATALOG_REQUIRED",
				],
				catalogRevisionId: null,
				connections: [],
			});

			await connectProduction(directory);
			const uncataloged = await environments(["readiness", "alpha"]);
			expect(uncataloged.code).toBe(2);
			expect(uncataloged.json.blockers).toEqual([
				"STRIPE_CATALOG_REQUIRED",
				"PUBLISHED_CATALOG_REQUIRED",
			]);
			expect(uncataloged.json.connections).toMatchObject([
				{ kind: "projection", enabled: true },
				{ kind: "stripe", enabled: true, eventVerifiedAt: expect.any(String) },
			]);

			// A blocked activation changes nothing, leaves no file and says what to fix.
			const blocked = await activate();
			expect(blocked.code).toBe(2);
			expect(blocked.json).toMatchObject({
				activated: false,
				blockers: ["STRIPE_CATALOG_REQUIRED", "PUBLISHED_CATALOG_REQUIRED"],
			});
			await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
			expect(await lifecycleOf("alpha")).toBe("inactive");

			const revision = await publishCatalog();
			const ready = await environments(["readiness", "alpha"]);
			expect(ready.code).toBe(0);
			expect(ready.json).toMatchObject({ ready: true, blockers: [], catalogRevisionId: revision });

			const activated = await activate();
			expect(activated.code).toBe(0);
			expect(activated.json).toMatchObject({
				instance: "alpha",
				environment: "production",
				active: true,
				credentialDisclosed: true,
				credentialsOut: out,
			});
			expect((await stat(out)).mode & 0o777).toBe(0o600);
			const token = String(JSON.parse(await readFile(out, "utf8")).credentials[0].credential);
			expect(token).toMatch(/^pqpk_[A-Za-z0-9_-]{43}$/u);
			expect(activated.stdout).not.toContain(token);
			expect((await resolver.resolveCredential(token)).kind).toBe("resolved");
			expect(await lifecycleOf("alpha")).toBe("active");
			expect((await credentials(["status", "alpha"])).json).toMatchObject({ full: { live: true } });
			expect(
				await f.sql`
					SELECT principal_id, metadata->>'operator' AS operator,
						metadata->>'catalogRevisionId' AS revision, metadata->>'memberOverrideReason' AS reason
					FROM platform_audit_events WHERE action='environment.activated'
				`,
			).toEqual([{ principal_id: null, operator: "ops-runbook", revision, reason: null }]);

			// Bootstrap must be told: it refuses the manifest that still says inactive, and a key it
			// does not declare. The updated manifest is exact and issues no second key.
			const bootstrap = new PlatformBootstrapService(new BunPlatformUnitOfWork(f.client));
			await expect(
				bootstrap.inspect(topology({ lifecycleStatus: "inactive", issueCredential: false })),
			).rejects.toThrow("lifecycleStatus active in the database but inactive in the manifest");
			await expect(
				bootstrap.inspect(topology({ lifecycleStatus: "active", issueCredential: false })),
			).rejects.toThrow("project credential not declared");
			await expect(
				bootstrap.inspect(topology({ lifecycleStatus: "active", issueCredential: true })),
			).resolves.toMatchObject({ state: "exact", credentialsToIssue: [] });
		});
	});

	it("replays a request key and answers an active environment without issuing another key", async () => {
		await seed("inactive");
		const resolver = new PostgresProjectInstanceContextResolver(f.client);
		await withDirectory(async (directory) => {
			await connectProduction(directory);
			await publishCatalog();
			const activate = (file: string, key: string) =>
				environments([
					"activate",
					"alpha",
					"--credentials-out",
					join(directory, file),
					"--request-key",
					key,
				]);
			const first = await activate("first.json", "activate-1");
			expect(first.json).toMatchObject({ credentialDisclosed: true });
			const token = String(
				JSON.parse(await readFile(join(directory, "first.json"), "utf8")).credentials[0].credential,
			);

			for (const [file, key] of [
				["replay.json", "activate-1"],
				["again.json", "activate-2"],
			] as const) {
				const repeated = await activate(file, key);
				expect(repeated.code).toBe(0);
				expect(repeated.json).toMatchObject({
					active: true,
					credentialDisclosed: false,
					credentialsOut: null,
				});
				await expect(stat(join(directory, file))).rejects.toMatchObject({ code: "ENOENT" });
			}
			// Neither repeat replaced the key that was issued.
			expect((await resolver.resolveCredential(token)).kind).toBe("resolved");
			expect(
				await f.sql`SELECT 1 FROM platform_audit_events WHERE action='environment.activated'`,
			).toHaveLength(1);
		});
	});

	it("keeps the environment inactive when the key cannot be delivered", async () => {
		await seed("inactive");
		await withDirectory(async (directory) => {
			await connectProduction(directory);
			await publishCatalog();
			// An existing output path is refused before anything changes.
			const existing = join(directory, "existing.json");
			await writeFile(existing, "kept");
			const refused = await environments(["activate", "alpha", "--credentials-out", existing]);
			expect(refused.code).toBe(1);
			expect(await readFile(existing, "utf8")).toBe("kept");
			expect(await lifecycleOf("alpha")).toBe("inactive");

			const context = await openOperatorContext(env, {
				validator: stubConnectionValidation(),
				billing: stubEnvironmentBilling(() => f.sql),
			});
			try {
				const gate = context.gate(await context.target("alpha"), "ops-runbook");
				const activate = (deliver: (token: string) => Promise<void>) =>
					context.lifecycle.activate(gate, context.billing, "activate-undelivered", {
						fingerprint: null,
						deliver,
					});
				await expect(
					activate(async () => {
						throw new Error("disk full");
					}),
				).rejects.toThrow("disk full");
				// The activation rolled back: still inactive, no key, and nothing for a retry to replay.
				expect(await lifecycleOf("alpha")).toBe("inactive");
				expect(await f.sql`SELECT 1 FROM platform_project_api_credentials`).toHaveLength(0);
				expect(
					await f.sql`SELECT 1 FROM platform_connection_operations WHERE request_key='activate-undelivered'`,
				).toHaveLength(0);
				let delivered = "";
				await expect(
					activate(async (token) => {
						delivered = token;
					}),
				).resolves.toMatchObject({ active: true, credentialDisclosed: true });
				expect(delivered).toStartWith("pqpk_");
			} finally {
				await context.close();
			}
		});
	});

	it("applies the production limit only while the merchant platform runs", async () => {
		await seed("inactive");
		await f.sql`UPDATE platform_organizations SET production_limit=0 WHERE slug='ops'`;
		await withDirectory(async (directory) => {
			await connectProduction(directory);
			await publishCatalog();
			const activate = (file: string, settings?: Record<string, string | undefined>) =>
				environments(["activate", "alpha", "--credentials-out", join(directory, file)], settings);
			const limited = await activate("limited.json", { ...env, QUOTUM_CONSOLE_ENABLED: "true" });
			expect(limited.code).toBe(1);
			expect(limited.stderr).toContain("ACTIVATION_CONFLICT");
			await expect(stat(join(directory, "limited.json"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await lifecycleOf("alpha")).toBe("inactive");

			// A headless deployment has no plan, so the same limit does not hold it back.
			const headless = await activate("headless.json");
			expect(headless.code).toBe(0);
			expect(headless.json).toMatchObject({ active: true, credentialDisclosed: true });
			expect(await lifecycleOf("alpha")).toBe("active");
		});
	});

	it("changes an organization its members manage only with a stated reason", async () => {
		await seed("inactive");
		await withDirectory(async (directory) => {
			await connectProduction(directory);
			await publishCatalog();
			await new MerchantBrowser(f).signup();
			await f.sql`
				INSERT INTO platform_memberships(organization_id, principal_id, role)
				SELECT o.id, p.id, 'Owner' FROM platform_organizations o, platform_principals p
				WHERE o.slug='ops'
			`;
			const merchantMode = { ...env, QUOTUM_CONSOLE_ENABLED: "true" };
			const activate = (file: string, ...extra: string[]) =>
				environments(
					["activate", "alpha", "--credentials-out", join(directory, file), ...extra],
					merchantMode,
				);
			// Reading readiness needs no flag.
			expect((await environments(["readiness", "alpha"], merchantMode)).code).toBe(0);

			const refused = await activate("refused.json");
			expect(refused.code).toBe(1);
			expect(refused.stderr).toContain("This organization has members");
			expect(refused.stderr).toContain("--member-override-reason");
			await expect(stat(join(directory, "refused.json"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await lifecycleOf("alpha")).toBe("inactive");

			const allowed = await activate(
				"allowed.json",
				"--member-override-reason",
				"owner asked us to go live",
			);
			expect(allowed.code).toBe(0);
			expect(await lifecycleOf("alpha")).toBe("active");
			expect(
				await f.sql`
					SELECT metadata->>'operator' AS operator, metadata->>'memberOverrideReason' AS reason
					FROM platform_audit_events WHERE action='environment.activated'
				`,
			).toEqual([{ operator: "ops-runbook", reason: "owner asked us to go live" }]);
		});
	});

	it("leaves sandbox to onboarding and rejects an unknown instance", async () => {
		await seed("inactive");
		await withDirectory(async (directory) => {
			const out = join(directory, "sandbox.json");
			const sandbox = await environments(["activate", "alpha-sandbox", "--credentials-out", out]);
			expect(sandbox.code).toBe(64);
			expect(sandbox.stderr).toContain("only production is activated");
			await expect(stat(out)).rejects.toMatchObject({ code: "ENOENT" });
			const unknown = await environments(["activate", "missing", "--credentials-out", out]);
			expect(unknown.code).toBe(1);
			expect(unknown.stderr).toContain("was not found");
		});
	});

	it("reads the published catalog through the operator's own connection", async () => {
		await seed("inactive");
		const revision = await publishCatalog();
		// No injected billing port: the command builds one on its own database connection.
		const readiness = await environments(["readiness", "alpha"], env, {});
		expect(readiness.code).toBe(2);
		expect(readiness.json).toMatchObject({ catalogRevisionId: revision });
		expect(readiness.json.blockers).toEqual([
			"PROVIDER_REQUIRED",
			"PROJECTION_VALIDATION_REQUIRED",
		]);
	});
});
