import { open, unlink } from "node:fs/promises";
import { BunPlatformUnitOfWork } from "./composition/project-instance-persistence";
import { createBillingDatabaseConnection } from "./db/client";
import {
	type PlatformBootstrapManifest,
	parsePlatformBootstrapManifest,
} from "./platform/bootstrap/manifest";
import {
	type PlatformBootstrapResult,
	PlatformBootstrapService,
} from "./platform/bootstrap/service";
import { generateProjectApiCredential } from "./platform/credentials/project-api-token";

if (import.meta.main) {
	await runPlatformBootstrap();
}

async function runPlatformBootstrap(): Promise<void> {
	const mode = parseMode(process.argv.slice(2));
	const postgresUri = requireEnvironmentValue("POSTGRES_URI");
	const manifest = parsePlatformBootstrapManifest(
		requireEnvironmentValue("BILLING_PLATFORM_BOOTSTRAP_JSON"),
	);
	const connection = createBillingDatabaseConnection({ postgresUri });
	const service = new PlatformBootstrapService(new BunPlatformUnitOfWork(connection.sql));

	try {
		const inspection = await service.inspect(manifest);
		if (mode.kind === "check") {
			console.log(JSON.stringify(inspection, null, 2));
			process.exitCode = platformBootstrapCheckExitCode(inspection);
		} else {
			await applyPlatformBootstrap(
				service,
				manifest,
				inspection.credentialsToIssue,
				mode.credentialsOut,
			);
		}
	} finally {
		await connection.sql.close();
	}
}

export function platformBootstrapCheckExitCode(inspection: {
	state: "empty" | "exact";
	credentialsToIssue: readonly string[];
}): 0 | 2 {
	return inspection.state === "exact" && inspection.credentialsToIssue.length === 0 ? 0 : 2;
}

export async function applyPlatformBootstrap(
	service: Pick<PlatformBootstrapService, "apply">,
	manifest: PlatformBootstrapManifest,
	credentialsToIssue: readonly string[],
	credentialsOut: string | null,
	writeSummary: (message: string) => void = console.log,
): Promise<void> {
	if (credentialsToIssue.length > 0 && credentialsOut === null) {
		throw new Error("--credentials-out is required when bootstrap will issue credentials");
	}

	const generated = credentialsToIssue.map((projectInstanceKey) => ({
		projectInstanceKey,
		...generateProjectApiCredential(),
	}));
	let outputCreated = false;
	let result: PlatformBootstrapResult;
	try {
		if (credentialsOut !== null && generated.length > 0) {
			await writePlatformCredentialOutput(credentialsOut, generated);
			outputCreated = true;
		}

		result = await service.apply(
			manifest,
			generated.map((credential) => ({
				credentialId: credential.credentialId,
				projectInstanceKey: credential.projectInstanceKey,
				secretVerifier: credential.secretVerifier,
			})),
		);
	} catch (error) {
		if (outputCreated && credentialsOut !== null) {
			await unlink(credentialsOut).catch(() => undefined);
		}
		throw error;
	}

	writeSummary(
		JSON.stringify(
			{
				state: result.state,
				organizationCount: result.organizationCount,
				logicalProjectCount: result.logicalProjectCount,
				projectInstanceCount: result.projectInstanceCount,
				credentialsIssued: result.credentialsIssued,
				credentialsOut: result.credentialsIssued > 0 ? credentialsOut : null,
			},
			null,
			2,
		),
	);
}

export async function writePlatformCredentialOutput(
	path: string,
	credentials: readonly { projectInstanceKey: string; token: string }[],
): Promise<void> {
	let output: Awaited<ReturnType<typeof open>> | undefined;
	try {
		output = await open(path, "wx", 0o600);
		await output.writeFile(
			`${JSON.stringify(
				{
					version: 1,
					credentials: credentials.map((credential) => ({
						projectInstanceKey: credential.projectInstanceKey,
						credential: credential.token,
					})),
				},
				null,
				2,
			)}\n`,
			{ encoding: "utf8" },
		);
		await output.sync();
	} catch (error) {
		if (output !== undefined) await unlink(path).catch(() => undefined);
		throw error;
	} finally {
		await output?.close();
	}
}

function parseMode(
	args: readonly string[],
): { kind: "check" } | { kind: "apply"; credentialsOut: string | null } {
	if (args.length === 1 && args[0] === "--check") return { kind: "check" };
	if (args[0] !== "--apply") {
		throw new Error("Usage: platform:bootstrap -- --check | --apply [--credentials-out <path>]");
	}
	if (args.length === 1) return { kind: "apply", credentialsOut: null };
	if (args.length === 3 && args[1] === "--credentials-out" && args[2]?.trim() !== "") {
		return { kind: "apply", credentialsOut: args[2] };
	}
	throw new Error("Usage: platform:bootstrap -- --check | --apply [--credentials-out <path>]");
}

function requireEnvironmentValue(name: string): string {
	const value = process.env[name]?.trim();
	if (value === undefined || value === "")
		throw new Error(`${name} environment variable is required`);
	return value;
}
