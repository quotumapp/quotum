import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { runWebhooksCommand } from "../../src/composition/cli/webhooks";
import { MerchantBrowser, merchantFixture } from "./fixture";
import {
	operatorEnv as env,
	runOperator,
	seedOperatorOrganization,
	withScratchDirectory,
} from "./operator-fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

const webhooks = (argv: string[], settings: Record<string, string | undefined> = env) =>
	runOperator(runWebhooksCommand, argv, {}, settings);
const url = "https://hooks.example.com/quotum";

describe("quotum webhooks", () => {
	it("manages an instance's endpoints headless and writes secrets only to new files", async () => {
		await seedOperatorOrganization(f);
		await withScratchDirectory(async (directory) => {
			const secretFile = join(directory, "webhook.json");
			const create = (out: string) =>
				webhooks([
					"endpoints",
					"create",
					"alpha-sandbox",
					"--url",
					url,
					"--event-types",
					"invoice.paid, subscription.updated",
					"--secret-out",
					out,
					"--request-key",
					"cli-webhook-create",
				]);
			const unknownType = await webhooks([
				"endpoints",
				"create",
				"alpha-sandbox",
				"--url",
				url,
				"--event-types",
				"invoice.lost",
				"--secret-out",
				join(directory, "unknown.json"),
			]);
			expect(unknownType.stderr).toStartWith("WEBHOOK_EVENT_TYPE_UNKNOWN:");
			expect(await Bun.file(join(directory, "unknown.json")).exists()).toBe(false);
			const created = await create(secretFile);
			expect(created.code).toBe(0);
			const endpoint = created.json.endpoint as { id: string };
			expect(created.json).toMatchObject({
				requestKey: "cli-webhook-create",
				instance: "alpha-sandbox",
				duplicate: false,
				secretOut: secretFile,
				endpoint: {
					url,
					eventTypes: ["invoice.paid", "subscription.updated"],
					createdBy: "operator:ops-runbook",
				},
			});
			const written = JSON.parse(await readFile(secretFile, "utf8"));
			expect(written).toEqual({
				version: 1,
				endpointId: endpoint.id,
				secretGeneration: 1,
				webhookSecret: expect.stringMatching(/^whsec_/),
			});
			expect((await stat(secretFile)).mode & 0o777).toBe(0o600);
			expect(created.stdout).not.toContain(written.webhookSecret);

			// The same request key changes nothing, and has no secret to write.
			const again = join(directory, "again.json");
			const repeated = await create(again);
			expect(repeated.code).toBe(0);
			expect(repeated.json).toMatchObject({ duplicate: true, secretOut: null });
			expect(repeated.stderr).toContain("rotate the secret");
			expect(await Bun.file(again).exists()).toBe(false);

			// An existing file is never overwritten, and refuses the command before anything changes.
			const occupied = await webhooks([
				"endpoints",
				"rotate-secret",
				"alpha-sandbox",
				endpoint.id,
				"--secret-out",
				secretFile,
			]);
			expect(occupied.code).toBe(1);

			const listed = await webhooks(["endpoints", "list", "alpha-sandbox"]);
			expect(listed.json).toMatchObject({
				instance: "alpha-sandbox",
				environment: "sandbox",
				endpoints: [{ id: endpoint.id, secretGeneration: 1 }],
			});
			// Production's endpoints are its own.
			expect((await webhooks(["endpoints", "list", "alpha"])).json.endpoints).toEqual([]);

			const id = endpoint.id;
			const update = (...flags: string[]) =>
				webhooks(["endpoints", "update", "alpha-sandbox", id, ...flags]);
			expect((await update("--enabled", "false")).json).toMatchObject({
				enabled: false,
				disabledReason: "operator",
			});
			const refused = await webhooks(["endpoints", "test", "alpha-sandbox", id]);
			expect(refused.code).toBe(1);
			expect(refused.stderr).toStartWith("WEBHOOK_ENDPOINT_DISABLED:");
			expect(
				(await update("--enabled", "true", "--event-types", "all", "--description", "Main")).json,
			).toMatchObject({ enabled: true, eventTypes: [], description: "Main" });
			expect((await update("--description", "")).json).toMatchObject({ description: null });

			const tested = await webhooks(["endpoints", "test", "alpha-sandbox", id]);
			expect(tested.code).toBe(0);
			const deliveries = await webhooks([
				"deliveries",
				"list",
				"alpha-sandbox",
				"--endpoint",
				id,
				"--status",
				"pending",
			]);
			expect(deliveries.json).toMatchObject({
				deliveries: [{ id: tested.json.deliveryId, eventType: "webhook.test" }],
				nextCursor: null,
			});
			const retried = await webhooks([
				"deliveries",
				"retry",
				"alpha-sandbox",
				String(tested.json.deliveryId),
			]);
			expect(retried.stderr).toStartWith("WEBHOOK_DELIVERY_NOT_FAILED:");
			const replayed = await webhooks([
				"deliveries",
				"replay",
				"alpha-sandbox",
				id,
				"--from",
				new Date(Date.now() - 3_600_000).toISOString(),
				"--to",
				new Date(Date.now() + 60_000).toISOString(),
			]);
			expect(replayed).toMatchObject({ code: 0, json: { queued: 0 } });

			const rotatedFile = join(directory, "rotated.json");
			const rotated = await webhooks([
				"endpoints",
				"rotate-secret",
				"alpha-sandbox",
				id,
				"--secret-out",
				rotatedFile,
				"--overlap-hours",
				"1",
			]);
			expect(rotated.json).toMatchObject({
				secretOut: rotatedFile,
				endpoint: { secretGeneration: 2 },
			});
			const rotatedSecret = JSON.parse(await readFile(rotatedFile, "utf8")).webhookSecret;
			expect(rotatedSecret).not.toBe(written.webhookSecret);

			expect((await webhooks(["endpoints", "delete", "alpha-sandbox", id])).json).toEqual({
				id,
				deleted: true,
			});
		});
		const audited = await f.sql<{ operation: string }[]>`
			SELECT metadata->>'operation' AS operation FROM platform_audit_events
			WHERE action='billing.action_accepted' AND metadata->>'operator'='ops-runbook'
			ORDER BY created_at, id
		`;
		// Each change is audited when it is accepted, before the service checks its input.
		expect(audited.map((row) => row.operation)).toEqual([
			"webhooks.endpoints.create",
			"webhooks.endpoints.create",
			"webhooks.endpoints.create",
			"webhooks.endpoints.update",
			"webhooks.endpoints.test",
			"webhooks.endpoints.update",
			"webhooks.endpoints.update",
			"webhooks.endpoints.test",
			"webhooks.deliveries.retry",
			"webhooks.endpoints.replay",
			"webhooks.endpoints.rotate-secret",
			"webhooks.endpoints.delete",
		]);
	});

	it("refuses bad arguments before connecting", async () => {
		const usage = async (argv: string[]) => {
			const result = await webhooks(argv, { QUOTUM_ACTOR: "ops-runbook" });
			expect(result.code, argv.join(" ")).toBe(64);
			return result.stderr;
		};
		expect(await usage(["endpoints", "create", "alpha", "--url", url])).toContain(
			"--secret-out <new-file> is required",
		);
		expect(
			await usage(["endpoints", "update", "alpha", "not-a-uuid", "--enabled", "true"]),
		).toContain("must be a UUID");
		expect(
			await usage(["endpoints", "update", "alpha", "11111111-1111-4111-8111-111111111111"]),
		).toContain("Name a change");
		expect(
			await usage([
				"endpoints",
				"update",
				"alpha",
				"11111111-1111-4111-8111-111111111111",
				"--enabled",
				"yes",
			]),
		).toContain("--enabled takes true or false");
		expect(await usage(["endpoints", "list", "alpha", "--secret-out", "x"])).toContain(
			"Unknown option --secret-out",
		);
	});

	it("reads organizations with members, and changes them only with a stated reason", async () => {
		await seedOperatorOrganization(f);
		await new MerchantBrowser(f).signup();
		await f.sql`
			INSERT INTO platform_memberships(organization_id, principal_id, role)
			SELECT o.id, p.id, 'Owner' FROM platform_organizations o, platform_principals p
			WHERE o.slug='ops'
		`;
		const merchantMode = { ...env, QUOTUM_CONSOLE_ENABLED: "true" };
		expect((await webhooks(["endpoints", "list", "alpha"], merchantMode)).code).toBe(0);
		await withScratchDirectory(async (directory) => {
			const create = (file: string, ...extra: string[]) =>
				webhooks(
					[
						"endpoints",
						"create",
						"alpha",
						"--url",
						url,
						"--secret-out",
						join(directory, file),
						...extra,
					],
					merchantMode,
				);
			const refused = await create("refused.json");
			expect(refused.code).toBe(1);
			expect(refused.stderr).toContain("--member-override-reason");
			expect(await Bun.file(join(directory, "refused.json")).exists()).toBe(false);
			expect(await f.sql`SELECT 1 FROM webhook_endpoints`).toHaveLength(0);
			expect(
				await f.sql`SELECT 1 FROM platform_audit_events WHERE metadata->>'operator' IS NOT NULL`,
			).toHaveLength(0);

			const allowed = await create(
				"allowed.json",
				"--member-override-reason",
				"owner asked for a receiver",
			);
			expect(allowed.code).toBe(0);
			expect(await Bun.file(join(directory, "allowed.json")).exists()).toBe(true);
		});
		expect(
			await f.sql`
				SELECT metadata->>'operator' AS operator, metadata->>'memberOverrideReason' AS reason,
					metadata->>'environment' AS environment
				FROM platform_audit_events WHERE metadata->>'operator' IS NOT NULL
			`,
		).toEqual([
			{ operator: "ops-runbook", reason: "owner asked for a receiver", environment: "production" },
		]);
	});
});
