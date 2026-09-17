import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateOpenApi } from "../src/composition/openapi";
import {
	providerCapabilityContract,
	renderProviderCapabilityBlock,
	replaceProviderCapabilityBlock,
} from "../src/composition/provider-capabilities";
import { createCliBillingLogger } from "../src/observability/logger";
import { generateErrorRegistry } from "./openapi-errors";

const logger = createCliBillingLogger();

export function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, v]) => v !== undefined)
				.sort(([a], [b]) => a.localeCompare(b, "en"))
				.map(([key, v]) => [key, canonical(v)]),
		);
	return value;
}

/** The committed artifact format: canonical key order, two-space indent, trailing newline. */
export function artifactJson(value: unknown): string {
	return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

/** Writes a generated file when it changed; with `check`, fails with `stale` instead. */
export async function syncGeneratedFile(
	path: string,
	content: string,
	options: { check: boolean; stale: string },
): Promise<void> {
	const current = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw error;
	});
	if (current === content) return;
	if (options.check) throw new Error(options.stale);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, content);
}

async function main(check: boolean): Promise<void> {
	const root = resolve(import.meta.dir, "..");
	const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
	const output = resolve(root, "contracts/v1/openapi.json");
	await syncGeneratedFile(output, artifactJson(await generateOpenApi(packageJson.version)), {
		check,
		stale: "OpenAPI is stale. Run bun run openapi:generate.",
	});
	logger.info(check ? "OpenAPI snapshot is current." : `Generated ${output}`);

	await syncGeneratedFile(
		resolve(root, "contracts/v1/errors.json"),
		artifactJson(await generateErrorRegistry(root)),
		{ check, stale: "Error registry is stale. Run bun run openapi:generate." },
	);

	const capabilities = providerCapabilityContract();
	await syncGeneratedFile(
		resolve(root, "contracts/v1/provider-capabilities.json"),
		artifactJson(capabilities),
		{ check, stale: "Provider capability contract is stale. Run bun run openapi:generate." },
	);
	const guidePath = resolve(root, "docs/providers.md");
	const guide = replaceProviderCapabilityBlock(
		await readFile(guidePath, "utf8"),
		renderProviderCapabilityBlock(capabilities),
	);
	await syncGeneratedFile(guidePath, guide, {
		check,
		stale: "Provider capability table is stale. Run bun run openapi:generate.",
	});
}

if (import.meta.main) await main(process.argv.includes("--check"));
