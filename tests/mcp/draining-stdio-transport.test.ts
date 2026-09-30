import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { type JSONRPCMessage, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DrainingStdioTransport } from "../../src/mcp/draining-stdio-transport";

const request = (id: number, method = "tools/list"): JSONRPCMessage => ({
	jsonrpc: "2.0",
	id,
	method,
});
const reply = (id: number): JSONRPCMessage => ({ jsonrpc: "2.0", id, result: {} });
const line = (message: JSONRPCMessage) => `${JSON.stringify(message)}\n`;

function collect(output: PassThrough): () => string {
	const chunks: string[] = [];
	output.on("data", (chunk) => chunks.push(String(chunk)));
	return () => chunks.join("");
}

async function startTransport(options?: { drainTimeoutMs?: number }) {
	const input = new PassThrough();
	const output = new PassThrough();
	const transport = new DrainingStdioTransport(input, output, options);
	const written = collect(output);
	const received: JSONRPCMessage[] = [];
	const errors: Error[] = [];
	transport.onmessage = (message) => received.push(message);
	transport.onerror = (error) => errors.push(error);
	await transport.start();
	return { input, written, transport, received, errors };
}

async function isClosed(transport: DrainingStdioTransport, waitMs = 30): Promise<boolean> {
	return Promise.race([
		transport.closed.then(() => true),
		new Promise<boolean>((done) => setTimeout(() => done(false), waitMs)),
	]);
}

describe("DrainingStdioTransport", () => {
	it("answers requests read before end of input, then closes itself", async () => {
		const { input, written, transport, received } = await startTransport();
		input.end(line(request(1)) + line(request(2)));

		expect(await isClosed(transport)).toBe(false);
		expect(received).toEqual([request(1), request(2)]);
		await transport.send(reply(1));
		expect(await isClosed(transport)).toBe(false);
		await transport.send(reply(2));

		expect(await isClosed(transport)).toBe(true);
		expect(written()).toBe(line(reply(1)) + line(reply(2)));
		await expect(transport.send(reply(3))).rejects.toThrow("StdioServerTransport is closed");
	});

	it("reports a read error instead of throwing it and drains as on end of input", async () => {
		const { input, transport, errors } = await startTransport();
		input.write(line(request(1)));
		await Bun.sleep(0);
		input.emit("error", new Error("EIO: read"));

		expect(errors.map((error) => error.message)).toEqual(["EIO: read"]);
		expect(await isClosed(transport)).toBe(false);
		await transport.send(reply(1));
		expect(await isClosed(transport)).toBe(true);
		// A late read error after close is swallowed rather than crashing the process.
		expect(() => input.emit("error", new Error("EIO: late"))).not.toThrow();
		expect(errors).toHaveLength(1);
	});

	it("closes when the drain timeout passes with a request unanswered", async () => {
		const { input, transport } = await startTransport({ drainTimeoutMs: 20 });
		input.end(line(request(1)));
		expect(await isClosed(transport, 1_000)).toBe(true);
	});

	it("does not wait for cancelled requests or listen subscriptions", async () => {
		const { input, transport } = await startTransport();
		input.end(
			line(request(1)) +
				line(request(2, "subscriptions/listen")) +
				line({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId: 1 },
				}),
		);
		expect(await isClosed(transport, 1_000)).toBe(true);
	});

	it("stops waiting when closed explicitly", async () => {
		const { input, transport } = await startTransport();
		input.end(line(request(1)));
		await Bun.sleep(0);
		await transport.close();
		expect(await isClosed(transport)).toBe(true);
	});

	it("answers a request still queued behind a slow server when input ends", async () => {
		const input = new PassThrough();
		const output = new PassThrough();
		const transport = new DrainingStdioTransport(input, output);
		const written = collect(output);
		const handle = serveStdio(
			async () => {
				await Bun.sleep(150);
				return new McpServer({ name: "drain-test", version: "0.0.0" });
			},
			{ transport },
		);
		try {
			input.end(
				line({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: { name: "drain-test", version: "0.0.0" },
					},
				}) +
					line({ jsonrpc: "2.0", method: "notifications/initialized" }) +
					line(request(2, "ping")),
			);
			await transport.closed;
			const answered = written()
				.split("\n")
				.filter((text) => text !== "")
				.map((text) => (JSON.parse(text) as { id?: number }).id);
			expect(answered).toEqual([1, 2]);
		} finally {
			await handle.close();
		}
	});
});
