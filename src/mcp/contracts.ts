import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ApiOperationSummary {
	operationId: string;
	method: string;
	path: string;
	tags: string[];
}

export interface ApiOperationDetail extends ApiOperationSummary {
	operation: unknown;
	/** Every component the operation references, transitively, keyed by its `$ref`. */
	components: Record<string, unknown>;
}

export interface ContractStore {
	findOperations(filter: { query?: string; tag?: string; limit: number }): Promise<{
		operations: ApiOperationSummary[];
		total: number;
	}>;
	getOperation(operationId: string): Promise<ApiOperationDetail | null>;
	readDocument(name: ContractDocument): Promise<string>;
}

export const contractDocuments = ["errors.json", "provider-capabilities.json"] as const;
export type ContractDocument = (typeof contractDocuments)[number];

const httpMethods = ["get", "post", "put", "patch", "delete"] as const;

/** The generated contract could not be read. The message is safe to show; the cause is not. */
export class ContractUnavailableError extends Error {
	constructor(cause: unknown) {
		super("The generated API contract is not available next to this server.", { cause });
		this.name = "ContractUnavailableError";
	}
}

interface OpenApiDocument {
	paths?: Record<string, Record<string, unknown>>;
	[section: string]: unknown;
}

/**
 * Reads the generated contract from disk on first use and keeps it. Create one store per process,
 * outside the per-connection server factory. Only `/v1` is indexed: the MCP server is a guide for
 * trusted-backend integration, and the merchant `/api` surface is not something a backend calls.
 */
export function createContractStore(directory: string): ContractStore {
	let loaded: Promise<{ document: OpenApiDocument; operations: ApiOperationDetail[] }> | undefined;
	const load = () => {
		loaded ??= readFile(join(directory, "openapi.json"), "utf8").then(
			(text) => {
				const document = JSON.parse(text) as OpenApiDocument;
				return { document, operations: indexOperations(document) };
			},
			(error: unknown) => {
				throw new ContractUnavailableError(error);
			},
		);
		return loaded;
	};

	return {
		async findOperations({ query, tag, limit }) {
			const { operations } = await load();
			const needle = query?.trim().toLowerCase() ?? "";
			const matches = operations.filter(
				(operation) =>
					(tag === undefined || operation.tags.includes(tag)) &&
					(needle === "" ||
						operation.path.toLowerCase().includes(needle) ||
						operation.operationId.toLowerCase().includes(needle)),
			);
			return {
				operations: matches
					.slice(0, limit)
					.map(({ operationId, method, path, tags }) => ({ operationId, method, path, tags })),
				total: matches.length,
			};
		},
		async getOperation(operationId) {
			const { operations } = await load();
			return operations.find((operation) => operation.operationId === operationId) ?? null;
		},
		readDocument: (name) => readFile(join(directory, name), "utf8"),
	};
}

function indexOperations(document: OpenApiDocument): ApiOperationDetail[] {
	const operations: ApiOperationDetail[] = [];
	for (const [path, item] of Object.entries(document.paths ?? {})) {
		if (!path.startsWith("/v1/") && path !== "/v1") continue;
		for (const method of httpMethods) {
			const operation = item[method] as { operationId?: string; tags?: string[] } | undefined;
			if (operation?.operationId === undefined) continue;
			const components: Record<string, unknown> = {};
			collectReferences(document, operation, components);
			operations.push({
				operationId: operation.operationId,
				method: method.toUpperCase(),
				path,
				tags: operation.tags ?? [],
				operation,
				components,
			});
		}
	}
	return operations;
}

function collectReferences(
	document: OpenApiDocument,
	value: unknown,
	found: Record<string, unknown>,
): void {
	if (Array.isArray(value)) {
		for (const item of value) collectReferences(document, item, found);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, item] of Object.entries(value)) {
		if (key === "$ref" && typeof item === "string" && item.startsWith("#/") && !(item in found)) {
			const target = resolvePointer(document, item);
			if (target !== undefined) {
				found[item] = target;
				collectReferences(document, target, found);
			}
		} else {
			collectReferences(document, item, found);
		}
	}
}

function resolvePointer(document: OpenApiDocument, pointer: string): unknown {
	let current: unknown = document;
	for (const segment of pointer.slice(2).split("/")) {
		if (typeof current !== "object" || current === null) return undefined;
		current = (current as Record<string, unknown>)[
			segment.replaceAll("~1", "/").replaceAll("~0", "~")
		];
	}
	return current;
}
