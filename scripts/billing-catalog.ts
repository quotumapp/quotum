#!/usr/bin/env bun
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CatalogIntent } from "../src/catalog/types";
import { BillingClient } from "../src/sdk/client";

const [command, file] = process.argv.slice(2);

if (command === undefined || command === "help" || command === "--help") {
	printHelp();
} else {
	const client = new BillingClient({
		baseUrl: requiredEnv("BILLING_BASE_URL"),
		apiKey: process.env.BILLING_PROJECT_API_KEY,
		projectKey: process.env.BILLING_PROJECT_KEY,
		operatorKey: requiredEnv("BILLING_OPERATOR_API_KEY"),
		actor: process.env.BILLING_ACTOR ?? "catalog-cli",
	});
	if (command === "status") {
		console.log(JSON.stringify(await client.catalog.status(), null, 2));
	} else if (command === "diff" || command === "push") {
		if (file === undefined) throw new Error(`${command} requires a catalog TypeScript file`);
		const source = await loadCatalog(file);
		const current = await client.catalog.status();
		const expectedRevision = source.expectedRevision ?? current.revision;
		const preview = await client.catalog.preview({
			expectedRevision,
			catalog: source.catalog,
		});
		if (command === "diff") {
			console.log(
				JSON.stringify(
					{
						changed: current.intentHash !== preview.intentHash,
						currentRevision: current.revision,
						nextRevision: preview.nextRevision,
						intentHash: preview.intentHash,
						expiresAt: preview.expiresAt,
						impact: preview.impact,
					},
					null,
					2,
				),
			);
		} else {
			const published = await client.catalog.publish({
				expectedRevision,
				previewToken: preview.previewToken,
				catalog: source.catalog,
			});
			console.log(JSON.stringify(published, null, 2));
		}
	} else {
		throw new Error(`Unknown catalog command: ${command}`);
	}
}

async function loadCatalog(
	file: string,
): Promise<{ catalog: CatalogIntent; expectedRevision?: number | null }> {
	const url = pathToFileURL(resolve(file));
	url.searchParams.set("loadedAt", String(Date.now()));
	const module = (await import(url.href)) as {
		default?: unknown;
		catalog?: unknown;
		expectedRevision?: unknown;
	};
	const catalog = module.catalog ?? module.default;
	if (!isCatalogIntent(catalog)) {
		throw new Error("Catalog file must export a CatalogIntent as `catalog` or default");
	}
	if (
		module.expectedRevision !== undefined &&
		module.expectedRevision !== null &&
		(!Number.isSafeInteger(module.expectedRevision) || Number(module.expectedRevision) < 1)
	) {
		throw new Error("expectedRevision must be a positive integer or null");
	}
	return {
		catalog,
		...(module.expectedRevision === undefined
			? {}
			: { expectedRevision: module.expectedRevision as number | null }),
	};
}

function isCatalogIntent(value: unknown): value is CatalogIntent {
	return (
		typeof value === "object" &&
		value !== null &&
		"features" in value &&
		Array.isArray(value.features) &&
		"plans" in value &&
		Array.isArray(value.plans) &&
		"topups" in value &&
		Array.isArray(value.topups) &&
		"rateCards" in value &&
		Array.isArray(value.rateCards)
	);
}

function requiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (value === undefined || value === "") throw new Error(`${name} is required`);
	return value;
}

function printHelp(): void {
	console.log(`billing-catalog <command> [catalog.ts]

Commands:
  status             Print the currently published catalog intent and revision
  diff <catalog.ts>  Validate and preview a catalog-as-code change
  push <catalog.ts>  Preview, then publish the unchanged catalog intent

Environment:
  BILLING_BASE_URL, BILLING_PROJECT_API_KEY (or BILLING_PROJECT_KEY),
  BILLING_OPERATOR_API_KEY, and optional BILLING_ACTOR`);
}
