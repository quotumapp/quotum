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
// Accepted: any sandbox key, and the read-only production key. The server only ever reads, so a
// read-only key is the right one everywhere; a sandbox full key stays accepted because that is what
// a developer already has.
const acceptedKeyPattern = /^(?:sq[pr]k|pqrk)_[A-Za-z0-9_-]{43}$/u;
const fullProductionKeyPattern = /^pqpk_[A-Za-z0-9_-]{43}$/u;
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
	if (acceptedKeyPattern.test(key)) return key;
	if (fullProductionKeyPattern.test(key)) {
		throw new McpConfigError(
			"QUOTUM_MCP_API_KEY is a full production key, which can also consume usage and execute commercial actions. Issue a read-only production key (pqrk_) and use that.",
		);
	}
	throw new McpConfigError(
		"QUOTUM_MCP_API_KEY is not a project API key this server accepts (sqpk_, sqrk_ or pqrk_ followed by 43 characters)",
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
