import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateOpenApi } from "../src/composition/openapi";
import { generateErrorRegistry } from "./openapi-errors";

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
const packageJson = JSON.parse(await readFile(resolve(import.meta.dir, "../package.json"), "utf8"));
const output = resolve(import.meta.dir, "../contracts/v1/openapi.json");
const content = `${JSON.stringify(canonical(await generateOpenApi(packageJson.version)), null, 2)}\n`;
if (process.argv.includes("--check")) {
	if ((await readFile(output, "utf8")) !== content)
		throw new Error("OpenAPI is stale. Run bun run openapi:generate.");
	console.log("OpenAPI snapshot is current.");
} else {
	await mkdir(resolve(output, ".."), { recursive: true });
	await writeFile(output, content);
	console.log(`Generated ${output}`);
}

const registryPath = resolve(import.meta.dir, "../contracts/v1/errors.json");
const registry = `${JSON.stringify(canonical(await generateErrorRegistry(resolve(import.meta.dir, ".."))), null, 2)}\n`;
if (process.argv.includes("--check")) {
	if ((await readFile(registryPath, "utf8")) !== registry)
		throw new Error("Error registry is stale. Run bun run openapi:generate.");
} else await writeFile(registryPath, registry);
