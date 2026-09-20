export interface McpConfig {
	baseUrl: string;
	apiKey: string;
	insecureHttp: boolean;
}

export class McpConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpConfigError";
	}
}

// Mirrors src/platform/credentials/project-api-token.ts, which this module cannot import.
const sandboxKeyPattern = /^sqpk_[A-Za-z0-9_-]{43}$/u;
const productionKeyPattern = /^pqpk_[A-Za-z0-9_-]{43}$/u;
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Reads MCP-specific variables only. The `BILLING_*` names a product backend or the catalog CLI
 * uses are ignored, so a key sitting in the host's environment is never picked up by accident.
 * Messages never contain the key.
 */
export function readMcpConfig(env: Readonly<Record<string, string | undefined>>): McpConfig {
	const insecureHttp = env.QUOTUM_MCP_ALLOW_INSECURE_HTTP === "true";
	return {
		baseUrl: parseBaseUrl(env.QUOTUM_MCP_BASE_URL, insecureHttp),
		apiKey: parseApiKey(env.QUOTUM_MCP_API_KEY),
		insecureHttp,
	};
}

function parseApiKey(value: string | undefined): string {
	const key = value?.trim() ?? "";
	if (key === "") throw new McpConfigError("QUOTUM_MCP_API_KEY is required");
	if (sandboxKeyPattern.test(key)) return key;
	if (productionKeyPattern.test(key)) {
		throw new McpConfigError(
			"QUOTUM_MCP_API_KEY is a production key. The MCP server accepts sandbox keys only until read-only production credentials exist.",
		);
	}
	throw new McpConfigError(
		"QUOTUM_MCP_API_KEY is not a sandbox project API key (sqpk_ followed by 43 characters)",
	);
}

function parseBaseUrl(value: string | undefined, insecureHttp: boolean): string {
	const raw = value?.trim() ?? "";
	if (raw === "") throw new McpConfigError("QUOTUM_MCP_BASE_URL is required");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new McpConfigError("QUOTUM_MCP_BASE_URL is not a valid URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new McpConfigError("QUOTUM_MCP_BASE_URL must use https or http");
	}
	if (url.username !== "" || url.password !== "") {
		throw new McpConfigError("QUOTUM_MCP_BASE_URL must not contain credentials");
	}
	if (url.search !== "" || url.hash !== "") {
		throw new McpConfigError("QUOTUM_MCP_BASE_URL must not contain a query string or fragment");
	}
	if (url.protocol === "http:" && !loopbackHosts.has(url.hostname) && !insecureHttp) {
		throw new McpConfigError(
			"QUOTUM_MCP_BASE_URL must use https unless the host is loopback; set QUOTUM_MCP_ALLOW_INSECURE_HTTP=true to send the key over plain http",
		);
	}
	return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
}
