import type { ClientMetadataResourceFetch } from "@better-auth/oauth-provider";
import { APIError } from "better-auth/api";
import { readCappedText } from "../../shared/body-limit";

/** MCP permits HTTPS callbacks and HTTP loopback callbacks, not private-use schemes. */
export function isMcpRedirectUri(value: unknown): value is string {
	if (typeof value !== "string" || value.trim() !== value) return false;
	try {
		const url = new URL(value);
		if (url.username || url.password || url.hash) return false;
		return (
			url.protocol === "https:" ||
			(url.protocol === "http:" &&
				(url.hostname === "localhost" ||
					url.hostname === "[::1]" ||
					/^127(?:\.\d{1,3}){3}$/.test(url.hostname)))
		);
	} catch {
		return false;
	}
}

/** Keep the provider's DNS-pinned transport, and reject forbidden metadata before persistence. */
export function withMcpRedirectPolicy(
	fetchResource: ClientMetadataResourceFetch,
): ClientMetadataResourceFetch {
	return async (input, init) => {
		const response = await fetchResource(input, init);
		if (response.status !== 200 || response.redirected) return response;
		const invalid = () =>
			new APIError("BAD_REQUEST", {
				error: "invalid_client_metadata",
				error_description: "MCP redirect URIs must use HTTPS or HTTP loopback.",
			});
		// The provider caps metadata at 5 KiB. Apply the cap before parsing it here too.
		const body = await readCappedText(response, 5 * 1024, invalid);
		let metadata: unknown;
		try {
			metadata = JSON.parse(body);
		} catch {
			/* The provider reports malformed JSON. */
		}
		if (
			metadata &&
			typeof metadata === "object" &&
			"redirect_uris" in metadata &&
			(!Array.isArray(metadata.redirect_uris) || !metadata.redirect_uris.every(isMcpRedirectUri))
		)
			throw invalid();
		return new Response(body, { status: response.status, headers: response.headers });
	};
}
