import { seedProcessConnections } from "./seed-connections";
export interface BillingServiceProcess {
	baseUrl: string;
	pid: number;
	request(path: string, init?: RequestInit): Promise<Response>;
	sendSignal(signal: NodeJS.Signals): void;
	exited: Promise<number>;
	stop(): Promise<void>;
	logs(): string;
}

export async function startBillingService(
	env: NodeJS.ProcessEnv,
	options: { entrypoint?: string } = {},
): Promise<BillingServiceProcess> {
	await seedProcessConnections(env);
	const port = env.PORT === undefined ? getFreePort() : Number(env.PORT);
	const logs: string[] = [];
	const proc = Bun.spawn(["bun", options.entrypoint ?? "src/testing/test-runtime-entrypoint.ts"], {
		env: { ...env, BILLING_TEST_LOOPBACK_PROJECTIONS: "true", PORT: String(port) },
		stdout: "pipe",
		stderr: "pipe",
	});
	void collect(proc.stdout, logs);
	void collect(proc.stderr, logs);

	const baseUrl = `http://127.0.0.1:${port}`;
	await waitForLivez(baseUrl, () => logs.join(""));

	return {
		baseUrl,
		pid: proc.pid,
		request(path, init) {
			return fetch(`${baseUrl}${path}`, init);
		},
		sendSignal(signal) {
			proc.kill(signal);
		},
		exited: proc.exited,
		async stop() {
			if ((await Promise.race([proc.exited, sleep(0).then(() => null)])) !== null) {
				return;
			}
			proc.kill("SIGTERM");
			const exited = await Promise.race([proc.exited, sleep(5000).then(() => null)]);
			if (exited === null) {
				proc.kill("SIGKILL");
				await proc.exited;
			}
		},
		logs() {
			return logs.join("");
		},
	};
}

function getFreePort(): number {
	const server = Bun.serve({
		port: 0,
		fetch() {
			return new Response("ok");
		},
	});
	const port = server.port;
	server.stop(true);
	if (port === undefined) {
		throw new Error("Bun did not allocate a free port");
	}
	return port;
}

async function waitForLivez(baseUrl: string, logs: () => string): Promise<void> {
	const deadline = Date.now() + 15_000;
	let lastError = "";
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}/livez`);
			if (response.status === 200) {
				return;
			}
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await sleep(100);
	}
	throw new Error(`Timed out waiting for billing service /livez: ${lastError}\n${logs()}`);
}

async function collect(stream: ReadableStream<Uint8Array> | null, logs: string[]): Promise<void> {
	if (stream === null) {
		return;
	}
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	for (;;) {
		const { value, done } = await reader.read();
		if (done) {
			return;
		}
		logs.push(decoder.decode(value, { stream: true }));
	}
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
