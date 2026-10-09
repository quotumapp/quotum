import { expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CatalogCommandDependencies,
	runCatalogCommand,
} from "../../src/composition/cli/catalog";
import {
	type ConnectionsCommandDependencies,
	runConnectionsCommand,
} from "../../src/composition/cli/connections";
import type { runCredentialsCommand } from "../../src/composition/cli/credentials";
import type {
	EnvironmentsCommandDependencies,
	runEnvironmentsCommand,
} from "../../src/composition/cli/environments";
import {
	BunPlatformUnitOfWork,
	PostgresProjectInstanceContextResolver,
} from "../../src/composition/project-instance-persistence";
import { BillingRepository } from "../../src/db/repository";
import { parsePlatformBootstrapManifest } from "../../src/platform/bootstrap/manifest";
import { PlatformBootstrapService } from "../../src/platform/bootstrap/service";
import { seedIntegrationProjectsAndCatalog } from "../../tests/integration/helpers/catalog-fixtures";
import { publishAiCreditsCatalog } from "../../tests/integration/helpers/metering-catalog";
import { type MerchantFixture, stubConnectionValidation } from "./fixture";

/** Settings an operator deployment provides; the key matches the fixture's connection cipher. */
export const operatorEnv = {
	POSTGRES_URI: process.env.POSTGRES_URI,
	QUOTUM_SECRETS_KEY_ID: "test",
	QUOTUM_SECRETS_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
	QUOTUM_AUTH_SECRET: "operator-connections-test-secret-0123456789",
	QUOTUM_CONSOLE_ENABLED: "false",
	QUOTUM_ACTOR: "ops-runbook",
};

/** The bootstrap manifest of one organization: an active sandbox and a production environment. */
export function operatorTopology(
	production: { lifecycleStatus: "active" | "inactive"; issueCredential: boolean } = {
		lifecycleStatus: "active",
		issueCredential: false,
	},
) {
	return parsePlatformBootstrapManifest(
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
									...production,
								},
							],
						},
					],
				},
			],
		}),
	);
}

/** One organization with an active sandbox and a production environment, no keys yet. */
export async function seedOperatorOrganization(
	f: MerchantFixture,
	productionStatus: "active" | "inactive" = "active",
): Promise<void> {
	await new PlatformBootstrapService(new BunPlatformUnitOfWork(f.client)).apply(
		operatorTopology({ lifecycleStatus: productionStatus, issueCredential: false }),
		[],
	);
}

export type OperatorResult = {
	code: number;
	stdout: string;
	stderr: string;
	json: Record<string, unknown>;
};

/** Runs one operator command in process with captured output. */
export async function runOperator(
	command:
		| typeof runConnectionsCommand
		| typeof runCredentialsCommand
		| typeof runEnvironmentsCommand,
	argv: string[],
	dependencies: ConnectionsCommandDependencies & EnvironmentsCommandDependencies = {},
	settings: Record<string, string | undefined> = operatorEnv,
): Promise<OperatorResult> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await command(argv, settings, {
		validator: stubConnectionValidation(),
		...dependencies,
		output: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
	});
	return result(code, out, err);
}

/** Runs `quotum catalog` in process; its output is the third argument, not a dependency. */
export async function runOperatorCatalog(
	argv: string[],
	dependencies: CatalogCommandDependencies = {},
	settings: Record<string, string | undefined> = operatorEnv,
): Promise<OperatorResult> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await runCatalogCommand(
		argv,
		settings,
		{ stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
		{ validator: stubConnectionValidation(), ...dependencies },
	);
	return result(code, out, err);
}

function result(code: number, out: string[], err: string[]): OperatorResult {
	const stdout = out.join("\n");
	// A failure prints on stderr only; a report that exits 2 prints JSON like a success.
	return { code, stdout, stderr: err.join("\n"), json: stdout === "" ? {} : JSON.parse(stdout) };
}

export async function withScratchDirectory(
	work: (directory: string) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "quotum-operator-connections-"));
	try {
		await work(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

/** Drafts, validates and commits a projection and a Stripe connection on the production instance. */
export async function connectProductionInstance(directory: string): Promise<void> {
	const connections = (argv: string[], dependencies?: ConnectionsCommandDependencies) =>
		runOperator(runConnectionsCommand, argv, dependencies);
	const projection = join(directory, "projection.json");
	await writeFile(projection, JSON.stringify({ projectionUrl: "https://backend.example/billing" }));
	const stripe = join(directory, "stripe.json");
	// The runtime reads these back when an adoption looks a price up, so all three URLs are valid.
	await writeFile(
		stripe,
		JSON.stringify({
			checkoutSuccessUrl: "https://shop.example/success?session_id={CHECKOUT_SESSION_ID}",
			checkoutCancelUrl: "https://shop.example/cancel",
			portalReturnUrl: "https://shop.example/billing",
		}),
	);
	const stripeSecrets = {
		stdin: async () =>
			new TextEncoder().encode(
				JSON.stringify({ secretKey: "rk_live_operator", webhookSecret: "whsec_operator" }),
			),
	};
	for (const [kind, args, dependencies] of [
		["projection", ["--settings", projection, "--secret-out", join(directory, "secret.json")], {}],
		["stripe", ["--settings", stripe, "--secrets-file", "-"], stripeSecrets],
	] as const) {
		const draft = await connections(["draft", "alpha", kind, ...args], dependencies);
		expect(draft.code).toBe(0);
		const draftId = String(draft.json.draftId);
		expect((await connections(["validate", "alpha", kind, draftId])).code).toBe(0);
		expect((await connections(["commit", "alpha", kind, draftId])).code).toBe(0);
	}
}

/** Publishes a catalog on the production instance through the repository and returns its revision. */
export async function publishAiCreditsOnProduction(f: MerchantFixture): Promise<string> {
	const resolved = await new PostgresProjectInstanceContextResolver(f.client).resolveInstanceKey(
		"alpha",
	);
	if (resolved.kind !== "resolved") throw new Error("Missing production fixture");
	await seedIntegrationProjectsAndCatalog(f.client, [
		{
			name: "Activation fixture",
			projectInstanceKey: "alpha",
			projectionContract: "billing_state_v1",
			projectionUrl: "https://receiver.example.com",
			projectionSecret: "synthetic-test-only",
			apple: null,
			googlePlay: null,
			stripe: null,
		},
	]);
	await publishAiCreditsCatalog(new BillingRepository(), resolved.context);
	const [row] = await f.sql<
		{ revision: string }[]
	>`SELECT published_catalog_revision_id::text AS revision FROM projects WHERE key='alpha'`;
	if (!row) throw new Error("The catalog was not published");
	return row.revision;
}

export async function lifecycleStatusOf(f: MerchantFixture, key: string) {
	return (
		await f.sql<
			{ status: string }[]
		>`SELECT lifecycle_status AS status FROM projects WHERE key=${key}`
	)[0]?.status;
}
