import type { Env, Hono } from "hono";

export function createBunServer<T extends Env>(app: Hono<T>, port: number) {
	return Bun.serve({
		port,
		hostname: "127.0.0.1",
		fetch: app.fetch,
	});
}
