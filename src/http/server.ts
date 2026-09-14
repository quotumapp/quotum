/** The part of Bun's server Quotum reads: the client address of an in-flight request. */
export interface RequestServer {
	requestIP(request: Request): { address: string } | null;
}

/**
 * Bun passes its server as the second `fetch` argument, but Elysia only exposes `app.server`
 * (normally set by `listen()`) to hooks. Composition calls this before dispatching a request so
 * IP-keyed limiters resolve the real client address instead of "unknown". `requestIP` looks the
 * socket up by the original Request object, so forward that object unchanged.
 */
export function attachRequestServer(
	app: { server: unknown },
	server: RequestServer | null | undefined,
): void {
	if (server !== null && server !== undefined && app.server !== server) app.server = server;
}
