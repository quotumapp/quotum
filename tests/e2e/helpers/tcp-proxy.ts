import { createConnection, createServer, type Server, type Socket } from "node:net";

export interface TcpProxy {
	host: string;
	port: number;
	start(): Promise<void>;
	stop(): Promise<void>;
}

export async function createTcpProxy({
	host,
	port,
}: {
	host: string;
	port: number;
}): Promise<TcpProxy> {
	let server: Server | null = null;
	let listenPort: number | null = null;
	const sockets = new Set<Socket>();

	const start = async () => {
		if (server !== null) {
			return;
		}

		server = createServer((client) => {
			const upstream = createConnection({ host, port });
			sockets.add(client);
			sockets.add(upstream);

			client.pipe(upstream);
			upstream.pipe(client);

			const closeBoth = () => {
				client.destroy();
				upstream.destroy();
			};
			client.on("error", closeBoth);
			upstream.on("error", closeBoth);
			client.on("close", () => sockets.delete(client));
			upstream.on("close", () => sockets.delete(upstream));
		});

		await new Promise<void>((resolve, reject) => {
			const activeServer = server;
			if (activeServer === null) {
				reject(new Error("TCP proxy server was not created"));
				return;
			}
			activeServer.once("error", reject);
			activeServer.listen(listenPort ?? 0, "127.0.0.1", () => {
				activeServer.off("error", reject);
				const address = activeServer.address();
				if (typeof address !== "object" || address === null) {
					reject(new Error("TCP proxy did not expose a TCP address"));
					return;
				}
				listenPort = address.port;
				resolve();
			});
		});
	};

	const stop = async () => {
		for (const socket of sockets) {
			socket.destroy();
		}
		sockets.clear();
		const activeServer = server;
		server = null;
		if (activeServer === null) {
			return;
		}
		await new Promise<void>((resolve, reject) => {
			activeServer.close((error) => {
				if (error !== undefined) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	};

	await start();
	if (listenPort === null) {
		throw new Error("TCP proxy did not start");
	}

	return {
		host: "127.0.0.1",
		port: listenPort,
		start,
		stop,
	};
}
