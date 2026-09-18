import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { BillingError } from "../../src/billing/errors";
import { createRuntimeConnectionResolver } from "../../src/composition/connections";
import { PostgresProjectInstanceContextResolver } from "../../src/composition/project-instance-persistence";
import type { ConnectionCipher } from "../../src/platform/connections/cipher";
import { ConnectionRepository } from "../../src/platform/connections/repository";
import { merchantFixture } from "./fixture";

const f = merchantFixture();
beforeEach(() => f.reset());
afterAll(() => f.sql.close());

const cipherCalls: string[] = [];
/** Every secret read or write fails, so only a read that never touches secrets can succeed. */
const refusingCipher = {
	encrypt() {
		cipherCalls.push("encrypt");
		throw new Error("describe must not encrypt");
	},
	decrypt() {
		cipherCalls.push("decrypt");
		throw new Error("describe must not decrypt");
	},
} as unknown as ConnectionCipher;

async function seedInstance(key: string): Promise<string> {
	const [organization] = await f.sql<{ id: string }[]>`
		INSERT INTO platform_organizations(slug,name) VALUES(${key},'Acme Company') RETURNING id
	`;
	const [platformProject] = await f.sql<{ id: string }[]>`
		INSERT INTO platform_projects(organization_id,key,name)
		VALUES(${organization?.id ?? null},'example','Example Project') RETURNING id
	`;
	const [instance] = await f.sql<{ id: string }[]>`
		INSERT INTO projects(key,name,platform_project_id,environment,lifecycle_status,internal_project)
		VALUES(${key},'Example Project',${platformProject?.id ?? null},'sandbox','active',false)
		RETURNING id
	`;
	if (!instance) throw new Error("Missing project instance");
	return instance.id;
}

const secretPurposes = {
	stripe: ["secretKey", "webhookSecret"],
	apple: ["privateKey"],
	google: ["serviceAccountJson", "obfuscatedAccountIdSecret"],
};

async function seedConnection(
	instanceId: string,
	kind: "stripe" | "apple" | "google",
	options: {
		enabled: boolean;
		settings: Record<string, unknown>;
		validatedAt: Date | null;
		identity: string | null;
		activate?: boolean;
	},
): Promise<void> {
	await f.sql.begin(async (tx) => {
		const [connection] = await tx<{ id: string }[]>`
			INSERT INTO platform_connections(project_instance_id,kind,revision,enabled)
			VALUES(${instanceId},${kind},1,${options.enabled}) RETURNING id
		`;
		if (!connection) throw new Error("Missing connection");
		const [version] = await tx<{ id: string }[]>`
			INSERT INTO platform_connection_versions(connection_id,project_instance_id,expected_revision,settings,status,validated_at,external_identity,request_key,request_fingerprint)
			VALUES(${connection.id},${instanceId},0,${JSON.stringify(options.settings)}::text::jsonb,${options.activate === false ? "draft" : "active"},${options.validatedAt},${options.identity},${`seed-${kind}-version`},'seed-fingerprint')
			RETURNING id
		`;
		if (!version) throw new Error("Missing connection version");
		// Every secret the kind needs, so only the cipher stands between a read and the secrets.
		for (const purpose of secretPurposes[kind])
			await tx`
				INSERT INTO platform_connection_secrets(connection_id,version_id,purpose,envelope)
				VALUES(${connection.id},${version.id},${purpose},'{"keyId":"test","nonce":"","tag":"","ciphertext":""}'::jsonb)
			`;
		if (options.activate !== false)
			await tx`UPDATE platform_connections SET active_version_id=${version.id} WHERE id=${connection.id}`;
	});
}

async function context(instanceId: string) {
	const lookup = await new PostgresProjectInstanceContextResolver(f.client).resolveInstanceId(
		instanceId,
	);
	if (lookup.kind !== "resolved") throw new Error("Missing project instance");
	return lookup.context;
}

describe("connection describe", () => {
	it("reads persisted state from Postgres without the cipher or secrets", async () => {
		cipherCalls.length = 0;
		const instanceId = await seedInstance("example");
		const validatedAt = new Date("2026-09-18T10:00:00.000Z");
		await seedConnection(instanceId, "stripe", {
			enabled: true,
			settings: { checkoutCancelUrl: "https://shop.example/cancel", livemode: false, retries: 3 },
			validatedAt,
			identity: "acct_voysee",
		});
		await seedConnection(instanceId, "apple", {
			enabled: false,
			settings: { bundleId: "com.voysee.app" },
			validatedAt: null,
			identity: "com.voysee.app",
		});
		await seedConnection(instanceId, "google", {
			enabled: true,
			settings: { packageName: "com.voysee.app" },
			validatedAt,
			identity: "com.voysee.app",
			activate: false,
		});
		const repository = new ConnectionRepository(f.sql, refusingCipher);

		const stripe = await repository.describe(instanceId, "stripe");
		expect(stripe).toEqual({
			enabled: true,
			active_version_id: expect.any(String),
			settings: { checkoutCancelUrl: "https://shop.example/cancel", livemode: false, retries: 3 },
			validated_at: validatedAt,
			external_identity: "acct_voysee",
		});
		expect(await repository.describe(instanceId, "apple")).toMatchObject({
			enabled: false,
			validated_at: null,
			external_identity: "com.voysee.app",
		});
		expect(await repository.describe(instanceId, "google")).toEqual({
			enabled: true,
			active_version_id: null,
			settings: null,
			validated_at: null,
			external_identity: null,
		});
		expect(await repository.describe(instanceId, "projection")).toBeNull();
		expect(await repository.describe(await seedInstance("other"), "stripe")).toBeNull();

		const project = await context(instanceId);
		const resolver = createRuntimeConnectionResolver(repository);
		expect(await resolver.describe?.(project, "stripe")).toEqual({
			enabled: true,
			active: true,
			validated: true,
			validatedAt: "2026-09-18T10:00:00.000Z",
			accountIdentity: "acct_voysee",
			settings: { checkoutCancelUrl: "https://shop.example/cancel", livemode: false },
		});
		expect(await resolver.describe?.(project, "apple")).toMatchObject({
			enabled: false,
			active: true,
			validated: false,
		});
		expect(await resolver.describe?.(project, "google")).toMatchObject({
			active: false,
			validated: false,
			accountIdentity: null,
		});
		expect(cipherCalls).toEqual([]);

		// Resolving the same row decrypts its secrets, which this cipher refuses.
		let resolveError: unknown;
		try {
			await resolver.resolve(project, "stripe");
		} catch (error) {
			resolveError = error;
		}
		expect(resolveError).toBeInstanceOf(BillingError);
		expect((resolveError as BillingError).code).toBe("CONNECTION_UNAVAILABLE");
		expect(cipherCalls).toEqual(["decrypt"]);
	});
});
