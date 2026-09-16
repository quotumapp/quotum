import pino, { type DestinationStream } from "pino";
import { type BillingLogLevel, loadBillingLogLevel } from "./log-level";
import { stringifyUnknown } from "./stringify-unknown";

export interface BillingLogger {
	info(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	error(message: string, error: unknown, context?: Record<string, unknown>): void;
}

export interface PinoBillingLoggerOptions {
	level?: BillingLogLevel;
	destination?: DestinationStream | 1 | 2;
	now?: () => Date;
}

export function createPinoBillingLogger({
	level = loadBillingLogLevel(),
	destination = 1,
	now,
}: PinoBillingLoggerOptions = {}): BillingLogger {
	const stream = typeof destination === "number" ? createDestination(destination) : destination;

	const logger = pino(
		{
			level,
			timestamp:
				now === undefined ? pino.stdTimeFunctions.epochTime : () => `,"time":${safeTimestamp(now)}`,
			serializers: { context: normalizeContext, err: normalizeLoggerError },
		},
		stream,
	);
	return {
		info(message, context) {
			writeSafely(() => logger.info({ context }, message));
		},
		warn(message, context) {
			writeSafely(() => logger.warn({ context }, message));
		},
		error(message, error, context) {
			writeSafely(() => logger.error({ err: error, context }, message));
		},
	};
}

/** Keep diagnostic events out of machine-readable command output on stdout. */
export function createCliBillingLogger(): BillingLogger {
	return createPinoBillingLogger({ destination: 2 });
}

export function safelyLogInfo(
	logger: BillingLogger,
	message: string,
	context?: Record<string, unknown>,
): void {
	try {
		logger.info(message, context);
	} catch {
		// Observability must not alter billing behavior.
	}
}

export function safelyLogWarn(
	logger: BillingLogger,
	message: string,
	context?: Record<string, unknown>,
): void {
	try {
		logger.warn(message, context);
	} catch {
		// Observability must not alter billing behavior.
	}
}

export function safelyLogError(
	logger: BillingLogger,
	message: string,
	error: unknown,
	context?: Record<string, unknown>,
): void {
	try {
		logger.error(message, error, context);
	} catch {
		// Observability must not alter billing behavior.
	}
}

export function createNoopBillingLogger(): BillingLogger {
	return {
		info() {},
		warn() {},
		error() {},
	};
}

function normalizeLoggerError(error: unknown): { type: string; message: string; stack?: string } {
	try {
		if (error instanceof Error) {
			return typeof error.stack === "string" && error.stack.length > 0
				? { type: error.name || "Error", message: error.message, stack: error.stack }
				: { type: error.name || "Error", message: error.message };
		}
		return { type: "Error", message: stringifyUnknown(error) };
	} catch {
		return { type: "Error", message: "[Unserializable]" };
	}
}

function safeTimestamp(now: () => Date): number {
	try {
		const timestamp = now().getTime();
		return Number.isFinite(timestamp) ? timestamp : Date.now();
	} catch {
		return Date.now();
	}
}

function normalizeContext(context: unknown): unknown {
	if (context === undefined) return undefined;
	try {
		return JSON.parse(JSON.stringify(context, createSafeJsonReplacer()));
	} catch {
		return "[Unserializable]";
	}
}

function createSafeJsonReplacer(): (key: string, value: unknown) => unknown {
	const seen = new WeakSet<object>();

	return (_key, value) => {
		if (typeof value === "bigint") {
			return value.toString();
		}

		if (typeof value !== "object" || value === null) {
			return value;
		}

		if (seen.has(value)) {
			return "[Circular]";
		}

		seen.add(value);
		return value;
	};
}

function writeSafely(write: () => void): void {
	try {
		write();
	} catch {
		// Observability must not alter billing behavior.
	}
}

function createDestination(fd: 1 | 2): DestinationStream {
	const stream = pino.destination({ dest: fd, sync: true });
	// A broken output pipe must not crash the service through an emitted stream error.
	stream.on("error", () => {});
	return stream;
}
