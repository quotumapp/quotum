import { PassThrough, type Readable, type Writable } from "node:stream";
import {
	isJSONRPCErrorResponse,
	isJSONRPCNotification,
	isJSONRPCRequest,
	isJSONRPCResultResponse,
	type JSONRPCMessage,
	type RequestId,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

export interface DrainingStdioTransportOptions {
	/** How long requests read before end of input may take to answer. */
	drainTimeoutMs?: number;
}

/**
 * A stdio transport that answers what it already read before it closes. The SDK transport closes
 * on end of input and drops the requests still in flight. This one waits, up to the drain timeout,
 * until every request read before end of input is answered or cancelled, then closes itself. A
 * read error is reported through `onerror` and ends input the same way.
 */
export class DrainingStdioTransport extends StdioServerTransport {
	/** Settles when the transport has closed, after a drain or through `close()`. */
	readonly closed: Promise<void>;
	private readonly input: PassThrough;
	private readonly drainTimeoutMs: number;
	private readonly pending = new Set<RequestId>();
	private answered: (() => void) | undefined;
	private inputEnded = false;
	private closing = false;
	private markClosed: () => void = () => {};

	constructor(
		private readonly source: Readable,
		output: Writable,
		{ drainTimeoutMs = 10_000 }: DrainingStdioTransportOptions = {},
	) {
		// The SDK reads from a stream that never ends, so only this class acts on end of input.
		const input = new PassThrough();
		super(input, output);
		this.input = input;
		this.drainTimeoutMs = drainTimeoutMs;
		this.closed = new Promise((done) => {
			this.markClosed = done;
		});
	}

	override async start(): Promise<void> {
		await super.start();
		// serveStdio and Protocol.connect assign onmessage before starting the transport.
		const deliver = this.onmessage;
		this.onmessage = (message) => {
			this.track(message);
			deliver?.(message);
		};
		// Stays attached after close, so a late read error cannot crash the process.
		this.source.on("error", this.onSourceError);
		this.source.once("end", this.endInput);
		this.source.once("close", this.endInput);
		this.source.pipe(this.input, { end: false });
		if (this.source.readableEnded || this.source.destroyed) this.endInput();
	}

	override async send(message: JSONRPCMessage): Promise<void> {
		try {
			await super.send(message);
		} finally {
			if (
				(isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) &&
				message.id !== undefined
			) {
				this.settle(message.id);
			}
		}
	}

	override async close(): Promise<void> {
		if (this.closing) return this.closed;
		this.closing = true;
		this.source.unpipe(this.input);
		this.source.off("end", this.endInput);
		this.source.off("close", this.endInput);
		this.pending.clear();
		this.answered?.();
		try {
			await super.close();
		} finally {
			this.input.destroy();
			this.markClosed();
		}
	}

	private track(message: JSONRPCMessage): void {
		if (isJSONRPCRequest(message)) {
			// A listen subscription stays open until the connection closes, so it is not awaited.
			if (message.method !== "subscriptions/listen") this.pending.add(message.id);
			return;
		}
		if (isJSONRPCNotification(message) && message.method === "notifications/cancelled") {
			const requestId = (message.params as { requestId?: RequestId } | undefined)?.requestId;
			if (requestId !== undefined) this.settle(requestId);
		}
	}

	private settle(id: RequestId): void {
		this.pending.delete(id);
		if (this.pending.size === 0) this.answered?.();
	}

	private readonly onSourceError = (error: Error): void => {
		if (this.closing) return;
		this.onerror?.(error);
		this.endInput();
	};

	private readonly endInput = (): void => {
		if (this.inputEnded) return;
		this.inputEnded = true;
		// Let the pipe hand over what it read before end of input, so those requests are counted.
		setImmediate(() => void this.drain());
	};

	private async drain(): Promise<void> {
		if (this.pending.size > 0 && !this.closing) {
			await new Promise<void>((done) => {
				const timer = setTimeout(done, this.drainTimeoutMs);
				this.answered = () => {
					clearTimeout(timer);
					done();
				};
			});
		}
		await this.close();
	}
}
