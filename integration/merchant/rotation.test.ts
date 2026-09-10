import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createRuntimeConnectionResolver } from "../../src/composition/connections";
import { PostgresProjectInstanceContextResolver } from "../../src/composition/project-instance-persistence";
import { ConnectionCipher } from "../../src/platform/connections/cipher";
import { ConnectionRepository } from "../../src/platform/connections/repository";
import { rotateConnectionSecrets } from "../../src/platform/connections/rotation";
import {
	MerchantBrowser,
	merchantFixture,
	merchantTestScope,
	onboard,
	stripeCheckoutSettings,
	stubConnectionValidation,
	stubEnvironmentBilling,
} from "./fixture";

const key7 = Buffer.alloc(32, 7);
const key9 = Buffer.alloc(32, 9);
const f = merchantFixture({
	connectionValidation: stubConnectionValidation(),
	environmentBilling: stubEnvironmentBilling(() => f.sql),
});

beforeEach(() => f.reset());
afterAll(() => f.sql.close());

describe("connection secret rotation", () => {
	it("re-encrypts every envelope to the new key and leaves no plaintext", async () => {
		const originals = await seedEnvelopes();
		const next = new ConnectionCipher(
			"b",
			new Map([
				["test", key7],
				["b", key9],
			]),
		);
		expect(await rotateConnectionSecrets(f.sql, next, 1)).toBe(1);
		expect(await rotateConnectionSecrets(f.sql, next, 1)).toBe(1);
		expect(await rotateConnectionSecrets(f.sql, next, 1)).toBe(1);
		expect(await rotateConnectionSecrets(f.sql, next, 1)).toBe(0);
		const rows = await f.sql<{ envelope: { keyId: string } }[]>`
			SELECT envelope FROM platform_connection_secrets
		`;
		expect(rows).toHaveLength(3);
		expect(rows.every((row) => row.envelope.keyId === "b")).toBe(true);
		expect(JSON.stringify(rows)).not.toContain(originals.projectionSecret);
		expect(JSON.stringify(rows)).not.toContain("rk_test_synthetic");
		expect(JSON.stringify(rows)).not.toContain("whsec_synthetic");

		const [stripeRow] = await f.sql<{ id: string; project_instance_id: string }[]>`
			SELECT v.id, v.project_instance_id
			FROM platform_connection_versions v
			JOIN platform_connections c ON c.id=v.connection_id
			WHERE c.kind='stripe'
		`;
		const rotated = new ConnectionRepository(f.sql, next);
		const stripeVersion = await rotated.version(stripeRow.project_instance_id, stripeRow.id);
		expect(await rotated.secrets(stripeVersion)).toMatchObject({
			secretKey: "rk_test_synthetic",
			webhookSecret: "whsec_synthetic",
		});
		const onlyNew = new ConnectionRepository(
			f.sql,
			new ConnectionCipher("b", new Map([["b", key9]])),
		);
		expect(await onlyNew.secrets(stripeVersion)).toMatchObject({
			secretKey: "rk_test_synthetic",
			webhookSecret: "whsec_synthetic",
		});
		await expect(f.connectionRepository.secrets(stripeVersion)).rejects.toMatchObject({
			code: "CONNECTION_SECRET_UNAVAILABLE",
		});

		const lookup = await new PostgresProjectInstanceContextResolver(f.client).resolveInstanceId(
			stripeRow.project_instance_id,
		);
		if (lookup.kind !== "resolved") throw new Error("Missing project instance");
		const resolved = await createRuntimeConnectionResolver(rotated).resolve(
			lookup.context,
			"projection",
		);
		expect(resolved?.projectionSecret).toBe(originals.projectionSecret);

		expect(() => rotateConnectionSecrets(f.sql, next, 0)).toThrow(/1 and 1000/);
		expect(() => rotateConnectionSecrets(f.sql, next, 1001)).toThrow(/1 and 1000/);
		expect(() => rotateConnectionSecrets(f.sql, next, 1.5)).toThrow(/1 and 1000/);
	});

	it("skips rows held under FOR UPDATE", async () => {
		await seedEnvelopes();
		const next = new ConnectionCipher(
			"b",
			new Map([
				["test", key7],
				["b", key9],
			]),
		);
		await f.client.begin(async (tx) => {
			await tx`SELECT 1 FROM platform_connection_secrets WHERE purpose='secretKey' FOR UPDATE`;
			expect(await rotateConnectionSecrets(f.sql, next)).toBe(2);
		});
		expect(await rotateConnectionSecrets(f.sql, next)).toBe(1);
	});

	it("prints the re-encrypted count from the CLI and is idle on rerun", async () => {
		await seedEnvelopes();
		const next = new ConnectionCipher(
			"b",
			new Map([
				["test", key7],
				["b", key9],
			]),
		);
		while ((await rotateConnectionSecrets(f.sql, next)) > 0) {
			/* rotate onto b so the CLI can move b -> c */
		}
		const env = {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			POSTGRES_URI: process.env.POSTGRES_URI ?? "",
			QUOTUM_SECRETS_KEY_ID: "c",
			QUOTUM_SECRETS_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"),
			QUOTUM_SECRETS_PREVIOUS_KEY_ID: "b",
			QUOTUM_SECRETS_PREVIOUS_KEY_BASE64: key9.toString("base64"),
		};
		const first = Bun.spawn(["bun", "scripts/rotate-connection-secrets.ts"], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const firstStdout = await new Response(first.stdout).text();
		expect(await first.exited).toBe(0);
		expect(firstStdout).toContain("Re-encrypted 3 connection secrets with key c.");
		const second = Bun.spawn(["bun", "scripts/rotate-connection-secrets.ts"], {
			env,
			stdout: "pipe",
			stderr: "pipe",
		});
		const secondStdout = await new Response(second.stdout).text();
		expect(await second.exited).toBe(0);
		expect(secondStdout).toContain("Re-encrypted 0 connection secrets with key c.");
	});
});

async function seedEnvelopes(): Promise<{ projectionSecret: string }> {
	const browser = new MerchantBrowser(f);
	await onboard(browser);
	const projection = await browser.json<{ draftId: string; projectionSecret: string }>(
		"/api/platform/connections/projection/drafts",
		{
			scope: merchantTestScope,
			expectedRevision: 0,
			settings: { projectionUrl: "https://receiver.example.com" },
			secrets: {},
		},
	);
	await browser.json("/api/platform/connections/projection/validate", {
		scope: merchantTestScope,
		draftId: projection.draftId,
	});
	await browser.json("/api/platform/connections/projection/commit", {
		scope: merchantTestScope,
		draftId: projection.draftId,
	});
	await browser.json("/api/platform/connections/stripe/drafts", {
		scope: merchantTestScope,
		expectedRevision: 0,
		settings: stripeCheckoutSettings,
		secrets: { secretKey: "rk_test_synthetic", webhookSecret: "whsec_synthetic" },
	});
	const rows = await f.sql`SELECT purpose FROM platform_connection_secrets`;
	expect(rows).toHaveLength(3);
	return { projectionSecret: projection.projectionSecret };
}
